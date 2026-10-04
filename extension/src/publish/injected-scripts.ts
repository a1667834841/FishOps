/**
 * P8 发布页注入脚本（Injected Scripts）。
 *
 * 核心约束（必须严格遵守）：
 * 1. 这里导出的每个函数都会被 `chrome.scripting.executeScript({ func })` 序列化后
 *    注入到目标页面执行，因此必须**完全自包含**：
 *    - 只能引用函数参数与被注入页面自身的全局对象（document / window / fetch / File 等）；
 *    - 严禁引用本模块作用域内的任何变量、导入、常量或辅助函数；
 *    - 所有辅助逻辑必须定义在函数体内部；
 * 2. 输入只通过 `args` 传入结构化可序列化数据（string / number / boolean / 数组 / 普通对象），
 *    严禁传递 Blob / File / HTMLElement / 函数 / class 实例等不可序列化对象；
 * 3. 返回值必须是可被 structured clone 的普通对象，便于 background 侧统一校验；
 * 4. 安全铁律（分层）：
 *    - `injectFillPublishForm` 仅做表单字段填充、只读回读，以及当前可见官方阻断提示
 *      （分类不支持网页端发布 / 描述含 emoji 等）的只读探测，绝不 `.click()` / `submit()`；
 *    - 唯一允许点击发布按钮的是 `injectClickPublishSubmit`，它只由用户显式触发的工作台
 *      “发布”命令经 host 侧调用，且只点击真实发布按钮
 *      `html.page-publish #content button[class*="publish-button"]`；
 *      命中前必须通过“唯一性 / 文本恰为“发布” / 可见且未禁用”三重校验，
 *      找不到 / 不唯一 / 文本不符 / 不可见 / 禁用时一律返回结构化失败，
 *      绝不猜测或点击包装器及其它任意元素。
 */

/**
 * 页面状态探测结果（可序列化）
 */
export interface PageStatusCheckResult {
  /** 当前是否处于闲鱼发布页 */
  isPublishPage: boolean
  /** 是否已登录 */
  isLoggedIn: boolean
  /** 是否命中验证码 / 滑块风控 */
  hasCaptcha: boolean
  /** 补充说明（可选） */
  message?: string
}

/**
 * 表单填充注入入参（必须全部可序列化）
 */
export interface PublishFillInjectionPayload {
  /** 商品标题 */
  title: string
  /** 商品描述 */
  desc: string
  /** 售价（元） */
  price: number
  /** 划线原价（元） */
  originalPrice: number
  /** 待上传图片 URL 列表（按顺序：第 1 张为主图） */
  imageUrls: string[]
  /**
   * 配送（邮费）意图：
   * - `free`：包邮 / 免费配送，映射邮费 0（勾选发布页“包邮”）；
   * - `paid`：需收取邮费，必须提供明确金额（勾选“一口价”并填入）；绝不伪造收费。
   * 缺省时不触碰配送控件（向后兼容旧任务）。
   */
  shipping?: {
    mode: 'free' | 'paid'
    /** 收费金额（元，>= 0），mode === 'paid' 时必填 */
    postFee?: number
  }
  /** 等待关键控件出现的最长毫秒数，缺省 8000 */
  waitTimeoutMs?: number
  /** 触发上传后等待页面渲染的毫秒数，缺省 600 */
  renderSettleMs?: number
}

/**
 * 单张图片失败记录
 */
export interface PublishFillFailedImage {
  /** 图片序号（从 1 开始，便于用户定位） */
  index: number
  /** 图片 URL */
  url: string
  /** 失败原因 */
  error: string
}

/**
 * 官方发布页**当前可见**的阻断提示（root guard 探测结果）。
 *
 * 用途：在填表 / 图片等待结束后，读取页面当前真正可见的官方校验态（toast 浮层或
 * 表单内联校验提示），把「分类不支持网页端发布」「描述含 emoji」这类真实阻断从
 * 图片回读失败中区分出来，避免误判（例如把页面移除上传区误报成 `FORM_FIELD_CHANGED`）。
 *
 * 安全约束：仅只读识别当前**可见**元素；隐藏 / 已消失的旧 toast（display:none /
 * 0 尺寸 / hidden）绝不参与，避免上一轮残留污染本轮；不点击、不切换分类、不绕过、不重试。
 */
export interface PublishOfficialBlock {
  /** 结构化原因码：分类不支持网页端发布 / 官方表单校验失败（如 emoji） */
  code: 'PUBLISH_CATEGORY_UNSUPPORTED' | 'FORM_VALIDATION_FAILED'
  /** 官方提示原文（折叠空白并截断后的脱敏文本） */
  message: string
  /** 命中来源：toast 浮层 / 表单内联校验 */
  source: 'toast' | 'form-validation'
}

/**
 * 表单填充注入的**安全计时**（毫秒，仅数字，供 host 侧写入诊断时间线）。
 *
 * 绝不包含任何页面原文 / URL / token；仅用于度量各阶段耗时，便于定位“卡在哪一步”。
 */
export interface PublishFillInjectionTimings {
  /** 注入函数整体耗时 */
  totalMs: number
  /** 字段（标题/描述/售价/原价/配送/所在地）填充与回读耗时 */
  fieldsMs: number
  /** 图片下载与上传回读耗时 */
  imagesMs: number
  /** 字段最终稳定回读与官方阻断探测耗时 */
  validationMs: number
}

/**
 * 表单填充注入结果（必须全部可序列化）
 */
export interface PublishFillInjectionResult {
  /** 标题是否填充并回读校验通过 */
  titleFilled: boolean
  /** 描述是否填充并回读校验通过 */
  descFilled: boolean
  /** 售价是否填充并回读校验通过 */
  priceFilled: boolean
  /** 划线原价是否填充并回读校验通过 */
  origPriceFilled: boolean
  /** 主图是否成功写入上传控件 */
  mainImageUploaded: boolean
  /** 详情图成功数量（不含主图） */
  detailImagesCount: number
  /** 成功写入上传控件的图片总数量 */
  imagesUploadedCount: number
  /** 失败图片明细（带序号） */
  imagesFailed: PublishFillFailedImage[]
  /**
   * 邮费 / 配送是否已满足：包邮映射 0 或收费额已填入并回读通过。
   * 未涉及配送时为 true。
   */
  postFeeFilled: boolean
  /** 已确认的配送状态（free 包邮 / paid 收费），未涉及配送时缺省 */
  shippingStatus?: 'free' | 'paid'
  /** 页面当前邮费输入值（仅审计，不含用户隐私） */
  postFeeValue?: string
  /**
   * 所在地是否已就绪：发布页已有合法地址或用户已选。
   * 未涉及所在地控件（旧版/灰度）时为 true。
   */
  locationFilled: boolean
  /** 发布页当前所在地文本（供编辑层提示“官方默认地址/需选择”） */
  locationValue?: string
  /** 所在地状态：ready 已有官方默认地址；needs_user_selection 需用户选择 */
  locationStatus?: 'ready' | 'needs_user_selection'
  /**
   * 官方页面当前可见的阻断提示（root guard）：命中分类不支持 / 官方校验失败时为结构化对象，
   * 否则缺省。该字段优先于图片回读失败被上层解读，避免把真实阻断误报成图片/字段失败。
   */
  officialBlock?: PublishOfficialBlock
  /** 安全计时（毫秒），供 host 侧写入诊断时间线；绝不含页面原文 */
  timings: PublishFillInjectionTimings
  /** 结构化错误信息汇总 */
  errors: string[]
}

