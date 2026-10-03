/**
 * Node resolve 钩子：让 Node 的 type-stripping 解析 TypeScript 的无扩展名相对导入，
 * 并把 `@fishops/shared` 映射到 monorepo 的 shared/events 入口。
 * 仅用于 workbench 的纯逻辑单测，不参与 vite 构建。
 */
const TS_EXTENSIONS = ['.ts', '.mts', '.cts']

// 本文件位于 workbench/src/features/chat/test/；shared 位于 monorepo 根的 shared/。
const SHARED_ENTRY = new URL('../../../../../shared/events/index.ts', import.meta.url).href

export function resolve(specifier, context, nextResolve) {
  if (specifier === '@fishops/shared') {
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
  for (const ext of TS_EXTENSIONS) candidates.push(specifier + ext)
  for (const ext of TS_EXTENSIONS) candidates.push(specifier + '/index' + ext)
  return candidates
}
