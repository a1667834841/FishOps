/**
 * 闲鱼/阿里风控滑块弹窗检测器。
 *
 * 只负责识别和通知，不拖动滑块、不关闭弹窗、不尝试绕过验证。
 * 跨域 iframe 无法读取内部 DOM 时，只返回 iframe 元素作为外层对象。
 */

export interface CaptchaDialogObject {
  /** 检测到的弹窗容器；跨域 iframe 场景下为 iframe 元素本身。 */
  dialog: Element
  /** 可访问时返回滑块手柄。 */
  slider: Element | null
  /** 可访问时返回滑块轨道。 */
  track: Element | null
  /** 可访问时返回关闭按钮；检测器不会主动点击。 */
  closeButton: Element | null
  /** 是否位于 iframe 内。 */
  inIframe: boolean
  /** 跨域或同源 iframe 元素。 */
  iframe: HTMLIFrameElement | null
  /** 脱敏后的检测原因，不包含 URL、Cookie 或响应内容。 */
  reason: 'text' | 'known-selector' | 'cross-origin-iframe'
  /** 匹配到的固定文案类别。 */
  text: string
  /** 读取坐标，便于 UI 诊断。不会执行任何交互。 */
  getRect(): {
    dialogRect: DOMRect | null
    sliderRect: DOMRect | null
    trackRect: DOMRect | null
  }
}

export interface CaptchaDetectorOptions {
  /** 弹窗出现后是否只回调一次，默认 false。 */
  once?: boolean
  /** iframe 等异步加载场景的轮询间隔，默认 800ms。 */
  pollInterval?: number
  /** 自定义日志函数，测试或页面接入时可注入。 */
  onLog?: (message: string, detail?: unknown) => void
}

const CAPTCHA_TEXTS = [
  '请拖动下方滑块完成验证',
  '通过验证以确保正常访问',
  '请按住滑块，拖动到最右边',
] as const

const CAPTCHA_SELECTORS = [
  '#baxia-dialog',
  '.baxia-dialog',
  '[id*="baxia-dialog"]',
  '#J_MIDDLEVERIFY',
  '#nc_1_wrapper',
  '.nc-container',
  '.nc_scale',
  '.btn_slide',
  '[role="slider"]',
] as const

const SLIDER_SELECTORS = [
  '#nc_1_n1z',
  '.btn_slide',
  'span[id*="_n1z"]',
  '.nc_iconfont.btn_slide',
  '[role="slider"]',
] as const

const TRACK_SELECTORS = ['.nc_scale', '.scale_text', '#nc_1__scale_text'] as const

function isVisible(element: Element): boolean {
  const view = element.ownerDocument?.defaultView
  if (!view) return true
  const style = view.getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
}

function firstVisible(root: Document | Element, selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    const element = root.querySelector(selector)
    if (element && isVisible(element)) return element
  }
  return null
}

function hasCaptchaText(doc: Document): boolean {
  const text = doc.body?.innerText ?? ''
  return CAPTCHA_TEXTS.some((item) => text.includes(item))
}

function captchaText(doc: Document): string {
  const text = doc.body?.innerText ?? ''
  return CAPTCHA_TEXTS.find((item) => text.includes(item)) ?? '滑块验证'
}

function findDialog(slider: Element | null, doc: Document): Element | null {
  if (!slider) return null
  let current: Element | null = slider
  for (let depth = 0; current && depth < 8; depth += 1) {
    const view: Window | null = current.ownerDocument.defaultView
    const style = view?.getComputedStyle(current)
    const className = typeof current.className === 'string' ? current.className : ''
    if (
      current.getAttribute('role') === 'dialog' ||
      current.id.toLowerCase().includes('dialog') ||
      className.toLowerCase().includes('dialog') ||
      className.toLowerCase().includes('modal') ||
      style?.position === 'fixed' ||
      Number.parseInt(style?.zIndex ?? '0', 10) >= 999
    ) {
      return current
    }
    current = current.parentElement
  }
  return doc.querySelector('[role="dialog"]') ?? slider.parentElement
}