/**
 * 探测发布页状态（登录态 / 验证码风控 / 是否发布页）。
 *
 * 该函数会被注入到页面执行，必须完全自包含，禁止引用模块作用域变量。
 */
export const injectCheckPageStatus = (): PageStatusCheckResult => {
  const href =
    typeof window !== 'undefined' && window.location ? String(window.location.href) : ''

  const isPublishPage = href.includes('goofish.com/publish')
  const isLoginPage =
    href.includes('login.taobao.com') || href.includes('login.m.taobao.com')

  let hasCaptcha = false
  try {
    hasCaptcha = Boolean(
      document.querySelector(
        '.baxia-dialog, [class*="punish"], #nc_1_wrapper, [class*="captcha"], #sufei-dialog',
      ),
    )
  } catch {
    hasCaptcha = false
  }

  let loginBtn: Element | null = null
  try {
    loginBtn = document.querySelector('[class*="login-btn"], a[href*="login"]')
  } catch {
    loginBtn = null
  }

  const isLoggedIn = !isLoginPage && (!loginBtn || isPublishPage)

  return { isPublishPage, isLoggedIn, hasCaptcha }
}

/**
 * 填充闲鱼发布表单（仅填充 + 回读校验，绝不提交）。
 *
 * 处理要点：
 * 1. 闲鱼发布页存在异步重渲染，关键控件可能延迟出现或整体重挂载，因此使用轮询等待
 *    `waitFor(...)` 而不是过短固定延时，并在需要时重新查询 DOM；
 * 1.1 真实发布页**没有独立商品标题输入框**：标题与描述统一为同一个描述编辑器，因此
 *    这里把标题与描述融合为“统一描述”写入描述控件；若页面确实存在独立标题框
 *    （部分版本/灰度）则仍分别填充，绝不因找不到标题而整体放弃；
 * 2. 每个字段填充后立即重新读取其当前值，与期望值比对，形成 read-back 校验；
 *    所有字段与图片处理完成后，再等待一次渲染稳定并重新查询 DOM 做最终回读，
 *    防止异步重渲染把已填值清空而造成“假成功”；
 * 3. 图片逐张处理：先校验 HTTPS，再 fetch → Blob → File → DataTransfer，逐张登记成功/失败；
 *    写回控件后重新查询 DOM 回读确认页面真实接受的数量，绝不复用可能被重渲染替换的旧 input
 *    引用；任一张失败或回读数量不足，都不会把图片整体标记为成功；
 * 4. 最终发布按钮只做存在性探测，绝不调用 click / submit。
 *
 * 该函数会被注入到页面执行，必须完全自包含，禁止引用模块作用域变量。
 */
