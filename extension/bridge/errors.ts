import type { ProtocolErrorCode } from '@fishops/shared'

/** Bridge 调用失败时抛出，携带协议错误码，便于调用方区分超时/环境缺失等情况。 */
export class BridgeError extends Error {
  readonly code: ProtocolErrorCode

  constructor(code: ProtocolErrorCode, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}
