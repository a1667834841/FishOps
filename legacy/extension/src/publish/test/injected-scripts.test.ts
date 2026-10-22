/**
 * 注入脚本纯性与序列化隔离测试（P8）。
 *
 * 核心目标：`chrome.scripting.executeScript({ func })` 会把函数源码序列化后注入到目标页面，
 * 函数体不允许引用 background 模块作用域中的任何变量。这里通过 `node:vm` 把注入函数源码
 * 放入一个全新的、仅含页面全局对象的上下文求值，从而真实复现“跨进程序列化注入”的行为：
 * - 若函数体引用了模块作用域变量，求值/执行时会抛 ReferenceError，测试即失败；
 * - 覆盖字段回读校验、图片逐张顺序与失败序号、以及“绝不点击发布按钮”的安全约束。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import {
  injectCheckPageStatus,
  injectClickPublishSubmit,
  injectFillPublishForm,
  type PublishFillInjectionPayload,
} from '../injected-scripts'

interface FakeElement {
  tagName: string
  value?: string
  textContent?: string
  accept?: string
  placeholder?: string
  id?: string
  ariaLabel?: string
  className?: string
  disabled?: boolean
  hidden?: boolean
  parentElement?: FakeElement | null
  files: FakeFileLike[] | null
  events: string[]
  dispatchEvent: (event: { type: string }) => boolean
  getAttribute: (name: string) => string | null
  getBoundingClientRect?: () => { width: number; height: number }
  closest: (selector: string) => FakeElement | null
  querySelector: (selector: string) => FakeElement | null
  querySelectorAll?: (selector: string) => FakeElement[]
  click: () => void
}

interface FakeFileLike {
  name: string
  type: string
  size: number
}

interface FakeDomOptions {
  title?: boolean
  desc?: boolean
  price?: boolean
  file?: boolean
  captcha?: boolean
  fileAcceptsAll?: boolean
  /** 页面渲染出的图片预览缩略图数量（用于验证回读确认不依赖旧 input 引用） */
  previewImages?: number
  /** 模拟上传后组件接管文件并把 input.files 重置为空（页面重渲染常见行为） */
  resetFileInputAfterUpload?: boolean
  /**
   * 价格输入框场景：
   * - `priceWrap`（默认）：两个无上下文的价格框；
   * - `labeled`：两个带“售价/原价”上下文标签的 placeholder=0.00 框；
   * - `labeledWithDecoy`：在“售价/原价”之前插入一个“运费”噪音框，
   *   用于验证精准定位不会按出现顺序误选。
   */
  priceScenario?: 'priceWrap' | 'labeled' | 'labeledWithDecoy'
  fetchImpl?: (url: string) => Promise<unknown>
  /** 发布按钮场景：enabled 可点击；disabled 禁用；false 不存在（默认 enabled） */
  publishButton?: 'enabled' | 'disabled' | false
  /** 发布按钮可见文本（默认“发布”；设为其它值用于验证文本校验） */
  publishButtonText?: string
  /** 发布按钮是否可见（默认 true；false 时给予 0 尺寸以模拟不可见） */
  publishButtonVisible?: boolean
  /**
   * 发布按钮选择器命中数量（默认 1）。
   * 大于 1 时模拟“包装器 / 其它同名按钮”干扰，真实按钮置于末尾，
   * 用于验证唯一性校验不取第一个、绝不误点包装器。
   */
  publishButtonCount?: number
  /** 多候选场景中干扰元素的文本（默认“发布设置”） */
  publishButtonDecoyText?: string
  /** 配送方式场景：'free' 包邮；'paid' 收费（需填邮费）；缺省不渲染 radio group */
  shippingMode?: 'free' | 'paid'
  /** 初始选中的配送 radio value（0 包邮 / 1 按距离计费 / 2 一口价 / 3 无需邮寄），缺省按 mode 推断 */
  shippingCheckedValue?: string
  /** 邮费输入框初始值（默认空串） */
  postFeeValue?: string
  /** 所在地控件场景：字符串为默认地址；'' 为空；false 表示不渲染所在地控件 */
  location?: string | false
  /** 官方内联表单校验提示（root guard 探测）；visible:false 模拟已隐藏的旧提示 */
  officialValidation?: Array<{ text: string; visible?: boolean }>
  /** 官方 toast 浮层提示（root guard 探测）；visible:false 模拟已隐藏的旧 toast */
  officialToasts?: Array<{ text: string; visible?: boolean }>
}

/**
 * 构造最小化的页面 DOM 与全局对象，用于在 vm 沙箱中执行注入函数。
 * 返回的 sandbox 只包含“注入页面本来就存在的”能力，绝不暴露本模块的任何变量。
 */