export const injectFillPublishForm = async (
  payload: PublishFillInjectionPayload,
): Promise<PublishFillInjectionResult> => {
  const errors: string[] = []
  const imagesFailed: PublishFillFailedImage[] = []
  const waitTimeoutMs = typeof payload.waitTimeoutMs === 'number' ? payload.waitTimeoutMs : 8000
  const renderSettleMs = typeof payload.renderSettleMs === 'number' ? payload.renderSettleMs : 600

  // 安全计时（毫秒）：仅用于诊断，绝不记录页面原文；即使抛异常也返回已测得的部分值。
  const startedAt = Date.now()
  let fieldsMs = 0
  let imagesMs = 0
  let validationMs = 0

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

  /** 轮询等待条件成立，超时返回 false。用于对抗页面异步重渲染。 */
  const waitFor = async (
    predicate: () => boolean,
    timeoutMs: number,
    intervalMs = 100,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      let ok = false
      try {
        ok = predicate()
      } catch {
        ok = false
      }
      if (ok) return true
      if (Date.now() >= deadline) return false
      await delay(intervalMs)
    }
  }

  const queryFirst = (selectors: string[]): HTMLElement | null => {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel)
        if (el) return el as HTMLElement
      } catch {
        // 忽略无效选择器，继续尝试
      }
    }
    return null
  }

  /**
   * 查找页面上可能存在的“独立商品标题输入框”。
   *
   * 注意：真实闲鱼发布页（/publish）**没有**独立的商品标题字段，标题与描述统一在描述
   * 编辑器中。因此这里仅作“可选增强”探测：若某些版本/灰度确实存在独立标题框则单独填充；
   * 若不存在，绝不阻断整体流程（标题会融合进统一描述）。
   */
  const findTitleEl = (): HTMLElement | null =>
    queryFirst([
      'textarea[placeholder*="标题"]',
      'input[placeholder*="标题"]',
      '[class*="title"] textarea',
      '[class*="title"] input[type="text"]',
    ])

  const findDescEl = (): HTMLElement | null =>
    queryFirst([
      '[contenteditable="true"][data-placeholder]',
      '[class^="editor--"]',
      '[class*="editor"] [contenteditable="true"]',
      '[contenteditable="true"]',
      'textarea[placeholder*="描述"]',
      '[data-placeholder*="描述"]',
      'textarea',
    ])

  /**
   * 融合商品标题与描述为发布页唯一的“统一描述”文本。
   *
   * 官方发布页已把标题与描述合并为一个描述编辑器，因此不能粗暴丢弃标题：
   * - 标题为空时只用描述；
   * - 描述为空时只用标题；
   * - 描述已完全等于标题或以标题开头时不再重复拼接，避免出现两遍标题；
   * - 其余情况拼接为“标题 + 换行 + 描述”。
   */
  const buildUnifiedDesc = (title: string, desc: string): string => {
    const safeTitle = String(title ?? '').trim()
    const safeDesc = String(desc ?? '').trim()
    if (!safeTitle) return safeDesc
    if (!safeDesc) return safeTitle
    const normalizedDesc = safeDesc.replace(/\s+/g, ' ').trim()
    const normalizedTitle = safeTitle.replace(/\s+/g, ' ').trim()
    if (normalizedDesc === normalizedTitle || normalizedDesc.startsWith(normalizedTitle)) {
      return safeDesc
    }
    return `${safeTitle}\n${safeDesc}`
  }

  /** 去除首尾空白并折叠连续空白，用于跨 contenteditable/受控输入的宽松回读比对。 */
  const normalizeText = (value: string): string =>
    String(value ?? '').replace(/\s+/g, ' ').trim()

  const getAttr = (el: HTMLElement, name: string): string => {
    try {
      return typeof el.getAttribute === 'function' ? String(el.getAttribute(name) ?? '') : ''
    } catch {
      return ''
    }
  }

  const closestOf = (el: HTMLElement, selector: string): HTMLElement | null => {
    try {
      return typeof el.closest === 'function' ? (el.closest(selector) as HTMLElement | null) : null
    } catch {
      return null
    }
  }

  /**
   * 判断元素当前是否**可见**（用于 root guard 只读探测）。
   *
   * 必须同时排除：hidden / aria-hidden / display:none / visibility:hidden / opacity:0
   * 以及 0 尺寸（已卸载或尚未渲染）。这样“上一轮残留但已隐藏的旧 toast”不会污染本轮判定。
   */
  const isElementVisible = (el: Element | null): boolean => {
    if (!el) return false
    try {
      const node = el as HTMLElement
      if (node.hidden === true) return false
      if (typeof node.getAttribute === 'function') {
        if (node.getAttribute('hidden') !== null) return false
        if (node.getAttribute('aria-hidden') === 'true') return false
      }
      const styleFn = (globalThis as { getComputedStyle?: (e: Element) => CSSStyleDeclaration }).getComputedStyle
      if (typeof styleFn === 'function') {
        const style = styleFn(node)
        if (style) {
          if (style.display === 'none' || style.visibility === 'hidden') return false
          if (style.opacity !== '' && Number(style.opacity) === 0) return false
        }
      }
      if (typeof node.getBoundingClientRect === 'function') {
        const rect = node.getBoundingClientRect()
        if (rect && (rect.width <= 0 || rect.height <= 0)) return false
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * 采集当前**可见**的官方提示文本（toast 浮层 + 表单内联校验）。
   *
   * 只做只读遍历，绝不点击 / 修改页面。隐藏或 0 尺寸节点一律跳过。
   */
  const collectVisibleOfficialNotices = (): Array<{ text: string; source: 'toast' | 'form-validation' }> => {
    const notices: Array<{ text: string; source: 'toast' | 'form-validation' }> = []
    const push = (selector: string, source: 'toast' | 'form-validation'): void => {
      try {
        const nodes = document.querySelectorAll(selector)
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i]
          if (!isElementVisible(node)) continue
          const text = String((node as HTMLElement).textContent ?? '')
            .replace(/\s+/g, ' ')
            .trim()
          if (text) notices.push({ text, source })
        }
      } catch {
        // 忽略无效选择器 / 异常，继续其它探针
      }
    }
    // 表单内联校验提示（真实现场字段：form-item-explain）优先采集。
    push('[class*="form-item-explain"]', 'form-validation')
    // 官方 toast / 全局提示浮层。
    push('[class*="toast"], .ant-message-notice-content, [role="alert"]', 'toast')
    return notices
  }

  /**
   * 识别官方当前可见的阻断提示并归类（root guard）。
   *
   * 优先级（官方 warning 优先于图片/字段回读失败）：
   * 1. 分类不支持网页端发布 → PUBLISH_CATEGORY_UNSUPPORTED（分类不支持是根本阻断，最高优先）；
   * 2. 描述含 emoji 等 → FORM_VALIDATION_FAILED（明确归因表单校验，绝不误判为图片失败）；
   * 3. 其它可见的内联表单校验提示 → FORM_VALIDATION_FAILED。
   *
   * 未命中任何当前可见提示时返回 undefined，交由既有字段/图片回读判定。
   */
  const detectOfficialBlock = (): PublishOfficialBlock | undefined => {
    const notices = collectVisibleOfficialNotices()
    if (notices.length === 0) return undefined

    const category = notices.find((n) =>
      /不支持.{0,6}网页端发布|网页端发布.{0,6}不支持|分类不支持/.test(n.text),
    )
    if (category) {
      return {
        code: 'PUBLISH_CATEGORY_UNSUPPORTED',
        message: category.text.slice(0, 200),
        source: category.source,
      }
    }

    const emoji = notices.find((n) => /emoji|表情/i.test(n.text))
    if (emoji) {
      return { code: 'FORM_VALIDATION_FAILED', message: emoji.text.slice(0, 200), source: emoji.source }
    }

    const validation = notices.find((n) => n.source === 'form-validation')
    if (validation) {
      return {
        code: 'FORM_VALIDATION_FAILED',
        message: validation.text.slice(0, 200),
        source: 'form-validation',
      }
    }
    return undefined
  }

  /**
   * 采集价格输入框的“上下文文本”，用于精准区分售价/原价与干扰项：
   * 依次读取 placeholder、aria-label、关联 label，以及最近的 .ant-form-item 内
   * **.ant-form-item-label 文本**（真实现场：input 的 id 为空，label[for] 关联会失效，
   * 但 form-item 内的 .ant-form-item-label 能稳定给出“价格* / 原价 / 邮费*”等语义）。
   */
  const elementContextText = (el: HTMLElement): string => {
    const parts: string[] = [getAttr(el, 'placeholder'), getAttr(el, 'aria-label')]
    const id = getAttr(el, 'id')
    if (id) {
      try {
        const label = document.querySelector(`label[for="${id}"]`)
        if (label) parts.push(String((label as HTMLElement).textContent ?? ''))
      } catch {
        // 忽略
      }
    }
    const wrappedLabel = closestOf(el, 'label')
    if (wrappedLabel) parts.push(String(wrappedLabel.textContent ?? ''))
    const formItem = closestOf(el, '.ant-form-item')
    if (formItem) {
      let labelNode: HTMLElement | null = null
      try {
        labelNode =
          typeof formItem.querySelector === 'function'
            ? (formItem.querySelector('.ant-form-item-label') as HTMLElement | null)
            : null
      } catch {
        labelNode = null
      }
      parts.push(String((labelNode ?? formItem).textContent ?? ''))
    }
    return parts.join(' ')
  }

  /** 通过 label[for=id] 关联定位其所在 form-item 内的 input。 */
  const inputByLabelFor = (id: string): HTMLInputElement | null => {
    try {
      const label = document.querySelector(`label[for="${id}"]`) as HTMLElement | null
      if (!label) return null
      if (typeof label.querySelector === 'function') {
        const wrapped = label.querySelector('input')
        if (wrapped) return wrapped as HTMLInputElement
      }
      const formItem = closestOf(label, '.ant-form-item')
      const scope: ParentNode = formItem ?? document
      const input =
        typeof scope.querySelector === 'function' ? scope.querySelector('input.ant-input, input') : null
      return (input as HTMLInputElement | null) ?? null
    } catch {
      return null
    }
  }

  /** 采集所有疑似价格输入框（含多个 placeholder=0.00 的框），供精准分类使用。 */
  const collectPriceCandidates = (): HTMLInputElement[] => {
    const list: HTMLInputElement[] = []
    const push = (el: Element | null) => {
      const input = el as HTMLInputElement | null
      if (input && input.tagName === 'INPUT' && list.indexOf(input) < 0) list.push(input)
    }
    try {
      document
        .querySelectorAll(
          '.priceWrap--nKmMUJ5X input.ant-input, div[class*="priceWrap"] input.ant-input, input[placeholder="0.00"]',
        )
        .forEach(push)
    } catch {
      // 忽略无效选择器
    }
    return list
  }

  /** 价格框语义正则：售价/原价，以及必须排除的干扰项（邮费、运费、库存等）。 */
  const PRICE_SELL_RE = /价格|售价|一口价|到手价|现价/
  const PRICE_ORIG_RE = /原价|划线|市场价/
  const PRICE_NOISE_RE = /邮费|运费|快递|库存|数量|限购/

  /**
   * 精准定位售价与划线原价输入框。
   *
   * 真实现场：input 无 id，页面存在**三个 placeholder=0.00 的价格框**（价格* / 原价 / 邮费*），
   * 因此不能简单取“前两个”，也不能在无标签时把邮费当售价/原价：
   * 1. 优先用 label[for="itemPriceDTO_priceInCent" / "itemPriceDTO_origPriceInCent"] 关联到
   *    其 form-item 内的 input（不依赖 input 的 id）；
   * 2. 其次读取 input 最近 form-item 的 .ant-form-item-label 文本分类；
   *    命中“邮费/运费/快递/库存/数量/限购”的干扰项**永不入选**；
   * 3. 最后仅在剩余非干扰候选里按顺序补齐，绝不把邮费当售价/原价。
   */
  const findPriceInputs = (): {
    price: HTMLInputElement | null
    original: HTMLInputElement | null
  } => {
    let price = inputByLabelFor('itemPriceDTO_priceInCent')
    let original = inputByLabelFor('itemPriceDTO_origPriceInCent')

    const candidates = collectPriceCandidates()
    if (!price || !original) {
      for (const input of candidates) {
        if (input === price || input === original) continue
        const context = elementContextText(input)
        // 邮费等干扰项永不作为售价/原价
        if (PRICE_NOISE_RE.test(context)) continue
        if (!original && PRICE_ORIG_RE.test(context)) {
          original = input
          continue
        }
        if (!price && PRICE_SELL_RE.test(context)) {
          price = input
        }
      }
    }

    // 兜底：仅在候选未被识别为干扰项时按顺序补齐，绝不误选邮费
    const eligible = candidates.filter(
      (c) => c !== price && c !== original && !PRICE_NOISE_RE.test(elementContextText(c)),
    )
    if (!price) price = eligible[0] ?? null
    if (!original) original = eligible.find((c) => c !== price) ?? null

    return { price, original }
  }

  const findFileInput = (): HTMLInputElement | null => {
    try {
      // 真实页面为 <span class="ant-upload"><input type="file" multiple>...</span>
      const inputs = Array.from(
        document.querySelectorAll('span.ant-upload input[type="file"], input[type="file"]'),
      ) as HTMLInputElement[]
      const imageInput =
        inputs.find((input) => !input.accept || input.accept.includes('image')) || inputs[0]
      return imageInput || null
    } catch {
      return null
    }
  }

  /** 写入值并派发原生事件，尽量兼容受控组件。 */
  const writeValue = (el: HTMLElement, value: string): boolean => {
    try {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        // 通过原型上的 value setter 写入，绕过受控组件的属性劫持
        const proto = Object.getPrototypeOf(el)
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
        if (descriptor && typeof descriptor.set === 'function') {
          descriptor.set.call(el, value)
        } else {
          ;(el as HTMLInputElement | HTMLTextAreaElement).value = value
        }
      } else {
        el.textContent = value
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      if (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') {
        el.dispatchEvent(new Event('blur', { bubbles: true }))
        if (typeof InputEvent !== 'undefined') {
          el.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: value,
            }),
          )
        }
      }
      return true
    } catch {
      return false
    }
  }

  /** 回读元素当前值（input/textarea 用 value，contenteditable 用 textContent）。 */
  const readValue = (el: HTMLElement | null): string => {
    if (!el) return ''
    try {
      if ('value' in el) {
        const v = (el as HTMLInputElement | HTMLTextAreaElement).value
        return typeof v === 'string' ? v : String(v ?? '')
      }
      return String(el.textContent ?? '')
    } catch {
      return ''
    }
  }

  const isHttpsUrl = (url: string): boolean => {
    try {
      return new URL(url).protocol === 'https:'
    } catch {
      return false
    }
  }

  /**
   * 回读页面上“确实已上传成功”的图片数量。
   *
   * 优先统计页面真实渲染出来的图片预览（最能反映上传组件是否真的接收了文件），
   * 预览区读不到时再回退到“重新查询”上传控件的 files 数量。
   *
   * 关键点：这里必须重新查询 DOM，绝不能使用写入时的旧 input 引用——闲鱼发布页在上传后
   * 会异步重渲染并替换上传控件节点，旧引用的 files 仍可能非空，从而造成“假成功”。
   */
  const countUploadedImages = (): number => {
    try {
      const previews = document.querySelectorAll(
        'img[src^="blob:"], img[src^="data:"], [class*="upload"] img, [class*="imgWrap"] img',
      )
      if (previews && previews.length > 0) return previews.length
    } catch {
      // 忽略选择器异常，走回退逻辑
    }
    try {
      const input = findFileInput()
      return input && input.files ? input.files.length : 0
    } catch {
      return 0
    }
  }

  /**
   * 配送方式（邮费）相关真实 DOM 定位。
   *
   * 真实现场：发布页有一组「包邮 / 按距离计费 / 一口价 / 无需邮寄」的
   * `label.ant-radio-wrapper`，对应 `input.ant-radio-input` 的 value 0/1/2/3；
   * 邮费输入框为 `label[for="itemPostFeeDTO_postPriceInCent"]` 所在 form-item 内的
   * `input.ant-input`（placeholder=0.00），仅在选中收费方式（如“一口价”）时
   * 解除 `ant-form-item-hidden` 隐藏。
   */
  const findShippingRadioGroup = (): HTMLElement | null => {
    try {
      const groups = Array.from(document.querySelectorAll('.ant-radio-group')) as HTMLElement[]
      for (const group of groups) {
        if (/包邮|按距离计费|一口价|无需邮寄/.test(String(group.textContent ?? ''))) return group
      }
    } catch {
      // 忽略无效选择器
    }
    return null
  }

  const findShippingRadio = (labelText: string): HTMLInputElement | null => {
    const group = findShippingRadioGroup()
    if (!group) return null
    try {
      const labels = Array.from(group.querySelectorAll('label.ant-radio-wrapper')) as HTMLElement[]
      for (const label of labels) {
        if (normalizeText(label.textContent).indexOf(labelText) >= 0) {
          const input = label.querySelector('input.ant-radio-input, input[type="radio"]')
          return (input as HTMLInputElement | null) ?? null
        }
      }
    } catch {
      // 忽略
    }
    return null
  }

  const isShippingRadioChecked = (labelText: string): boolean => {
    const input = findShippingRadio(labelText)
    return Boolean(input && input.checked)
  }

  /**
   * 切换配送方式（包邮 / 一口价）。
   *
   * 仅通过派发原生 click 事件触发 antd Radio 的选中，**绝不**调用元素原生 click 方法或 submit，
   * 也绝不触碰任何发布按钮，保持“填充阶段无提交”的安全铁律。
   */
  const selectShippingRadio = (labelText: string): boolean => {
    const input = findShippingRadio(labelText)
    if (!input) return false
    try {
      if (input.checked) return true
      const proto = Object.getPrototypeOf(input)
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'checked')
      if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(input, true)
      else input.checked = true
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    } catch {
      return false
    }
  }

  const findPostFeeInput = (): HTMLInputElement | null => {
    try {
      const label = document.querySelector(
        'label[for="itemPostFeeDTO_postPriceInCent"]',
      ) as HTMLElement | null
      if (!label) return null
      const formItem = closestOf(label, '.ant-form-item')
      const scope: ParentNode = formItem ?? document
      const input =
        typeof scope.querySelector === 'function'
          ? scope.querySelector('input.ant-input, input')
          : null
      return (input as HTMLInputElement | null) ?? null
    } catch {
      return null
    }
  }

  const isPostFeeInputVisible = (): boolean => {
    const input = findPostFeeInput()
    if (!input) return false
    try {
      const formItem = closestOf(input, '.ant-form-item')
      if (formItem && String(formItem.className ?? '').indexOf('ant-form-item-hidden') >= 0) {
        return false
      }
      const rect =
        typeof input.getBoundingClientRect === 'function' ? input.getBoundingClientRect() : null
      return Boolean(rect && rect.width > 0 && rect.height > 0)
    } catch {
      return false
    }
  }

  /**
   * 所在地（宝贝所在地）只读定位与读取。
   *
   * 真实现场：`label[for="itemAddrDTO"]` 所在 form-item 的
   * `.ant-form-item-control-input-content` 文本即当前账号默认地址；
   * 为空表示需用户在页面选择，**绝不自动凭空选择地区**。
   */
  const findLocationFormItem = (): HTMLElement | null => {
    try {
      const label = document.querySelector('label[for="itemAddrDTO"]') as HTMLElement | null
      if (!label) return null
      return closestOf(label, '.ant-form-item')
    } catch {
      return null
    }
  }

  const readLocationValue = (): string => {
    const formItem = findLocationFormItem()
    if (!formItem) return ''
    try {
      const content =
        typeof formItem.querySelector === 'function'
          ? (formItem.querySelector('.ant-form-item-control-input-content') as HTMLElement | null)
          : null
      return normalizeText(content ? String(content.textContent ?? '') : '')
    } catch {
      return ''
    }
  }

  try {
    // ---- 0. 等待关键控件出现（对抗闲鱼发布页异步重渲染） ----
    await waitFor(() => {
      // 不再等待独立标题框：真实发布页无该字段，标题会融合进统一描述
      const hasDesc = Boolean(findDescEl())
      const priceInputs = findPriceInputs()
      const hasPrice = Boolean(priceInputs.price)
      const hasFile = Boolean(findFileInput())
      return hasDesc && hasPrice && hasFile
    }, waitTimeoutMs)

    const fieldsStart = Date.now()

    // ---- 1. 标题与描述：适配“发布页无独立商品标题输入框”的真实现状 ----
    // 闲鱼发布页已将标题与描述统一为同一个“描述编辑器”（contenteditable），因此：
    // - 若页面存在独立标题输入框（部分版本/灰度），仍分别填充标题与描述；
    // - 若不存在（真实现状），则把标题与描述融合为统一描述写入描述编辑器，
    //   绝不因找不到标题而整体放弃填充，也绝不粗暴丢弃标题。
    const independentTitleEl = findTitleEl()
    // 无独立标题框时，把标题融合进描述；有独立标题框时描述保持原样，避免标题重复出现
    const descContent = independentTitleEl
      ? String(payload.desc ?? '').trim()
      : buildUnifiedDesc(payload.title, payload.desc)

    let titleFilled = false
    if (independentTitleEl) {
      if (writeValue(independentTitleEl, payload.title)) {
        titleFilled = readValue(independentTitleEl).trim() === String(payload.title ?? '').trim()
        if (!titleFilled) errors.push('标题填充后回读校验失败')
      } else {
        errors.push('写入标题失败')
      }
    }

    // ---- 2. 描述（无独立标题时含标题融合内容）填充 + 回读校验 ----
    let descFilled = false
    {
      const descEl = findDescEl()
      if (!descEl) {
        errors.push('未找到商品描述编辑器输入框')
      } else if (writeValue(descEl, descContent)) {
        descFilled = normalizeText(readValue(descEl)) === normalizeText(descContent)
        if (!descFilled) errors.push('描述填充后回读校验失败')
      } else {
        errors.push('写入描述失败')
      }
    }

    // 无独立标题框：标题已融合进统一描述，描述回读通过且确实包含标题即视为标题写入成功
    if (!independentTitleEl) {
      const titleText = String(payload.title ?? '').trim()
      titleFilled =
        descFilled &&
        (titleText.length === 0 || normalizeText(descContent).indexOf(normalizeText(titleText)) >= 0)
      if (!titleFilled) errors.push('标题未能融合进商品描述（回读校验失败）')
    }

    // ---- 3. 售价填充 + 回读校验 ----
    let priceFilled = false
    {
      const { price: priceInput } = findPriceInputs()
      if (!priceInput) {
        errors.push('未找到商品售价输入框')
      } else if (writeValue(priceInput, String(payload.price))) {
        priceFilled = Number(readValue(priceInput)) === Number(payload.price)
        if (!priceFilled) errors.push('售价填充后回读校验失败')
      } else {
        errors.push('写入售价失败')
      }
    }

    // ---- 4. 划线原价填充 + 回读校验 ----
    let origPriceFilled = false
    {
      const { original: origInput } = findPriceInputs()
      if (!origInput) {
        errors.push('未找到商品划线原价输入框')
      } else if (writeValue(origInput, String(payload.originalPrice))) {
        origPriceFilled = Number(readValue(origInput)) === Number(payload.originalPrice)
        if (!origPriceFilled) errors.push('划线原价填充后回读校验失败')
      } else {
        errors.push('写入划线原价失败')
      }
    }

    // ---- 4.5 配送（邮费）：包邮映射 0，或按显式金额收费；绝不伪造收费 ----
    let postFeeFilled = true
    let shippingStatus: 'free' | 'paid' | undefined
    let postFeeValue = ''
    {
      const shipping = payload.shipping
      if (shipping && (shipping.mode === 'free' || shipping.mode === 'paid')) {
        shippingStatus = shipping.mode
        postFeeFilled = false
        if (shipping.mode === 'free') {
          // 包邮 / 免费配送：映射邮费 0（勾选“包邮”）
          if (isShippingRadioChecked('包邮')) {
            postFeeFilled = true
          } else if (selectShippingRadio('包邮')) {
            await waitFor(() => isShippingRadioChecked('包邮'), 2000)
            postFeeFilled = isShippingRadioChecked('包邮')
            if (!postFeeFilled) errors.push('选择“包邮”后回读校验失败，无法映射免费配送')
          } else {
            errors.push('未找到“包邮”配送方式控件，无法映射免费配送')
          }
        } else {
          // 收费配送：勾选“一口价”并填入显式金额（绝不伪造收费）
          const fee = typeof shipping.postFee === 'number' ? shipping.postFee : NaN
          if (!Number.isFinite(fee) || fee < 0) {
            errors.push('收费配送缺少有效邮费金额，拒绝伪造收费')
          } else {
            if (!isShippingRadioChecked('一口价')) {
              selectShippingRadio('一口价')
              await waitFor(() => isShippingRadioChecked('一口价'), 2000)
            }
            await waitFor(() => isPostFeeInputVisible(), 2000)
            const feeInput = findPostFeeInput()
            if (!feeInput) {
              errors.push('未找到邮费输入框（itemPostFeeDTO_postPriceInCent）')
            } else if (!isPostFeeInputVisible()) {
              errors.push('邮费输入框未显示，无法填写收费邮费')
            } else if (writeValue(feeInput, String(fee))) {
              await delay(100)
              postFeeValue = readValue(findPostFeeInput())
              postFeeFilled = Number(postFeeValue) === Number(fee)
              if (!postFeeFilled) errors.push('邮费填充后回读校验失败')
            } else {
              errors.push('写入邮费失败')
            }
          }
        }
        if (postFeeFilled) postFeeValue = readValue(findPostFeeInput())
      }
    }

    // ---- 4.6 所在地：只读保留页面已有合法地址；为空则提示需用户选择，绝不自动选 ----
    let locationFilled = true
    let locationValue = ''
    let locationStatus: 'ready' | 'needs_user_selection' | undefined
    {
      const locationFormItem = findLocationFormItem()
      if (locationFormItem) {
        locationValue = readLocationValue()
        if (locationValue.length > 0) {
          locationStatus = 'ready'
          locationFilled = true
        } else {
          locationStatus = 'needs_user_selection'
          locationFilled = false
          errors.push('发布页宝贝所在地为空：请在发布页选择所在地后重试（绝不自动凭空选择地区）')
        }
      }
    }

    fieldsMs = Date.now() - fieldsStart

    // ---- 5. 图片逐张处理（HTTPS 校验 → fetch → Blob → File → DataTransfer） ----
    // fetchedCount 记录成功构造出 File 的数量；confirmedCount 记录写回控件后页面上
    // 真实回读确认的上传数量。二者分离，避免“构造成功”被误当作“页面已接受”。
    let fetchedCount = 0
    let confirmedCount = 0
    const imagesStart = Date.now()

    if (!Array.isArray(payload.imageUrls) || payload.imageUrls.length === 0) {
      errors.push('待上传图片列表为空，无法完成图片填充')
    } else {
      const fileInput = findFileInput()
      if (!fileInput) {
        errors.push('未找到商品图片文件选择控件')
      } else if (typeof DataTransfer === 'undefined' || typeof File === 'undefined') {
        errors.push('当前页面环境不支持 DataTransfer / File，无法构造图片上传数据')
      } else {
        const dataTransfer = new DataTransfer()
        for (let i = 0; i < payload.imageUrls.length; i++) {
          const url = payload.imageUrls[i] ?? ''
          if (!isHttpsUrl(url)) {
            imagesFailed.push({ index: i + 1, url, error: '图片仅允许 HTTPS 协议' })
            continue
          }
          try {
            const response = await fetch(url)
            if (!response || !response.ok) {
              throw new Error(`HTTP 状态异常 ${response ? response.status : 'unknown'}`)
            }
            const blob = await response.blob()
            if (!blob || blob.size === 0) {
              throw new Error('下载到空图片 Blob')
            }
            const fileName = i === 0 ? 'main-image.jpg' : `detail-image-${i}.jpg`
            const mimeType =
              blob.type && blob.type.indexOf('image/') === 0 ? blob.type : 'image/jpeg'
            const file = new File([blob], fileName, { type: mimeType })
            dataTransfer.items.add(file)
            fetchedCount++
            // 逐张让出事件循环，等待 Blob/File/DataTransfer 落位，稳定上传时序
            await delay(0)
          } catch (err) {
            const message =
              err && typeof err === 'object' && 'message' in err
                ? String((err as { message: unknown }).message)
                : String(err)
            imagesFailed.push({ index: i + 1, url, error: message })
          }
        }

        if (fetchedCount > 0) {
          // 写入前重新查询，防止重渲染替换了 input 节点
          const targetInput = findFileInput() || fileInput
          try {
            targetInput.files = dataTransfer.files
            targetInput.dispatchEvent(new Event('input', { bubbles: true }))
            targetInput.dispatchEvent(new Event('change', { bubbles: true }))
            // 等待上传组件响应渲染（不使用过短固定延时）
            await delay(renderSettleMs)
            // 关键：重渲染后重新查询 DOM 回读确认，绝不复用旧 input 引用
            confirmedCount = countUploadedImages()
            if (confirmedCount !== fetchedCount) {
              errors.push(
                `图片写入上传控件后回读确认未完全生效（页面确认 ${confirmedCount} / 已构造 ${fetchedCount}）`,
              )
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            errors.push(`写入图片文件控件失败: ${message}`)
          }
        }

        if (imagesFailed.length > 0) {
          const detail = imagesFailed
            .map((item) => `第 ${item.index} 张(${item.url}): ${item.error}`)
            .join('; ')
          errors.push(`存在图片处理失败: ${detail}`)
        }
      }
    }

    imagesMs = Date.now() - imagesStart

    const validationStart = Date.now()

    // ---- 6. 字段最终稳定回读：对抗异步重渲染把已填值清空 ----
    await delay(renderSettleMs)
    {
      if (titleFilled && independentTitleEl) {
        const el = findTitleEl()
        titleFilled = Boolean(el) && readValue(el).trim() === String(payload.title ?? '').trim()
        if (!titleFilled) errors.push('标题在页面重渲染后回读校验失败')
      }
      if (descFilled) {
        const el = findDescEl()
        descFilled = Boolean(el) && normalizeText(readValue(el)) === normalizeText(descContent)
        if (!descFilled) errors.push('描述在页面重渲染后回读校验失败')
        if (!independentTitleEl) {
          const titleText = String(payload.title ?? '').trim()
          titleFilled =
            descFilled &&
            (titleText.length === 0 ||
              normalizeText(descContent).indexOf(normalizeText(titleText)) >= 0)
          if (!titleFilled) errors.push('标题融合内容在页面重渲染后回读校验失败')
        }
      }
      if (priceFilled) {
        const { price: el } = findPriceInputs()
        priceFilled = Boolean(el) && Number(readValue(el)) === Number(payload.price)
        if (!priceFilled) errors.push('售价在页面重渲染后回读校验失败')
      }
      if (origPriceFilled) {
        const { original: el } = findPriceInputs()
        origPriceFilled = Boolean(el) && Number(readValue(el)) === Number(payload.originalPrice)
        if (!origPriceFilled) errors.push('划线原价在页面重渲染后回读校验失败')
      }
    }

    // ---- 6.5 官方阻断提示只读探测（root guard）----
    // 在字段最终回读之后、依据图片/字段结果判定之前，读取页面当前真正可见的官方校验态：
    // 「当前分类不支持网页端发布」或「商品描述不能包含emoji」等。仅只读探测，绝不点击 /
    // 切换分类 / 绕过 / 重试；隐藏或已消失的旧 toast 不会污染。上层据此优先于图片回读失败判定。
    const officialBlock = detectOfficialBlock()

    validationMs = Date.now() - validationStart

    const allImagesSucceeded =
      payload.imageUrls.length > 0 &&
      imagesFailed.length === 0 &&
      confirmedCount === payload.imageUrls.length &&
      fetchedCount === payload.imageUrls.length
    const mainImageUploaded = allImagesSucceeded
    const imagesUploadedCount = confirmedCount

    // ---- 7. 发布按钮存在性检测：只读，绝不 click / submit ----
    try {
      // 仅用于记录按钮是否可点击，绝不触发任何点击行为
      void document.querySelector('button[class*="publish-button"]')
    } catch {
      // 忽略
    }

    return {
      titleFilled,
      descFilled,
      priceFilled,
      origPriceFilled,
      mainImageUploaded,
      detailImagesCount: Math.max(0, imagesUploadedCount - 1),
      imagesUploadedCount,
      imagesFailed,
      postFeeFilled,
      shippingStatus,
      postFeeValue,
      locationFilled,
      locationValue,
      locationStatus,
      officialBlock,
      timings: { totalMs: Date.now() - startedAt, fieldsMs, imagesMs, validationMs },
      errors,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      titleFilled: false,
      descFilled: false,
      priceFilled: false,
      origPriceFilled: false,
      mainImageUploaded: false,
      detailImagesCount: 0,
      imagesUploadedCount: 0,
      imagesFailed,
      postFeeFilled: false,
      locationFilled: false,
      timings: { totalMs: Date.now() - startedAt, fieldsMs, imagesMs, validationMs },
      errors: [...errors, `注入填充执行异常: ${message}`],
    }
  }
}

