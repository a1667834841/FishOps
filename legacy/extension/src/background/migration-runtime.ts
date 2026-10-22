/**
 * 旧扩展配置迁移命令运行时（background 接线，惰性组装）。
 *
 * 机制（与跨 extension 隔离一致）：
 * - 跨 extension ID 无法直接读取旧扩展 `chrome.storage.local`，因此**不读 storage**；
 * - 预览命令需携带受信上下文采集的白名单载荷 `legacy`，校验通过后在**内存**缓存来源；
 * - 确认命令复用内存中已校验的来源（也可再携带 `legacy`），写入新扩展专用键；
 * - 迁移成功 / 失败均立即清空内存来源，避免凭据残留。
 *
 * 安全：
 * - 只接受白名单载荷（协议层 `isMigrateLegacyConfigPayload` 校验），未知键拒绝；
 * - 不打印 / 不回显任何凭据；返回值只含存在性、条数与派生 provider；
 * - 依赖通过 {@link MigrationRuntimeDeps} 注入，Node 测试无需 chrome 环境。
 */
import {
  CommandTypes,
  createErrorResponse,
  createResponse,
  isMigrateLegacyConfigPayload,
  type CommandEnvelope,
  type ResponseEnvelope,
} from '@fishops/shared'
import type { MigrateLegacyConfigResult } from '../../../shared/types/legacy-migration'
import type { LegacyConfigMigration } from '../data-source/legacy-config-migration'
import { PayloadLegacyConfigSource, type LegacyConfigSource } from '../data-source/legacy-config-source'

/** 迁移运行时依赖。 */
export interface MigrationRuntimeDeps {
  migration: LegacyConfigMigration
  /** 内存来源有效期（毫秒）；超时后需重新预览。缺省 10 分钟。 */
  pendingTtlMs?: number
  now?: () => number
}

/** 迁移运行时。 */
export interface MigrationRuntime {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
  /** 丢弃内存中待确认的来源（不返回值）。 */
  clearPending(): void
}

/** 走迁移运行时的命令集合。 */
export const MIGRATION_COMMANDS: ReadonlySet<string> = new Set<string>([CommandTypes.MIGRATE_LEGACY_CONFIG])

/** 是否为迁移命令。 */
export function isMigrationCommand(type: string): boolean {
  return MIGRATION_COMMANDS.has(type)
}

const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000

/** 创建迁移命令运行时。 */
export function createMigrationRuntime(deps: MigrationRuntimeDeps): MigrationRuntime {
  const now = deps.now ?? (() => Date.now())
  const pendingTtlMs = deps.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS
  let pending: { source: LegacyConfigSource; createdAt: number } | null = null

  const clearPending = (): void => {
    pending = null
  }

  /** 取当前有效的内存来源（过期即丢弃）。 */
  const takePendingSource = (): LegacyConfigSource | null => {
    if (!pending) return null
    if (now() - pending.createdAt > pendingTtlMs) {
      pending = null
      return null
    }
    return pending.source
  }

  async function handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (command.type !== CommandTypes.MIGRATE_LEGACY_CONFIG) {
      return createErrorResponse(command.requestId, command.type, {
        code: 'UNKNOWN_COMMAND',
        message: `非迁移命令: ${command.type}`,
      })
    }
    if (!isMigrateLegacyConfigPayload(command.payload)) {
      return createErrorResponse(command.requestId, command.type, {
        code: 'INVALID_PAYLOAD',
        message: '非法的 MIGRATE_LEGACY_CONFIG 负载（受信载荷/字段白名单；overwrite 需同时 confirm）',
      })
    }

    try {
      if (command.payload.confirm === true) {
        // 确认：优先使用本次携带的载荷，否则复用预览时缓存的来源。
        const source: LegacyConfigSource | null = command.payload.legacy
          ? new PayloadLegacyConfigSource(command.payload.legacy)
          : takePendingSource()
        if (!source) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INVALID_PAYLOAD',
            message: '确认迁移前需先携带 legacy 载荷进行预览',
          })
        }
        try {
          const result: MigrateLegacyConfigResult = {
            mode: 'applied',
            result: await deps.migration.migrate(source, { overwrite: command.payload.overwrite === true }),
          }
          return createResponse(command.requestId, command.type, result)
        } finally {
          // 迁移结束（成功 / 失败）立即清空内存来源，不残留凭据。
          clearPending()
        }
      }

      // 预览：必须携带受信载荷；校验后在内存缓存，供后续确认复用。
      if (!command.payload.legacy) {
        return createErrorResponse(command.requestId, command.type, {
          code: 'INVALID_PAYLOAD',
          message: '预览迁移需要携带受信上下文采集的 legacy 载荷',
        })
      }
      const source = new PayloadLegacyConfigSource(command.payload.legacy)
      const preview = await deps.migration.preview(source)
      pending = { source, createdAt: now() }
      const result: MigrateLegacyConfigResult = { mode: 'preview', preview }
      return createResponse(command.requestId, command.type, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return createErrorResponse(command.requestId, command.type, { code: 'INTERNAL', message: `迁移失败: ${message}` })
    }
  }

  return { handleCommand, clearPending }
}
