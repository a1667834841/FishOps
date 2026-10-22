/** 文档内执行锁；必须挂在文档全局对象，而不是随 SW/native 连接重建。 */
export type PageLock = {
  status(): { documentId: string; activeStepId: string | null; completed: number }
  run(stepId: string, fingerprint: string, execute: () => Promise<unknown>): Promise<unknown>
  /** 文档销毁或页面生命周期结束；终止等待并阻止后续步骤继续占用旧锁。 */
  dispose?(): void
}

/** 创建不可提前解锁的单请求执行器；只在真实请求 settle 后释放。 */
export function createPageLock(documentId: string, capacity = 10000): PageLock {
  if (!documentId || !Number.isSafeInteger(capacity) || capacity < 1) throw new Error('文档锁配置无效')
  /** `settle` 仅用于文档销毁等无法继续等待的场景；正常流程必须等待真实网络终结。 */
  const history = new Map<string, { fingerprint: string; result: Promise<unknown>; settle?: () => void }>()
  let active: string | null = null
  let completed = 0
  let disposed = false
  return {
    status: () => ({ documentId, activeStepId: active, completed }),
    run(stepId, fingerprint, execute) {
      if (disposed) return Promise.reject(new Error('文档已销毁'))
      if (!stepId || !fingerprint || typeof execute !== 'function') return Promise.reject(new Error('步骤参数无效'))
      const previous = history.get(stepId)
      if (previous) return previous.fingerprint === fingerprint ? previous.result : Promise.reject(new Error('步骤参数冲突'))
      if (active !== null) return Promise.reject(new Error('旧平台步骤仍在执行'))
      if (history.size >= capacity) return Promise.reject(new Error('文档去重容量已满'))
      active = stepId
      // 延迟进入回调，先登记去重记录，避免同步异常或重入发生在登记之前。
      let settle!: () => void
      const terminal=new Promise<unknown>((resolve,reject)=>{settle=()=>reject(new Error('文档已销毁'))})
      const result = Promise.race([Promise.resolve().then(execute),terminal]).finally(() => { active = null; completed++ })
      history.set(stepId, { fingerprint, result, settle })
      return result
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const item of history.values()) item.settle?.()
      active = null
    },
  }
}

/** 在同一文档全局复用锁；文档代次不符时拒绝覆盖，不能借重新注入清除旧锁。 */
export function installPageLock(scope: Record<string, unknown>, documentId: string): PageLock {
  const key = '__fishopsDocumentExecutionLockV1__'
  const existing = scope[key] as PageLock | undefined
  if (existing) {
    if (typeof existing.status !== 'function' || existing.status().documentId !== documentId) throw new Error('文档锁代次冲突')
    return existing
  }
  const lock = createPageLock(documentId)
  Object.freeze(lock)
  Object.defineProperty(scope, key, { value: lock, configurable: false, writable: false })
  return lock
}
