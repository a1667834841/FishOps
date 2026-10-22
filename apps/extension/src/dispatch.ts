import { ApiError } from './errors.ts'
import { systemStatus, type SystemModuleDeps } from './modules/system.ts'

export type MethodDispatcher = (method: string, params: unknown) => Promise<unknown>

/**
 * `method → handler` 分发。
 *
 * M1 只注册 `system.status`：`events.list` / `requests.list` 是 host 的本地查询，
 * 不会转发到扩展。未知方法返回 NOT_FOUND，不进入任何 handler。
 */
export function createDispatcher(deps: SystemModuleDeps): MethodDispatcher {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>([
    ['system.status', (params) => systemStatus(deps, params)],
  ])

  return async (method, params) => {
    const handler = handlers.get(method)
    if (!handler) throw new ApiError('NOT_FOUND', `未实现的方法：${method}`)
    try {
      // host 允许省略 params；缺省按空对象校验，缺字段由协议校验统一拒绝。
      return await handler(params ?? {})
    } catch (error) {
      throw ApiError.from(error, 'INTERNAL')
    }
  }
}
