/**
 * M3 缺口恢复协议基础：缺口 occurrence 与覆盖证书的严格校验、比较与清除资格判断。
 *
 * 本模块**只是结构校验与比较基础**，尚无生产接入：
 * - 未注册任何生产路由，不读写 state，不发送 SSE，不删除任何标记。
 * - 证书里的 `reliableEnd` / `committed` / `confirmations` 是各端**自称的布尔事实**，
 *   本模块无法验证其真实性，因此**证书本身不构成生产清除授权**。
 * - 真正清除必须在各端比较同一账号/来源/代次/范围后再执行；任一端无法确认即视为未恢复。
 * - `scope: 'unknown'` 只是“尚不知道范围”，不是证明；在实现显式全账号覆盖证据前，
 *   未知范围证书不能作为通配全覆盖证书，因此当前永远不会据此清除缺口。
 * 设计依据见 docs/m3-gap-recovery-next.md 与 docs/m3-sync-contract.md 第 8 节。
 */

/** 缺口来源；与 chat-wire 的 chat-gap 原因保持一致。 */
export type GapReason = 'PAGE_GAP' | 'OUTBOX_CAPACITY'

/**
 * 缺口覆盖范围；判别联合保证范围字段互斥。
 * - `unknown`：账号全局但具体会话/来源未知，只有完整枚举会话并覆盖全部相关历史才能证明。
 * - `account`：账号级范围（已枚举会话集合）。
 * - `session`：单个会话范围，必须给出 sessionId。
 */
export type GapScope =
  | { scope: 'unknown' }
  | { scope: 'account' }
  | { scope: 'session'; sessionId: string }

/**
 * 缺口 occurrence：账号、来源、稳定 occurrenceId、代次和范围。
 * 同一 occurrence 重投不推进代次；新 occurrence 即使原因相同也必须推进代次。
 */
export type GapOccurrence = {
  accountId: string
  reason: GapReason
  occurrenceId: string
  generation: number
  scope: GapScope
}

/** 需要确认的端；清除缺口时全部必需端都要确认。 */
export type GapEndpoint = 'host' | 'outbox' | 'page'

/** 全部可用端，顺序仅用于展示；确认数组按集合语义比较，不要求顺序。 */
export const GAP_ENDPOINTS: readonly GapEndpoint[] = ['host', 'outbox', 'page']

/**
 * 覆盖证书：绑定缺口快照（账号/来源/代次/范围）、同步 runId、覆盖证据与各端确认。
 * 字段语义：`unsupported` 必须为 0；`reliableEnd` 表示已分页到可靠末页；
 * `committed` 表示覆盖页已持久提交；`confirmations` 是各端自称已确认的端集合。
 * `occurrenceId` 与缺口 occurrence 绑定：同代次但不同 occurrence 的证书不得清除。
 */
export type GapCoverageCertificate = {
  runId: string
  accountId: string
  reason: GapReason
  occurrenceId: string
  generation: number
  scope: GapScope
  unsupported: number
  reliableEnd: boolean
  committed: boolean
  confirmations: GapEndpoint[]
}

/** 清除被拒绝的原因；为空表示可以比较后清除。 */
export type GapClearReject =
  | 'NO_GAP'
  | 'GAP_INVALID'
  | 'CERTIFICATE_INVALID'
  | 'ACCOUNT_MISMATCH'
  | 'REASON_MISMATCH'
  | 'OCCURRENCE_MISMATCH'
  | 'GENERATION_MISMATCH'
  | 'SCOPE_INSUFFICIENT'
  | 'UNKNOWN_SCOPE_UNPROVEN'
  | 'UNSUPPORTED_PRESENT'
  | 'RELIABLE_END_REQUIRED'
  | 'COMMIT_REQUIRED'
  | 'CONFIRMATION_MISSING'

/** 清除判定结果；`reject` 为空时 `clear` 才为 true。 */
export type GapClearDecision = { clear: boolean; reject: readonly GapClearReject[] }

// 严格 UUID 分组，避免 36 个连字符之类的伪 runId 通过。
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 输入非法时失败关闭；不返回部分结果，也不静默修正。 */
function gapInvalid(message: string): never {
  throw Object.assign(new Error(message), { code: 'BAD_REQUEST' })
}

