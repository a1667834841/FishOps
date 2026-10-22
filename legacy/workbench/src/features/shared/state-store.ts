/**
 * 控制器公共基类：不可变状态 + 订阅通知 + 释放保护。
 * 纯 TypeScript，不依赖 Vue，页面通过 `subscribe` 把状态同步到 `shallowRef`。
 */
export type LoadPhase = 'idle' | 'loading' | 'ready' | 'error'

/** 单次异步命令的状态：idle 未发起，running 进行中，ok 成功，failed 失败。 */
export type ActionPhase = 'idle' | 'running' | 'ok' | 'failed'

export abstract class StateStore<S> {
  protected state: S
  protected disposed = false
  private readonly listeners = new Set<() => void>()
  private readonly cleanups: Array<() => void> = []

  protected constructor(initial: S) {
    this.state = initial
  }

  getState(): S {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 登记需要在 dispose 时释放的资源（事件订阅等）。 */
  protected track(cleanup: () => void): void {
    this.cleanups.push(cleanup)
  }

  protected patch(partial: Partial<S>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...partial }
    for (const listener of [...this.listeners]) listener()
  }

  /** 释放所有订阅；之后在途请求的返回都应被丢弃（用 `this.disposed` 判断）。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup()
      } catch {
        // 单个释放失败不影响其余资源。
      }
    }
    this.listeners.clear()
  }
}
