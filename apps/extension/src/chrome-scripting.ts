import type { PageBootstrapScripting } from './page-bootstrap.ts'

/** 生产 Chrome scripting 适配；业务组合只依赖最小注入接口。 */
export function createChromeScripting(): PageBootstrapScripting {
  return chrome.scripting as unknown as PageBootstrapScripting
}