/** 只接受无隐藏字段、无访问器的纯数据对象，避免验证期间运行调用者代码。 */
function record(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(value).length === fields.length && fields.every(key => {
    const descriptor = descriptors[key]
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
  })
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}

function generation(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

/** 缺口来源必须来自固定集合，不接受自造原因。 */
export function isGapReason(value: unknown): value is GapReason {
  return value === 'PAGE_GAP' || value === 'OUTBOX_CAPACITY'
}

/** 严格校验范围判别联合；`account`/`unknown` 不允许携带 sessionId。 */
export function isGapScope(value: unknown): value is GapScope {
  try {
    if (!value || typeof value !== 'object') return false
    const scope = Object.getOwnPropertyDescriptor(value, 'scope')?.value
    if (scope === 'session') return record(value, ['scope', 'sessionId']) && id(value.sessionId)
    if (scope === 'unknown' || scope === 'account') return record(value, ['scope'])
    return false
  } catch {
    return false
  }
}

/** 严格校验缺口 occurrence；未知字段、访问器与非法代次一律拒绝。 */
export function isGapOccurrence(value: unknown): value is GapOccurrence {
  try {
    return record(value, ['accountId', 'reason', 'occurrenceId', 'generation', 'scope']) &&
      id(value.accountId) && isGapReason(value.reason) && id(value.occurrenceId) &&
      generation(value.generation) && isGapScope(value.scope)
  } catch {
    return false
  }
}

/** 确认端必须是固定集合成员，不接受未知端或任意字符串。 */
export function isGapEndpoint(value: unknown): value is GapEndpoint {
  return value === 'host' || value === 'outbox' || value === 'page'
}

function endpointList(value: unknown): value is GapEndpoint[] {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) return false
  const seen = new Set<GapEndpoint>()
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || !isGapEndpoint(descriptor.value) || seen.has(descriptor.value)) return false
    seen.add(descriptor.value)
  }
  return true
}

/** 严格校验覆盖证书结构；unsupported 允许任意非负整数，是否可清除由 evaluateGapClear 判定。 */
export function isGapCoverageCertificate(value: unknown): value is GapCoverageCertificate {
  try {
    return record(value, ['runId', 'accountId', 'reason', 'occurrenceId', 'generation', 'scope', 'unsupported', 'reliableEnd', 'committed', 'confirmations']) &&
      typeof value.runId === 'string' && RUN_ID_PATTERN.test(value.runId) &&
      id(value.accountId) && isGapReason(value.reason) && id(value.occurrenceId) && generation(value.generation) && isGapScope(value.scope) &&
      generation(value.unsupported) && typeof value.reliableEnd === 'boolean' && typeof value.committed === 'boolean' &&
      endpointList(value.confirmations)
  } catch {
    return false
  }
}

/** occurrence 身份三元组；账号、来源、occurrenceId 全等才算同一次丢失。 */
export function sameGapOccurrenceIdentity(left: GapOccurrence, right: GapOccurrence): boolean {
  return left.accountId === right.accountId && left.reason === right.reason && left.occurrenceId === right.occurrenceId
}

function cloneScope(scope: GapScope): GapScope {
  return scope.scope === 'session' ? { scope: 'session', sessionId: scope.sessionId } : { scope: scope.scope }
}

function cloneOccurrence(occurrence: GapOccurrence): GapOccurrence {
  return {
    accountId: occurrence.accountId,
    reason: occurrence.reason,
    occurrenceId: occurrence.occurrenceId,
    generation: occurrence.generation,
    scope: cloneScope(occurrence.scope),
  }
}

/** 推进结果；`advanced` 为 false 表示同 occurrence 重投，代次保持不变。 */
export type GapAdvance = { occurrence: GapOccurrence; advanced: boolean }

/**
 * 纯函数推进代次：
 * - 无当前记录时以 incoming 作为基线。
 * - 同 occurrence（账号/来源/occurrenceId 全等）重投不推进，保留已持久代次。
 * - 同一账号同一来源的新 occurrence 即使原因相同也推进：取 `max(current+1, incoming)`，不倒退。
 * - 不同账号或不同来源是独立基线，直接采用 incoming。
 * 输入必须是合法 occurrence；当前代次已达安全整数上限时无法推进，按失败关闭拒绝。
 */
