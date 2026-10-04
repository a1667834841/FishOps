/**
 * 手动配置命令运行时（background 接线，专用写入通道）。
 *
 * 职责：处理用户**手动填写**的 AI / 飞书配置，替代此前误用的 `MIGRATE_LEGACY_CONFIG`
 * （迁移命令语义为「从旧扩展转移」，不应承载手动输入）。
 *
 * 命令：
 * - `AI_CONFIG_SET` / `AI_CONFIG_STATUS`：AI 配置（apiKey / baseUrl / model / timeoutMs）；
 * - `AI_CONFIG_TEST`：AI 配置连通性自测（用已保存凭据调用一次真实文本接口，只回测量指标）；
 * - `FEISHU_CONFIG_SET` / `FEISHU_CONFIG_STATUS`：飞书配置（appId / appSecret / ...）。
 *
 * 安全（硬性）：
 * - 凭据只经现有 {@link ReplyConfigStore} / {@link FeishuConfigStore} 写入专用键；
 * - 响应 / 日志 / 错误**绝不回显任何明文凭据**，只返回 `configured` 与派生的 `provider` / 存在性布尔；
 * - 写入采用 PATCH 语义：负载中出现的字段才更新（含显式空串 = 清除）；
 * - 飞书配置合并后必需字段不完整时拒绝写入，避免落库半成品。
 *
 * 依赖通过 {@link ConfigRuntimeDeps} 注入，Node 测试无需 chrome 环境。
 */
import {
  CommandTypes,
  createErrorResponse,
  createResponse,
  isEmptyPayload,
  isAiConfigSetPayload,
  isAiConfigTestPayload,
  isFeishuConfigSetPayload,
  type CommandEnvelope,
  type ResponseEnvelope,
} from '@fishops/shared'
import {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  type AiChatMessage,
  type AiProviderConfig,
} from '../../../shared/types/reply'
import {
  type AiConfigSetPayload,
  type AiConfigStatus,
  type AiConfigTestErrorCode,
  type AiConfigTestResult,
  type FeishuConfigSetPayload,
  type FeishuConfigStatus,
  extractSafeAiOrigin,
} from '../../../shared/types/config-setup'
import type { FeishuConfig } from '../../../shared/data-source/feishu-types'
import { describeProvider } from '../data-source/legacy-config-migration'
import type { ReplyConfigStore } from '../chat/reply-config'
import type { FeishuConfigStore } from '../data-source/feishu-config-store'
import type { AiChatService, AiErrorCode } from '../chat/ai-service'

/** 配置运行时依赖。 */
export interface ConfigRuntimeDeps {
  /** AI 凭据 / 规则 / 全局配置存储（P6）。 */
  replyConfigStore: ReplyConfigStore
  /** 飞书配置存储（P7）。 */
  feishuConfigStore: FeishuConfigStore
  /**
   * AI 文本补全服务（仅用于 AI_CONFIG_TEST 连通性自测）。
   * 复用 {@link AiChatService} 的现有超时 / 错误归一逻辑，不新增网络路径。
   */
  ai: Pick<AiChatService, 'completeText'>
  /** 当前时间戳（毫秒）；测试可注入以确定性测量探测耗时。 */
  now?: () => number
}

/** 配置运行时。 */
export interface ConfigRuntime {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
}

/** 走配置运行时的命令集合。 */
export const CONFIG_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.AI_CONFIG_SET,
  CommandTypes.AI_CONFIG_STATUS,
  CommandTypes.AI_CONFIG_TEST,
  CommandTypes.FEISHU_CONFIG_SET,
  CommandTypes.FEISHU_CONFIG_STATUS,
])

/** 是否为手动配置命令。 */
export function isConfigCommand(type: string): boolean {
  return CONFIG_COMMANDS.has(type)
}

/** 组装 AI 配置状态（绝不包含 apiKey / baseUrl 明文 / 路径 / query，仅提供安全 origin）。 */
function toAiStatus(config: AiProviderConfig): AiConfigStatus {
  const targetUrl = config.baseUrl && config.baseUrl.trim().length > 0 ? config.baseUrl.trim() : DEFAULT_AI_BASE_URL
  const originResult = extractSafeAiOrigin(targetUrl)

  return {
    configured: config.apiKey.length > 0,
    provider: describeProvider(config.baseUrl),
    model: config.model,
    timeoutMs: config.timeoutMs,
    ...(originResult.ok && originResult.origin ? { permissionOrigin: originResult.origin } : {}),
  }
}

/** 组装飞书配置状态（绝不包含 appSecret / token 明文）。 */
function toFeishuStatus(config: FeishuConfig | null): FeishuConfigStatus {
  return {
    configured: config !== null,
    hasAppId: !!config?.appId,
    hasAppSecret: !!config?.appSecret,
    hasSpreadsheetToken: !!config?.spreadsheetToken,
    hasProductTableId: !!config?.productTableId,
    hasSellerTableId: !!config?.sellerTableId,
  }
}

