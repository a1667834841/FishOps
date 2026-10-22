/**
 * 直接发布（两阶段）扩展后台通信客户端。
 *
 * 负责通过 chrome.runtime.sendMessage 与扩展 Service Worker 的
 * direct-publish-api 监听器通信。
 *
 * 安全规范：
 * 1. 消息契约：kind 必须为 'fishops-direct-publish'，method 为 'prepare' | 'submit'；
 * 2. 运行时检查：检测到非扩展环境（如 localhost 独立开发）时，给出明确提示，不伪造权限；
 * 3. 超时控制：默认超时 130 秒（后台页面注入超时为 120 秒），防止前端先行断开将真实执行误判为 unknown；
 * 4. submit 传输失联防线：提交时若发生通信中断、端口关闭或超时，提交动作可能已在平台生效，
 *    必须保守归为 `unknown` 状态并阻断重试，严禁当成一般失败重放！
 */

import type {
  DirectPublishPrepareRequest,
  DirectPublishPreparedResult,
  DirectPublishSubmitRequest,
  DirectPublishSubmitResult,
} from './direct-publish-types'

export interface DirectPublishJob {
  idempotencyKey: string
  status: string
  itemId?: string
  /** 发布时冻结的商品名称，旧记录可缺省。 */
  productName?: string
  at: string
  code?: string
  actionRequired?: string
}

export interface DirectPublishProductResult {
  status: 'ok' | 'action_required' | 'rejected' | 'unknown'
  itemId: string
  product?: {
    description: string
    price: string
    images: string[]
    specifications?: Array<{ name: string; value: string }>
  }
  code?: string
  message?: string
}

export const DIRECT_PUBLISH_MESSAGE_KIND = 'fishops-direct-publish'

/**
 * 默认前端等待超时（毫秒）：提升至 300 秒（5 分钟）。
 * 原因：后台 prepare 包含 15 秒专用 tab 加载等待，加之多张图片上传、资格预检、
 * 敏感词扫描、POI 归一与推荐类目卡片等多次 120 秒页面注入阶段，总请求包含多个阶段，
 * 因此前端整体等待超时设为 300 秒，防止前端因提早超时将正常执行中的后台请求误判为 unknown。
 */
export const DEFAULT_DIRECT_PUBLISH_TIMEOUT_MS = 300000

export interface DirectPublishClientDeps {
  /** 允许外部注入 Promise 或 Chrome callback 风格的 sendMessage（便于纯 Node 单测）。 */
  sendMessage?: (message: unknown, callback?: (response: unknown) => void) => Promise<unknown> | void
  timeoutMs?: number
}

interface ChromeRuntimeLike {
  lastError?: { message?: string }
  sendMessage(message: unknown, callback: (response: unknown) => void): void
}

interface BackgroundResponse<T> {
  kind: typeof DIRECT_PUBLISH_MESSAGE_KIND
  method: string
  ok: boolean
  result?: T
  error?: { code: string; message: string }
}

export class DirectPublishClient {
  private readonly injectedSendMessage?: (message: unknown, callback?: (response: unknown) => void) => Promise<unknown> | void
  private readonly timeoutMs: number

  constructor(deps: DirectPublishClientDeps = {}) {
    this.injectedSendMessage = deps.sendMessage
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_DIRECT_PUBLISH_TIMEOUT_MS
  }

