import { computed, ref } from 'vue'

/** system：跟随系统；light / dark：用户手动指定。 */
export type ThemeMode = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'fishops.workbench.theme'

export const themeOptions: readonly { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark'
}

function readStored(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return isThemeMode(raw) ? raw : 'system'
  } catch {
    // 存储不可用（隐私模式等）时退回跟随系统。
    return 'system'
  }
}

function applyToDocument(mode: ThemeMode): void {
  const root = document.documentElement
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
}

const mode = ref<ThemeMode>('system')

/** 在应用挂载前调用，避免首屏闪烁。 */
export function initTheme(): void {
  mode.value = readStored()
  applyToDocument(mode.value)
}

export function useTheme() {
  function setMode(next: ThemeMode): void {
    mode.value = next
    applyToDocument(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // 持久化失败不影响本次会话内的主题切换。
    }
  }

  /** 顶部栏按钮：跟随系统 → 浅色 → 深色 循环。 */
  function cycle(): void {
    const order = themeOptions.map((option) => option.value)
    setMode(order[(order.indexOf(mode.value) + 1) % order.length])
  }

  const label = computed(() => themeOptions.find((option) => option.value === mode.value)?.label ?? '')

  return { mode, label, setMode, cycle }
}
