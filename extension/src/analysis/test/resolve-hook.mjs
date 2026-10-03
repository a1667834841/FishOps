/**
 * Node resolve 钩子（数据源与分析模块测试共用）。
 *
 * 1. 把 `@fishops/shared` 映射到 monorepo 的 shared/events 入口；
 * 2. 相对路径缺少扩展名时依次尝试 `.ts` / `.mts` / `.mjs` / `.js`。
 */
const EXTENSIONS = ['.ts', '.mts', '.mjs', '.js']

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
        // 继续尝试下一个
      }
    }
  }
  return nextResolve(specifier, context)
}
