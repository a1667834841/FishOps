/**
 * 直接接口发布 —— MAIN world 自包含页面脚本。
 *
 * 该模块只导出一个函数 {@link injectDirectPublishInPage}，它会被
 * `chrome.scripting.executeScript({ func })` 序列化后注入到
 * `https://www.goofish.com/publish` 的 MAIN world 执行，**复用官方
 * `window.lib.mtop.request`** 直接调用闲鱼发布业务接口（非 DOM 填表、非纯 HTTP）。
 *
 * 硬约束（与 P8 `injected-scripts.ts` 一致）：
 * 1. **完全自包含**：函数体内部不得引用本模块作用域的任何变量 / 常量 / 辅助函数，
 *    所有 helper（sha256、金额换算、POI 归一化、上传等）都定义在函数内部；
 * 2. 入参只通过可序列化对象传入；返回值必须是可 structured clone 的普通对象；
 * 3. 只走官方 SDK：`window.lib.mtop.request`，请求参数固定
 *    `type:"POST" / appKey:"34839810" / accountSite:"xianyu" / dataType:"json" / timeout:20000`；
 * 4. 绝不输出 Cookie / token / 明文 unb：unb 只用于（a）派生不可逆账号 scope，（b）违禁词 sessionId；
 * 5. 错误信息脱敏，不含凭据与完整地址明文。
 *
 * 成功判据：`mtop.idle.pc.idleitem.publish` 的 `data.itemId` 存在，缺一不可。
 */

/** 单品规格项（下单规格融入描述，不虚构多 SKU）。 */
export interface DirectPublishSpecificationsEntry {
  name: string
  value: string
}

/** 第二种入口（product）使用的源商品数据（价格为「元」字符串）。 */
export interface DirectPublishPageProduct {
  description: string
  /**
   * @deprecated 闲鱼商品无独立标题：该字段被**忽略**，最终文案统一取 description。
   * 保留可选仅为旧调用兼容。
   */
  title?: string
  price: string
  images: string[]
  specifications?: DirectPublishSpecificationsEntry[]
}

/** 卖家发货地址（可传归一化 itemAddrDTO，也可传未加工的 POI 原始字段）。 */
export interface DirectPublishPageSellerAddress {
  prov?: string
  city?: string
  area?: string
  divisionId?: string
  poiName?: string
  poiId?: string
  gps?: string
  /** POI 原始字段（旧接口地点名）。 */
  poi?: string
  /** POI 原始字段。 */
  latitude?: number | string
  /** POI 原始字段。 */
  longitude?: number | string
  /** 可选地址文本回退。 */
  address?: string
}

/** 类目 / 属性候选值（attribute 候选选择被后台按候选 transportData 重建，不信任前端字段）。 */
export type DirectPublishPageCardValue = {
  /** 候选 valueId（类目为 channelCatId || catId || valueId）。 */
  valueId: string
  /** 候选 valueName。 */
  valueName: string
  /** 该候选的权威 transportData（原样来自推荐接口，后台据此重建 label item）。 */
  transportData: Record<string, unknown>
  /** 是否类目候选。 */
  isCategory: boolean
  /** 类目候选附加字段。 */
  catId?: string
  channelCatId?: string
  catName?: string
  leafId?: string
  tbCatId?: string
}

/** 类目 / 属性候选卡（propertyCards）。 */
export type DirectPublishPagePropertyCard = {
  cardType: string
  propertyId: string
  propertyName: string
  isCategory: boolean
  isBook: boolean
  supportWebPublish: boolean
  tips: string
  values: DirectPublishPageCardValue[]
}

/** submit 阶段后台归一化后的权威提交数据（前端不可直接构造）。 */
export type DirectPublishPageSubmitCore = {
  /**
   * @deprecated 兼容字段：描述模式**无独立标题**，后台归一化时以 description 填充；
   * 页面组装最终 payload 时**不使用**该字段（统一用最终描述作为 title/desc）。
   */
  title?: string
  /** 原始描述（不含规格追加；最终作为唯一文案，规格只追加一次）。 */
  description: string
  priceYuan: string
  specifications: DirectPublishSpecificationsEntry[]
  itemCatDTO: Record<string, string>
  itemLabelExtList: Record<string, unknown>[]
  itemAddrDTO: Record<string, string>
  imageInfoDOList: Record<string, unknown>[]
  services: Array<{ serviceCode: string; enable: boolean }>
}

/** 注入请求（分阶段）。 */
export interface DirectPublishPageRequest {
  /** 阶段：账号探测 / 准备 / 提交(publish) / 两阶段最终提交(submit) / 只读读取商品 / 本地图片上传。 */
  op: 'account' | 'prepare' | 'publish' | 'submit' | 'getProduct' | 'uploadImage'
  /** uploadImage：仅接受 data URL，不接受 blob URL 或任意远程地址。 */
  dataUrl?: string
  /** 仅用于关联脱敏日志，不得传入凭据或业务正文。 */
  traceId?: string
  /** 源商品 id（prepare / getProduct）。 */
  sourceItemId?: string
  /** 第二种入口：直接给定商品（prepare）。 */
  sourceProduct?: DirectPublishPageProduct
  /** 源商品图片下标选择（例如 [0,2]：只用已知安全的第 1、第 3 张）。 */
  imageIndexes?: number[]
  /** 卖家发货地址（与 coordinates 二选一）。 */
  sellerAddress?: DirectPublishPageSellerAddress | null
  /** 卖家坐标（与 sellerAddress 二选一；不得硬编码账号坐标）。 */
  coordinates?: { latitude: number | string; longitude: number | string } | null
  /** 服务卡偏好（默认全部 false；AI_SALE 强制 false）。 */
  servicePreferences?: Record<string, boolean>
  /** 人工确认图片无二维码（上传必需）。 */
  confirmedNoQrCodes?: boolean
  /** 后台探测到的账号 scope；prepare/publish/submit 阶段据此校验账号未漂移。 */
  expectedAccountScope?: string
  /** publish 阶段使用的已准备 payload（由 prepare 阶段返回）。 */
  preparedPayload?: Record<string, unknown> | null
  /** prepare：已有类目（作为初始选择，按候选校验，不覆盖用户选择）。 */
  category?: Record<string, string>
  /** prepare：已有属性 label items（作为初始选择，按候选校验，不覆盖用户选择）。 */
  attributes?: Array<Record<string, unknown>>
  /** submit：后台归一化后的权威提交数据。 */
  submitCore?: DirectPublishPageSubmitCore | null
  /** submit：prepare 缓存的原始推荐卡片（service cards cpvList）。 */
  rawCards?: unknown[]
  /**
   * 两阶段「审核模式」标记。
   * - true：跳过旧版二维码人工确认门禁（图片自动上传），且未显式提供 seller 时
   *   自动只读取当前账号官方默认发货地址（不回退源卖家地址）；
   * - 缺省 / false：保持旧一步式 publish 行为（QR 门禁 + seller 必填）。
   */
  reviewMode?: boolean
}

/** 页面脚本状态。 */
export type DirectPublishPageStatus =
  | 'account'
  | 'prepared'
  | 'published'
  | 'product'
  | 'uploaded'
  | 'action_required'
  | 'rejected'
  | 'unknown'

/** 页面脚本统一返回结构（可序列化）。 */
export interface DirectPublishPageResult {
  ok: boolean
  op: string
  status: DirectPublishPageStatus
  /** 需人工处理的类别。 */
  actionRequired?: 'login' | 'captcha' | 'verification'
  /** 不可逆账号 scope（unb 的 SHA-256），未登录为 null。 */
  accountScope?: string | null
  /** 发布成功的新商品 id。 */
  itemId?: string
  /** 结构化代码。 */
  code?: string
  /** 脱敏说明。 */
  message?: string
  /** prepare 阶段返回的完整提交 payload（仅内存传递，不落盘 / 不打印）。 */
  payload?: Record<string, unknown> | null
  /** getProduct 阶段返回的最小商品信息。 */
  product?: DirectPublishPageProduct
  /** uploadImage 阶段返回的真实平台图片对象。 */
  image?: Record<string, unknown>
  /** prepare 摘要。 */
  itemCount?: number
  catId?: string
  warnings?: string[]
  /** prepare：完整「实际待发送数据」草稿（submit 回传核对）。 */
  draft?: Record<string, unknown>
  /** prepare：类目 / 属性候选卡。 */
  propertyCards?: DirectPublishPagePropertyCard[]
  /** prepare：原始推荐卡片（service cards cpvList；仅内存传递）。 */
  rawCards?: unknown[]
  /** 失败阶段细分（如 source/login/network/parse/address/category/images/badwords/services），不吞异常。 */
  failureStage?: string
  /** 解析 / 前置条件缺失的字段清单（供 UI 提示补全）。 */
  missingFields?: string[]
}

/**
 * MAIN world 注入入口（自包含）。
 *
 * 注意：函数体不得引用模块作用域——所有常量与 helper 均定义在内部。
 */