function createInjectionSandbox(options: FakeDomOptions = {}) {
  const makeElement = (tagName: string, init: Partial<FakeElement> = {}): FakeElement => ({
    tagName,
    files: null,
    events: [],
    getAttribute(name) {
      const map: Record<string, string | undefined> = {
        placeholder: this.placeholder,
        id: this.id,
        'aria-label': this.ariaLabel,
      }
      if (name === 'disabled') return this.disabled ? 'disabled' : null
      const value = map[name]
      return value === undefined || value === null ? null : String(value)
    },
    dispatchEvent(event) {
      this.events.push(event.type)
      return true
    },
    closest() {
      return null
    },
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    click() {
      this.events.push('click')
    },
    ...init,
  })

  /**
   * 构造真实页面结构的价格输入框：input **无 id**，标签文本挂在最近
   * .ant-form-item 内的 .ant-form-item-label 节点上（如“价格* / 原价 / 邮费*”）。
   */
  const makeLabeledPrice = (labelText: string): FakeElement => {
    const input = makeElement('INPUT', { value: '', placeholder: '0.00' })
    const labelEl = makeElement('LABEL', { textContent: labelText })
    const formItem = makeElement('DIV', {
      querySelector: (selector: string) =>
        selector.indexOf('ant-form-item-label') >= 0 ? labelEl : null,
    })
    input.closest = (selector: string) =>
      selector.indexOf('form-item') >= 0 ? formItem : null
    return input
  }

  // 官方提示元素（toast / 内联校验）：textContent 承载原文；visible:false 用 hidden 模拟隐藏。
  const makeNotice = (n: { text: string; visible?: boolean }): FakeElement =>
    makeElement('DIV', {
      textContent: n.text,
      ...(n.visible === false ? { hidden: true } : {}),
    })
  const officialValidationEls = (options.officialValidation ?? []).map(makeNotice)
  const officialToastEls = (options.officialToasts ?? []).map(makeNotice)

  const titleEl = makeElement('TEXTAREA', { value: '' })
  const descEl = makeElement('DIV', { textContent: '' })
  const useLabeledPrice =
    options.priceScenario === 'labeled' || options.priceScenario === 'labeledWithDecoy'
  const priceEl = useLabeledPrice ? makeLabeledPrice('价格*') : makeElement('INPUT', { value: '' })
  const origEl = useLabeledPrice ? makeLabeledPrice('原价') : makeElement('INPUT', { value: '' })
  const decoyEl = makeLabeledPrice('邮费*')
  const priceCandidateList = (): FakeElement[] =>
    options.priceScenario === 'labeledWithDecoy' ? [decoyEl, priceEl, origEl] : [priceEl, origEl]
  const fileEl = makeElement('INPUT', {
    accept: options.fileAcceptsAll ? undefined : 'image/*',
  })

  // 真实发布按钮：class 含 publish-button（与 .p0-runtime/main/publish-helper.js 真实选择器一致），
  // 文本恰为“发布”；visible/tall 尺寸用于可见性校验。
  const publishButtonEl = makeElement('BUTTON', {
    textContent: options.publishButtonText ?? '发布',
    // 真实 DOM 的 HTMLButtonElement 始终拥有 value 属性（默认空串），这里如实建模，
    // 用于锁定“读取按钮文案必须按标签类型取值（BUTTON 走 textContent）、绝不误读 value”的行为。
    value: '',
    className:
      options.publishButton === 'disabled'
        ? 'publish-button disabled'
        : 'publish-button',
    disabled: options.publishButton === 'disabled',
    ...(options.publishButtonVisible === false
      ? { getBoundingClientRect: () => ({ width: 0, height: 0 }) }
      : {}),
  })

  if (options.resetFileInputAfterUpload) {
    // 模拟上传组件接管文件后重置 input.files：任何写入都被丢弃，
    // 真实的“已上传”只能通过页面预览图回读确认。
    Object.defineProperty(fileEl, 'files', {
      configurable: true,
      get() {
        return null
      },
      set() {
        // 丢弃写入
      },
    })
  }

  // ---- 配送（邮费）与所在地真实 DOM 建模（对齐真实发布页 selectors） ----
  const radioLabels = ['包邮', '按距离计费', '一口价', '无需邮寄']
  const radioValues = ['0', '1', '2', '3']
  const radioInputs: FakeElement[] = []
  const makeShippingRadio = (value: string): FakeElement => {
    const input = makeElement('INPUT', { value, className: 'ant-radio-input' })
    let checked = value === (options.shippingCheckedValue ?? (options.shippingMode === 'paid' ? '2' : '0'))
    Object.defineProperty(input, 'checked', {
      configurable: true,
      get: () => checked,
      set: (next: boolean) => {
        checked = next
      },
    })
    // 模拟原生 radio 点击：同组互斥，点击后选中自身。
    input.dispatchEvent = (event: { type: string }) => {
      input.events.push(event.type)
      if (event && (event.type === 'click' || event.type === 'change')) {
        for (const other of radioInputs) {
          const descriptor = Object.getOwnPropertyDescriptor(other, 'checked')
          if (descriptor && descriptor.set) descriptor.set.call(other, false)
        }
        checked = true
      }
      return true
    }
    radioInputs.push(input)
    return input
  }
  const shippingRadios = radioValues.map((value) => makeShippingRadio(value))
  const shippingLabels = shippingRadios.map((input, index) => {
    const label = makeElement('LABEL', {
      className: 'ant-radio-wrapper',
      textContent: radioLabels[index],
    })
    label.querySelector = (selector: string) =>
      selector.indexOf('ant-radio-input') >= 0 || selector.indexOf('input') >= 0 ? input : null
    return label
  })
  const shippingGroup = makeElement('DIV', { className: 'ant-radio-group' })
  shippingGroup.textContent = radioLabels.join('')
  shippingGroup.querySelectorAll = (selector: string) =>
    selector.indexOf('ant-radio-wrapper') >= 0 ? shippingLabels : []
  shippingGroup.querySelector = (selector: string) => {
    if (selector.indexOf(':checked') >= 0) {
      return radioInputs.find((input) => Boolean((input as { checked?: boolean }).checked)) ?? null
    }
    return null
  }

  const postFeeInputEl = makeElement('INPUT', {
    value: options.postFeeValue ?? '',
    placeholder: '0.00',
    className: 'ant-input',
  })
  const postFeeFormItem = makeElement('DIV', { className: 'ant-form-item' })
  postFeeFormItem.querySelector = (selector: string) =>
    selector.indexOf('ant-input') >= 0 || selector.indexOf('input') >= 0 ? postFeeInputEl : null
  postFeeInputEl.closest = (selector: string) =>
    selector.indexOf('form-item') >= 0 ? postFeeFormItem : null
  postFeeInputEl.getBoundingClientRect = () => ({ width: 236, height: 34 })
  const postFeeLabel = makeElement('LABEL', {
    className: 'ant-form-item-required',
    textContent: '邮费*',
  })
  postFeeLabel.closest = (selector: string) =>
    selector.indexOf('form-item') >= 0 ? postFeeFormItem : null

  const locationPresent = options.location !== false
  const locationContentEl = makeElement('DIV', {
    textContent: typeof options.location === 'string' ? options.location : '外滩',
  })
  const locationFormItem = makeElement('DIV', {
    className: 'ant-form-item ant-form-item-has-success',
  })
  locationFormItem.querySelector = (selector: string) =>
    selector.indexOf('ant-form-item-control-input-content') >= 0 ? locationContentEl : null
  const locationLabel = makeElement('LABEL', { textContent: '宝贝所在地' })
  locationLabel.closest = (selector: string) =>
    selector.indexOf('form-item') >= 0 ? locationFormItem : null

  const fakeDocument = {
    querySelector(selector: string) {
      if (options.captcha && selector.indexOf('baxia') >= 0) return makeElement('DIV')
      if (
        options.publishButton !== false &&
        selector.indexOf('publish-button') >= 0
      ) {
        return publishButtonEl
      }
      if (
        options.price !== false &&
        (selector.indexOf('priceWrap') >= 0 || selector.indexOf('placeholder="0.00"') >= 0)
      ) {
        return priceEl
      }
      if (selector.indexOf('标题') >= 0 && options.title !== false) return titleEl
      if (selector.indexOf('editor') >= 0 && options.desc !== false) return descEl
      if (selector.indexOf('itemPostFeeDTO_postPriceInCent') >= 0) return postFeeLabel
      if (selector.indexOf('itemAddrDTO') >= 0) return locationPresent ? locationLabel : null
      return null
    },
    querySelectorAll(selector: string) {
      if (selector.indexOf('form-item-explain') >= 0) return officialValidationEls
      if (selector.indexOf('toast') >= 0) return officialToastEls
      if (selector.indexOf('publish-button') >= 0) {
        if (options.publishButton === false) return []
        const count = options.publishButtonCount ?? 1
        if (count <= 1) return [publishButtonEl]
        // 多候选：模拟包装器 / 其它同名按钮与真实按钮同时命中，真实按钮置于末尾
        const decoys = Array.from({ length: count - 1 }, () =>
          makeElement('BUTTON', {
            className: 'publish-button-wrap',
            textContent: options.publishButtonDecoyText ?? '发布设置',
          }),
        )
        return [...decoys, publishButtonEl]
      }
      if (typeof options.previewImages === 'number' && selector.indexOf('blob:') >= 0) {
        return Array.from({ length: options.previewImages }, () => makeElement('IMG'))
      }
      if (options.file !== false && selector.indexOf('input[type="file"]') >= 0) return [fileEl]
      if (
        options.price !== false &&
        (selector.indexOf('priceWrap') >= 0 || selector.indexOf('placeholder="0.00"') >= 0)
      ) {
        return priceCandidateList()
      }
      if (selector.indexOf('ant-radio-group') >= 0) {
        return options.shippingMode ? [shippingGroup] : []
      }
      return []
    },
  }

  class FakeEvent {
    type: string
    bubbles?: boolean
    constructor(type: string, init?: { bubbles?: boolean; [key: string]: unknown }) {
      this.type = type
      this.bubbles = init?.bubbles
    }
  }
  class FakeInputEvent extends FakeEvent {}
  class FakeMouseEvent extends FakeEvent {}

  class FakeFile implements FakeFileLike {
    name: string
    type: string
    size: number
    constructor(parts: Array<{ size?: number }>, name: string, init?: { type?: string }) {
      this.name = name
      this.type = init?.type ?? ''
      this.size = parts.reduce((sum, p) => sum + (p.size ?? 0), 0)
    }
  }

  class FakeDataTransfer {
    private readonly fileList: FakeFileLike[] = []
    readonly items = {
      add: (file: FakeFileLike) => {
        this.fileList.push(file)
      },
    }
    get files(): FakeFileLike[] {
      return this.fileList
    }
  }

  const defaultFetch = async () => ({
    ok: true,
    status: 200,
    blob: async () => ({ size: 16, type: 'image/jpeg' }),
  })

  const sandbox: Record<string, unknown> = {
    window: { location: { href: 'https://www.goofish.com/publish' } },
    document: fakeDocument,
    fetch: options.fetchImpl ?? defaultFetch,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    Event: FakeEvent,
    InputEvent: FakeInputEvent,
    MouseEvent: FakeMouseEvent,
    setTimeout,
    clearTimeout,
    URL,
    console,
  }

  return {
    sandbox,
    elements: {
      titleEl,
      descEl,
      priceEl,
      origEl,
      decoyEl,
      fileEl,
      publishButtonEl,
      shippingGroup,
      postFeeInputEl,
      locationContentEl,
    },
  }
}

