import { normalizeWriteParams, writeFingerprint, type ChatSendParams, type ChatSendResult } from '../../../packages/protocol/src/write.ts'
import type { HostDatabase } from './database.ts'
import type { RunInput } from './scheduler.ts'

export type ChatWriteServiceDeps = { db: HostDatabase; accountId(): string | null; schedule<T>(input: RunInput, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>; executeSend(params: { sessionId: string; receiverId: string; text: string; accountId: string }): Promise<ChatSendResult> }
const fail = (code: string, phase: 'queue' | 'write' = 'write') => Object.assign(new Error('聊天发送未完成'), { code, phase, retryable: false })
/** 统一 chat.send 编排；attempting/unknown 永不自动重发。 */
export function createChatWriteService(deps: ChatWriteServiceDeps) {
  return {
    async send(raw: unknown, signal?: AbortSignal): Promise<ChatSendResult> {
      const params = normalizeWriteParams('chat.send', raw)
      const accountId = deps.accountId(); if (!accountId) throw fail('LOGIN_REQUIRED')
      const fp = writeFingerprint(accountId, 'chat.send', params)
      const claim = deps.db.claimOperation(accountId, 'chat.send', params.idempotencyKey, fp.fingerprint)
      const existing = claim.record
      if (existing.status === 'succeeded') return existing.resultJson as ChatSendResult
      if (!claim.claimed) throw fail('RESULT_UNKNOWN')
      // 排队前取消时尚未派发平台请求，必须显式终结 claim，避免同名幂等键永久卡在 dispatching。
      if (signal?.aborted) {
        deps.db.finishOperation(accountId, 'chat.send', params.idempotencyKey, 'failed', undefined, 'CANCELLED')
        throw fail('CANCELLED', 'queue')
      }
      let dispatched = false
      try {
        const result = await deps.schedule({ accountId, category: 'chatSend', maxWaitMs: params.maxWaitMs ?? 120000, minIntervalMs: params.minIntervalMs }, async () => {
          if (signal?.aborted) throw fail('CANCELLED', 'queue')
          if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED')
          dispatched = true
          return deps.executeSend({ sessionId: params.sessionId, receiverId: params.receiverId, text: params.text, accountId })
        }, signal)
        if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED')
        deps.db.finishOperation(accountId, 'chat.send', params.idempotencyKey, 'succeeded', result)
        return result
      } catch (error) {
        // native 桥把扩展侧错误放在 apiError 上；只读 code 会把真实原因塌缩成 INTERNAL。
        const code = (error as { code?: string }).code ?? (error as { apiError?: { code?: string } }).apiError?.code
        const phase = (error as { phase?: string }).phase ?? (error as { apiError?: { phase?: string } }).apiError?.phase
        // 只有能证明"未派发或平台明确拒绝"的错误才记 failed；无码/INTERNAL 等不明错误一律视为 unknown，
        // 否则调用方换键重试会造成重复发送（真实 E2E 曾因此重复发出消息）。
        const definite = code === 'PLATFORM_REJECTED' || (!dispatched || phase === 'queue' || phase === 'read') && ['CANCELLED', 'LOGIN_REQUIRED', 'PLATFORM_REJECTED', 'VALIDATION_FAILED', 'INVALID_PARAMS', 'RATE_LIMITED', 'NOT_FOUND', 'PAGE_NOT_READY'].includes(code ?? '') ||
          (code === 'RISK_BLOCKED' && (!dispatched || phase === 'read' || phase === 'queue'))
        const unknown = !definite
        deps.db.finishOperation(accountId, 'chat.send', params.idempotencyKey, unknown ? 'unknown' : 'failed', undefined, code ?? 'INTERNAL')
        // 风控与登录失效是 Agent 必须看到的停止信号，原样透传；其余明确失败归为 PLATFORM_REJECTED。
        const stop = code === 'RISK_BLOCKED' || code === 'LOGIN_REQUIRED'
        throw fail(unknown && !stop ? 'RESULT_UNKNOWN' : code === 'CANCELLED' ? 'CANCELLED' : stop ? code! : 'PLATFORM_REJECTED', code === 'CANCELLED' ? 'queue' : 'write')
      }
    },
  }
}
