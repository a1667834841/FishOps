/**
 * 闲鱼 MTOP 签名与 token 解析。
 *
 * 迁移自旧 `FishOps`（main 分支）`xianyu-api.js` 的 `md5` / `getToken` / `getFullToken` / `generate`。
 * 行为保持一致的要点：
 * - 签名公式 `sign = md5(token & t & appKey & data)`；
 * - appKey 默认 `34839810`；
 * - token 取自 cookie `_m_h5_tk`，格式为 `<token>_<timestamp>`，签名只用下划线前的部分；
 * - MD5 按 UTF-8 字节计算。
 *
 * 安全约定：本模块只做“计算”，**不打印任何 token / cookie**；需要日志时使用 {@link redactSecret}。
 */

/** 闲鱼默认 MTOP appKey（旧代码硬编码，非密钥）。 */
export const MTOP_APP_KEY = '34839810'

/** 标准 MTOP token cookie 名。 */
export const MTOP_TOKEN_COOKIE = '_m_h5_tk'

/** 旧的登录 token cookie 名（chat 分支 user-api.js 使用）。 */
export const MTOP_LEGACY_TOKEN_COOKIE = '_m_h'

/** 签名结果，字段与旧 `generate()` 返回值一一对应。 */
export interface SignResult {
  /** 计算得到的 MD5 签名。 */
  sign: string
  /** 使用的时间戳（毫秒字符串）。 */
  t: string
  /** 使用的 appKey。 */
  appKey: string
  /** 使用的 token（已去掉 `_timestamp` 后缀）。 */
  token: string
  /** 序列化后的请求数据。 */
  data: string
  /**
   * 明文签名串 `token&t&appKey&data`。
   * 仅用于与旧实现对照 / 本地排查，**禁止写入日志或上报**（含 token）。
   */
  signString: string
}

export interface SignOptions {
  /** 自定义 token；缺省时使用空串（调用方应从 cookie 解析后传入）。 */
  token?: string | null
  /** 自定义时间戳（毫秒字符串）。 */
  timestamp?: string
  /** 自定义 appKey。 */
  appKey?: string
}

/**
 * 计算字符串的 MD5（UTF-8），复刻旧 `xianyu-api.js` 的实现。
 *
 * 旧实现通过 `unescape(encodeURIComponent(str))` 得到 UTF-8 字节；这里改用 `TextEncoder`
 * 得到等价字节序列，避免依赖已废弃的 `unescape`。对合法 UTF-16 字符串两者结果一致。
 */
export function md5(input: string): string {
  function rotateLeft(value: number, shift: number): number {
    return (value << shift) | (value >>> (32 - shift))
  }
  function addUnsigned(x: number, y: number): number {
    return (x + y) >>> 0
  }
  function fFn(x: number, y: number, z: number): number {
    return (x & y) | (~x & z)
  }
  function gFn(x: number, y: number, z: number): number {
    return (x & z) | (y & ~z)
  }
  function hFn(x: number, y: number, z: number): number {
    return x ^ y ^ z
  }
  function iFn(x: number, y: number, z: number): number {
    return y ^ (x | ~z)
  }
  function convertToWordArray(str: string): number[] {
    const bytes = new TextEncoder().encode(str)
    const len = bytes.length
    const words: number[] = []
    for (let i = 0; i < len; i += 4) {
      words.push(
        (bytes[i] ?? 0) |
          ((bytes[i + 1] ?? 0) << 8) |
          ((bytes[i + 2] ?? 0) << 16) |
          ((bytes[i + 3] ?? 0) << 24),
      )
    }
    const bitLen = len * 8
    words[len >> 2] = (words[len >> 2] ?? 0) | (0x80 << ((len % 4) * 8))
    words[(((len + 8) >>> 6) << 4) + 14] = bitLen
    return words
  }
  function wordToHex(value: number): string {
    let hex = ''
    for (let i = 0; i < 4; i++) {
      hex += ((value >> (i * 8)) & 0xff).toString(16).padStart(2, '0')
    }
    return hex
  }

  const x = convertToWordArray(input)
  let a = 0x67452301
  let b = 0xefcdab89
  let c = 0x98badcfe
  let d = 0x10325476
  const s = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  const k = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ]

  for (let block = 0; block < x.length; block += 16) {
    const aa = a
    const bb = b
    const cc = c
    const dd = d
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = fFn(b, c, d)
        g = i
      } else if (i < 32) {
        f = gFn(b, c, d)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = hFn(b, c, d)
        g = (3 * i + 5) % 16
      } else {
        f = iFn(b, c, d)
        g = (7 * i) % 16
      }
      const temp = d
      d = c
      c = b
      b = addUnsigned(
        b,
        rotateLeft(addUnsigned(addUnsigned(a, f), addUnsigned(k[i] ?? 0, x[block + g] ?? 0)), s[(Math.floor(i / 16) * 4) + (i % 4)] ?? 0),
      )
      a = temp
    }
    a = addUnsigned(a, aa)
    b = addUnsigned(b, bb)
    c = addUnsigned(c, cc)
    d = addUnsigned(d, dd)
  }
  return wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)
}

/**
 * 从 cookie 字符串中取出 `_m_h5_tk` 的完整值（形如 `<token>_<timestamp>`）。
 *
 * @param cookieString `document.cookie` 或等价字符串。
 * @returns 完整 cookie 值；未找到返回 null。**调用方不得将其写入日志。**
 */
export function getFullToken(cookieString: string): string | null {
  const match = cookieString.match(/_m_h5_tk=([^;]+)/)
  return match ? match[1] : null
}

/**
 * 解析 MTOP token：完整值 `xxx_timestamp` 取下划线前的 `xxx`。
 * 与旧 `getToken()` 的 `fullToken.split('_')[0]` 行为一致。
 */
export function parseToken(tokenCookieValue: string): string {
  return tokenCookieValue.split('_')[0] ?? ''
}

/**
 * 直接从 cookie 字符串解析出用于签名的 token（已去掉时间戳后缀）。
 * @returns token；未找到 cookie 时返回 null。
 */
export function extractToken(cookieString: string): string | null {
  const full = getFullToken(cookieString)
  return full === null ? null : parseToken(full)
}

/**
 * 读取页面 cookie 并解析 token 的默认实现（MAIN world 使用）。
 * 没有 document 时返回 null（便于 Node 环境安全调用）。
 */
export function extractDocumentToken(): string | null {
  if (typeof document === 'undefined') return null
  return extractToken(document.cookie)
}

/**
 * 生成 MTOP 签名，字段与旧 `generate()` 完全一致。
 *
 * @param data 请求数据对象或 JSON 字符串。
 */
export function generateSignature(data: unknown, options: SignOptions = {}): SignResult {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data)
  const token = options.token ?? ''
  const timestamp = options.timestamp ?? Date.now().toString()
  const appKey = options.appKey ?? MTOP_APP_KEY
  const signString = `${token}&${timestamp}&${appKey}&${dataStr}`
  return {
    sign: md5(signString),
    t: timestamp,
    appKey,
    token,
    data: dataStr,
    signString,
  }
}

/** 对敏感值脱敏，供日志使用：有值统一显示为 `***`。 */
export function redactSecret(value: string | null | undefined): string {
  return value ? '***' : ''
}
