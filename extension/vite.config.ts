import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig, type UserConfig } from 'vite'

/**
 * Extension 打包配置。
 *
 * 通过 ENTRY 环境变量切换入口，每个入口单独构建，避免多入口之间产生共享 chunk
 * （content script 由 manifest 以经典脚本方式加载，不能含顶层 import/export）。
 *
 * 产物统一输出到 `extension/dist`，与 workbench 构建产物合并后即为可加载的扩展目录。
 */

const here = fileURLToPath(new URL('.', import.meta.url))

interface EntrySpec {
  input: string
  /** 相对 dist 的输出文件名。 */
  output: string
  /** background 用 ESM（service worker type: module），content script 用 IIFE。 */
  format: 'es' | 'iife'
}

const entries: Record<string, EntrySpec> = {
  background: { input: 'src/background/index.ts', output: 'background.js', format: 'es' },
  'content-isolated': {
    input: 'src/content/isolated-bridge.ts',
    output: 'content/isolated-bridge.js',
    format: 'iife',
  },
  'content-main': {
    input: 'src/content/main-world-bridge.ts',
    output: 'content/main-world-bridge.js',
    format: 'iife',
  },
  'content-platform': {
    input: 'src/content/platform-main.ts',
    output: 'content/platform-main.js',
    format: 'iife',
  },
  'content-chat': {
    input: 'src/content/chat-main.ts',
    output: 'content/chat-main.js',
    format: 'iife',
  },
}

export default defineConfig((): UserConfig => {
  const entryKey = process.env.ENTRY ?? 'background'
  const spec = entries[entryKey]
  if (!spec) {
    throw new Error(`未知的 ENTRY=${entryKey}，可选值：${Object.keys(entries).join(', ')}`)
  }

  return {
    root: here,
    // manifest.json 等静态文件从 public/ 复制到 dist/
    publicDir: resolve(here, 'public'),
    resolve: {
      alias: {
        '@fishops/shared': resolve(here, '../shared/events/index.ts'),
      },
    },
    build: {
      outDir: resolve(here, 'dist'),
      // 多个入口分多次构建共享同一 outDir，交由根脚本 clean 统一清理。
      emptyOutDir: false,
      target: 'chrome110',
      minify: false,
      sourcemap: true,
      rollupOptions: {
        input: { [entryKey]: resolve(here, spec.input) },
        output: {
          format: spec.format,
          entryFileNames: spec.output,
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  }
})
