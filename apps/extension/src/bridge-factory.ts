import { AccountTracker } from './account.ts'
import { NativeBridge } from './connection.ts'
import { createDispatcher } from './dispatch.ts'
import type { ExtensionEnv } from './env.ts'
import { createChromePageContext } from './page-context.ts'
import { createPageBootstrap, type PageBootstrapScripting } from './page-bootstrap.ts'
import { createPageClient } from './page-client.ts'
import { createPlatformExecutor } from './platform-executor.ts'
import type { ChatOutbox } from './chat-outbox.ts'

export type BridgeDeps = {
  env: ExtensionEnv
  account?: AccountTracker
  scripting: PageBootstrapScripting
  /** 可选持久 outbox，由生产存储适配或测试显式注入。 */
  outbox?: ChatOutbox
  /** 可选人机验证解题器；生产注入 CDP 适配，测试可省略以只验证停机行为。 */
}

/**
 * 组合 native 连接与固定文档页面执行链。
 *
 * 每次 native 连接调用 `createStepHandler`，因此旧连接去重状态不会跨连接复用。
 * 账号读取由同一个 AccountTracker 串行化；页面上下文只接受绑定后的主文档。
 */
export function createBridge({ env, account: providedAccount, scripting, outbox }: BridgeDeps): NativeBridge {
  const account = providedAccount ?? new AccountTracker(env)
  const context = createChromePageContext(
    async () => (await account.read())?.userId ?? null,
    () => env.tabs.query('https://www.goofish.com/*', { active: true, lastFocusedWindow: true }),
    () => env.tabs.query('https://www.goofish.com/*'),
  )
  const bootstrap = createPageBootstrap({ context, scripting })
  const client = createPageClient({ scripting, context })
  return new NativeBridge({
    env,
    account,
    outbox,
    dispatch: createDispatcher({ env, account }),
    createPageResolver: () => async expectedAccountId => {
      const resolved = await context.resolve(expectedAccountId)
      return { tabId: resolved.tabId, documentId: resolved.documentId }
    },
    createStepHandler: () => createPlatformExecutor({ context, bootstrap, client }),
  })
}