export const injectDirectPublishInPage = async (
  request: DirectPublishPageRequest,
): Promise<DirectPublishPageResult> => {
  // ==================== 常量 ====================
  const OFFICIAL_APP_KEY = '34839810'
  const OFFICIAL_ACCOUNT_SITE = 'xianyu'
  const UPLOAD_APP_KEY = 'fleamarket'
  const UPLOAD_URL =
    'https://stream-upload.goofish.com/api/upload.api?floderId=0&appkey=' +
    UPLOAD_APP_KEY +
    '&_input_charset=utf-8'
  const MAX_IMAGE_COUNT = 9
  const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024
  const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']
  const EXPECTED_HOST = 'www.goofish.com'
  const SDK_WAIT_MS = 5000
  const SDK_POLL_MS = 200
  // 仅允许把已知阿里/闲鱼媒体主机的 HTTP 自动升级为 HTTPS，绝不猜测第三方 host。
  const KNOWN_MEDIA_HOST_REG =
    /^(?:[a-zA-Z0-9-]+\.)*(?:alicdn\.com|taobaocdn\.com|taobao\.com|alipayobjects\.com|goofish\.com)$/i

  const W: any = typeof window !== 'undefined' ? window : (globalThis as any)
  const warnings: string[] = []
  // 只记录受控字段，原始错误可能含验证码 URL 和会话参数，禁止直接输出。
  const traceId = /^[a-zA-Z0-9-]{1,64}$/.test(request.traceId || '') ? request.traceId : 'untracked'
  const logEvent = (event: string, api: string, code: string, status: string, actionRequired?: string): void => {
    const safeCode = /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'UNCLASSIFIED'
    const record = { traceId, phase: request.op, event, api, code: safeCode, status, actionRequired }
    try {
      if (status === 'success' || status === 'pending') console.info('[FishOps:DirectPublish:Page]', record)
      else console.warn('[FishOps:DirectPublish:Page]', record)
    } catch {
      // 日志不可用不能影响业务结果。
    }
  }

  // ==================== 通用工具 ====================
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms)
    })

  const safeText = (value: unknown): string => (value === undefined || value === null ? '' : String(value).trim())

  /** 可序列化深拷贝（页面脚本自包含，用于构造 partial draft 快照）。 */
  const cloneJson = (value: any): any => JSON.parse(JSON.stringify(value))

  /**
   * gps 需为 `lat,lng` 且经纬度在合法范围内。
   * 防止 UI 只改 GPS 后与 poiId 不一致却静默通过（至少做格式 / 数值范围校验）。
   */
  const isValidGps = (gps: string): boolean => {
    const parts = gps.split(',')
    if (parts.length !== 2) return false
    const lat = Number(parts[0])
    const lng = Number(parts[1])
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  }

  /** 返回地址 7 字段中缺失 / 非法的字段名（不吞异常，供 UI 提示）。 */
  const missingAddressFields = (addr: Record<string, string> | null): string[] => {
    const fields = ['prov', 'city', 'area', 'divisionId', 'poiName', 'poiId', 'gps'] as const
    const missing: string[] = []
    if (!addr) return fields.slice()
    for (const field of fields) {
      if (!addr[field]) missing.push(field)
    }
    if (addr.gps && !isValidGps(addr.gps)) missing.push('gps')
    return missing
  }

  /** 结构化错误信息提取（MTOP reject 常为普通对象，不是 Error）。 */
  const describeError = (err: unknown): string => {
    if (!err) return '未知错误'
    if (typeof err === 'string') return err
    const e: any = err
    if (e.ret && Array.isArray(e.ret) && e.ret.length > 0) {
      const first = String(e.ret[0] || '')
      const idx = first.indexOf('::')
      return idx === -1 ? first : '[' + first.slice(0, idx) + '] ' + first.slice(idx + 2)
    }
    if (e.message) return String(e.message)
    if (e.msg) return String(e.msg)
    return '请求未成功返回预期数据'
  }

  const retCode = (resp: any): string => {
    const ret = resp && resp.ret
    if (!Array.isArray(ret) || ret.length === 0) return ''
    const first = String(ret[0] || '')
    const idx = first.indexOf('::')
    return idx === -1 ? first : first.slice(0, idx)
  }

  const retMessage = (resp: any): string => {
    const ret = resp && resp.ret
    if (!Array.isArray(ret) || ret.length === 0) return ''
    const first = String(ret[0] || '')
    const idx = first.indexOf('::')
    return idx === -1 ? '' : first.slice(idx + 2)
  }

  const isRetOk = (resp: any): boolean => retCode(resp).startsWith('SUCCESS')

  /** 元（字符串或数字）→ 分（整数，字符串）。 */
  const toCentString = (value: unknown): string => {
    if (value === undefined || value === null || value === '') return '0'
    const num = typeof value === 'number' ? value : Number(String(value).trim())
    if (!Number.isFinite(num) || num < 0) return '0'
    const fixed = num.toFixed(2).split('.')
    const yuan = parseInt(fixed[0] as string, 10) || 0
    const fen = parseInt(fixed[1] || '0', 10) || 0
    return String(yuan * 100 + fen)
  }

  const generateUniqueCode = (): string =>
    Date.now().toString() + Math.floor(1000 * Math.random()).toString()

  const sha256Hex = async (text: string): Promise<string | null> => {
    const subtle = W.crypto && W.crypto.subtle ? W.crypto.subtle : (globalThis as any).crypto?.subtle
    if (!subtle || typeof subtle.digest !== 'function') return null
    try {
      const bytes = new TextEncoder().encode(text)
      const digest = await subtle.digest('SHA-256', bytes)
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    } catch {
      return null
    }
  }

  /** 只读账号登录标识（unb）；不输出、不落盘。 */
  const readUnb = (): string => {
    try {
      const viaConfig = W.g_config && W.g_config.syncUser ? W.g_config.syncUser.userId : ''
      const viaInitial = W.__INITIAL_DATA__ && W.__INITIAL_DATA__.user ? W.__INITIAL_DATA__.user.userId : ''
      const viaUser = W.user ? W.user.userId : ''
      const direct = viaConfig || viaInitial || viaUser
      if (direct) return String(direct).trim()
    } catch {
      // 忽略页面全局结构差异
    }
    try {
      const cookie = W.document && W.document.cookie ? String(W.document.cookie) : ''
      const match = cookie.match(/(?:^|;\s*)(?:unb|munb)=([^;]*)/)
      if (match && match[1]) {
        try {
          return decodeURIComponent(match[1]).trim()
        } catch {
          return String(match[1]).trim()
        }
      }
    } catch {
      // 忽略 cookie 读取异常
    }
    return ''
  }

  const knownAction = (
    actionRequired: 'login' | 'captcha' | 'verification',
    code: string,
    message: string,
    op = 'unknown',
  ): DirectPublishPageResult => ({
    ok: false,
    op,
    status: 'action_required',
    actionRequired,
    code,
    message,
  })

  const rejected = (op: string, code: string, message: string): DirectPublishPageResult => ({
    ok: false,
    op,
    status: 'rejected',
    code,
    message,
  })

  const unknown = (op: string, code: string, message: string): DirectPublishPageResult => ({
    ok: false,
    op,
    status: 'unknown',
    code,
    message,
  })

  // ==================== 统一 MTOP 失败分类 ====================
  /**
   * 把任意阶段的 MTOP 失败（ret / SDK reject）统一归一到
   * login / captcha / verification / rejected / unknown，
   * 避免只在 publish 阶段识别风控。
   */
  const classifyMtopFailure = (op: string, code: string, message: string): DirectPublishPageResult => {
    const upper = (code + ' ' + message).toUpperCase()
    if (upper.indexOf('STRONG_VALID_VERIFY_INFO') !== -1 || upper.indexOf('LIVE_CERT') !== -1) {
      return knownAction('verification', 'VERIFICATION_REQUIRED', '需实人认证：' + message, op)
    }
    if (upper.indexOf('SESSION_EXPIRED') !== -1 || upper.indexOf('NOT_LOGIN') !== -1 || upper.indexOf('LOGIN') !== -1) {
      return knownAction('login', 'LOGIN_REQUIRED', '登录已失效：' + message, op)
    }
    if (
      upper.indexOf('CAPTCHA') !== -1 ||
      upper.indexOf('USER_VALIDATE') !== -1 ||
      upper.indexOf('VALIDATE') !== -1 ||
      /RGV587|_TMD_|X5SEC|PUNISH/.test(upper) ||
      message.indexOf('验证码') !== -1 ||
      message.indexOf('滑块') !== -1
    ) {
      return knownAction('captcha', 'CAPTCHA_REQUIRED', '触发风控验证码：' + message, op)
    }
    if (code.indexOf('FAIL_BIZ_') === 0) {
      return rejected(op, code, message || '业务拒绝')
    }
    return unknown(op, code || 'MTOP_FAILED', message || '接口失败')
  }

  /**
   * 从受控文案提取业务码：只接受 `FAIL_BIZ_*`（纯码 / `FAIL_BIZ_*::msg` / `[FAIL_BIZ_*] msg`）
   * 前缀，避免把「business 规则变更」这类自由文案误判为业务拒绝。
   */
  const extractBizCode = (text: string): string => {
    const trimmed = safeText(text)
    if (trimmed.indexOf('FAIL_BIZ_') === 0) {
      const idx = trimmed.indexOf('::')
      return idx === -1 ? trimmed : trimmed.slice(0, idx)
    }
    const bracket = /^\[([A-Z0-9_]+)\]/.exec(trimmed)
    if (bracket && bracket[1].indexOf('FAIL_BIZ_') === 0) return bracket[1]
    return ''
  }

  /** 从 SDK reject（可能是普通对象）提取 code/ret 后统一分类。 */
  const mtopFailureFromError = (op: string, err: unknown): DirectPublishPageResult => {
    const e: any = err
    if (e && typeof e === 'object') {
      // 结构化 ret（SDK reject 常为普通对象）最权威。
      if (Array.isArray(e.ret) && e.ret.length > 0) {
        return classifyMtopFailure(op, retCode(e), retMessage(e))
      }
      if (e.code === 'SDK_MISSING') {
        return knownAction('login', 'SDK_MISSING', '未检测到官方 MTOP SDK', op)
      }
      // 结构化 code 优先于自由文本；非业务码交由 classify 归 unknown。
      if (typeof e.code === 'string' && e.code !== '') {
        return classifyMtopFailure(op, e.code, describeError(err))
      }
    }
    // 无结构：仅受控 `[FAIL_BIZ_*]` 文案可解析为业务码，其余保持 unknown。
    const message = describeError(err)
    return classifyMtopFailure(op, extractBizCode(message), message)
  }

  // ==================== 账号一致（防漂移） ====================
  const currentAccountScope = async (): Promise<string | null> => {
    const unb = readUnb()
    return unb ? await sha256Hex(unb) : null
  }

  /** 各阶段开始 / 最终提交前校验账号未漂移；不一致返回 action_required。 */
  const verifyAccount = async (op: string): Promise<DirectPublishPageResult | null> => {
    const expected = request.expectedAccountScope
    if (!expected) return null
    const current = await currentAccountScope()
    if (!current || current !== expected) {
      return knownAction('login', 'ACCOUNT_CHANGED', '检测到登录账号发生变化，请确认账号一致后重试', op)
    }
    return null
  }

  // ==================== SDK / 域名 ====================
  const waitForSdk = async (): Promise<boolean> => {
    const deadline = Date.now() + SDK_WAIT_MS
    for (;;) {
      const lib = W.lib
      if (lib && lib.mtop && typeof lib.mtop.request === 'function') return true
      if (Date.now() >= deadline) return false
      await sleep(SDK_POLL_MS)
    }
  }

  const currentHost = (): string => {
    try {
      return W.location && W.location.hostname ? String(W.location.hostname) : ''
    } catch {
      return ''
    }
  }

  /** 官方 SDK 请求适配层：固定 MTOP 参数，绝不手工签名 / 构造风控 token。 */
  const mtop = async (
    api: string,
    v: string,
    data: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<any> => {
    if (!(await waitForSdk())) {
      const err: any = new Error('MTOP SDK 缺失：window.lib.mtop.request 未就绪')
      err.code = 'SDK_MISSING'
      throw err
    }
    const lib = W.lib
    const startedAt = Date.now()
    logEvent('request_started', api, 'PENDING', 'pending')
    try {
      const response = await lib.mtop.request({
      api,
      v: v || '1.0',
      data: data || {},
      type: 'POST',
      appKey: OFFICIAL_APP_KEY,
      accountSite: OFFICIAL_ACCOUNT_SITE,
      dataType: 'json',
      timeout: 20000,
      needLoginPC: false,
      showErrorToast: false,
      needLogin: false,
      sessionOption: 'AutoLoginOnly',
      ecode: 0,
      headers: headers || {},
      })
      if (isRetOk(response)) {
        logEvent('request_completed', api, retCode(response), 'success')
      } else {
        const failure = classifyMtopFailure(request.op, retCode(response), retMessage(response))
        logEvent('request_failed', api, retCode(response), failure.status, failure.actionRequired)
      }
      return response
    } catch (err) {
      const failure = mtopFailureFromError(request.op, err)
      const code = retCode(err) || ((err as { code?: string })?.code ?? '')
      logEvent('request_failed', api, code || (Date.now() - startedAt >= 20000 ? 'TIMEOUT' : 'REQUEST_EXCEPTION'), failure.status, failure.actionRequired)
      throw err
    }
  }

  // ==================== 来源商品解析 ====================
  interface NormalizedSource {
    /** 原始描述（不含规格追加）。 */
    description: string
    /**
     * @deprecated 无独立标题：统一等于 description（来源 title 被忽略、不与描述合并）。
     * 保留仅为内部结构兼容。
     */
    title: string
    priceYuan: string
    images: string[]
    specifications: DirectPublishSpecificationsEntry[]
    sourceItemId: string
  }

  const mapSpecifications = (raw: unknown): DirectPublishSpecificationsEntry[] => {
    if (!Array.isArray(raw)) return []
    const out: DirectPublishSpecificationsEntry[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const name = safeText(rec['propertyName'] || rec['name'] || rec['text'])
      const value = safeText(rec['valueName'] || rec['value'] || rec['text'])
      if (name && value && name !== value) out.push({ name, value })
    }
    return out
  }

  const selectImages = (images: string[], imageIndexes?: number[]): string[] => {
    let selected = images
    if (Array.isArray(imageIndexes) && imageIndexes.length > 0) {
      const picked: string[] = []
      for (const idx of imageIndexes) {
        if (typeof idx === 'number' && idx >= 0 && idx < images.length) {
          const url = images[idx]
          if (url && picked.indexOf(url) === -1) picked.push(url)
        }
      }
      selected = picked
    }
    if (selected.length > MAX_IMAGE_COUNT) {
      warnings.push('图片超过 ' + MAX_IMAGE_COUNT + ' 张，仅保留前 ' + MAX_IMAGE_COUNT + ' 张')
      selected = selected.slice(0, MAX_IMAGE_COUNT)
    }
    return selected
  }

  const resolveProductSource = (product: DirectPublishPageProduct): NormalizedSource => {
    const images = Array.isArray(product.images) ? product.images.filter((u) => typeof u === 'string' && u) : []
    const description = safeText(product.description)
    return {
      description,
      // 无独立标题：忽略 product.title，统一取 description（不与标题合并）。
      title: description,
      priceYuan: safeText(product.price),
      images,
      specifications: mapSpecifications(product.specifications),
      sourceItemId: '',
    }
  }

  const resolveItemSource = async (itemId: string): Promise<{ result?: NormalizedSource; failure?: DirectPublishPageResult }> => {
    let resp: any
    try {
      resp = await mtop('mtop.taobao.idle.pc.detail', '1.0', { itemId })
    } catch (err) {
      return { failure: mtopFailureFromError('prepare', err) }
    }
    if (!isRetOk(resp)) {
      return { failure: classifyMtopFailure('prepare', retCode(resp), retMessage(resp)) }
    }
    if (!resp || !resp.data || !resp.data.itemDO) {
      return {
        failure: unknown('prepare', 'SOURCE_DETAIL_FAILED', '源商品详情无 itemDO：' + (retMessage(resp) || retCode(resp) || '空响应')),
      }
    }
    const itemDO = resp.data.itemDO as Record<string, unknown>
    const imageInfos = Array.isArray(itemDO['imageInfos']) ? (itemDO['imageInfos'] as unknown[]) : []
    const images = imageInfos
      .map((info) => (info && typeof info === 'object' ? safeText((info as Record<string, unknown>)['url']) : ''))
      .filter((url) => url.length > 0)
    return {
      result: {
        description: safeText(itemDO['desc'] || itemDO['title']),
        // 无独立标题：统一取 description（不单独使用 itemDO.title）。
        title: safeText(itemDO['desc'] || itemDO['title']),
        priceYuan: safeText(itemDO['soldPrice']),
        images,
        specifications: mapSpecifications(itemDO['itemLabelExtList']),
        sourceItemId: itemId,
      },
    }
  }

  // ==================== 地址 ====================
  const normalizeAddress = (raw: any): Record<string, string> | null => {
    if (!raw || typeof raw !== 'object') return null
    const poiName = safeText(raw.poiName || raw.poi || raw.address)
    const lat = raw.latitude !== undefined && raw.latitude !== null ? safeText(raw.latitude) : ''
    const lng = raw.longitude !== undefined && raw.longitude !== null ? safeText(raw.longitude) : ''
    let gps = ''
    if (lat && lng) gps = lat + ',' + lng
    else if (raw.gps) gps = safeText(raw.gps)
    return {
      prov: safeText(raw.prov),
      city: safeText(raw.city),
      area: safeText(raw.area),
      divisionId: safeText(raw.divisionId),
      poiName,
      poiId: safeText(raw.poiId),
      gps,
    }
  }

  // ==================== 图片 ====================
  const normalizeImageUrl = (rawUrl: string): string => {
    if (!rawUrl || typeof rawUrl !== 'string') throw new Error('图片 URL 格式非法')
    let trimmed = rawUrl.trim()
    if (trimmed.indexOf('//') === 0) trimmed = 'https:' + trimmed
    const URLClass = W.URL || (globalThis as any).URL
    if (!URLClass) throw new Error('缺少 URL 解析器')
    let parsed: any
    try {
      parsed = new URLClass(trimmed)
    } catch {
      throw new Error('图片 URL 解析失败')
    }
    const hostname = String(parsed.hostname || '').toLowerCase()
    if (parsed.protocol === 'http:') {
      if (KNOWN_MEDIA_HOST_REG.test(hostname)) {
        parsed.protocol = 'https:'
        return String(parsed.toString())
      }
      throw new Error('拒绝非 HTTPS 图片：未知主机 ' + hostname)
    }
    if (parsed.protocol === 'https:') return String(parsed.toString())
    throw new Error('不支持的图片协议 ' + parsed.protocol)
  }

  const IMAGE_FETCH_TIMEOUT_MS = 30000
  const IMAGE_DECODE_TIMEOUT_MS = 10000

  const getImageDimensions = async (blob: any): Promise<{ width: number; height: number } | null> => {
    const ImageCtor = W.Image
    const URLClass = W.URL || (globalThis as any).URL
    if (!ImageCtor || !URLClass || typeof URLClass.createObjectURL !== 'function') return null
    return await new Promise((resolve) => {
      const img = new ImageCtor()
      const objectUrl = URLClass.createObjectURL(blob)
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: { width: number; height: number } | null): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        try {
          URLClass.revokeObjectURL(objectUrl)
        } catch {
          // 忽略
        }
        resolve(value)
      }
      // 解码有界：超时归 null（不猜尺寸），并清定时器与 object URL。
      timer = setTimeout(() => finish(null), IMAGE_DECODE_TIMEOUT_MS)
      img.onload = () => {
        const w = img.naturalWidth || img.width
        const h = img.naturalHeight || img.height
        finish(w && h ? { width: w, height: h } : null)
      }
      img.onerror = () => finish(null)
      img.src = objectUrl
    })
  }

  const uploadSingleImage = async (source: string | Blob): Promise<Record<string, unknown>> => {
    let blob: Blob
    if (typeof source !== 'string') {
      blob = source
    } else {
      const fetchFn = W.fetch || (globalThis as any).fetch
      if (!fetchFn) throw new Error('缺少 fetch 能力')
      const safeUrl = normalizeImageUrl(source)
      const AbortControllerCtor = W.AbortController || (globalThis as any).AbortController
      const controller = AbortControllerCtor ? new AbortControllerCtor() : null
      let fetchTimer: ReturnType<typeof setTimeout> | undefined
      try {
        const fetchPromise = controller ? fetchFn(safeUrl, { signal: controller.signal }) : fetchFn(safeUrl)
        // 下载有界 30s；finally 必定清理定时器，避免泄漏与悬挂请求。
        if (controller) {
          fetchTimer = setTimeout(() => {
            try {
              controller.abort()
            } catch {
              // 忽略
            }
          }, IMAGE_FETCH_TIMEOUT_MS)
        }
        const resp = await fetchPromise
        if (!resp || !resp.ok) throw new Error('获取图片资源失败 HTTP ' + (resp ? resp.status : 'unknown'))
        blob = await resp.blob()
      } catch (err) {
        throw new Error('图片下载失败：' + describeError(err))
      } finally {
        if (fetchTimer !== undefined) clearTimeout(fetchTimer)
      }
    }
    if (!blob || blob.size > MAX_IMAGE_SIZE_BYTES) {
      throw new Error('图片大小超出 10MB 限制')
    }
    if (blob.type && ALLOWED_IMAGE_MIMES.indexOf(String(blob.type).toLowerCase()) === -1) {
      throw new Error('不支持的图片格式 ' + blob.type)
    }
    const XMLHttpRequestCtor = W.XMLHttpRequest
    const FormDataCtor = W.FormData || (globalThis as any).FormData
    if (!XMLHttpRequestCtor || !FormDataCtor) throw new Error('缺少上传能力 (XHR/FormData)')
    const uploadResult: any = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequestCtor()
      const formData = new FormDataCtor()
      formData.append('file', blob, 'upload.jpg')
      xhr.open('POST', UPLOAD_URL, true)
      xhr.withCredentials = true
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const parsed = JSON.parse(xhr.responseText)
            if (parsed && parsed.success && parsed.object) resolve(parsed.object)
            else reject(new Error(parsed && parsed.message ? String(parsed.message) : '上传接口返回失败'))
          } catch {
            reject(new Error('上传响应 JSON 解析失败'))
          }
        } else {
          reject(new Error('上传接口 HTTP ' + xhr.status))
        }
      }
      xhr.onerror = () => reject(new Error('上传图片网络异常'))
      xhr.ontimeout = () => reject(new Error('上传图片网络超时'))
      xhr.timeout = 30000
      xhr.send(formData)
    })
    let width = uploadResult.width || (uploadResult.pix ? Number(String(uploadResult.pix).split('x')[0]) : 0)
    let height = uploadResult.height || (uploadResult.pix ? Number(String(uploadResult.pix).split('x')[1]) : 0)
    if (!width || !height) {
      const natural = await getImageDimensions(blob)
      if (natural) {
        width = natural.width
        height = natural.height
      }
    }
    if (!width || !height) throw new Error('无法取得上传图片真实像素宽高，严禁伪造尺寸')
    return {
      extraInfo: { isH: 'false', isT: 'false', raw: 'false' },
      isQrCode: false,
      url: safeText(uploadResult.url),
      heightSize: Number(height),
      widthSize: Number(width),
      major: false,
      type: 0,
      status: 'done',
    }
  }

  // ==================== 阶段：uploadImage ====================
  const opUploadImage = async (): Promise<DirectPublishPageResult> => {
    const raw = safeText(request.dataUrl)
    if (!raw.startsWith('data:')) return rejected('uploadImage', 'DATA_URL_REQUIRED', '本地图片上传只接受 data URL')
    const match = /^data:([^;,]+);base64,(.*)$/is.exec(raw)
    if (!match) return rejected('uploadImage', 'INVALID_DATA_URL', 'data URL 必须是 base64 图片数据')
    const mime = match[1].trim().toLowerCase()
    if (ALLOWED_IMAGE_MIMES.indexOf(mime) === -1) return rejected('uploadImage', 'IMAGE_TYPE_INVALID', '不支持的图片格式 ' + mime)
    let blob: Blob
    try {
      const binary = atob(match[2].replace(/\s/g, ''))
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      blob = new Blob([bytes], { type: mime })
    } catch {
      return rejected('uploadImage', 'INVALID_DATA_URL', '图片 data URL 解码失败')
    }
    try {
      const image = await uploadSingleImage(blob)
      if (!safeText(image.url)) return rejected('uploadImage', 'UPLOAD_RESULT_INVALID', '上传接口未返回有效图片地址')
      return { ok: true, op: 'uploadImage', status: 'uploaded', image }
    } catch (err) {
      return rejected('uploadImage', 'IMAGE_UPLOAD_FAILED', '本地图片上传失败：' + describeError(err))
    }
  }

  // ==================== 阶段：account ====================
  const opAccount = async (): Promise<DirectPublishPageResult> => {
    const host = currentHost()
    if (host !== EXPECTED_HOST) {
      return knownAction('login', 'HOST_INVALID', '当前页面非 www.goofish.com（' + host + '），可能已被重定向到登录页')
    }
    if (!(await waitForSdk())) {
      return knownAction('login', 'SDK_MISSING', '未检测到官方 MTOP SDK，请确认已登录并停留在闲鱼发布页')
    }
    const unb = readUnb()
    if (!unb) {
      return knownAction('login', 'NO_LOGIN', '未检测到登录标识，请在已登录的闲鱼发布页使用')
    }
    const scope = await sha256Hex(unb)
    if (!scope) {
      return unknown('account', 'HASH_UNAVAILABLE', '当前环境缺少 WebCrypto，无法派生账号 scope')
    }
    return { ok: true, op: 'account', status: 'account', accountScope: scope }
  }

  // ==================== 阶段：prepare ====================
  const opPrepare = async (): Promise<DirectPublishPageResult> => {
    const host = currentHost()
    if (host !== EXPECTED_HOST) {
      return { ...knownAction('login', 'HOST_INVALID', '当前页面非 www.goofish.com（' + host + '）'), failureStage: 'login' }
    }
    if (!(await waitForSdk())) {
      return { ...knownAction('login', 'SDK_MISSING', '未检测到官方 MTOP SDK'), failureStage: 'login' }
    }
    const unb = readUnb()
    if (!unb) {
      return { ...knownAction('login', 'NO_LOGIN', '未检测到登录标识，无法执行发布准备'), failureStage: 'login' }
    }

    // 阶段开始：校验账号未漂移
    const drift = await verifyAccount('prepare')
    if (drift) return { ...drift, failureStage: 'login' }

    const isProductSource = Boolean(request.sourceProduct)
    const itemId = safeText(request.sourceItemId)

    // prepare 失败时用于展示「已准备部分」的 partial draft（无 token，仅展示，不是可提交数据）。
    let partialDraft: Record<string, unknown> | null = null
    // 推荐成功后取得的权威候选卡（失败时一并返回，供 UI 继续人工选择）。
    let preparedPropertyCards: DirectPublishPagePropertyCard[] | null = null
    /**
     * 统一包装 prepare 失败：保留到当前点的 partial draft、已取得的 propertyCards（推荐之后）、
     * failureStage / missingFields；登录 / 风控同样带阶段，不返回空白技术表单。
     */
    const decorateFailure = (
      result: DirectPublishPageResult,
      failureStage: string,
      missingFields?: string[],
      draftOverride?: Record<string, unknown> | null,
    ): DirectPublishPageResult => ({
      ...result,
      ok: false,
      op: 'prepare',
      failureStage,
      ...(missingFields && missingFields.length > 0 ? { missingFields } : {}),
      ...(draftOverride
        ? { draft: cloneJson(draftOverride) }
        : partialDraft
          ? { draft: cloneJson(partialDraft) }
          : {}),
      ...(preparedPropertyCards && preparedPropertyCards.length > 0
        ? { propertyCards: cloneJson(preparedPropertyCards) }
        : {}),
      warnings,
    })

    /** 本地构造的 prepare 失败。 */
    const fail = (
      status: 'rejected' | 'unknown',
      code: string,
      message: string,
      failureStage: string,
      missingFields?: string[],
    ): DirectPublishPageResult =>
      decorateFailure({ ok: false, op: 'prepare', status, code, message }, failureStage, missingFields)

    /** 把已分类的 MTOP 失败（含 login / captcha 等 action_required）统一补齐 partial 与阶段。 */
    const wrapFailure = (
      classified: DirectPublishPageResult,
      failureStage: string,
      missingFields?: string[],
    ): DirectPublishPageResult => decorateFailure(classified, failureStage, missingFields)

    // 1. 发布资格 / 实人预检
    let checkResp: any
    try {
      checkResp = await mtop('mtop.idle.pc.idleitem.prepublish.check', '1.0', {})
    } catch (err) {
      const classified = mtopFailureFromError('prepare', err)
      return wrapFailure(classified, 'network')
    }
    if (!isRetOk(checkResp)) {
      return wrapFailure(classifyMtopFailure('prepare', retCode(checkResp), retMessage(checkResp)), 'network')
    }
    const checkData = checkResp.data || {}
    if (checkData.limited) {
      const info = checkData.publishLimitInfo || {}
      return wrapFailure(
        knownAction(
          'verification',
          'PUBLISH_LIMITED',
          '账号发布资格受限：' + safeText(info.title || '需实人认证') + ' ' + safeText(info.content),
        ),
        'verification',
      )
    }

    // 2. preget（读取能力；失败仅是警告，但登录/风控类错误结构化中断）
    try {
      const pregetResp = await mtop('mtop.idle.pc.idleitem.preget', '1.0', {})
      if (!isRetOk(pregetResp)) {
        const classified = classifyMtopFailure('prepare', retCode(pregetResp), retMessage(pregetResp))
        if (classified.status === 'action_required') return wrapFailure(classified, 'network')
        warnings.push('preget 异常：' + (classified.message || '接口失败'))
      }
    } catch (err) {
      const classified = mtopFailureFromError('prepare', err)
      if (classified.status === 'action_required') return wrapFailure(classified, 'network')
      warnings.push('preget 异常：' + (classified.message || '接口失败'))
    }

    // 3. 解析来源商品
    let source: NormalizedSource
    if (isProductSource) {
      source = resolveProductSource(request.sourceProduct as DirectPublishPageProduct)
    } else {
      if (!itemId) {
        return fail('rejected', 'SOURCE_REQUIRED', '缺少 source.itemId 或 source.product', 'source', ['source'])
      }
      const resolved = await resolveItemSource(itemId)
      if (resolved.failure) {
        return wrapFailure(resolved.failure, 'source', ['source'])
      }
      source = resolved.result as NormalizedSource
    }

    // 组装 partial draft（源商品字段），供后续失败时展示已准备部分。
    partialDraft = {
      // deprecated 兼容：描述模式无独立标题，统一等于 description。
      title: source.description,
      description: source.description,
      price: source.priceYuan,
      specifications: source.specifications.map((s) => ({ name: s.name, value: s.value })),
      category: {},
      attributes: [],
      address: {},
      images: [],
      services: [],
    }

    if (!source.description) {
      return fail('rejected', 'DESCRIPTION_REQUIRED', '商品描述为空，无法发布', 'parse', ['description'])
    }
    if (toCentString(source.priceYuan) === '0') {
      return fail('rejected', 'PRICE_REQUIRED', '商品售价必须大于 0 元', 'parse', ['price'])
    }

    // 单品规格融入描述（不虚构多 SKU）；legacy payload 保留此行为，
    // 两阶段 draft 的 description 保持原始文本、规格单独存放，最终 submit 只追加一次。
    const rawDescription = source.description
    let description = rawDescription
    if (source.specifications.length > 0) {
      const specLines = source.specifications.map((s) => s.name + '：' + s.value)
      description = description + '\n' + specLines.join('\n')
    }

    const selectedImages = selectImages(source.images, request.imageIndexes)
    if (partialDraft && selectedImages.length > 0) {
      // 尚未上传的源图片以 pending 标记展示（仅供 UI 保留商品图，submit 前必须替换为真实上传结果）。
      partialDraft.images = selectedImages.map((url) => ({ url, pending: true }))
    }
    if (selectedImages.length === 0) {
      return fail('rejected', 'IMAGES_REQUIRED', '商品图片为空，无法发布', 'images', ['images'])
    }

    // 4. 违禁词预检（fail-closed）；unb 仅在此用作 sessionId；
    // 检测对象仅为「最终待发送描述（含规格追加）」——描述模式无独立标题，不额外附加标题。
    const badwordsText = description
    let badwordsResp: any
    try {
      badwordsResp = await mtop('mtop.taobao.idleitem.badwords.prepubcheck', '2.0', {
        title: badwordsText,
        scene: 'pcPublish',
        sessionId: Date.now().toString() + unb,
      })
    } catch (err) {
      const classified = mtopFailureFromError('prepare', err)
      return wrapFailure(classified, 'badwords')
    }
    if (!isRetOk(badwordsResp) || !badwordsResp.data) {
      // 违禁词接口异常 fail-closed：统一分类（登录/验证码/业务拒绝/未知均阻断）
      const classified = classifyMtopFailure('prepare', retCode(badwordsResp), retMessage(badwordsResp))
      if (classified.status === 'action_required' || classified.status === 'rejected') {
        return wrapFailure(classified, 'badwords')
      }
      return fail('unknown', 'BADWORDS_FAILED', '违禁词预检无有效数据：' + (classified.message || '空响应'), 'badwords')
    }
    if (badwordsResp.data.forbidPublish === true) {
      const detail =
        safeText(badwordsResp.data.msg) ||
        safeText(badwordsResp.data.badWordAlertInfo && badwordsResp.data.badWordAlertInfo.items
          ? badwordsResp.data.badWordAlertInfo.items[0] && badwordsResp.data.badWordAlertInfo.items[0].words
            ? badwordsResp.data.badWordAlertInfo.items[0].words.join(',')
            : ''
          : '') ||
        '文案包含敏感违禁内容'
      return fail('rejected', 'BADWORDS_FORBIDDEN', '违禁词拦截：' + detail, 'badwords')
    }

    // 5. 图片上传：两阶段（reviewMode）自动上传，不再要求人工二维码确认；旧一步式保留 QR 门禁。
    if (!request.reviewMode && request.confirmedNoQrCodes !== true) {
      return fail('rejected', 'QR_CONFIRM_REQUIRED', '未人工确认图片无二维码，禁止上传图片', 'images')
    }
    const imageInfoDOList: Record<string, unknown>[] = []
    for (let i = 0; i < selectedImages.length; i++) {
      try {
        const uploaded = await uploadSingleImage(selectedImages[i] as string)
        uploaded.major = i === 0
        imageInfoDOList.push(uploaded)
        if (partialDraft) partialDraft.images = cloneJson(imageInfoDOList)
      } catch (err) {
        if (partialDraft) partialDraft.images = cloneJson(imageInfoDOList)
        return fail('rejected', 'IMAGE_UPLOAD_FAILED', '第 ' + (i + 1) + ' 张图片上传失败：' + describeError(err), 'images', ['images'])
      }
    }

    // 6. 分类 / 属性推荐（完整 imageDO）
    let rawCardList: unknown[] = []
    let recommendResp: any
    try {
      recommendResp = await mtop('mtop.taobao.idle.kgraph.property.recommend', '2.0', {
        title: description,
        description,
        imageInfos: imageInfoDOList,
        lockCpv: false,
        multiSKU: false,
        publishScene: 'mainPublish',
        scene: 'newPublishChoice',
        uniqueCode: generateUniqueCode(),
      })
    } catch (err) {
      const classified = mtopFailureFromError('prepare', err)
      return wrapFailure(classified, 'category')
    }
    if (!isRetOk(recommendResp) || !recommendResp.data) {
      const classified = classifyMtopFailure('prepare', retCode(recommendResp), retMessage(recommendResp))
      return wrapFailure(classified, 'category', ['category'])
    }
    rawCardList = Array.isArray(recommendResp.data.cardList) ? recommendResp.data.cardList : []

    interface NormalizedCard {
      cardType: string
      propertyId: string
      propertyName: string
      isBook: boolean
      supportWebPublish: boolean
      tips: string
      valuesList: Record<string, unknown>[]
    }
    const normalizedCards: NormalizedCard[] = rawCardList.map((card) => {
      const raw = (card || {}) as Record<string, unknown>
      const cd = (raw['cardData'] as Record<string, unknown>) || raw
      const values = Array.isArray(cd['valuesList'])
        ? (cd['valuesList'] as unknown[])
        : Array.isArray(cd['values'])
          ? (cd['values'] as unknown[])
          : []
      return {
        cardType: safeText(raw['cardType']),
        propertyId: safeText(cd['propertyId']),
        propertyName: safeText(cd['propertyName']),
        isBook: Boolean(cd['isBook']),
        supportWebPublish: cd['supportWebPublish'] !== false,
        tips: safeText(cd['tips']),
        valuesList: values.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object'),
      }
    })

    // 明确：仅支持网页端发布的分类卡类型 20401，且非图书
    for (const card of normalizedCards) {
      if (card.propertyId !== '-10000') continue
      if (card.cardType !== '20401') {
        return fail('rejected', 'UNSUPPORTED_CATEGORY', '类目卡类型为 ' + (card.cardType || '未知') + '，不支持网页端发布', 'category', ['category'])
      }
      if (card.isBook) {
        return fail('rejected', 'UNSUPPORTED_CATEGORY', '图书类目不支持网页端直接发布', 'category', ['category'])
      }
      if (!card.supportWebPublish) {
        return fail('rejected', 'UNSUPPORTED_CATEGORY', card.tips || '该类目不支持网页发布', 'category', ['category'])
      }
    }

    const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

    /** 单个候选值（保留权威 transportData，submit 按此重建 label item，不信任前端字段）。 */
    const buildCandidate = (card: NormalizedCard, raw: Record<string, unknown>): DirectPublishPageCardValue | null => {
      const isCategory = card.propertyId === '-10000'
      const valueId = isCategory
        ? safeText(raw['channelCatId'] || raw['catId'] || raw['valueId'])
        : safeText(raw['valueId'] || raw['id'])
      const valueName = isCategory
        ? safeText(raw['catName'] || raw['channelCateName'] || raw['valueName'])
        : safeText(raw['valueName'] || raw['name'])
      if (!valueId || !valueName) return null
      const transportData =
        raw['transportData'] && typeof raw['transportData'] === 'object'
          ? (deepClone(raw['transportData']) as Record<string, unknown>)
          : {}
      const candidate: DirectPublishPageCardValue = { valueId, valueName, transportData, isCategory }
      if (isCategory) {
        candidate.catId = safeText(raw['catId'] || raw['channelCatId'] || raw['valueId'])
        candidate.channelCatId = safeText(raw['channelCatId'] || raw['catId'] || raw['valueId'])
        candidate.catName = valueName
        candidate.leafId = safeText(raw['leafId'] || '0')
        candidate.tbCatId = safeText(raw['tbCatId'])
      }
      return candidate
    }

    interface CardWithCandidates {
      card: NormalizedCard
      candidates: DirectPublishPageCardValue[]
      rawValues: Record<string, unknown>[]
    }
    const cardsWithCandidates: CardWithCandidates[] = normalizedCards.map((card) => {
      const candidates: DirectPublishPageCardValue[] = []
      const rawValues: Record<string, unknown>[] = []
      for (const raw of card.valuesList) {
        const candidate = buildCandidate(card, raw)
        if (candidate) {
          candidates.push(candidate)
          rawValues.push(raw)
        }
      }
      return { card, candidates, rawValues }
    })

    /** 候选卡（供人工资讯；transportData 仅用于后台重建，前端不应改写）。 */
    const propertyCards: DirectPublishPagePropertyCard[] = cardsWithCandidates.map(({ card, candidates }) => ({
      cardType: card.cardType,
      propertyId: card.propertyId,
      propertyName: card.propertyName,
      isCategory: card.propertyId === '-10000',
      isBook: card.isBook,
      supportWebPublish: card.supportWebPublish,
      tips: card.tips,
      values: candidates,
    }))
    // 推荐成功后即持有权威候选卡；后续失败一并返回，避免 UI 丢失已准备的类目 / 属性候选。
    preparedPropertyCards = propertyCards

    /** 由权威候选构造平台 label item（与原来 isClicked 分支一致）。 */
    const buildLabelItem = (card: NormalizedCard, candidate: DirectPublishPageCardValue): Record<string, unknown> => {
      const labelItem: Record<string, unknown> = {
        ...(deepClone(candidate.transportData) as Record<string, unknown>),
        propertyName: card.propertyName,
        propertyId: card.propertyId,
        isUserClick: '1',
        isUserCancel: '0',
        text: candidate.valueName,
        properties:
          card.propertyId + '##' + card.propertyName + ':' + candidate.valueId + '##' + candidate.valueName,
      }
      if (candidate.isCategory) {
        if (labelItem['channelCateId'] === undefined) labelItem['channelCateId'] = candidate.channelCatId || candidate.catId || ''
        if (labelItem['channelCateName'] === undefined) labelItem['channelCateName'] = candidate.catName || candidate.valueName
      } else {
        if (labelItem['valueId'] === undefined) labelItem['valueId'] = candidate.valueId
        if (labelItem['valueName'] === undefined) labelItem['valueName'] = candidate.valueName
      }
      return labelItem
    }

    // 类目选择：请求携带已有类目时按候选校验后使用（不覆盖用户选择）；否则用推荐点击值/预测值。
    const categoryEntry = cardsWithCandidates.filter((entry) => entry.card.propertyId === '-10000')[0]
    let selectedCategory: { card: NormalizedCard; candidate: DirectPublishPageCardValue } | null = null
    if (request.category) {
      if (!categoryEntry) {
        return fail('rejected', 'CATEGORY_INVALID', '未取得网页支持的类目候选，拒绝发布', 'category', ['category'])
      }
      const wanted = [
        safeText(request.category['catId']),
        safeText(request.category['channelCatId']),
        safeText(request.category['valueId']),
      ].filter(Boolean)
      const index = categoryEntry.candidates.findIndex(
        (v) =>
          wanted.indexOf(v.valueId) !== -1 ||
          (v.catId !== undefined && wanted.indexOf(v.catId) !== -1) ||
          (v.channelCatId !== undefined && wanted.indexOf(v.channelCatId) !== -1),
      )
      if (index === -1) {
        return fail('rejected', 'CATEGORY_INVALID', '提供的类目不在网页支持候选内，拒绝发布', 'category', ['category'])
      }
      selectedCategory = { card: categoryEntry.card, candidate: categoryEntry.candidates[index] as DirectPublishPageCardValue }
    } else if (categoryEntry) {
      const clickedIndex = categoryEntry.rawValues.findIndex((v) => String(v['isClicked']) === '1')
      if (clickedIndex !== -1) {
        selectedCategory = {
          card: categoryEntry.card,
          candidate: categoryEntry.candidates[clickedIndex] as DirectPublishPageCardValue,
        }
      }
    }

    let itemCatDTO: Record<string, string> | null = null
    if (selectedCategory) {
      const candidate = selectedCategory.candidate
      itemCatDTO = {
        catId: candidate.catId || candidate.valueId,
        catName: candidate.catName || candidate.valueName,
        channelCatId: candidate.channelCatId || candidate.valueId,
        leafId: candidate.leafId || '0',
        tbCatId: candidate.tbCatId || '',
      }
    }
    if (!itemCatDTO && recommendResp.data.categoryPredictResult) {
      const cp = recommendResp.data.categoryPredictResult as Record<string, unknown>
      itemCatDTO = {
        catId: safeText(cp['catId']),
        catName: safeText(cp['catName']),
        channelCatId: safeText(cp['channelCatId']),
        leafId: safeText(cp['leafId'] || '0'),
        tbCatId: safeText(cp['tbCatId']),
      }
    }
    if (!itemCatDTO || !itemCatDTO.catId) {
      return fail('rejected', 'CATEGORY_REQUIRED', '未识别到有效商品类目，禁止发布', 'category', ['category'])
    }
    if (partialDraft) partialDraft.category = { ...itemCatDTO }

    // 属性选择：请求携带已有属性时逐项按候选校验（不覆盖用户选择）；否则用推荐 clicked 值。
    const attributeLabelItems: Record<string, unknown>[] = []
    if (request.attributes !== undefined) {
      for (const rawAttribute of request.attributes) {
        const rec = (rawAttribute || {}) as Record<string, unknown>
        const propertyId = safeText(rec['propertyId'])
        if (!propertyId || propertyId === '-10000') continue // 类目由 category 统一处理
        const entry = cardsWithCandidates.filter((e) => e.card.propertyId === propertyId)[0]
        if (!entry) {
          return fail('rejected', 'ATTRIBUTE_INVALID', '属性 ' + propertyId + ' 不在网页支持候选内', 'category', ['attributes'])
        }
        const wantedValueId = safeText(rec['valueId'] || rec['id'])
        const index = entry.candidates.findIndex((c) => c.valueId === wantedValueId)
        if (index === -1) {
          return fail('rejected', 'ATTRIBUTE_INVALID', '属性 ' + propertyId + ' 的取值不在候选内', 'category', ['attributes'])
        }
        attributeLabelItems.push(buildLabelItem(entry.card, entry.candidates[index] as DirectPublishPageCardValue))
      }
    } else {
      for (const entry of cardsWithCandidates) {
        if (entry.card.propertyId === '-10000') continue
        for (let i = 0; i < entry.rawValues.length; i++) {
          if (String(entry.rawValues[i]?.['isClicked']) !== '1') continue
          const candidate = entry.candidates[i]
          if (candidate) attributeLabelItems.push(buildLabelItem(entry.card, candidate))
        }
      }
    }

    // itemLabelExtList = 类目 label item + 属性 label items（与平台结构一致）。
    const itemLabelExtList: Record<string, unknown>[] = []
    if (selectedCategory) itemLabelExtList.push(buildLabelItem(selectedCategory.card, selectedCategory.candidate))
    itemLabelExtList.push(...attributeLabelItems)
    if (partialDraft) partialDraft.attributes = cloneJson(itemLabelExtList)

    // 7. 发货地址
    let itemAddrDTO: Record<string, string> | null = null
    if (request.sellerAddress) {
      itemAddrDTO = normalizeAddress(request.sellerAddress)
      // 即使字段无效也保留到 partial.address，便于 UI 展示缺失 / 非法原因。
      if (partialDraft) partialDraft.address = cloneJson(itemAddrDTO)
      const missing = missingAddressFields(itemAddrDTO)
      if (missing.length > 0) {
        return fail(
          'rejected',
          'ADDRESS_INCOMPLETE',
          'seller.address 字段不完整或 gps 非法（需 prov/city/area/divisionId/poiName/poiId/gps）',
          'address',
          missing,
        )
      }
    } else if (request.coordinates) {
      let poiResp: any
      try {
        poiResp = await mtop(
          'mtop.taobao.idle.local.poi.get',
          '1.0',
          { longitude: request.coordinates.longitude, latitude: request.coordinates.latitude },
          { 'EagleEye-UserData': 'spm-cnt=a21ybx' },
        )
      } catch (err) {
        return wrapFailure(mtopFailureFromError('prepare', err), 'address', ['address'])
      }
      if (!isRetOk(poiResp)) {
        return wrapFailure(classifyMtopFailure('prepare', retCode(poiResp), retMessage(poiResp)), 'address', ['address'])
      }
      // 仅接受官方已选地址 selectedPoi；不做 commonAddresses / nearbyAddresses 的假匹配。
      const pickedPoi = poiResp.data && poiResp.data.selectedPoi
      if (!pickedPoi) {
        return fail(
          'rejected',
          'DEFAULT_ADDRESS_NOT_SELECTED',
          'coordinates 未匹配到官方已选发货地址（仅接受 selectedPoi），请在官方发布页选择地址后重试',
          'address',
          ['address', 'poiId'],
        )
      }
      itemAddrDTO = normalizeAddress(pickedPoi)
      if (partialDraft) partialDraft.address = cloneJson(itemAddrDTO)
      const missing = missingAddressFields(itemAddrDTO)
      if (missing.length > 0) {
        return fail('rejected', 'ADDRESS_INCOMPLETE', 'POI 返回地址字段不完整', 'address', missing)
      }
    } else if (request.reviewMode) {
      // 两阶段：未显式提供 seller 时，自动只读取当前账号官方默认发货地址 selectedPoi。
      // 已通过浏览器只读验证：poi.get 空参即可返回 data.selectedPoi（账号已选）/ commonAddresses / nearbyAddresses；
      // 归一化 poiName ← poi、gps ← latitude,longitude；绝不继承源卖家地址，也不把「常用/附近」当已选。
      let poiResp: any
      try {
        poiResp = await mtop('mtop.taobao.idle.local.poi.get', '1.0', {}, { 'EagleEye-UserData': 'spm-cnt=a21ybx' })
      } catch (err) {
        return wrapFailure(mtopFailureFromError('prepare', err), 'address', ['address'])
      }
      if (!isRetOk(poiResp)) {
        return wrapFailure(classifyMtopFailure('prepare', retCode(poiResp), retMessage(poiResp)), 'address', ['address'])
      }
      const pickedPoi = poiResp.data && poiResp.data.selectedPoi
      if (!pickedPoi) {
        return fail(
          'rejected',
          'DEFAULT_ADDRESS_NOT_SELECTED',
          '账号未选择默认发货地址（selectedPoi 为空），请先在官方发布页选择发货地址后重试',
          'address',
          ['address', 'poiId'],
        )
      }
      itemAddrDTO = normalizeAddress(pickedPoi)
      if (partialDraft) partialDraft.address = cloneJson(itemAddrDTO)
      const missing = missingAddressFields(itemAddrDTO)
      if (missing.length > 0) {
        return fail('rejected', 'ADDRESS_INCOMPLETE', '账号默认地址字段不完整', 'address', missing)
      }
      warnings.push('发货地址来自当前账号官方默认 POI（仅只读 selectedPoi，未使用源卖家地址）')
    } else {
      return fail('rejected', 'ADDRESS_REQUIRED', 'seller 必须配置 address 或 coordinates，禁止继承账号默认地址', 'address', ['address'])
    }

    // 8. 服务卡（默认全部关闭）
    const priceInCent = toCentString(source.priceYuan)
    const intermediateItemInfo: Record<string, unknown> = {
      freebies: false,
      itemTypeStr: 'b',
      quantity: '1',
      simpleItem: 'true',
      itemTextDTO: { desc: description, title: description, titleDescSeparate: false },
      itemPriceDTO: { priceInCent },
      itemPostFeeDTO: { canFreeShipping: true, supportFreight: true, onlyTakeSelf: false },
      itemAddrDTO: itemAddrDTO,
      itemCatDTO: itemCatDTO,
      itemLabelExtList: itemLabelExtList,
      imageInfoDOList: imageInfoDOList,
      defaultPrice: false,
      publishScene: 'mainPublish',
    }
    let userRightsProtocols: Array<{ serviceCode: string; enable: boolean }> = []
    let cardsResp: any
    try {
      cardsResp = await mtop('mtop.idle.item.publish.service.cards.list', '1.0', {
        cpvList: JSON.stringify(rawCardList),
        itemInfoJson: JSON.stringify(intermediateItemInfo),
        param: JSON.stringify({ multiSkuEditingMode: 'false', settingsPreferences: null, supportDefaultOpen: true }),
      })
    } catch (err) {
      return wrapFailure(mtopFailureFromError('prepare', err), 'services')
    }
    if (!isRetOk(cardsResp) || !cardsResp.data) {
      return wrapFailure(classifyMtopFailure('prepare', retCode(cardsResp), retMessage(cardsResp)), 'services')
    }
    const availableServices = Array.isArray(cardsResp.data.services) ? (cardsResp.data.services as unknown[]) : []
    const prefs = request.servicePreferences || {}
    userRightsProtocols = availableServices.map((svc) => {
      const rec = (svc || {}) as Record<string, unknown>
      const code = safeText(rec['code'])
      let enable = false
      if (code !== 'AI_SALE' && prefs[code] !== undefined) enable = Boolean(prefs[code])
      return { serviceCode: code, enable }
    })
    if (partialDraft) partialDraft.services = cloneJson(userRightsProtocols)

    const payload: Record<string, unknown> = {
      freebies: false,
      itemTypeStr: 'b',
      quantity: '1',
      simpleItem: 'true',
      itemTextDTO: { desc: description, title: description, titleDescSeparate: false },
      itemPriceDTO: { priceInCent },
      itemPostFeeDTO: { canFreeShipping: true, supportFreight: true, onlyTakeSelf: false },
      itemAddrDTO: itemAddrDTO,
      itemCatDTO: itemCatDTO,
      itemLabelExtList: itemLabelExtList,
      imageInfoDOList: imageInfoDOList,
      userRightsProtocols: userRightsProtocols,
      defaultPrice: false,
      sourceId: 'pcMainPublish',
      bizcode: 'pcMainPublish',
      publishScene: 'pcMainPublish',
    }

    // 推荐类目 / 属性为接口自动识别，必须人工核对；规格仅追加描述，未经平台标签校验。
    warnings.push('推荐类目与属性由接口自动识别，需人工核对，不保证精准配置')
    if (source.specifications.length > 0) {
      warnings.push('规格仅追加到描述文本，未经平台属性标签校验，不保证平台已校验通过')
    }

    // 两阶段 draft：完整「实际待发送数据」（description 为原始文本，规格独立）。
    const draft = {
      // deprecated 兼容：描述模式无独立标题，统一等于原始描述。
      title: rawDescription,
      description: rawDescription,
      price: source.priceYuan,
      specifications: source.specifications.map((s) => ({ name: s.name, value: s.value })),
      category: { ...itemCatDTO },
      attributes: itemLabelExtList.map((item) => deepClone(item)),
      address: { ...itemAddrDTO },
      images: imageInfoDOList.map((img) => deepClone(img)),
      services: userRightsProtocols.map((s) => ({ serviceCode: s.serviceCode, enable: s.enable })),
    }

    return {
      ok: true,
      op: 'prepare',
      status: 'prepared',
      payload,
      draft,
      propertyCards,
      rawCards: rawCardList,
      accountScope: await currentAccountScope(),
      itemCount: imageInfoDOList.length,
      catId: itemCatDTO.catId,
      warnings,
    }
  }

  // ==================== 阶段：publish ====================
  const opPublish = async (): Promise<DirectPublishPageResult> => {
    const payload = request.preparedPayload
    if (!payload || typeof payload !== 'object') {
      return unknown('publish', 'PAYLOAD_MISSING', '缺少 prepare 阶段生成的 payload')
    }
    if (!(await waitForSdk())) {
      return knownAction('login', 'SDK_MISSING', '未检测到官方 MTOP SDK')
    }
    // 阶段开始：校验账号未漂移
    const driftAtStart = await verifyAccount('publish')
    if (driftAtStart) return driftAtStart
    // 提交前再次只读预检
    let checkResp: any
    try {
      checkResp = await mtop('mtop.idle.pc.idleitem.prepublish.check', '1.0', {})
    } catch (err) {
      return mtopFailureFromError('publish', err)
    }
    if (!isRetOk(checkResp)) {
      return classifyMtopFailure('publish', retCode(checkResp), retMessage(checkResp))
    }
    if (checkResp.data && checkResp.data.limited) {
      return knownAction('verification', 'PUBLISH_LIMITED', '发布资格受限，需人工处理')
    }

    // 最终 mtop publish 前再校验一次账号
    const driftBeforeSubmit = await verifyAccount('publish')
    if (driftBeforeSubmit) return driftBeforeSubmit

    const submitPayload = { ...(payload as Record<string, unknown>), uniqueCode: generateUniqueCode() }
    let pubResp: any
    try {
      pubResp = await mtop('mtop.idle.pc.idleitem.publish', '1.0', submitPayload)
    } catch (err) {
      // 明确业务拒绝 / 需人工处理优先返回：不能把 FAIL_BIZ 误判为「网络未知」而锁死重试。
      const classified = mtopFailureFromError('publish', err)
      if (classified.status === 'rejected' || classified.status === 'action_required') {
        return classified
      }
      const text = describeError(err)
      const lower = text.toLowerCase()
      if (lower.indexOf('timeout') !== -1 || lower.indexOf('超时') !== -1) {
        return unknown('publish', 'PUBLISH_TIMEOUT', '发布请求超时，结果未知，禁止自动重试')
      }
      return unknown('publish', 'PUBLISH_NETWORK_UNKNOWN', '发布请求异常，结果未知，禁止自动重试：' + text)
    }
    if (!isRetOk(pubResp)) {
      return classifyMtopFailure('publish', retCode(pubResp), retMessage(pubResp))
    }
    const itemId = pubResp.data && pubResp.data.itemId ? safeText(pubResp.data.itemId) : ''
    if (!itemId) {
      return unknown('publish', 'NO_ITEM_ID', '服务端返回 SUCCESS 但缺少 itemId，结果未知')
    }
    return { ok: true, op: 'publish', status: 'published', itemId, warnings }
  }

  // ==================== 阶段：submit（两阶段最终提交） ====================
  /**
   * 只接受后台归一化后的权威数据（submitCore）；文案 / 规格 / 价格变更后
   * 提交前重新跑违禁词与 service cards 校验，但**绝不重新推荐覆盖人选择**。
   * 成功判据仍为 `mtop.idle.pc.idleitem.publish` 返回 `data.itemId`。
   */
  const opSubmit = async (): Promise<DirectPublishPageResult> => {
    const core = request.submitCore
    if (!core || typeof core !== 'object') {
      return rejected('submit', 'SUBMIT_CORE_MISSING', '缺少后台归一化的提交数据')
    }
    if (!(await waitForSdk())) {
      return knownAction('login', 'SDK_MISSING', '未检测到官方 MTOP SDK')
    }
    const driftAtStart = await verifyAccount('submit')
    if (driftAtStart) return driftAtStart

    // 提交前安全资格预检
    let checkResp: any
    try {
      checkResp = await mtop('mtop.idle.pc.idleitem.prepublish.check', '1.0', {})
    } catch (err) {
      return mtopFailureFromError('submit', err)
    }
    if (!isRetOk(checkResp)) {
      return classifyMtopFailure('submit', retCode(checkResp), retMessage(checkResp))
    }
    if (checkResp.data && checkResp.data.limited) {
      return knownAction('verification', 'PUBLISH_LIMITED', '发布资格受限，需人工处理')
    }

    // 组装最终描述：规格只追加一次；描述模式无独立标题，title/desc 统一最终描述（titleDescSeparate=false）。
    const specs = Array.isArray(core.specifications) ? core.specifications : []
    const finalDesc =
      specs.length > 0
        ? core.description + '\n' + specs.map((s) => s.name + '：' + s.value).join('\n')
        : core.description

    // 提交前重新违禁词校验（文案 / 价格 / 规格变更后必须重跑）；仅校验最终描述，无标题附加。
    const badwordsText = finalDesc
    let badwordsResp: any
    try {
      badwordsResp = await mtop('mtop.taobao.idleitem.badwords.prepubcheck', '2.0', {
        title: badwordsText,
        scene: 'pcPublish',
        sessionId: Date.now().toString() + readUnb(),
      })
    } catch (err) {
      return mtopFailureFromError('submit', err)
    }
    if (!isRetOk(badwordsResp) || !badwordsResp.data) {
      const classified = classifyMtopFailure('submit', retCode(badwordsResp), retMessage(badwordsResp))
      if (classified.code === 'MTOP_FAILED' || classified.status === 'unknown') {
        return unknown('submit', 'BADWORDS_FAILED', '违禁词复检无有效数据：' + (classified.message || '空响应'))
      }
      return classified
    }
    if (badwordsResp.data.forbidPublish === true) {
      const detail =
        safeText(badwordsResp.data.msg) ||
        safeText(badwordsResp.data.badWordAlertInfo && badwordsResp.data.badWordAlertInfo.items
          ? badwordsResp.data.badWordAlertInfo.items[0] && badwordsResp.data.badWordAlertInfo.items[0].words
            ? badwordsResp.data.badWordAlertInfo.items[0].words.join(',')
            : ''
          : '') ||
        '文案包含敏感违禁内容'
      return rejected('submit', 'BADWORDS_FORBIDDEN', '违禁词拦截：' + detail)
    }

    const priceInCent = toCentString(core.priceYuan)
    if (priceInCent === '0') {
      return rejected('submit', 'PRICE_REQUIRED', '商品售价必须大于 0 元')
    }
    const intermediateItemInfo: Record<string, unknown> = {
      freebies: false,
      itemTypeStr: 'b',
      quantity: '1',
      simpleItem: 'true',
      itemTextDTO: { desc: finalDesc, title: finalDesc, titleDescSeparate: false },
      itemPriceDTO: { priceInCent },
      itemPostFeeDTO: { canFreeShipping: true, supportFreight: true, onlyTakeSelf: false },
      itemAddrDTO: core.itemAddrDTO,
      itemCatDTO: core.itemCatDTO,
      itemLabelExtList: core.itemLabelExtList,
      imageInfoDOList: core.imageInfoDOList,
      defaultPrice: false,
      publishScene: 'mainPublish',
    }

    // 提交前重新 service cards 校验：只允许启用「已确认可用」的服务；AI_SALE 强制 false。
    let cardsResp: any
    try {
      cardsResp = await mtop('mtop.idle.item.publish.service.cards.list', '1.0', {
        cpvList: JSON.stringify(Array.isArray(request.rawCards) ? request.rawCards : []),
        itemInfoJson: JSON.stringify(intermediateItemInfo),
        param: JSON.stringify({ multiSkuEditingMode: 'false', settingsPreferences: null, supportDefaultOpen: true }),
      })
    } catch (err) {
      return mtopFailureFromError('submit', err)
    }
    if (!isRetOk(cardsResp) || !cardsResp.data) {
      return classifyMtopFailure('submit', retCode(cardsResp), retMessage(cardsResp))
    }
    const availableServices = Array.isArray(cardsResp.data.services) ? (cardsResp.data.services as unknown[]) : []
    // 提交前复检：只以用户已确认的服务为准（按用户顺序输出）：
    // 1. 已开启但复检后不可用 → 明确 rejected SERVICE_UNAVAILABLE，绝不静默删除或自动改变已确认数据；
    // 2. 不自动追加复检新出现但用户未确认的服务；AI_SALE 强制 false。
    const availableCodes = new Set<string>()
    for (const svc of availableServices) {
      const rec = (svc || {}) as Record<string, unknown>
      const code = safeText(rec['code'])
      if (code) availableCodes.add(code)
    }
    const userRightsProtocols: Array<{ serviceCode: string; enable: boolean }> = []
    for (const svc of core.services) {
      if (!svc || typeof svc.serviceCode !== 'string' || !svc.serviceCode) continue
      const code = svc.serviceCode
      if (code === 'AI_SALE') {
        userRightsProtocols.push({ serviceCode: code, enable: false })
        continue
      }
      const enable = svc.enable === true
      if (enable && !availableCodes.has(code)) {
        return rejected('submit', 'SERVICE_UNAVAILABLE', '所选服务 ' + code + ' 在当前商品上不可用，请取消该服务后重新提交')
      }
      userRightsProtocols.push({ serviceCode: code, enable })
    }

    const submitPayload: Record<string, unknown> = {
      ...intermediateItemInfo,
      publishScene: 'pcMainPublish',
      userRightsProtocols,
      sourceId: 'pcMainPublish',
      bizcode: 'pcMainPublish',
      uniqueCode: generateUniqueCode(),
    }

    // 最终 mtop publish 前再校验一次账号
    const driftBeforeSubmit = await verifyAccount('submit')
    if (driftBeforeSubmit) return driftBeforeSubmit

    let pubResp: any
    try {
      pubResp = await mtop('mtop.idle.pc.idleitem.publish', '1.0', submitPayload)
    } catch (err) {
      // 明确业务拒绝 / 需人工处理优先返回：不能把 FAIL_BIZ 误判为「网络未知」而锁死重试。
      const classified = mtopFailureFromError('submit', err)
      if (classified.status === 'rejected' || classified.status === 'action_required') {
        return classified
      }
      const text = describeError(err)
      const lower = text.toLowerCase()
      if (lower.indexOf('timeout') !== -1 || lower.indexOf('超时') !== -1) {
        return unknown('submit', 'PUBLISH_TIMEOUT', '发布请求超时，结果未知，禁止自动重试')
      }
      return unknown('submit', 'PUBLISH_NETWORK_UNKNOWN', '发布请求异常，结果未知，禁止自动重试：' + text)
    }
    if (!isRetOk(pubResp)) {
      return classifyMtopFailure('submit', retCode(pubResp), retMessage(pubResp))
    }
    const itemId = pubResp.data && pubResp.data.itemId ? safeText(pubResp.data.itemId) : ''
    if (!itemId) {
      return unknown('submit', 'NO_ITEM_ID', '服务端返回 SUCCESS 但缺少 itemId，结果未知')
    }
    return { ok: true, op: 'submit', status: 'published', itemId, warnings }
  }

  // ==================== 阶段：getProduct ====================
  const opGetProduct = async (): Promise<DirectPublishPageResult> => {
    const itemId = safeText(request.sourceItemId)
    if (!itemId) return rejected('getProduct', 'ITEM_ID_REQUIRED', '缺少 itemId')
    if (!(await waitForSdk())) {
      return knownAction('login', 'SDK_MISSING', '未检测到官方 MTOP SDK')
    }
    let resp: any
    try {
      resp = await mtop('mtop.taobao.idle.pc.detail', '1.0', { itemId })
    } catch (err) {
      return mtopFailureFromError('getProduct', err)
    }
    if (!isRetOk(resp)) {
      return classifyMtopFailure('getProduct', retCode(resp), retMessage(resp))
    }
    if (!resp.data || !resp.data.itemDO) {
      return rejected('getProduct', 'DETAIL_FAILED', '商品详情无 data.itemDO：' + (retMessage(resp) || retCode(resp) || '空响应'))
    }
    const itemDO = resp.data.itemDO as Record<string, unknown>
    const imageInfos = Array.isArray(itemDO['imageInfos']) ? (itemDO['imageInfos'] as unknown[]) : []
    const images = imageInfos
      .map((info) => (info && typeof info === 'object' ? safeText((info as Record<string, unknown>)['url']) : ''))
      .filter((url) => url.length > 0)
    return {
      ok: true,
      op: 'getProduct',
      status: 'product',
      product: {
        description: safeText(itemDO['desc'] || itemDO['title']),
        price: safeText(itemDO['soldPrice']),
        images,
        specifications: mapSpecifications(itemDO['itemLabelExtList']),
      },
    }
  }

  // ==================== 分派 ====================
  try {
    switch (request.op) {
      case 'account':
        return await opAccount()
      case 'uploadImage':
        return await opUploadImage()
      case 'prepare':
        return await opPrepare()
      case 'publish':
        return await opPublish()
      case 'submit':
        return await opSubmit()
      case 'getProduct':
        return await opGetProduct()
      default:
        return unknown(String(request.op), 'UNKNOWN_OP', '未知的页面操作')
    }
  } catch (err) {
    return unknown(request.op, 'PAGE_EXCEPTION', '页面脚本异常：' + describeError(err))
  }
}