/**
 * 提交注入结果（可序列化）
 */
export interface PublishSubmitInjectionResult {
  /** 是否已成功派发一次发布按钮点击 */
  clicked: boolean
  /** 未点击时的结构化原因码（与 PublishErrorCode 对齐） */
  code?:
    | 'SUBMIT_PAGE_INVALID'
    | 'NOT_LOGGED_IN'
    | 'VERIFICATION_REQUIRED'
    | 'FORM_FIELD_CHANGED'
    | 'FORM_VALIDATION_FAILED'
    | 'SUBMIT_BUTTON_NOT_FOUND'
    | 'SUBMIT_BUTTON_DISABLED'
  /** 人类可读的原因说明 */
  reason?: string
  /** 命中到的发布按钮 class（仅用于审计，不含任何用户隐私） */
  buttonClass?: string
  /** 派发点击的时间戳（毫秒） */
  clickedAt: number
  /** 安全计时（毫秒，仅数字），供 host 侧写入诊断时间线 */
  timings: { totalMs: number }
}

/**
 * 最终提交：在用户显式触发下，点击闲鱼发布页的真实发布按钮（一次性）。
 *
 * 设计要点：
 * 1. 提交前重新校验页面状态仍有效：仍处于发布页、已登录、无验证码风控，
 *    且描述 / 售价 / 原价 / 已上传图片等关键字段仍非空（防止页面被改动后盲提交）；
 * 2. 只使用真实发布按钮作用域选择器
 *    `html.page-publish #content button[class*="publish-button"]`（来源于迁移前
 *    `.p0-runtime/main/publish-helper.js` 的实现与真实发布页 DOM 核对报告），并对命中元素
 *    追加“唯一性 / 文本恰为“发布” / 可见且未禁用”三重校验：
 *    - 唯一性：命中数必须恰为 1，多个（如包装器 / 其它同名按钮）时拒绝，绝不取第一个；
 *    - 文本：`textContent.trim()` 必须恰为“发布”，否则视为命中了包装器 / 其它按钮；
 *    - 可点击：必须可见（非 hidden / aria-hidden，且 `getBoundingClientRect` 有正尺寸）
 *      且未禁用；
 *    绝不猜测或点击任何其它按钮 / 元素；
 * 3. 找到且可点击时**只点击一次**并立即返回；是否真正发布成功由 host 侧依据官方「我的商品库」
 *    在售商品数严格 +1（after === before + 1）判定，绝不凭标签页跳转判定，页面内不做二次点击；
 * 4. 未找到 / 不可点击 / 页面状态失效时，返回结构化 `clicked:false`，绝不假成功。
 *
 * 该函数会被注入到页面执行，必须完全自包含，禁止引用模块作用域变量。
 */
