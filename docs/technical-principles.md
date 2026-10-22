# Agent API 技术原理

## 边界

Agent 经带 Bearer token 的本机 HTTP 调用 Node host，host 经 Chrome native messaging 与 MV3 service worker 通信。公共协议统一在 `packages/protocol`。host 只监听 IPv4 loopback，拒绝 Origin，不启用 CORS。

M1 的扩展只读 cookie 和 tabs，不注入页面、不建立 IM 连接、不调用闲鱼网络。`system.status` 经真实 native bridge 返回，历史查询从 SQLite 返回。

## 生命周期与持久化

扩展连接时先读取账号并发送 hello，host 完成验证后才就绪。账号读取异常不能变成假退出。native stdin EOF 结束 host，因此停止 SW 或关闭浏览器可使 HTTP 连接失败。重新打开后通过 SQLite 恢复记录，不承诺常驻。

数据库启用 WAL，序号使用 SQLite 64 位整数并通过十进制字符串对外提供。事件先入库再 SSE 推送；账号切换关闭已有订阅。SSE 只恢复已入库事件，M1 不保证断线期间所有账号转换都有记录。聊天可靠 outbox 与历史补齐属于 M3。

## 验证

协议单测、真实 host 子进程集成、构建与临时安装测试均不需要账号。真实 Chrome 验收单独记录，不把模拟 native 对端当成浏览器。完整契约以 [实施契约](agent-api-contract.md) 为准。
