/**
 * 测试注册入口：`node --import ./register.mjs --test <dir>`。
 *
 * 平台源码沿用项目一贯的“无扩展名相对导入”写法（与 bundler/tsc 一致），
 * 但 Node 原生 ESM 要求显式扩展名。这里注册一个同步 resolve hook：
 * 1. 把 `@fishops/shared` 映射到 monorepo 的 shared 入口（源码里用裸包名导入）；
 * 2. 仅在解析相对路径且缺少扩展名时依次尝试 `.ts`/`.mts`/`.mjs`/`.js`。
 * 不改变任何其它解析行为。
 */
import { registerHooks } from 'node:module'

const EXTENSIONS = ['.ts', '.mts', '.mjs', '.js']

// register.mjs 位于 extension/src/platform/__tests__/；shared 位于 monorepo 根的 shared/。
const SHARED_ENTRY = new URL('../../../../shared/events/index.ts', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@fishops/shared' || specifier === '@fishops/shared/events') {
      return nextResolve(SHARED_ENTRY, context)
    }

    const isRelative =
      specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')
    const hasExtension = /\.[cm]?[jt]s$/.test(specifier)

    if (isRelative && !hasExtension) {
      for (const extension of EXTENSIONS) {
        try {
          return nextResolve(specifier + extension, context)
        } catch {
          // 该扩展名不存在，继续尝试下一个
        }
      }
    }
    return nextResolve(specifier, context)
  },
})
