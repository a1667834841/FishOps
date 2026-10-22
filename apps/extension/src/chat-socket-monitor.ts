/** 被动聊天 socket 回调；仅提供当前 socket 和受限帧，不读取凭据或解析协议。 */
export type ChatSocketMonitorHandlers = {
  onDropped?(reason: 'NON_STRING_FRAME' | 'FRAME_TOO_LARGE'): void
  onMessage?(data: string, socket: WebSocket): void
  onOpen?(socket: WebSocket): void
  onClose?(socket: WebSocket): void
}

/** 安装位置；生产传入页面 globalThis，测试可注入假构造器。 */
export type ChatSocketMonitorScope = { WebSocket: typeof WebSocket }

/** 监视器释放接口；重复调用安全，不关闭页面连接。 */
export type ChatSocketMonitor = { dispose(): void }

const MAX_FRAME_BYTES = 256 * 1024
const encoder = new TextEncoder()

function isTarget(value: unknown): boolean {
  try {
    const url = new URL(String(value))
    return url.protocol === 'wss:' && url.hostname === 'wss-goofish.dingtalk.com' &&
      !url.username && !url.password && !url.port
  } catch { return false }
}

/**
 * 包装页面自身的 WebSocket 构造器；只有页面主动 new 时才委托原构造器一次。
 * 不创建后台连接，不调用 send，不保存 URL 或凭据。仅捕获安装后创建的目标连接。
 */
export function installChatSocketMonitor(
  scope: ChatSocketMonitorScope,
  handlers: ChatSocketMonitorHandlers = {},
): ChatSocketMonitor {
  const Original = scope.WebSocket
  let disposed = false
  const listeners = new Map<WebSocket, Array<[string, EventListener]>>()
  const safely = (callback: () => void) => { try { callback() } catch { /* 观察失败不能干扰页面。 */ } }
  function detach(socket: WebSocket): void {
    for (const [type, listener] of listeners.get(socket) ?? []) {
      safely(() => socket.removeEventListener(type, listener))
    }
    listeners.delete(socket)
  }
  function observe(socket: WebSocket): void {
    if (disposed || listeners.has(socket)) return
    const entries: Array<[string, EventListener]> = [
      ['message', event => {
        if (disposed) return
        const data: unknown = (event as MessageEvent).data
        // UTF-16 长度先拦截明显超限输入，避免对巨大帧额外分配编码缓冲。
        if (typeof data !== 'string') { safely(() => handlers.onDropped?.('NON_STRING_FRAME')); return }
        if (data.length > MAX_FRAME_BYTES || encoder.encode(data).byteLength > MAX_FRAME_BYTES) { safely(() => handlers.onDropped?.('FRAME_TOO_LARGE')); return }
        safely(() => handlers.onMessage?.(data, socket))
      }],
      ['open', () => { if (!disposed) safely(() => handlers.onOpen?.(socket)) }],
      ['close', () => {
        detach(socket)
        if (!disposed) safely(() => handlers.onClose?.(socket))
      }],
    ]
    listeners.set(socket, entries)
    try {
      for (const [type, listener] of entries) socket.addEventListener(type, listener)
    } catch { detach(socket) }
  }
  // Proxy 默认转发静态属性和 prototype；保留原生 instanceof 与子类 new.target。
  const Wrapped = new Proxy(Original, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget) as WebSocket
      safely(() => { if (!disposed && isTarget(args[0])) observe(socket) })
      return socket
    },
  })
  scope.WebSocket = Wrapped
  return {
    dispose() {
      if (disposed) return
      disposed = true
      for (const socket of listeners.keys()) detach(socket)
      // 后装的第三方 wrapper 可能还委托本 wrapper，不能覆盖它；disposed 会阻止重新观察。
      if (scope.WebSocket === Wrapped) scope.WebSocket = Original
    },
  }
}