/** 取 PATCH 字段：未提供时沿用原值，提供时取去空白后的新值。 */
function patchString(current: string, provided: boolean, next: string | undefined): string {
  return provided ? (next ?? '').trim() : current
}

// ---- AI_CONFIG_TEST 连通性自测 ----

/**
 * 固定探测提示词：不含任何聊天 / 商品 / 图片上下文，避免把业务数据外送。
 */
const AI_CONFIG_TEST_MESSAGES: AiChatMessage[] = [
  { role: 'system', content: '你是接口连通性探测助手。' },
  { role: 'user', content: '请仅回复 OK 两个字符，不要输出其它内容。' },
]

/**
 * 探测错误码 → 安全错误码 / 固定文案映射。
 *
 * 刻意不转发底层 `error.message`（可能含响应 body / 详情），避免泄露。
 */
const AI_CONFIG_TEST_ERROR_MAP: Record<AiErrorCode, { code: AiConfigTestErrorCode; message: string }> = {
  NO_API_KEY: { code: 'NO_API_KEY', message: 'AI API Key 未配置' },
  INVALID_REQUEST: { code: 'INVALID_REQUEST', message: '探测请求参数非法' },
  TIMEOUT: { code: 'TIMEOUT', message: 'AI 接口测试超时' },
  HTTP_ERROR: { code: 'HTTP_ERROR', message: 'AI 接口返回错误状态' },
  INVALID_RESPONSE: { code: 'INVALID_RESPONSE', message: 'AI 返回结构非法或无有效回复' },
  NETWORK: { code: 'NETWORK', message: 'AI 网络异常' },
  UNSUPPORTED: { code: 'UNSUPPORTED', message: '当前供应方不支持文本探测' },
}

