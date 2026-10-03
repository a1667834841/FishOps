/**
 * P5 聊天只读层出口。
 *
 * 模块划分：
 * - `websocket.ts` 只读监听闲鱼聊天 WebSocket（不发送）
 * - `parser.ts`   消息解码与归一（MessagePack / base64 / JSON）
 * - `history.ts`  会话列表与消息历史请求构造（LWP、分页游标）
 * - `store.ts`    标准 ChatMessage / Conversation 存储（去重、排序、会话隔离）
 * - `sync.ts`     实时与历史归一后写入 store
 * - `bridge-adapter.ts` 对接 P1 Bridge 的事件/命令适配层
 * - `socket-transport.ts` 只读 LWP transport（MAIN world 发送 + 白名单校验）
 * - `background-transport.ts` background 侧经 chrome.scripting 调用 MAIN world transport
 * - `chat-host.ts` MAIN world 组装（monitor + transport + 上报）
 * - `session-persistence.ts` chrome.storage.session 持久化实现
 */
export * from './parser'
export * from './websocket'
export * from './history'
export * from './store'
export * from './sync'
export * from './bridge-adapter'
export * from './socket-transport'
export * from './chat-host'
export * from './session-persistence'
