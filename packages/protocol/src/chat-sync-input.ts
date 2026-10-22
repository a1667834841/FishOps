/** 公共同步一次推进一个平台页；cursor 仅由 Host 签发，不接受平台原始 anchor。 */
export type ChatSyncInput = { sessionId?: string; cursor?: string; limit: number; maxWaitMs: number; minIntervalMs?: number; tag?: string }
const bad = (): never => { throw Object.assign(new Error('同步参数无效'), { code: 'BAD_REQUEST' }) }
/** 严格输入规范化；不注册生产方法，也不修改传入对象。 */
export function normalizeChatSyncInput(value: unknown): ChatSyncInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad()
  const v = value as Record<string, unknown>
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) bad()
  if (Reflect.ownKeys(v).length !== Object.keys(v).length || Object.values(Object.getOwnPropertyDescriptors(v)).some(d => !('value' in d))) bad()
  if (Object.keys(v).some(key => !['sessionId', 'cursor', 'limit', 'maxWaitMs', 'minIntervalMs', 'tag'].includes(key))) bad()
  const result: ChatSyncInput = { limit: 20, maxWaitMs: 120000 }
  for (const key of ['sessionId', 'tag'] as const) {
    if (v[key] !== undefined) {
      if (typeof v[key] !== 'string' || !v[key].trim() || v[key].length > 128) bad()
      result[key] = v[key] as string
    }
  }
  // 平台 cid 可带域后缀；在绑定游标与执行范围前统一为本地会话标识。
  if (result.sessionId !== undefined) {
    if (!/^[^@\s]+(?:@goofish)?$/.test(result.sessionId)) bad()
    result.sessionId = result.sessionId.replace(/@goofish$/, '')
  }
  if (v.cursor !== undefined) {
    if (typeof v.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(v.cursor)) bad()
    result.cursor = v.cursor as string
  }
  for (const [key, min, max] of [['limit', 1, 100], ['maxWaitMs', 1, 600000], ['minIntervalMs', 0, 600000]] as const) {
    if (v[key] === undefined) continue
    if (!Number.isSafeInteger(v[key]) || Number(v[key]) < min || Number(v[key]) > max) bad()
    result[key] = Number(v[key])
  }
  return result
}
