import { validateParams, type ExtensionStatus } from '../../../../packages/protocol/src/index.ts'
import type { AccountTracker } from '../account.ts'
import type { ExtensionEnv } from '../env.ts'
import { ApiError, fromProtocolError } from '../errors.ts'

/** 闲鱼页面匹配范围：M1 只判断“有没有页面”，不注入也不打开。 */
const XIANYU_TAB_PATTERN = 'https://*.goofish.com/*'

export interface SystemModuleDeps {
  env: ExtensionEnv
  account: AccountTracker
}

/**
 * `system.status` 的扩展侧实现。
 *
 * 只读 cookie 与 tabs，不发闲鱼请求。`chatReady` 固定为 null：
 * M1 没有观测聊天连接，不能用 null 冒充“未就绪”或“已就绪”。
 * `protocolVersion` / `hostVersion` / `nativeConnected` / `capabilities` 由 host 补齐。
 */
export async function systemStatus(deps: SystemModuleDeps, params: unknown): Promise<ExtensionStatus> {
  try {
    validateParams('system.status', params)
  } catch (error) {
    throw fromProtocolError(error)
  }
  const account = await readAccount(deps.account)
  const present = await hasXianyuTab(deps.env)
  return {
    extensionVersion: deps.env.version,
    account,
    page: { present },
    chatReady: null,
  }
}

/** 读取失败必须显式报错：账号未知不等于未登录。 */
async function readAccount(account: AccountTracker) {
  try {
    return await account.read()
  } catch {
    throw new ApiError('INTERNAL', '账号读取失败', { retryable: true })
  }
}

async function hasXianyuTab(env: ExtensionEnv): Promise<boolean> {
  try {
    const tabs = await env.tabs.query(XIANYU_TAB_PATTERN)
    return tabs.length > 0
  } catch {
    throw new ApiError('INTERNAL', '标签页查询失败', { retryable: true })
  }
}