  /** 检测扩展通信通道是否可用。 */
  public isRuntimeAvailable(): boolean {
    if (this.injectedSendMessage) return true
    const globalChrome = (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome
    return typeof globalChrome?.runtime?.sendMessage === 'function'
  }

  /** 发送底层消息（带超时与环境守卫）。 */
  private async send<TReq, TRes>(method: 'prepare' | 'submit' | 'uploadImage' | 'getProduct' | 'getJob', request: TReq): Promise<TRes> {
    if (!this.isRuntimeAvailable()) {
      throw new Error(
        JSON.stringify({
          code: 'RUNTIME_UNAVAILABLE',
          message: '当前处于非扩展环境（如 localhost），无法与后台 Service Worker 通信',
        }),
      )
    }

    const message = {
      kind: DIRECT_PUBLISH_MESSAGE_KIND,
      method,
      request,
    }

    const sendFn =
      this.injectedSendMessage ||
      ((msg: unknown, callback?: (response: unknown) => void) => {
        const chromeRuntime = (globalThis as unknown as { chrome: { runtime: ChromeRuntimeLike } }).chrome.runtime
        return new Promise<unknown>((resolve, reject) => {
          chromeRuntime.sendMessage(msg, (response) => {
            const lastError = chromeRuntime.lastError
            if (lastError) {
              reject(new Error(JSON.stringify({
                code: 'RUNTIME_MESSAGE_FAILED',
                message: lastError.message || '后台消息通道失败',
              })))
              return
            }
            callback?.(response)
            resolve(response)
          })
        })
      })

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`COMMUNICATION_TIMEOUT:${method}`))
      }, this.timeoutMs)
    })

    try {
      const raw = (await Promise.race([
        new Promise<unknown>((resolve, reject) => {
          try {
            const returned = sendFn(message, (response) => resolve(response))
            if (returned && typeof (returned as Promise<unknown>).then === 'function') {
              ;(returned as Promise<unknown>).then(resolve, reject)
            }
          } catch (error) {
            reject(error)
          }
        }),
        timeoutPromise,
      ])) as BackgroundResponse<TRes>
      if (!raw || raw.kind !== DIRECT_PUBLISH_MESSAGE_KIND || raw.method !== method) {
        throw new Error(
          JSON.stringify({
            code: 'INVALID_RESPONSE',
            message: '后台返回了非预期的消息格式',
          }),
        )
      }

      if (raw.error) {
        throw new Error(
          JSON.stringify({
            code: raw.error.code || 'UNKNOWN_ERROR',
            message: raw.error.message || '后台返回错误',
          }),
        )
      }

      if (!raw.result) {
        throw new Error(
          JSON.stringify({
            code: 'NO_RESULT',
            message: '后台未返回操作结果',
          }),
        )
      }

      return raw.result
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * 第一阶段：准备发布数据（跑完 publish 前全部接口，返回待审核 draft 与候选 cards）。
   * 绝不调用 submit。
   */
  public async prepare(request: DirectPublishPrepareRequest): Promise<DirectPublishPreparedResult> {
    try {
      return await this.send<DirectPublishPrepareRequest, DirectPublishPreparedResult>('prepare', request)
    } catch (err) {
      let code = 'PREPARE_TRANSPORT_ERROR'
      let message = '准备发布通信失败'
      if (err instanceof Error) {
        try {
          const parsed = JSON.parse(err.message) as { code?: string; message?: string }
          if (parsed && typeof parsed === 'object') {
            code = parsed.code || code
            message = parsed.message || message
          }
        } catch {
          if (err.message.startsWith('COMMUNICATION_TIMEOUT')) {
            code = 'PREPARE_TIMEOUT'
            message = `准备发布接口等待超过 ${Math.round(this.timeoutMs / 1000)} 秒，操作未完成`
          } else {
            message = err.message
          }
        }
      }
      return {
        status: 'rejected',
        code,
        message,
      }
    }
  }

  /** 只读查询后台持久化的直接发布审计历史。 */
  public async getJobs(): Promise<{ ok: boolean; jobs: DirectPublishJob[]; error?: { code: string; message: string } }> {
    try {
      const response = await this.send<Record<string, never>, { ok: boolean; jobs: DirectPublishJob[]; error?: { code: string; message: string } }>('getJob', {})
      if (!response || typeof response.ok !== 'boolean' || !Array.isArray(response.jobs)) {
        return { ok: false, jobs: [], error: { code: 'INVALID_JOB_RESPONSE', message: '后台 getJob 响应缺少审计记录列表' } }
      }
      return response
    } catch (error) {
      return { ok: false, jobs: [], error: { code: 'AUDIT_QUERY_FAILED', message: error instanceof Error ? error.message : '读取发布审计失败' } }
    }
  }

  /** 在闲鱼页面上下文上传本地图片，返回平台图片对象。 */
  /** 获取自营商品最新详情；失败时不回退到旧缓存。 */
  public async getProduct(itemId: string): Promise<DirectPublishProductResult> {
    return this.send<{ itemId: string }, DirectPublishProductResult>('getProduct', { itemId })
  }


  public async uploadImage(dataUrl: string): Promise<Record<string, unknown>> {
    try {
      return await this.send<{ dataUrl: string }, Record<string, unknown>>('uploadImage', { dataUrl })
    } catch (err) {
      const message = err instanceof Error ? err.message : '本地图片上传失败'
      throw new Error(message)
    }
  }

  /**
   * 第二阶段：最终提交发布。
   * 提交时失联或超时，保守按 unknown 处理，严禁自动重试！
   */
  public async submit(request: DirectPublishSubmitRequest): Promise<DirectPublishSubmitResult> {
    try {
      const res = await this.send<DirectPublishSubmitRequest, DirectPublishSubmitResult>('submit', request)
      return res
    } catch (err) {
      let code = 'SUBMIT_TRANSPORT_LOST'
      let message = '提交阶段与后台通信失联或超时，发布提交结果未知（平台可能已接收并发布），为防重复发布已锁定，严禁自动重试，请去闲鱼核实'
      if (err instanceof Error) {
        try {
          const parsed = JSON.parse(err.message) as { code?: string; message?: string }
          if (parsed?.code === 'RUNTIME_UNAVAILABLE') {
            return {
              status: 'rejected',
              idempotencyKey: '',
              code: parsed.code,
              message: parsed.message || message,
            }
          }
          if (parsed && typeof parsed === 'object') {
            code = parsed.code || code
            message = parsed.message || message
          }
        } catch {
          if (err.message.startsWith('COMMUNICATION_TIMEOUT')) {
            code = 'SUBMIT_TIMEOUT'
            message = `提交阶段等待后台响应超过 ${Math.round(this.timeoutMs / 1000)} 秒，平台状态未知，已锁定禁止重试`
          }
        }
      }
      return {
        status: 'unknown',
        idempotencyKey: '',
        code,
        message,
      }
    }
  }
}