/**
 * 模拟 executeScript 的“序列化注入”：把函数 toString 后放入隔离上下文重新求值。
 */
function materializeInjected<T extends (...args: any[]) => any>(fn: T, sandbox: Record<string, unknown>): T {
  const code = `(${fn.toString()})`
  return vm.runInNewContext(code, sandbox) as T
}

test('注入脚本纯性: 函数源码自包含，不含模块级引用与任何提交调用', () => {
  const fnSource = injectFillPublishForm.toString()
  const statusSource = injectCheckPageStatus.toString()

  // 不得引用模块作用域符号（PublishError / 导入 / this / exports 等）
  for (const forbidden of ['PublishError', 'require(', 'module.exports', 'import ', 'this.', 'controller', 'formFiller']) {
    assert.ok(!fnSource.includes(forbidden), `注入函数不得引用模块作用域符号: ${forbidden}`)
  }

  // 安全铁律：填充与探测函数绝不出现任何触发提交/点击的调用
  for (const forbidden of ['.click(', '.submit(', 'requestSubmit', "dispatchEvent(new Event('submit'", 'form.submit']) {
    assert.ok(!fnSource.includes(forbidden), `填充函数不得包含提交调用: ${forbidden}`)
    assert.ok(!statusSource.includes(forbidden), `探测函数不得包含提交调用: ${forbidden}`)
  }

  // 提交函数必须完全自包含（不得引用模块作用域符号）
  const submitSource = injectClickPublishSubmit.toString()
  for (const forbidden of ['PublishError', 'require(', 'module.exports', 'import ', 'controller', 'formFiller']) {
    assert.ok(!submitSource.includes(forbidden), `提交函数不得引用模块作用域符号: ${forbidden}`)
  }
})