function findCloseButton(dialog: Element | null): Element | null {
  if (!dialog) return null
  const direct = dialog.querySelector('button[aria-label="Close"], .close, [class*="close"], [class*="Close"]')
  if (direct) return direct
  return (
    Array.from(dialog.querySelectorAll('button, span, i, a')).find((element) => {
      const value = element.textContent?.trim()
      return value === '×' || value === 'X' || value === '✕'
    }) ?? null
  )
}

function makeObject(
  doc: Document,
  slider: Element | null,
  track: Element | null,
  dialog: Element,
  iframe: HTMLIFrameElement | null,
  reason: CaptchaDialogObject['reason'],
): CaptchaDialogObject {
  return {
    dialog,
    slider,
    track,
    closeButton: findCloseButton(dialog),
    inIframe: iframe !== null,
    iframe,
    reason,
    text: captchaText(doc),
    getRect: () => ({
      dialogRect: typeof dialog.getBoundingClientRect === 'function' ? dialog.getBoundingClientRect() : null,
      sliderRect: slider?.getBoundingClientRect?.() ?? null,
      trackRect: track?.getBoundingClientRect?.() ?? null,
    }),
  }
}

function inspectDocument(doc: Document, iframe: HTMLIFrameElement | null): CaptchaDialogObject | null {
  if (!doc.body) return null
  const slider = firstVisible(doc, SLIDER_SELECTORS)
  const track = firstVisible(doc, TRACK_SELECTORS) ?? slider?.parentElement ?? null
  const known = firstVisible(doc, CAPTCHA_SELECTORS)
  const textFound = hasCaptchaText(doc)
  if (!slider && !known && !textFound) return null

  const dialog = known && !known.matches('.nc_scale, .btn_slide, [role="slider"]')
    ? known
    : findDialog(slider ?? known, doc)
  if (!dialog) return null
  return makeObject(doc, slider, track, dialog, iframe, textFound ? 'text' : 'known-selector')
}

/** 检测当前文档和可访问 iframe 中的滑块验证弹窗。 */
export function detectCaptchaDialog(root: Document = document): CaptchaDialogObject | null {
  const main = inspectDocument(root, null)
  if (main) return main

  for (const iframe of Array.from(root.querySelectorAll('iframe'))) {
    try {
      const child = iframe.contentDocument
      if (child) {
        const result = inspectDocument(child, iframe)
        if (result) return result
      }
    } catch {
      // 跨域 iframe 不能读取内部 DOM，只在 src/属性具备风控特征时返回外层 iframe。
      const source = iframe.getAttribute('src')?.toLowerCase() ?? ''
      const id = iframe.id.toLowerCase()
      if (/punish|captcha|baxia|_____tmd_____/.test(source) || /punish|captcha|baxia/.test(id)) {
        return makeObject(root, null, null, iframe, iframe, 'cross-origin-iframe')
      }
    }
  }
  return null
}

/**
 * 持续监听弹窗出现/消失。
 * 回调接收完整对象；监听器不会点击 closeButton，也不会模拟滑块操作。
 */
export function observeCaptchaDialog(
  callback: (dialog: CaptchaDialogObject) => void,
  options: CaptchaDetectorOptions = {},
): () => void {
  const once = options.once ?? false
  const pollInterval = options.pollInterval ?? 800
  const log = options.onLog ?? ((message, detail) => console.warn(message, detail))
  let lastDialog: Element | null = null
  let stopped = false

  const check = (): void => {
    if (stopped) return
    const found = detectCaptchaDialog()
    if (!found) {
      lastDialog = null
      return
    }
    if (found.dialog === lastDialog && !once) return
    lastDialog = found.dialog
    log('[FishOps:Platform:MAIN] 检测到闲鱼滑块验证弹窗', {
      reason: found.reason,
      inIframe: found.inIframe,
      text: found.text,
    })
    try {
      callback(found)
    } catch (error) {
      log('[FishOps:Platform:MAIN] 风控弹窗回调执行失败', {
        name: error instanceof Error ? error.name : 'unknown',
      })
    }
    if (once) stop()
  }

  const observer = new MutationObserver(check)
  observer.observe(document.documentElement ?? document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
  })
  const timer = window.setInterval(check, pollInterval)
  check()

  function stop(): void {
    if (stopped) return
    stopped = true
    observer.disconnect()
    window.clearInterval(timer)
  }

  return stop
}
