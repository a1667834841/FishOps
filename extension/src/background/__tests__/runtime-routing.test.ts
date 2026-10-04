/**
 * 运行时命令路由测试（P8，无 chrome 依赖）。
 *
 * 验证 `message-router` 把 `RUNTIME_STATUS` / `CHAT_RUNTIME_PREPARE` 委托给运行时层：
 * - 未接线时返回结构化 `INTERNAL`（而不是空响应 / UNKNOWN_COMMAND）；
 * - 运行时层返回的结构化失败（host-unavailable / unauthorized / captcha）原样透传，
 *   仍是**合法 envelope**（`ok:true` + `result.ok:false`），Workbench 可据 `result.error.category` 引导；
 * - 分别委托、互不串号。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandTypes,
  createCommand,
  createResponse,
  type CommandEnvelope,
  type ResponseEnvelope,
} from '@fishops/shared'
import { handleCommand, type RouterDeps } from '../message-router'

function baseDeps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    now: () => 1000,
    workerStartedAt: 500,
    incrementPingCount: async () => 1,
    broadcast: () => 0,
    subscribe: (events) => events,
    unsubscribe: (events) => events,
    ...overrides,
  }
}

test('RUNTIME_STATUS / CHAT_RUNTIME_PREPARE：委托给运行时层，不返回 UNKNOWN_COMMAND', async () => {
  const seen: string[] = []
  const deps = baseDeps({
    runtime: {
      handleCommand: async (command: CommandEnvelope): Promise<ResponseEnvelope> => {
        seen.push(command.type)
        return createResponse(command.requestId, command.type, { ok: true })
      },
    },
  })

  const status = await handleCommand(createCommand(CommandTypes.RUNTIME_STATUS, {}), deps)
  assert.equal(status.ok, true)

  const prepare = await handleCommand(
    createCommand(CommandTypes.CHAT_RUNTIME_PREPARE, { purpose: 'chat', force: true }),
    deps,
  )
  assert.equal(prepare.ok, true)

  assert.deepEqual(seen, [CommandTypes.RUNTIME_STATUS, CommandTypes.CHAT_RUNTIME_PREPARE])
})

test('CHAT_RUNTIME_PREPARE：结构化失败类别原样透传，仍是合法 envelope（不是空响应）', async () => {
  const categories = ['host-unavailable', 'unauthorized', 'captcha'] as const
  for (const category of categories) {
    const deps = baseDeps({
      runtime: {
        handleCommand: async (command: CommandEnvelope): Promise<ResponseEnvelope> =>
          createResponse(command.requestId, command.type, {
            ok: false,
            tabId: null,
            tabCreated: false,
            platformReady: false,
            socketReady: false,
            socketStatus: 'connecting',
            userIdReady: false,
            error: { category, message: `失败：${category}` },
          }),
      },
    })

    const response = await handleCommand(
      createCommand(CommandTypes.CHAT_RUNTIME_PREPARE, { purpose: 'chat', force: true }),
      deps,
    )

    assert.equal(response.kind, 'response')
    assert.equal(response.ok, true)
    assert.equal(response.type, CommandTypes.CHAT_RUNTIME_PREPARE)
    const result = response.result as { ok: boolean; error?: { category: string } }
    assert.equal(result.ok, false)
    assert.equal(result.error?.category, category)
  }
})

test('运行时未接线：RUNTIME_STATUS / CHAT_RUNTIME_PREPARE 返回结构化 INTERNAL', async () => {
  const deps = baseDeps()

  const status = await handleCommand(createCommand(CommandTypes.RUNTIME_STATUS, {}), deps)
  assert.equal(status.ok, false)
  assert.equal(status.error?.code, 'INTERNAL')

  const prepare = await handleCommand(createCommand(CommandTypes.CHAT_RUNTIME_PREPARE, {}), deps)
  assert.equal(prepare.ok, false)
  assert.equal(prepare.error?.code, 'INTERNAL')
})
