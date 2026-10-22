import { CHAT_NOTICE, createChatNotice } from './chat-notice.ts'
import { createPageChat, type PageChat } from './page-chat.ts'
import { createPageRuntime, type PageRuntime } from './page-runtime.ts'
import type { MtopRequestFn } from './publish-page-executor.ts'
import { createPublishImageUploader } from './publish-image-uploader.ts'

/** MAIN world 注册入口。仅注册初始化函数，加载时不读取账号或发网络请求。 */
type PageScope = typeof globalThis & {
  __fishopsPageChatV1__?: PageChat
  __fishopsPageRuntimeV1__?: PageRuntime
  __fishopsInitPageRuntimeV1__?: (documentId: string) => void
}
const scope = globalThis as PageScope
/** 页面官方 MTOP SDK 的最小读取面；不创建、不替换 SDK，也不手工签名。 */
type MtopScope = typeof globalThis & {
  lib?: { mtop?: { request?: (options: Record<string, unknown>) => Promise<unknown> } }
}
const OFFICIAL_APP_KEY = '34839810'
const UPLOAD_URL = 'https://stream-upload.goofish.com/api/upload.api?floderId=0&appkey=fleamarket&_input_charset=utf-8'
/** MAIN world 的唯一原生 fetch 绑定；业务模块只能经注入函数访问。 */
const pageFetch = (url: string, init?: object): Promise<Response> =>
  globalThis.fetch(url, init as RequestInit | undefined)
/** 页面网络能力集中注入；模块自身不得直接访问全局 fetch。 */
const uploadTransport = async (
  url: string,
  init: { method?: string; body?: unknown; credentials?: 'include'; headers?: Record<string, string> },
): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; blob(): Promise<unknown> }> => {
  return pageFetch(url, init)
}
const mtopRequest: MtopRequestFn = async (api, version, data, headers) => {
  const sdk = (scope as MtopScope).lib?.mtop?.request
  if (typeof sdk !== 'function') throw new Error('官方 MTOP SDK 尚未就绪')
  const response = await sdk({
    api, v: version || '1.0', data: data || {}, type: 'POST',
    appKey: OFFICIAL_APP_KEY, accountSite: 'xianyu', dataType: 'json',
    timeout: 20000, needLoginPC: false, showErrorToast: false,
    needLogin: false, sessionOption: 'AutoLoginOnly', ecode: 0,
    headers: headers || {},
  }) as { ret?: unknown; data?: unknown }
  if (!response || typeof response !== 'object' || !Array.isArray(response.ret) || response.ret.some(value => typeof value !== 'string')) {
    throw new Error('官方 MTOP 响应结构无效')
  }
  return response as { ret: string[]; data?: unknown }
}
/**
 * 页面上传适配：下载源图和上传都必须经页面能力，且使用官方上传域名。
 * 上传响应只取脱敏字段，不把 cookie、请求头或原始错误写回执行器。
 */
const uploadImage = createPublishImageUploader({
  AbortController: globalThis.AbortController,
  fetch: async (url, init) => {
    const response = await uploadTransport(url, init ?? {})
    return response
  },
  readBlob: async blob => {
    const value = blob as Blob
    if (!(value instanceof Blob)) throw new Error('图片下载结果不是 Blob')
    return { size: value.size, type: value.type }
  },
  measure: async blob => new Promise(resolve => {
    const value = blob as Blob
    const image = new Image()
    const objectUrl = URL.createObjectURL(value)
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: { width: number; height: number } | null) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      image.onload = null
      image.onerror = null
      URL.revokeObjectURL(objectUrl)
      resolve(result)
    }
    timer = setTimeout(() => finish(null), 10_000)
    image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : null)
    image.onerror = () => finish(null)
    image.src = objectUrl
  }),
  upload: async blob => {
    const form = new FormData()
    form.append('file', blob as Blob, 'upload.jpg')
    const response = await uploadTransport(UPLOAD_URL, {
      method: 'POST',
      body: form,
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
    if (!response.ok) throw new Error(`上传接口 HTTP ${response.status}`)
    const payload = await response.json() as { success?: unknown; object?: unknown }
    if (payload?.success !== true || !payload.object || typeof payload.object !== 'object') {
      throw new Error('上传接口返回失败')
    }
    return payload.object
  },
})
// document_start 安装被动观察，不等首次 API 调用，避免错过页面自己的连接。
if (location.origin === 'https://www.goofish.com' && !scope.__fishopsPageChatV1__) {
  const notice = createChatNotice(() => window.postMessage(CHAT_NOTICE, location.origin), callback => setTimeout(callback, 100))
  const chat = createPageChat(scope, () => {
    const value = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('unb='))?.slice(4)
    return value && /^[0-9]+$/.test(value) ? value : null
  }, () => notice.signal())
  Object.defineProperty(scope, '__fishopsPageChatV1__', { value: Object.freeze(chat), configurable: false, writable: false })
}
if (!scope.__fishopsInitPageRuntimeV1__) {
  Object.defineProperty(scope, '__fishopsInitPageRuntimeV1__', {
    configurable: false, writable: false,
    value(documentId: string) {
      if (scope.__fishopsPageRuntimeV1__) {
        if (scope.__fishopsPageRuntimeV1__.status().documentId !== documentId) throw new Error('执行文档代次不符')
        return
      }
      if (location.origin !== 'https://www.goofish.com') throw new Error('执行页面无效')
      const readAccountId = () => {
        const value = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('unb='))?.slice(4)
        return value && /^[0-9]+$/.test(value) ? value : null
      }
      const runtime = createPageRuntime({
        scope: scope as unknown as Record<string, unknown>, documentId,
        readAccountId,
        readCookie: () => document.cookie,
        fetch: (url, init) => pageFetch(url, init),
        now: () => Date.now(),
        chatSyncPage: (params, accountId, mid) => {
          if (!scope.__fishopsPageChatV1__) return Promise.reject(new Error('页面聊天同步尚不可用'))
          return scope.__fishopsPageChatV1__.queryPage(params, accountId, mid)
        },
        chatSend: (params, accountId, mid) => {
          if (!scope.__fishopsPageChatV1__) return Promise.reject(new Error('页面聊天发送尚不可用'))
          return scope.__fishopsPageChatV1__.chatSend(params, accountId, mid)
        },
        // MAIN world 无扩展 storage 权限；可信会话通道接入前保留文档内存，
        // 页面重载必须重新 prepare，不能静默迁移授权。
        publish: { mtopRequest, uploadImage },
      })
      Object.freeze(runtime)
      Object.defineProperty(scope, '__fishopsPageRuntimeV1__', { value: runtime, configurable: false, writable: false })
    },
  })
}
