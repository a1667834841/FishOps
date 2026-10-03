/**
 * 后台命令错误的统一建模与中文文案（纯函数，无 Vue / DOM 依赖）。
 *
 * 为什么不直接用 `RuntimeClient.call` 抛出的 `BridgeError`：
 * 它只保留 `code`，会丢掉 `PLATFORM_ERROR` 附带的 `category`（未登录 / 验证码 / 平台不可用等），
 * 而采集、聊天发送都需要据此给出明确的提示。因此 Workbench 的 Bridge 适配层
 * 会保留完整的协议错误，转换成这里的 {@link CommandError}。
 */

/** 平台错误类别（与 shared 协议的 PlatformErrorCategory 同构）。 */
export type PlatformCategory =
  | 'host-unavailable'
  | 'unauthorized'
  | 'token-expired'
  | 'captcha'
  | 'network'
  | 'api'
  | 'unknown'

/** 携带协议错误码与平台类别的异常。 */
export class CommandError extends Error {
  readonly code: string
  readonly category: PlatformCategory | undefined
  readonly retCode: string | undefined

  constructor(code: string, message: string, category?: string, retCode?: string) {
    super(message)
    this.name = 'CommandError'
    this.code = code
    this.category = isPlatformCategory(category) ? category : undefined
    this.retCode = retCode
  }
}

const CATEGORIES: ReadonlySet<string> = new Set([
  'host-unavailable',
  'unauthorized',
  'token-expired',
  'captcha',
  'network',
  'api',
  'unknown',
])

function isPlatformCategory(value: unknown): value is PlatformCategory {
  return typeof value === 'string' && CATEGORIES.has(value)
}

/** 展示用的错误视图。 */
export interface ErrorView {
  /** 一句话结论。 */
  title: string
  /** 下一步该怎么做；没有可靠建议时为空。 */
  hint: string
  /** 脱敏、截断后的原始说明（可能为空）。 */
  detail: string
  /** 用于决定颜色 / 是否需要人工处理。 */
  kind: 'platform' | 'auth' | 'captcha' | 'timeout' | 'unavailable' | 'validation' | 'unknown'
  /** 协议错误码或平台类别，便于排查。 */
  code: string
}

const CATEGORY_TEXT: Record<PlatformCategory, Pick<ErrorView, 'title' | 'hint' | 'kind'>> = {
  'host-unavailable': {
    title: '闲鱼页面未就绪，平台不可用',
    hint: '请先在浏览器中打开并登录 https://www.goofish.com，保持该页面打开后重试。',
    kind: 'unavailable',
  },
  unauthorized: {
    title: '未登录或登录状态已失效',
    hint: '请在闲鱼页面重新登录，然后回到这里重试或恢复任务。',
    kind: 'auth',
  },
  'token-expired': {
    title: '平台登录令牌已过期',
    hint: '请刷新已打开的闲鱼页面（必要时重新登录），然后重试或恢复任务。',
    kind: 'auth',
  },
  captcha: {
    title: '触发验证码或平台风控',
    hint: '请切换到闲鱼页面手动完成验证，等待一段时间后再恢复，避免频繁重试加重风控。',
    kind: 'captcha',
  },
  network: {
    title: '网络请求失败',
    hint: '请检查网络连接后重试。',
    kind: 'platform',
  },
  api: {
    title: '平台接口返回业务错误',
    hint: '',
    kind: 'platform',
  },
  unknown: {
    title: '平台调用失败',
    hint: '',
    kind: 'platform',
  },
}

/** 敏感片段脱敏：即使后台误带入，也不在界面上展示。 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /bearer\s+[A-Za-z0-9._-]{12,}/gi,
  /(app_?secret|api_?key|token|password|authorization)\s*[:=]\s*["']?[^\s"',;]{4,}/gi,
  /_m_h5_tk[^\s;]*/gi,
  /\bt-[A-Za-z0-9]{20,}/g,
]

/** 脱敏并截断一段文本。 */
export function redactSecrets(text: string, maxLength = 240): string {
  let output = text
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[已隐藏]')
  output = output.replace(/\s+/g, ' ').trim()
  return output.length > maxLength ? `${output.slice(0, maxLength)}...` : output
}

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

/** 把任意异常转成可展示的错误视图。 */
export function toErrorView(error: unknown): ErrorView {
  const message = redactSecrets(rawMessage(error))
  if (error instanceof CommandError) {
    if (error.code === 'PLATFORM_ERROR' && error.category) {
      const text = CATEGORY_TEXT[error.category]
      return {
        ...text,
        detail: message,
        code: error.retCode ? `${error.category} / ${error.retCode}` : error.category,
      }
    }
    switch (error.code) {
      case 'TIMEOUT':
        return {
          title: '等待扩展响应超时',
          hint: '操作可能仍在后台执行，请稍后刷新查看结果，不要连续重复提交。',
          detail: message,
          kind: 'timeout',
          code: error.code,
        }
      case 'NO_TRANSPORT':
        return {
          title: '当前页面无法连接扩展',
          hint: '请通过 chrome-extension://<扩展 ID>/workbench.html 打开工作台。',
          detail: message,
          kind: 'unavailable',
          code: error.code,
        }
      case 'INVALID_PAYLOAD':
        return { title: '扩展拒绝了这次请求', hint: '', detail: message, kind: 'validation', code: error.code }
      case 'UNKNOWN_COMMAND':
        return {
          title: '扩展不认识这条命令',
          hint: '工作台与扩展版本可能不一致，请重新构建并重新加载扩展。',
          detail: message,
          kind: 'unavailable',
          code: error.code,
        }
      default:
        return { title: '扩展处理失败', hint: '', detail: message, kind: 'unknown', code: error.code }
    }
  }
  const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? String((error as { code: string }).code) : ''
  if (code === 'TIMEOUT') {
    return toErrorView(new CommandError('TIMEOUT', rawMessage(error)))
  }
  return { title: message || '未知错误', hint: '', detail: '', kind: 'unknown', code }
}

/** 压成单行文案：`标题（说明）。建议`。 */
export function errorLine(view: ErrorView): string {
  const detail = view.detail && view.detail !== view.title ? `（${view.detail}）` : ''
  return `${view.title}${detail}${view.hint ? ` ${view.hint}` : ''}`
}

/** 任务错误文本（后端只存字符串、不带类别）的类别推断。 */
export function inferCategoryFromText(text: string): PlatformCategory | null {
  if (/captcha|验证码|滑块|风控|安全验证|被挤爆/i.test(text)) return 'captcha'
  if (/token[\s_-]*(expired|exoired|empty|invalid)|令牌|token 已过期/i.test(text)) return 'token-expired'
  if (/unauthorized|未登录|请先登录|登录状态|登录失效|登录已过期/i.test(text)) return 'unauthorized'
  if (/host-unavailable|平台层未就绪|未找到可用的闲鱼页面|MAIN world host/i.test(text)) return 'host-unavailable'
  if (/网络请求失败|network|fetch failed|超时/i.test(text)) return 'network'
  return null
}

/** 任务失败 / 暂停原因的展示视图：能识别类别就给出明确提示，否则原样（脱敏后）展示。 */
export function describeTaskProblem(text: string): ErrorView {
  const clean = redactSecrets(text)
  const category = inferCategoryFromText(text)
  if (category) {
    const preset = CATEGORY_TEXT[category]
    return { ...preset, detail: clean, code: category }
  }
  return { title: clean || '任务失败，后台未给出原因', hint: '', detail: '', kind: 'unknown', code: '' }
}