test('注入脚本纯性: injectCheckPageStatus 在隔离上下文中可独立运行', () => {
  const { sandbox } = createInjectionSandbox()
  const fn = materializeInjected(injectCheckPageStatus, sandbox)

  const result = fn()
  assert.equal(result.isPublishPage, true)
  assert.equal(result.isLoggedIn, true)
  assert.equal(result.hasCaptcha, false)
})

test('注入脚本纯性: injectCheckPageStatus 命中验证码时返回 hasCaptcha=true', () => {
  const { sandbox } = createInjectionSandbox({ captcha: true })
  const fn = materializeInjected(injectCheckPageStatus, sandbox)

  const result = fn()
  assert.equal(result.hasCaptcha, true)
})

test('注入填充: 在隔离上下文完成全部字段填充与回读校验（图片顺序正确）', async () => {
  const { sandbox, elements } = createInjectionSandbox()
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const payload: PublishFillInjectionPayload = {
    title: '隔离校验标题',
    desc: '隔离校验描述内容',
    price: 199.9,
    originalPrice: 999.5,
    imageUrls: ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  }

  const result = await fn(payload)

  assert.equal(result.titleFilled, true)
  assert.equal(result.descFilled, true)
  assert.equal(result.priceFilled, true)
  assert.equal(result.origPriceFilled, true)
  assert.equal(result.mainImageUploaded, true)
  assert.equal(result.imagesUploadedCount, 2)
  assert.equal(result.detailImagesCount, 1)
  assert.equal(result.imagesFailed.length, 0)
  assert.equal(result.errors.length, 0)

  // 回读校验：元素最终值应与期望一致
  assert.equal(elements.titleEl.value, payload.title)
  assert.equal(elements.descEl.textContent, payload.desc)
  assert.equal(elements.priceEl.value, String(payload.price))
  assert.equal(elements.origEl.value, String(payload.originalPrice))

  // 图片按顺序写入文件控件，第 1 张为主图
  assert.equal(elements.fileEl.files?.length, 2)
  assert.equal(elements.fileEl.files?.[0]?.name, 'main-image.jpg')
  assert.equal(elements.fileEl.files?.[1]?.name, 'detail-image-1.jpg')
})

