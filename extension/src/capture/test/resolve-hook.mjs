/**
 * Node resolve 钩子（采集模块测试与 smoke 共用）。
 *
 * 1. 把 `@fishops/shared` 映射到 monorepo 的 shared/events 入口；
 * 2. 相对路径缺少扩展名时依次尝试 `.ts` / `.mts` / `.mjs` / `.js`。
 *
 * TS 源码按 bundler resolution 书写（无扩展名），Node 原生 ESM 需要显式扩展名。
 */
const EXTENSIONS = ['.ts', '.mts', '.mjs', '.js']

// 本文件位于 extension/src/capture/test/；shared 位于 monorepo 根的 shared/。
const SHARED_ENTRY = new URL('../../../../shared/events/index.ts', import.meta.url).href

export function resolve(specifier, context, nextResolve) {
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
}
