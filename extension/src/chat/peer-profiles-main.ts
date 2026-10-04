/**
 * 会话对方头像补齐 —— MAIN world 只读读取模块。
 *
 * 该模块只导出一个**自包含**函数 {@link fetchPeerProfileInPage}，由 background 通过
 * `chrome.scripting.executeScript({ world: 'MAIN', func })` 注入 goofish 页面执行。
 * 它在页面上下文复用官方 mtop SDK（`window.lib.mtop.request`，与项目
 * `background/direct-publish-page.ts` 同一条官方 SDK 路径），只读调用两条已实测接口：
 * - `mtop.taobao.idlemessage.pc.session.sync`（v3.0）
 * - `mtop.taobao.idlemessage.pc.user.query`（v4.0）
 *
 * 口径依据（ego-browser 只读捕获页面自身请求 + SDK 实测，未导出个人数据）：
 * - 普通单聊会话 `sessionTypes` 为 `[1]`；`[3]` 只会返回系统会话（伪 UID，不可用）；
 * - `pc.user.query` v4.0 请求 `{ type:0, sessionType:1, sessionId, isOwner:false }` 返回**对方**
 *   `data.userInfo.{logo,fishNick,nick}`（`isOwner:false` 在“自己是 owner / guest”两种角色下均实测为对方）。
 *
 * 硬约束：
 * 1. **完全自包含**：函数体不得引用本模块作用域的任何变量 / 常量 / 辅助函数；
 *    入参只通过可序列化对象传入，返回值必须是可 structured clone 的普通对象；
 * 2. **只读**：不发送消息、不标记已读、不修改任何平台状态；
 * 3. **绝不输出凭据 / token / cookie / 聊天正文**：只返回 mtop payload（`ret` / `data`），
 *    错误只返回粗粒度 code，绝不回传原始响应或异常原文；
 * 4. 不直接网络请求、不手工签名：一律走页面官方 SDK。
 */
import type { PeerProfileApi, PeerProfileRequest } from './peer-profiles'

/** 注入调用结果：成功带 mtop payload（含 ret / data），失败只带粗粒度 code。 */
export type PeerProfilePageResult =
  | { ok: true; payload: unknown }
  | { ok: false; code: 'SDK_MISSING' | 'UNKNOWN_API' | 'MTOP_REJECTED' | 'EMPTY_RESPONSE' | 'TIMEOUT' }

/**
 * 在页面 MAIN world 只读调用一次头像相关的 mtop 接口。
 *
 * 该函数会被 `chrome.scripting.executeScript` **序列化后注入**，
 * 因此**禁止引用模块外的任何变量**（只允许自身参数、局部变量与页面全局）。
 */
export async function fetchPeerProfileInPage(request: PeerProfileRequest): Promise<PeerProfilePageResult> {
  // api → { api, v } 映射必须内联：注入函数无法引用模块级常量。
  const configs: Record<string, { api: string; v: string }> = {
    'session.sync': { api: 'mtop.taobao.idlemessage.pc.session.sync', v: '3.0' },
    'user.query': { api: 'mtop.taobao.idlemessage.pc.user.query', v: '4.0' },
  }

  const globalObject = globalThis as {
    lib?: { mtop?: { request?: (options: unknown) => Promise<unknown> } }
  }
  const lib = globalObject.lib
  const mtop = lib?.mtop
  if (!mtop || typeof mtop.request !== 'function') {
    return { ok: false, code: 'SDK_MISSING' }
  }

  const requestFn = mtop.request
  const api = request && typeof request.api === 'string' ? request.api : ''
  const config = configs[api]
  if (!config) return { ok: false, code: 'UNKNOWN_API' }

  const data = request && typeof request.data === 'object' && request.data !== null ? request.data : {}

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const payload = await Promise.race([
      requestFn.call(mtop, {
        api: config.api,
        v: config.v,
        data,
        type: 'POST',
        dataType: 'json',
        appKey: '34839810',
        accountSite: 'xianyu',
        timeout: 5000,
        needLogin: true,
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('PEER_PROFILE_TIMEOUT')), 6000)
      }),
    ])
    if (payload === undefined || payload === null) return { ok: false, code: 'EMPTY_RESPONSE' }
    return { ok: true, payload }
  } catch (error) {
    // 绝不回传异常原文（可能含响应体）；只给粗粒度 code。
    return { ok: false, code: error instanceof Error && error.message === 'PEER_PROFILE_TIMEOUT' ? 'TIMEOUT' : 'MTOP_REJECTED' }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

/** 类型收窄辅助（供接线方判断注入结果）。 */
export function isPeerProfilePageResult(value: unknown): value is PeerProfilePageResult {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { ok?: unknown }
  return record.ok === true || record.ok === false
}

/** 公开接口名到 mtop 接口的映射（供接线方与测试使用）。 */
export const PEER_PROFILE_API_MAP: Record<PeerProfileApi, { api: string; v: string }> = {
  'session.sync': { api: 'mtop.taobao.idlemessage.pc.session.sync', v: '3.0' },
  'user.query': { api: 'mtop.taobao.idlemessage.pc.user.query', v: '4.0' },
}