export function advanceGapOccurrence(current: GapOccurrence | null, incoming: GapOccurrence): GapAdvance {
  if (current !== null && !isGapOccurrence(current)) gapInvalid('当前缺口 occurrence 无效')
  if (!isGapOccurrence(incoming)) gapInvalid('新缺口 occurrence 无效')
  if (current === null) return { occurrence: cloneOccurrence(incoming), advanced: false }
  if (sameGapOccurrenceIdentity(current, incoming)) return { occurrence: cloneOccurrence(current), advanced: false }
  const sameLine = current.accountId === incoming.accountId && current.reason === incoming.reason
  // current+1 会溢出安全整数，无法表达新代次，拒绝而不是产生不精确数。
  if (sameLine && current.generation === Number.MAX_SAFE_INTEGER) gapInvalid('缺口代次已达上限，无法推进')
  const nextGeneration = sameLine ? Math.max(current.generation + 1, incoming.generation) : incoming.generation
  return { occurrence: { ...cloneOccurrence(incoming), generation: nextGeneration }, advanced: true }
}

/**
 * 清除缺口必须确认的全部端；中间持久端 outbox 不能因来源是页面而省略。
 * 当前固定为 Host、outbox、page 三点全确认。
 */
export function requiredGapConfirmations(): GapEndpoint[] {
  return [...GAP_ENDPOINTS]
}

/**
 * 纯函数判断证书范围是否覆盖缺口范围：
 * - `unknown` 证书不覆盖任何范围：未知范围不是证明，在实现显式全账号覆盖证据前一律拒绝。
 * - `account` 证书覆盖 `account` 与 `session`，但不能清除未知范围缺口。
 * - `session` 证书只覆盖同一会话；未知范围和账号范围都不接受。
 */
export function gapScopeCovers(certificateScope: GapScope, gapScope: GapScope): boolean {
  if (certificateScope.scope === 'unknown') return false
  if (certificateScope.scope === 'account') return gapScope.scope === 'account' || gapScope.scope === 'session'
  return gapScope.scope === 'session' && gapScope.sessionId === certificateScope.sessionId
}

function missingConfirmations(certificate: GapCoverageCertificate): boolean {
  return requiredGapConfirmations().some(endpoint => !certificate.confirmations.includes(endpoint))
}

/**
 * 比较后清除资格判定；返回全部被拒原因，便于诊断，不短路。
 *
 * 只有同时满足才允许清除：账号、来源、occurrenceId、代次与当前缺口一致；证书范围充分覆盖缺口范围；
 * unsupported=0；reliableEnd 与 committed 均为真；所有必需端已确认。
 * 旧代次证书（generation 小于当前）或未来代次都不匹配，因此旧证书不能清除新缺口。
 * 同代次但不同 occurrenceId 的证书同样拒绝，避免同代次新缺口被误清。
 */
export function evaluateGapClear(current: unknown, certificate: unknown): GapClearDecision {
  const reject: GapClearReject[] = []
  if (current === null || current === undefined) return { clear: false, reject: ['NO_GAP'] }
  if (!isGapOccurrence(current)) return { clear: false, reject: ['GAP_INVALID'] }
  if (!isGapCoverageCertificate(certificate)) return { clear: false, reject: ['CERTIFICATE_INVALID'] }

  if (certificate.accountId !== current.accountId) reject.push('ACCOUNT_MISMATCH')
  if (certificate.reason !== current.reason) reject.push('REASON_MISMATCH')
  if (certificate.occurrenceId !== current.occurrenceId) reject.push('OCCURRENCE_MISMATCH')
  if (certificate.generation !== current.generation) reject.push('GENERATION_MISMATCH')
  if (certificate.scope.scope === 'unknown') reject.push('UNKNOWN_SCOPE_UNPROVEN')
  else if (!gapScopeCovers(certificate.scope, current.scope)) reject.push('SCOPE_INSUFFICIENT')
  if (certificate.unsupported !== 0) reject.push('UNSUPPORTED_PRESENT')
  if (!certificate.reliableEnd) reject.push('RELIABLE_END_REQUIRED')
  if (!certificate.committed) reject.push('COMMIT_REQUIRED')
  if (missingConfirmations(certificate)) reject.push('CONFIRMATION_MISSING')

  return { clear: reject.length === 0, reject }
}
