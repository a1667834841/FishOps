export interface PublishReturnCountdownState {
  countdownSeconds: number
  isPublishModalOpen: boolean
  modalOpen: boolean
  showTaskListOnly: boolean
  taskHistoryOpen: boolean
}

let activeTimer: ReturnType<typeof setInterval> | null = null

export interface PublishReturnCountdownEffects {
  onTick?(seconds: number): void
  onComplete?(): void
}

/** 成功发布后倒数五秒回到历史列表；返回清理函数以隔离页面实例生命周期。 */
export function startPublishReturnCountdown(
  state: PublishReturnCountdownState,
  effects: PublishReturnCountdownEffects = {},
): () => void {
  const clear = (): void => {
    if (activeTimer !== null) {
      clearInterval(activeTimer)
      activeTimer = null
    }
  }

  clear()
  state.countdownSeconds = 5
  activeTimer = setInterval(() => {
    if (state.countdownSeconds > 1) {
      state.countdownSeconds -= 1
      effects.onTick?.(state.countdownSeconds)
      return
    }
    state.countdownSeconds = 0
    state.isPublishModalOpen = false
    state.modalOpen = false
    state.taskHistoryOpen = true
    state.showTaskListOnly = true
    clear()
    effects.onComplete?.()
  }, 1000)

  return clear
}