export const injectClickPublishSubmit = (): PublishSubmitInjectionResult => {
  const clickedAt = Date.now()
  const startedAt = clickedAt
  const queryFirst = (selectors: string[]): HTMLElement | null => {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel)
        if (el) return el as HTMLElement
      } catch {
        // 忽略无效选择器
      }
    }
    return null
  }

  const notClicked = (
    code: PublishSubmitInjectionResult['code'],
    reason: string,
  ): PublishSubmitInjectionResult => ({
    clicked: false,
    code,
    reason,
    clickedAt,
    timings: { totalMs: Math.max(0, Date.now() - startedAt) },
  })

  try {
    const href =
      typeof window !== 'undefined' && window.location ? String(window.location.href) : ''
    if (!href.includes('goofish.com/publish')) {
      return notClicked('SUBMIT_PAGE_INVALID', '当前标签页不在闲鱼发布页')
    }
    if (href.includes('login.taobao.com') || href.includes('login.m.taobao.com')) {
      return notClicked('NOT_LOGGED_IN', '发布页已跳转登录页，登录态失效')
    }
    try {
      if (
        document.querySelector(
          '.baxia-dialog, [class*="punish"], #nc_1_wrapper, [class*="captcha"], #sufei-dialog',
        )
      ) {
        return notClicked('VERIFICATION_REQUIRED', '发布页出现验证码 / 滑块风控')
      }
    } catch {
      // 忽略选择器异常
    }

    // ---- 关键字段仍非空校验（后台已先填表，这里做提交前最终确认） ----
    const descEl = queryFirst([
      '[contenteditable="true"][data-placeholder]',
      '[class^="editor--"]',
      '[class*="editor"] [contenteditable="true"]',
      '[contenteditable="true"]',
      'textarea[placeholder*="描述"]',
      '[data-placeholder*="描述"]',
      'textarea',
    ])
    const readText = (el: HTMLElement | null): string => {
      if (!el) return ''
      try {
        // 仅表单输入控件（INPUT/TEXTAREA）读取 value；其余元素（含 BUTTON 与 contenteditable）
        // 一律读取文本内容。真实 HTMLButtonElement 始终存在 value 属性（默认空串），
        // 若用 `'value' in el` 判断会把 BUTTON 的空 value 误当成按钮文案，导致误拒绝提交。
        const tag = String(el.tagName ?? '').toUpperCase()
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          const v = (el as HTMLInputElement | HTMLTextAreaElement).value
          return typeof v === 'string' ? v : String(v ?? '')
        }
        const text = el.textContent
        if (typeof text === 'string' && text.length > 0) return text
        const inner = el.innerText
        return typeof inner === 'string' ? inner : String(text ?? '')
      } catch {
        return ''
      }
    }
    if (!descEl || readText(descEl).trim().length === 0) {
      return notClicked('FORM_FIELD_CHANGED', '发布描述为空，页面状态已失效，拒绝提交')
    }

    const inputByLabelFor = (id: string): HTMLInputElement | null => {
      try {
        const label = document.querySelector(`label[for="${id}"]`) as HTMLElement | null
        if (!label) return null
        if (typeof label.querySelector === 'function') {
          const wrapped = label.querySelector('input')
          if (wrapped) return wrapped as HTMLInputElement
        }
        let formItem: HTMLElement | null = null
        try {
          formItem =
            typeof label.closest === 'function'
              ? (label.closest('.ant-form-item') as HTMLElement | null)
              : null
        } catch {
          formItem = null
        }
        const scope: ParentNode = formItem ?? document
        const input =
          typeof scope.querySelector === 'function'
            ? scope.querySelector('input.ant-input, input')
            : null
        return (input as HTMLInputElement | null) ?? null
      } catch {
        return null
      }
    }

    const priceInput =
      inputByLabelFor('itemPriceDTO_priceInCent') ??
      queryFirst([
        '.priceWrap--nKmMUJ5X input.ant-input',
        'div[class*="priceWrap"] input.ant-input',
        'input[placeholder="0.00"]',
      ])
    if (!priceInput || readText(priceInput).trim().length === 0) {
      return notClicked('FORM_FIELD_CHANGED', '售价为空，页面状态已失效，拒绝提交')
    }

    const origPriceInput =
      inputByLabelFor('itemPriceDTO_origPriceInCent') ?? null
    if (origPriceInput && readText(origPriceInput).trim().length === 0) {
      return notClicked('FORM_FIELD_CHANGED', '划线原价为空，页面状态已失效，拒绝提交')
    }

    let uploadedCount = 0
    try {
      uploadedCount = document.querySelectorAll(
        'img[src^="blob:"], img[src^="data:"], [class*="upload"] img, [class*="imgWrap"] img',
      ).length
    } catch {
      uploadedCount = 0
    }
    if (uploadedCount === 0) {
      return notClicked('FORM_FIELD_CHANGED', '未检测到已上传图片，页面状态已失效，拒绝提交')
    }

    // ---- 配送（邮费）提交前确认：不满足禁止提交 ----
    try {
      const groups = Array.from(document.querySelectorAll('.ant-radio-group')) as HTMLElement[]
      const shipGroup = groups.find((group) =>
        /包邮|按距离计费|一口价|无需邮寄/.test(String(group.textContent ?? '')),
      )
      if (shipGroup) {
        const checked = shipGroup.querySelector(
          'input.ant-radio-input:checked, input[type="radio"]:checked',
        ) as HTMLInputElement | null
        const mode = checked ? String(checked.value ?? '') : ''
        // value 2 = 一口价（按金额收费，必须已填邮费）；包邮(0)/无需邮寄(3) 无需金额。
        if (mode === '2') {
          const postLabel = document.querySelector(
            'label[for="itemPostFeeDTO_postPriceInCent"]',
          ) as HTMLElement | null
          const postItem =
            postLabel && typeof postLabel.closest === 'function'
              ? (postLabel.closest('.ant-form-item') as HTMLElement | null)
              : null
          const postInput =
            postItem && typeof postItem.querySelector === 'function'
              ? (postItem.querySelector('input.ant-input, input') as HTMLInputElement | null)
              : null
          const feeVal = postInput ? String(postInput.value ?? '').trim() : ''
          if (feeVal.length === 0) {
            return notClicked(
              'FORM_VALIDATION_FAILED',
              '配送方式为“一口价”但邮费为空：请填写邮费或改为包邮后重试',
            )
          }
        }
      }
    } catch {
      // 忽略选择器异常，交由后续按钮定位兜底
    }

    // ---- 所在地提交前确认：为空禁止提交（不自动选择地区） ----
    try {
      const locLabel = document.querySelector('label[for="itemAddrDTO"]') as HTMLElement | null
      if (locLabel) {
        const locItem =
          typeof locLabel.closest === 'function'
            ? (locLabel.closest('.ant-form-item') as HTMLElement | null)
            : null
        const locContent =
          locItem && typeof locItem.querySelector === 'function'
            ? (locItem.querySelector('.ant-form-item-control-input-content') as HTMLElement | null)
            : null
        const locVal = locContent
          ? String(locContent.textContent ?? '').replace(/\s+/g, ' ').trim()
          : ''
        if (locVal.length === 0) {
          return notClicked(
            'FORM_VALIDATION_FAILED',
            '宝贝所在地为空：请先在发布页选择所在地后重试（不自动选择地区）',
          )
        }
      }
    } catch {
      // 忽略选择器异常
    }

    // ---- 定位真实发布按钮（真实作用域选择器，绝不猜测、绝不命中包装器/其它按钮） ----
    // 选择器来自真实发布页 DOM 核对报告：按钮位于 html.page-publish 的 #content 容器内，
    // 且正是 `button` 标签；限定作用域 + 标签，避免命中同名 class 的包装器或其它按钮。
    const publishButtonSelector = 'html.page-publish #content button[class*="publish-button"]'
    let candidates: HTMLElement[] = []
    try {
      candidates = Array.from(
        document.querySelectorAll(publishButtonSelector),
      ) as HTMLElement[]
    } catch {
      candidates = []
    }

    // 校验一·唯一性：必须恰为 1 个命中，0 个视为未找到，>1 个视为无法唯一确定（拒绝）。
    if (candidates.length === 0) {
      return notClicked(
        'SUBMIT_BUTTON_NOT_FOUND',
        `未找到真实发布按钮 ${publishButtonSelector}`,
      )
    }
    if (candidates.length > 1) {
      return notClicked(
        'SUBMIT_BUTTON_NOT_FOUND',
        `发布按钮选择器命中 ${candidates.length} 个元素，无法唯一确定真实发布按钮，拒绝提交`,
      )
    }
    const publishButton = candidates[0]

    // 校验二·文本：必须恰为“发布”，否则视为命中了包装器 / 其它按钮。
    const buttonText = readText(publishButton).trim()
    if (buttonText !== '发布') {
      return notClicked(
        'SUBMIT_BUTTON_NOT_FOUND',
        `命中元素文本非“发布”（实际“${buttonText}”），拒绝点击以免误触包装器 / 其它按钮`,
      )
    }

    // 校验三·可点击：必须可见（非 hidden / aria-hidden，且有正尺寸）且未禁用。
    const isVisible = (el: HTMLElement): boolean => {
      try {
        if ((el as HTMLElement).hidden === true) return false
        if (typeof el.getAttribute === 'function') {
          if (el.getAttribute('hidden') !== null) return false
          if (el.getAttribute('aria-hidden') === 'true') return false
        }
        if (typeof el.getBoundingClientRect === 'function') {
          const rect = el.getBoundingClientRect()
          if (!rect || rect.width <= 0 || rect.height <= 0) return false
        }
        return true
      } catch {
        return false
      }
    }

    const className = String(publishButton.className ?? '')
    const disabledAttr =
      (publishButton as HTMLButtonElement).disabled === true ||
      publishButton.getAttribute('disabled') !== null
    if (className.indexOf('disabled') >= 0 || disabledAttr) {
      return {
        clicked: false,
        code: 'SUBMIT_BUTTON_DISABLED',
        reason: '发布按钮当前不可点击（disabled）',
        buttonClass: className,
        clickedAt,
        timings: { totalMs: Math.max(0, Date.now() - startedAt) },
      }
    }
    if (!isVisible(publishButton)) {
      return {
        clicked: false,
        code: 'SUBMIT_BUTTON_DISABLED',
        reason: '发布按钮当前不可见，视为不可点击，拒绝提交',
        buttonClass: className,
        clickedAt,
        timings: { totalMs: Math.max(0, Date.now() - startedAt) },
      }
    }

    // ---- 只点击一次，立即返回；是否成功由 host 侧依据官方「我的商品库」在售数严格 +1 判定 ----
    publishButton.click()
    return {
      clicked: true,
      buttonClass: className,
      clickedAt: Date.now(),
      timings: { totalMs: Math.max(0, Date.now() - startedAt) },
    }
  } catch (err) {
    const message =
      err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err)
    return notClicked('SUBMIT_PAGE_INVALID', `提交前校验执行异常: ${message}`)
  }
}
