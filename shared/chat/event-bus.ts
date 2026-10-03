/**
 * 极简类型化事件总线（P5 只读）。
 *
 * 参考旧 `chat` 分支的 `inject/events/event-bus.js`，但改为模块导出 + 类型安全，
 * 不再挂到 `window`。用于把「消息源 → 业务处理」解耦：解析器/同步器只发布事件，
 * 未来的 Bridge 适配层或 Workbench 消费事件。
 */

/** 取消订阅函数。 */
export type Unsubscribe = () => void

/** 事件负载映射：键为事件名，值为负载类型。 */
export type ChatEventMap = Record<string, unknown>

/** 类型化事件总线。 */
export class TypedEventBus<TEvents extends ChatEventMap = ChatEventMap> {
  private readonly handlers = new Map<keyof TEvents, Set<(payload: TEvents[keyof TEvents]) => void>>()

  /** 订阅事件，返回取消订阅函数。 */
  on<K extends keyof TEvents>(type: K, handler: (payload: TEvents[K]) => void): Unsubscribe {
    const set = this.handlers.get(type) ?? new Set()
    set.add(handler as (payload: TEvents[keyof TEvents]) => void)
    this.handlers.set(type, set)
    return () => {
      set.delete(handler as (payload: TEvents[keyof TEvents]) => void)
      if (set.size === 0) this.handlers.delete(type)
    }
  }

  /**
   * 发布事件。
   * 单个处理器抛错不影响其他处理器，与旧 EventBus 行为一致。
   */
  emit<K extends keyof TEvents>(type: K, payload: TEvents[K]): void {
    const set = this.handlers.get(type)
    if (!set) return
    for (const handler of [...set]) {
      try {
        handler(payload)
      } catch {
        // 吞掉处理器异常，避免影响消息主流程；调用方自行在处理器内记录。
      }
    }
  }

  /** 清空全部订阅。 */
  clear(): void {
    this.handlers.clear()
  }
}
