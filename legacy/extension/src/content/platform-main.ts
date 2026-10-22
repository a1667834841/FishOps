/**
 * goofish 页面 MAIN world 平台 host 入口（P3）。
 *
 * 由 manifest 以 `world: "MAIN"`、`run_at: "document_start"` 注入 goofish 页面，
 * 组装 `MtopClient` / `AuthService` / `RuntimeHost` 并挂载到页面 window：
 * - background 通过 `chrome.scripting.executeScript({ world: 'MAIN' })` 调用
 *   `window.__FISHOPS_PLATFORM_HOST__`（见 platform/host-client.ts）；
 * - 同时监听 window message（来源、origin 校验 + 方法白名单）供 ISOLATED content 转发。
 *
 * 为什么必须在 MAIN world：MTOP 请求要带上页面 cookie（`credentials: include`）并用
 * `_m_h5_tk` 生成签名，而 MV3 background service worker 无法直接读取页面 `document.cookie`。
 *
 * 安全：本入口不打印、不返回 token / cookie / 完整响应；签名的 token 仅在平台层内部
 * （`getToken`）使用，页面脚本即使拿到 host 对象也无法取得 token。
 */
import { createRateLimiter, DEFAULT_MIN_INTERVAL_MS } from '../platform/rate-limit'
import { createRuntimeHost } from '../platform/runtime-host'
import { installRuntimeHost, type HostWindowLike } from '../platform/host-entry'
import { createAuthService } from '../platform/xianyu/auth'
import { createFetchTransport, createMtopClient } from '../platform/xianyu/mtop-client'
import { observeCaptchaDialog, type CaptchaDialogObject } from '../platform/captcha-detector'

const LOG_PREFIX = '[FishOps:Platform:MAIN]'

/**
 * 组装平台 host 并挂载到给定窗口。
 *
 * 导出为函数以便后续阶段复用或在测试中用 mock window 调用。
 */
export function installPlatformHost(win: HostWindowLike): void {
  const transport = createFetchTransport()
  const client = createMtopClient({
    transport,
    // token 默认由 extractDocumentToken 从 document.cookie 解析，仅在平台层内部用于签名。
    rateLimiter: createRateLimiter({ minIntervalMs: DEFAULT_MIN_INTERVAL_MS }),
  })
  const auth = createAuthService({ transport })
  const host = createRuntimeHost({ client, auth })

  installRuntimeHost(win, host, {
    selfWindow: win,
    // 只接受来自页面自身 origin 的消息；origin 不可用时由 host-entry 退化为 '*'（同页内部消息）。
    allowedOrigins: typeof location === 'undefined' ? undefined : [location.origin],
  })
}

/**
 * 平台页风控检测回调。
 * 这里只广播“出现了验证码”这一事实，不传递 URL、Cookie、Token 或弹窗内部文本。
 * 不关闭弹窗、不拖动滑块，后续由用户完成验证。
 */
export function onCaptchaDialogDetected(dialog: CaptchaDialogObject): void {
  const detail = {
    reason: dialog.reason,
    inIframe: dialog.inIframe,
    text: dialog.text,
  }
  console.warn(LOG_PREFIX, '检测到闲鱼滑块验证弹窗，请人工完成验证', detail)
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('FISHOPS_CAPTCHA_DETECTED', { detail }))
  }
}

/** 安装平台 host 后同步安装风控弹窗监听。 */
export function installPlatformCaptchaObserver(): () => void {
  return observeCaptchaDialog(onCaptchaDialogDetected)
}

installPlatformHost(window as unknown as HostWindowLike)
installPlatformCaptchaObserver()
console.info(LOG_PREFIX, 'platform host 已安装，风控弹窗检测已启用')
