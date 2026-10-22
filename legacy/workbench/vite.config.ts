import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '..')

/**
 * Workbench 构建配置。
 *
 * - 以 `workbench.html` 作为唯一入口，输出到 `extension/dist`，与扩展构建产物合并，
 *   使 `chrome-extension://<id>/workbench.html` 可直接打开。
 * - base 用 './'，保证在 chrome-extension:// 协议下静态资源按相对路径加载。
 * - alias 让 @fishops/bridge 直接指向 extension/bridge 源码（开发期无需先构建）。
 */
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(here, 'src'),
      '@fishops/shared': resolve(root, 'shared/events/index.ts'),
      '@fishops/bridge': resolve(root, 'extension/bridge/index.ts'),
    },
  },
  optimizeDeps: {
    // 指向源码的 workspace 包不参与预构建，交给 Vite 直接编译 TypeScript。
    exclude: ['@fishops/shared'],
  },
  build: {
    outDir: resolve(root, 'extension/dist'),
    // 与扩展构建共享输出目录，交由根脚本统一清理，这里不清空。
    emptyOutDir: false,
    target: 'chrome110',
    sourcemap: true,
    rollupOptions: {
      input: {
        workbench: resolve(here, 'workbench.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