/** 创建手动配置运行时。 */
export function createConfigRuntime(deps: ConfigRuntimeDeps): ConfigRuntime {
  const now = deps.now ?? (() => Date.now())
  /** 并发保护：同一时刻只允许一次 AI 探测。 */
  let aiTestInFlight = false

  /**
   * AI 配置连通性自测：使用已保存凭据调用一次真实文本接口。
   *
   * 任何失败都归一为结构化 `AiConfigTestFailure`，绝不抛错；
   * 成功只回 `provider` / `model` / `latencyMs` / `hasContent` / `responseChars`。
   */
  async function testAiConfig(): Promise<AiConfigTestResult> {
    let base: AiProviderConfig
    try {
      base = await deps.replyConfigStore.loadAiProvider()
    } catch {
      return {
        ok: false,
        provider: 'custom',
        model: DEFAULT_AI_MODEL,
        latencyMs: 0,
        error: { code: 'CONFIG_ERROR', message: '读取 AI 配置失败' },
      }
    }

    const provider = describeProvider(base.baseUrl)
    const model = base.model.length > 0 ? base.model : DEFAULT_AI_MODEL

    // 防并发：进行中的测试未结束时，直接回结构化错误，不排队、不并发打接口。
    if (aiTestInFlight) {
      return {
        ok: false,
        provider,
        model,
        latencyMs: 0,
        error: { code: 'TEST_IN_PROGRESS', message: '已有 AI 配置测试进行中，请稍后重试' },
      }
    }

    aiTestInFlight = true
    const startedAt = now()
    try {
      const result = await deps.ai.completeText(AI_CONFIG_TEST_MESSAGES)
      const latencyMs = Math.max(0, now() - startedAt)
      if (result.ok) {
        return {
          ok: true,
          provider,
          model: result.model || model,
          latencyMs,
          hasContent: result.content.length > 0,
          responseChars: result.content.length,
        }
      }
      const mapped = AI_CONFIG_TEST_ERROR_MAP[result.error.code]
      return {
        ok: false,
        provider,
        model,
        latencyMs,
        error: {
          code: mapped.code,
          message: mapped.message,
          ...(result.error.status === undefined ? {} : { status: result.error.status }),
        },
      }
    } catch {
      // completeText 约定不抛错，此处兜底，仍不回传原始异常文本。
      return {
        ok: false,
        provider,
        model,
        latencyMs: Math.max(0, now() - startedAt),
        error: { code: 'NETWORK', message: 'AI 接口测试出现异常' },
      }
    } finally {
      aiTestInFlight = false
    }
  }
  /** 保存 AI 配置（PATCH 合并），返回非敏感状态。 */
  async function saveAi(patch: AiConfigSetPayload): Promise<AiConfigStatus> {
    const current = await deps.replyConfigStore.loadAiProvider()
    const apiKey = patchString(current.apiKey, 'apiKey' in patch, patch.apiKey)
    const baseUrl = patchString(current.baseUrl, 'baseUrl' in patch, patch.baseUrl)
    const model = patchString(current.model, 'model' in patch, patch.model)
    const timeoutMs = 'timeoutMs' in patch ? (patch.timeoutMs as number) : current.timeoutMs
    const merged: AiProviderConfig = {
      apiKey,
      // 空 Base URL / 模型回退默认值，避免落库半配置导致调用失败。
      baseUrl: baseUrl.length > 0 ? baseUrl : DEFAULT_AI_BASE_URL,
      model: model.length > 0 ? model : DEFAULT_AI_MODEL,
      timeoutMs,
    }
    await deps.replyConfigStore.saveAiProvider(merged)
    return toAiStatus(merged)
  }

  /**
   * 保存飞书配置（PATCH 合并）。
   * 合并后必需字段（appId / appSecret / spreadsheetToken）不完整时返回 null，
   * 由调用方回结构化错误，绝不写入半成品。
   */
  async function saveFeishu(patch: FeishuConfigSetPayload): Promise<FeishuConfigStatus | null> {
    const current = await deps.feishuConfigStore.load()
    const appId = patchString(current?.appId ?? '', 'appId' in patch, patch.appId)
    const appSecret = patchString(current?.appSecret ?? '', 'appSecret' in patch, patch.appSecret)
    const spreadsheetToken = patchString(
      current?.spreadsheetToken ?? '',
      'spreadsheetToken' in patch,
      patch.spreadsheetToken,
    )
    const productTableId = patchString(current?.productTableId ?? '', 'productTableId' in patch, patch.productTableId)
    const sellerTableId = patchString(current?.sellerTableId ?? '', 'sellerTableId' in patch, patch.sellerTableId)
    if (!appId || !appSecret || !spreadsheetToken) return null

    const config: FeishuConfig = {
      appId,
      appSecret,
      spreadsheetToken,
      productTableId,
      ...(sellerTableId.length > 0 ? { sellerTableId } : {}),
    }
    await deps.feishuConfigStore.save(config)
    return toFeishuStatus(config)
  }

  async function handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope> {
    switch (command.type) {
      case CommandTypes.AI_CONFIG_SET: {
        if (!isAiConfigSetPayload(command.payload)) {
          return invalid(command, '非法的 AI_CONFIG_SET 负载（字段白名单 / 类型 / 长度）')
        }
        try {
          return createResponse(command.requestId, command.type, await saveAi(command.payload))
        } catch {
          // 不回显底层异常文本，避免间接泄露凭据。
          return internalError(command, '保存 AI 配置失败')
        }
      }
      case CommandTypes.AI_CONFIG_STATUS: {
        if (!isEmptyPayload(command.payload)) return invalid(command, 'AI_CONFIG_STATUS 负载必须为空对象')
        try {
          return createResponse(command.requestId, command.type, toAiStatus(await deps.replyConfigStore.loadAiProvider()))
        } catch {
          return internalError(command, '读取 AI 配置失败')
        }
      }
      case CommandTypes.AI_CONFIG_TEST: {
        if (!isAiConfigTestPayload(command.payload)) {
          return invalid(command, 'AI_CONFIG_TEST 负载必须为空对象（不接受任何探测参数）')
        }
        // testAiConfig 内部已保证不抛错，直接返回结构化结果。
        return createResponse(command.requestId, command.type, await testAiConfig())
      }
      case CommandTypes.FEISHU_CONFIG_SET: {
        if (!isFeishuConfigSetPayload(command.payload)) {
          return invalid(command, '非法的 FEISHU_CONFIG_SET 负载（字段白名单 / 类型 / 长度）')
        }
        try {
          const status = await saveFeishu(command.payload)
          if (!status) {
            return invalid(command, '飞书配置不完整：需提供 appId / appSecret / spreadsheetToken')
          }
          return createResponse(command.requestId, command.type, status)
        } catch {
          return internalError(command, '保存飞书配置失败')
        }
      }
      case CommandTypes.FEISHU_CONFIG_STATUS: {
        if (!isEmptyPayload(command.payload)) return invalid(command, 'FEISHU_CONFIG_STATUS 负载必须为空对象')
        try {
          return createResponse(command.requestId, command.type, toFeishuStatus(await deps.feishuConfigStore.load()))
        } catch {
          return internalError(command, '读取飞书配置失败')
        }
      }
      default:
        return createErrorResponse(command.requestId, command.type, {
          code: 'UNKNOWN_COMMAND',
          message: `非配置命令: ${command.type}`,
        })
    }
  }

  return { handleCommand }
}

function invalid(command: CommandEnvelope, message: string): ResponseEnvelope {
  return createErrorResponse(command.requestId, command.type, { code: 'INVALID_PAYLOAD', message })
}

function internalError(command: CommandEnvelope, message: string): ResponseEnvelope {
  return createErrorResponse(command.requestId, command.type, { code: 'INTERNAL', message })
}
