import type { ApiError as ApiErrorShape, ErrorCode } from '../../../packages/protocol/src/index.ts'

/** 扩展侧统一错误：携带公共协议错误码，直接映射为 wire 的 res.error。 */
export class ApiError extends Error {
  readonly code: ErrorCode
  readonly phase: 'queue' | 'read' | 'write' | undefined
  readonly retryable: boolean | undefined

  constructor(
    code: ErrorCode,
    message: string,
    options: { phase?: 'queue' | 'read' | 'write'; retryable?: boolean } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.phase = options.phase
    this.retryable = options.retryable
  }

  /**
   * 转为 wire 响应体。协议只允许这四个字段，因此缺省字段不写入，
   * 避免出现 `undefined` 键被严格校验拒绝。
   */
  toWire(): ApiErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.phase === undefined ? {} : { phase: this.phase }),
      ...(this.retryable === undefined ? {} : { retryable: this.retryable }),
    }
  }

  /**
   * 任意异常归一化为 ApiError。
   * 非本模块构造的异常一律使用常量中文消息：原始 message 可能包含 cookie、
   * 浏览器内部信息或平台响应，不能回传到 wire 或日志摘要里。
   */
  static from(error: unknown, fallbackCode: ErrorCode = 'INTERNAL'): ApiError {
    if (error instanceof ApiError) return error
    return new ApiError(fallbackCode, '扩展内部错误')
  }
}

/** 协议校验函数会抛出字符串错误码，这里统一转换。 */
export function fromProtocolError(error: unknown): ApiError {
  if (typeof error === 'string') {
    return new ApiError(error as ErrorCode, `参数校验失败：${error}`)
  }
  return ApiError.from(error, 'BAD_REQUEST')
}
