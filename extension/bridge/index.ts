/**
 * @fishops/bridge —— Workbench 侧运行时 SDK。
 *
 * 该目录是 Workbench 与扩展通信的唯一入口：
 * - `createRuntimeClient()` 创建客户端
 * - `ChromeRuntimeTransport` / `PostMessageTransport` 两种传输层
 * - `postmessage-protocol` 供 content script / MAIN world 共用的页面消息协议
 */
export * from './errors'
export * from './runtime-client'
export * from './transport'
export * from './postmessage-protocol'