test('注入填充: 第二张图片下载失败时指出序号且绝不标记图片成功', async () => {
  const { sandbox } = createInjectionSandbox({
    fetchImpl: async (url) => {
      if (url.indexOf('/2.jpg') >= 0) {
        return { ok: false, status: 404, blob: async () => ({ size: 0, type: '' }) }
      }
      return { ok: true, status: 200, blob: async () => ({ size: 16, type: 'image/jpeg' }) }
    },
  })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(result.imagesFailed.length, 1)
  assert.equal(result.imagesFailed[0]?.index, 2)
  assert.ok(result.imagesFailed[0]?.url.includes('/2.jpg'))
  assert.equal(result.mainImageUploaded, false) // 绝不把未上传成功的图片标记成功
  assert.equal(result.imagesUploadedCount, 1)
  assert.ok(result.errors.some((e) => e.includes('第 2 张')))
})

test('注入填充: 非 HTTPS 图片被拦截并指出序号，整体图片不标记成功', async () => {
  const { sandbox } = createInjectionSandbox()
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['http://img.example.com/1.jpg', 'https://img.example.com/2.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(result.imagesFailed.length, 1)
  assert.equal(result.imagesFailed[0]?.index, 1)
  assert.ok(result.imagesFailed[0]?.error.includes('HTTPS'))
  assert.equal(result.mainImageUploaded, false)
})

test('注入填充 root guard: 可见 toast「当前分类不支持网页端发布」→ PUBLISH_CATEGORY_UNSUPPORTED', async () => {
  const { sandbox } = createInjectionSandbox({
    officialToasts: [{ text: '当前分类不支持网页端发布' }],
  })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(result.officialBlock?.code, 'PUBLISH_CATEGORY_UNSUPPORTED')
  assert.equal(result.officialBlock?.source, 'toast')
  assert.ok(result.officialBlock?.message.includes('不支持网页端发布'))
})

test('注入填充 root guard: 表单内联「商品描述不能包含emoji」→ FORM_VALIDATION_FAILED（不误判图片）', async () => {
  const { sandbox } = createInjectionSandbox({
    officialValidation: [{ text: '商品描述不能包含emoji' }],
  })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(result.officialBlock?.code, 'FORM_VALIDATION_FAILED')
  assert.equal(result.officialBlock?.source, 'form-validation')
  assert.ok(result.officialBlock?.message.includes('emoji'))
})

test('注入填充 root guard: 分类不支持优先于 emoji（根本阻断最高优先）', async () => {
  const { sandbox } = createInjectionSandbox({
    officialToasts: [{ text: '当前分类不支持网页端发布' }],
    officialValidation: [{ text: '商品描述不能包含emoji' }],
  })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(result.officialBlock?.code, 'PUBLISH_CATEGORY_UNSUPPORTED')
})

test('注入填充 root guard: 隐藏的旧 toast 不污染当前判定（不得误报阻断）', async () => {
  const { sandbox } = createInjectionSandbox({
    officialToasts: [{ text: '当前分类不支持网页端发布', visible: false }],
    officialValidation: [{ text: '商品描述不能包含emoji', visible: false }],
    previewImages: 1,
  })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(result.officialBlock, undefined)
})

test('注入填充 root guard: 无可见官方提示时 officialBlock 缺省', async () => {
  const { sandbox } = createInjectionSandbox({ previewImages: 1 })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(result.officialBlock, undefined)
})

test('注入填充: 页面控件缺失时返回结构化失败而非抛出/假成功', async () => {
  const { sandbox } = createInjectionSandbox({ title: false, desc: false, price: false, file: false })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    waitTimeoutMs: 5,
    renderSettleMs: 1,
  })

  assert.equal(result.titleFilled, false)
  assert.equal(result.descFilled, false)
  assert.equal(result.priceFilled, false)
  assert.equal(result.mainImageUploaded, false)
  assert.ok(result.errors.length >= 3)
})

test('注入填充: 回读校验失败（页面改写字段值）时不标记字段成功', async () => {
  const { sandbox, elements } = createInjectionSandbox()
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  // 模拟受控组件把售价改写为 0，回读即失败
  elements.priceEl.dispatchEvent = function (event: { type: string }) {
    this.events.push(event.type)
    if (event.type === 'input') {
      this.value = '0'
    }
    return true
  }

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 199,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(result.priceFilled, false)
  assert.ok(result.errors.some((e) => e.includes('售价')))
})

test('注入填充: 上传控件被重渲染重置时以页面预览回读确认（不依赖旧引用）', async () => {
  const { sandbox } = createInjectionSandbox({
    previewImages: 2,
    resetFileInputAfterUpload: true,
  })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  // 旧 input 引用的 files 已被重置，但页面预览图确实有 2 张，回读确认成功
  assert.equal(result.imagesUploadedCount, 2)
  assert.equal(result.mainImageUploaded, true)
  assert.equal(result.imagesFailed.length, 0)
  assert.equal(result.errors.length, 0)
})

test('注入填充: 图片写入后页面未确认任何图片时绝不标记成功（不假成功）', async () => {
  const { sandbox } = createInjectionSandbox({ resetFileInputAfterUpload: true })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  // 页面既没有预览图，上传控件的 files 也被重渲染重置，回读确认数量为 0
  assert.equal(result.imagesUploadedCount, 0)
  assert.equal(result.mainImageUploaded, false)
  assert.ok(result.errors.some((e) => e.includes('回读确认')))
})

