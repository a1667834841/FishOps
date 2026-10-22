/**
 * chrome.storage.session 的极简封装。
 *
 * background service worker 会被浏览器随时回收，内存变量无法跨回收保存；
 * 因此凡是需要跨回收保留的状态都写这里（同一浏览器会话内有效）。
 * 注意：storage.session 默认仅扩展上下文（TRUSTED_CONTEXTS）可读，content script 不可见。
 */

/** 读取键值，键不存在时返回 fallback。 */
export async function readState<T>(key: string, fallback: T): Promise<T> {
  const stored = await chrome.storage.session.get(key)
  const value = stored[key]
  return value === undefined ? fallback : (value as T)
}

/** 写入键值。 */
export async function writeState<T>(key: string, value: T): Promise<void> {
  await chrome.storage.session.set({ [key]: value })
}

/**
 * 计数自增：读取 → 加 delta → 写回，返回新值。
 * P1 单页面场景下并发极低，未做加锁；后续如需强一致可改为串行队列。
 */
export async function incrementCounter(key: string, delta = 1): Promise<number> {
  const current = await readState<number>(key, 0)
  const next = current + delta
  await writeState(key, next)
  return next
}
