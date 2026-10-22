/**
 * Node resolve 钩子：让 Node 的 type-stripping 能解析 TypeScript 的无扩展名相对导入，
 * 并把 `@fishops/shared` 映射到 monorepo 的 shared/events 入口。
 *
 * TS 源码按 bundler resolution 书写（无扩展名），而 Node 需要显式扩展名。
 * 本钩子先走默认解析，失败后再依次尝试追加 `.ts` / `/index.ts`。
 * 使用同步实现，以配合 `module.registerHooks()`。
 */
const TS_EXTENSIONS = ['.ts', '.mts', '.cts']

// 本文件位于 extension/src/chat/test/；shared 位于 monorepo 根的 shared/。
const SHARED_ENTRY = new URL('../../../../shared/events/index.ts', import.meta.url).href

export function resolve(specifier, context, nextResolve) {
  if (specifier === '@fishops/shared' || specifier === '@fishops/shared/events') {
    return nextResolve(SHARED_ENTRY, context)
  }

  const isRelative =
    specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/') || specifier.startsWith('file:')
  if (!isRelative) return nextResolve(specifier, context)

  try {
    return nextResolve(specifier, context)
  } catch (originalError) {
    for (const candidate of candidatesFor(specifier)) {
      try {
        return nextResolve(candidate, context)
      } catch {
        // 继续尝试下一个候选。
      }
    }
    throw originalError
  }
}

function candidatesFor(specifier) {
  const candidates = []
  if (specifier.endsWith('.js')) candidates.push(specifier.slice(0, -3) + '.ts')
  if (specifier.endsWith('.mjs')) candidates.push(specifier.slice(0, -4) + '.mts')
  for (const ext of TS_EXTENSIONS) candidates.push(specifier + ext)
  for (const ext of TS_EXTENSIONS) candidates.push(specifier + '/index' + ext)
  return candidates
}