test('注入填充: 字段在异步重渲染后清空时最终回读失败（不假成功）', async () => {
  const { sandbox, elements } = createInjectionSandbox()
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  elements.descEl.dispatchEvent = function (event: { type: string }) {
    this.events.push(event.type)
    if (event.type === 'blur') {
      // 模拟闲鱼发布页异步重渲染把已填描述清空
      setTimeout(() => {
        elements.descEl.textContent = ''
      }, 0)
    }
    return true
  }

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(result.descFilled, false)
  assert.ok(result.errors.some((e) => e.includes('描述') && e.includes('重渲染')))
})

test('注入填充: 无独立标题字段时把标题与描述融合进描述并回读通过', async () => {
  const { sandbox, elements } = createInjectionSandbox({ title: false })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: '融合标题',
    desc: '融合描述正文',
    price: 12,
    originalPrice: 60,
    imageUrls: ['https://img.example.com/1.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  // 页面没有独立标题框：标题必须融合进描述，而不是被粗暴丢弃
  assert.equal(elements.descEl.textContent, '融合标题\n融合描述正文')
  assert.equal(result.descFilled, true)
  assert.equal(result.titleFilled, true)
  assert.equal(result.priceFilled, true)
  assert.equal(result.origPriceFilled, true)
  assert.equal(result.errors.length, 0)
})

test('注入填充: 无独立标题且描述为空时以标题作为统一描述', async () => {
  const { sandbox, elements } = createInjectionSandbox({ title: false })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: '仅标题内容',
    desc: '',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(elements.descEl.textContent, '仅标题内容')
  assert.equal(result.titleFilled, true)
  assert.equal(result.descFilled, true)
})

test('注入填充: 描述已包含标题时不重复拼接标题', async () => {
  const { sandbox, elements } = createInjectionSandbox({ title: false })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: '芝麻信用',
    desc: '芝麻信用 转让自用相机，成色很新',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(elements.descEl.textContent, '芝麻信用 转让自用相机，成色很新')
  assert.equal(result.descFilled, true)
  assert.equal(result.titleFilled, true)
})

test('注入填充: input 无 id 且含“价格*/原价/邮费*”三框时精准定位售价与原价（不误选邮费）', async () => {
  // 真实现场：input 无 id，三个 placeholder=0.00 价格框，顺序为 邮费* -> 价格* -> 原价；
  // 若按出现顺序取前两个会把邮费* 误当售价，必须靠 .ant-form-item-label 文本精准区分
  const { sandbox, elements } = createInjectionSandbox({
    title: false,
    priceScenario: 'labeledWithDecoy',
  })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  // 锁定现场：三个价格框均无 id
  assert.equal(elements.decoyEl.getAttribute('id'), null)
  assert.equal(elements.priceEl.getAttribute('id'), null)
  assert.equal(elements.origEl.getAttribute('id'), null)

  const result = await fn({
    title: '价格定位标题',
    desc: '价格定位描述',
    price: 19.9,
    originalPrice: 99.5,
    imageUrls: ['https://img.example.com/1.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(elements.priceEl.value, '19.9')
  assert.equal(elements.origEl.value, '99.5')
  // 邮费框绝不能被误填成售价或原价
  assert.equal(elements.decoyEl.value, '')
  assert.equal(result.priceFilled, true)
  assert.equal(result.origPriceFilled, true)
  assert.equal(result.errors.length, 0)
})

test('注入填充: 图片未全部确认写入时不标记主图成功', async () => {
  const { sandbox } = createInjectionSandbox({
    title: false,
    previewImages: 1,
  })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  // 页面只回读确认了 1 张，却是 2 张待上传：绝不假成功
  assert.equal(result.imagesUploadedCount, 1)
  assert.equal(result.mainImageUploaded, false)
  assert.ok(result.errors.some((e) => e.includes('回读确认')))
})

test('注入提交: 页面状态有效时只点击一次真实发布按钮', () => {
  const { sandbox, elements } = createInjectionSandbox({ previewImages: 1 })
  elements.descEl.textContent = '统一描述'
  elements.priceEl.value = '14.70'

  const fn = materializeInjected(injectClickPublishSubmit, sandbox)
  const result = fn()

  assert.equal(result.clicked, true)
  assert.equal(result.buttonClass, 'publish-button')
  assert.equal(elements.publishButtonEl.events.filter((e) => e === 'click').length, 1)
})

test('注入提交: 真实 BUTTON 带空 value 时仍按 textContent 识别“发布”并点击一次', () => {
  // 回归用例：真实 DOM 的 HTMLButtonElement 始终存在 value 属性（默认空串）。
  // readText 必须按标签类型取值——BUTTON 走 textContent，绝不能因 `'value' in el` 命中
  // 而误读空 value，导致按钮文案判定失败、拒绝提交（任务 publish_08193f7154da42cb）。
  const { sandbox, elements } = createInjectionSandbox({ previewImages: 1 })
  elements.descEl.textContent = '统一描述'
  elements.priceEl.value = '14.70'
  elements.publishButtonEl.value = ''
  elements.publishButtonEl.textContent = '发布'

  const fn = materializeInjected(injectClickPublishSubmit, sandbox)
  const result = fn()

  assert.equal(result.clicked, true)
  assert.equal(result.buttonClass, 'publish-button')
  assert.equal(elements.publishButtonEl.events.filter((e) => e === 'click').length, 1)
})

test('注入提交: 使用收紧后的真实作用域选择器，绝不回退到裸选择器', () => {
  const source = injectClickPublishSubmit.toString()

  // 必须使用真实 DOM 核对报告确定的作用域选择器
  assert.ok(
    source.includes('html.page-publish #content button[class*="publish-button"]'),
    '提交函数必须使用收紧后的作用域选择器',
  )
  // 禁止回退到可能命中包装器 / 其它同名按钮的裸选择器写法
  assert.ok(
    !/querySelector\(\s*['"]button\[class\*="publish-button"\]/.test(source),
    '提交函数不得回退到裸 querySelector 选择器',
  )
})

test('注入提交: 唯一命中但文本非“发布”时拒绝（避免误点包装器/其它按钮）', () => {
  const { sandbox, elements } = createInjectionSandbox({
    previewImages: 1,
    publishButtonText: '立即发布',
  })
  elements.descEl.textContent = '统一描述'
  elements.priceEl.value = '14.70'

  const fn = materializeInjected(injectClickPublishSubmit, sandbox)
  const result = fn()

  assert.equal(result.clicked, false)
  assert.equal(result.code, 'SUBMIT_BUTTON_NOT_FOUND')
  assert.equal(elements.publishButtonEl.events.length, 0)
})

test('注入提交: 选择器命中多个元素（包装器/同名按钮）时拒绝且绝不取第一个', () => {
  const { sandbox, elements } = createInjectionSandbox({
    previewImages: 1,
    publishButtonCount: 2,
  })
  elements.descEl.textContent = '统一描述'
  elements.priceEl.value = '14.70'

  const fn = materializeInjected(injectClickPublishSubmit, sandbox)
  const result = fn()

  assert.equal(result.clicked, false)
  assert.equal(result.code, 'SUBMIT_BUTTON_NOT_FOUND')
  assert.ok((result.reason ?? '').includes('2'))
  assert.equal(elements.publishButtonEl.events.length, 0)
})

test('注入提交: 唯一命中但按钮不可见时拒绝（视为不可点击）', () => {
  const { sandbox, elements } = createInjectionSandbox({
    previewImages: 1,
    publishButtonVisible: false,
  })
  elements.descEl.textContent = '统一描述'
  elements.priceEl.value = '14.70'

  const fn = materializeInjected(injectClickPublishSubmit, sandbox)
  const result = fn()

  assert.equal(result.clicked, false)
  assert.equal(result.code, 'SUBMIT_BUTTON_DISABLED')
  assert.equal(elements.publishButtonEl.events.length, 0)
})

test('注入提交: 未找到真实发布按钮时返回结构化失败且绝不点击', () => {
  const { sandbox, elements } = createInjectionSandbox({ previewImages: 1, publishButton: false })
  elements.descEl.textContent = '统一描述'
  elements.priceEl.value = '14.70'

  const fn = materializeInjected(injectClickPublishSubmit, sandbox)
  const result = fn()

  assert.equal(result.clicked, false)
  assert.equal(result.code, 'SUBMIT_BUTTON_NOT_FOUND')
  assert.equal(elements.publishButtonEl.events.length, 0)
})

test('注入提交: 发布按钮禁用时返回结构化失败且绝不点击', () => {
  const { sandbox, elements } = createInjectionSandbox({ previewImages: 1, publishButton: 'disabled' })
  elements.descEl.textContent = '统一描述'
  elements.priceEl.value = '14.70'

  const fn = materializeInjected(injectClickPublishSubmit, sandbox)
  const result = fn()

  assert.equal(result.clicked, false)
  assert.equal(result.code, 'SUBMIT_BUTTON_DISABLED')
  assert.equal(elements.publishButtonEl.events.length, 0)
})

test('注入提交: 描述为空时拒绝提交（页面状态失效）', () => {
  const { sandbox, elements } = createInjectionSandbox({ previewImages: 1 })
  elements.priceEl.value = '14.70'

  const fn = materializeInjected(injectClickPublishSubmit, sandbox)
  const result = fn()

  assert.equal(result.clicked, false)
  assert.equal(result.code, 'FORM_FIELD_CHANGED')
  assert.equal(elements.publishButtonEl.events.length, 0)
})

test('注入提交: 命中验证码时拒绝提交', () => {
  const { sandbox, elements } = createInjectionSandbox({ previewImages: 1, captcha: true })
  elements.descEl.textContent = '统一描述'
  elements.priceEl.value = '14.70'

  const fn = materializeInjected(injectClickPublishSubmit, sandbox)
  const result = fn()

  assert.equal(result.clicked, false)
  assert.equal(result.code, 'VERIFICATION_REQUIRED')
  assert.equal(elements.publishButtonEl.events.length, 0)
})

test('注入提交: 未检测到已上传图片时拒绝提交', () => {
  const { sandbox, elements } = createInjectionSandbox({ previewImages: 0 })
  elements.descEl.textContent = '统一描述'
  elements.priceEl.value = '14.70'

  const fn = materializeInjected(injectClickPublishSubmit, sandbox)
  const result = fn()

  assert.equal(result.clicked, false)
  assert.equal(result.code, 'FORM_FIELD_CHANGED')
  assert.equal(elements.publishButtonEl.events.length, 0)
})

// ============================ 配送（邮费）与所在地 ============================

test('注入填充: 配送为包邮时映射邮费 0 并标记 postFeeFilled', async () => {
  const { sandbox } = createInjectionSandbox({ shippingMode: 'free' })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    shipping: { mode: 'free' },
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(result.postFeeFilled, true)
  assert.equal(result.shippingStatus, 'free')
})

test('注入填充: 配送为收费时切换“一口价”并填入显式邮费（回读通过）', async () => {
  const { sandbox, elements } = createInjectionSandbox({
    shippingMode: 'paid',
    shippingCheckedValue: '0',
  })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    shipping: { mode: 'paid', postFee: 12.5 },
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(result.postFeeFilled, true)
  assert.equal(result.shippingStatus, 'paid')
  assert.equal(elements.postFeeInputEl.value, '12.5')
})

test('注入填充: 收费配送缺有效邮费金额时结构化失败（绝不伪造收费）', async () => {
  const { sandbox } = createInjectionSandbox({ shippingMode: 'paid' })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    shipping: { mode: 'paid' },
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(result.postFeeFilled, false)
  assert.ok(result.errors.some((e) => e.includes('邮费')))
})

test('注入填充: 所在地已有官方默认地址时保留并标记 ready', async () => {
  const { sandbox } = createInjectionSandbox({ location: '外滩' })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(result.locationFilled, true)
  assert.equal(result.locationStatus, 'ready')
  assert.equal(result.locationValue, '外滩')
})

test('注入填充: 所在地为空时标记需用户选择且绝不自动选地区', async () => {
  const { sandbox } = createInjectionSandbox({ location: '' })
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: 't',
    desc: 'd',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  assert.equal(result.locationFilled, false)
  assert.equal(result.locationStatus, 'needs_user_selection')
  assert.ok(result.errors.some((e) => e.includes('所在地')))
})

test('注入提交: 一口价邮费为空时拒绝提交（FORM_VALIDATION_FAILED）', () => {
  const { sandbox, elements } = createInjectionSandbox({
    previewImages: 1,
    shippingMode: 'paid',
    shippingCheckedValue: '2',
    postFeeValue: '',
  })
  elements.descEl.textContent = '统一描述'
  elements.priceEl.value = '14.70'

  const fn = materializeInjected(injectClickPublishSubmit, sandbox)
  const result = fn()

  assert.equal(result.clicked, false)
  assert.equal(result.code, 'FORM_VALIDATION_FAILED')
  assert.equal(elements.publishButtonEl.events.filter((e) => e === 'click').length, 0)
})

test('注入提交: 所在地为空时拒绝提交（FORM_VALIDATION_FAILED）', () => {
  const { sandbox, elements } = createInjectionSandbox({ previewImages: 1, location: '' })
  elements.descEl.textContent = '统一描述'
  elements.priceEl.value = '14.70'

  const fn = materializeInjected(injectClickPublishSubmit, sandbox)
  const result = fn()

  assert.equal(result.clicked, false)
  assert.equal(result.code, 'FORM_VALIDATION_FAILED')
  assert.equal(elements.publishButtonEl.events.filter((e) => e === 'click').length, 0)
})

test('注入填充: 返回安全 timings（仅数字，无页面原文）', async () => {
  const { sandbox } = createInjectionSandbox()
  const fn = materializeInjected(injectFillPublishForm, sandbox)

  const result = await fn({
    title: '内部标题不得外泄',
    desc: '内部描述不得外泄',
    price: 1,
    originalPrice: 5,
    imageUrls: ['https://img.example.com/1.jpg'],
    waitTimeoutMs: 20,
    renderSettleMs: 1,
  })

  for (const key of ['totalMs', 'fieldsMs', 'imagesMs', 'validationMs'] as const) {
    assert.equal(typeof result.timings[key], 'number')
    assert.ok(result.timings[key] >= 0)
  }
  // timings 必须只是数字，绝不携带标题 / URL 等页面原文
  const json = JSON.stringify(result.timings)
  assert.ok(!json.includes('内部标题'))
  assert.ok(!json.includes('img.example.com'))
})

test('注入提交: 返回安全 timings.totalMs', () => {
  const { sandbox, elements } = createInjectionSandbox({ previewImages: 1 })
  elements.descEl.textContent = '统一描述'
  elements.priceEl.value = '14.70'

  const fn = materializeInjected(injectClickPublishSubmit, sandbox)
  const result = fn()

  assert.equal(typeof result.timings.totalMs, 'number')
  assert.ok(result.timings.totalMs >= 0)
})
