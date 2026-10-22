# M4 写聊天实施契约

## 范围

实现 `chat.open` 和 `chat.send`。只复用页面已经建立的聊天 socket，不新建 IM 连接、不刷新 token、不自动重试。每次写操作经过 Host 调度、账号核验、固定页面文档锁和统一 `operations` 表。

## 幂等

- `chat.open` 和 `chat.send` 必须带 `idempotencyKey`。
- Host 先按账号、方法和 key 计算规范参数指纹，再预留 `attempting`。
- 同指纹重复调用返回已有状态；不同指纹返回 `IDEMPOTENCY_CONFLICT`。
- `attempting`、`unknown` 不自动重发，返回 `RESULT_UNKNOWN`，由 Agent 先查询操作或调用同步。
- 只有收到明确业务终结响应才写 `succeeded` 或 `rejected`。
- 写入操作响应丢失时不能根据 HTTP 断开推断失败。

## 页面边界

- `chat.open` 只允许已核验的建聊路由和参数。
- `chat.send` 只允许已核验的发送路由和文本；文本最多 2000 字符，禁止原始 envelope 透传。
- socket 必须是页面已观察、OPEN、当前账号和 documentId 唯一匹配的连接。
- 发送前登记唯一 `mid`，响应必须来自同一 socket、同一代次并匹配 `mid`。
- 超时、断线、账号变化和页面导航都进入未知状态；不能释放在途锁后重发。
- 风控、登录失效和平台拒绝必须转为固定错误类别，不写平台原文。

## 测试契约

- 正常 open/send：一次发送、明确终结、结果落库。
- 同 key 同参数：不再发送，返回已有结果。
- 同 key 异参数：`IDEMPOTENCY_CONFLICT`，不发送。
- 进程重启：`attempting`/`unknown` 不重放。
- socket 无法唯一定位、账号切换、导航、超时、错误响应：固定失败，写操作不自动重试。
- 真实验收只使用用户授权测试账号和测试商品；普通回归不发送真实消息。

M4 完成前不把真实平台发送结果写成已验证风控安全；平台风控仍以停止和提示为准。

## 基础进度

- 写参数 schema 与幂等指纹模块已完成，8 项定向测试通过。
- SQLite operations v4 已完成，4 项定向测试通过；`attempting` 重启保留，不自动重放，同 key 异指纹拒绝。
- 当前未注册 `chat.open`/`chat.send`，未发送真实消息。页面证据明确 chat.open 协议仍缺可靠当前实现，不能假设 legacy 单样本可直接上线。
- M4 基础实现后完整离线回归通过：`.test-results/2026-10-17T18-08-22.972Z-66674-50a22b8c/report.json`。
- 修正现有聊天数据库迁移测试的版本期望：operations 表使最终 schema 为 v4，不影响迁移保留验证。

## 页面写 transport 进度

静态证据已确认 `chat.send` 的固定 envelope、路由、双接收方、单次 send 和未知结果语义。当前按安全边界实现独立 transport：不创建 socket、不重试、不关闭页面连接，超时/断线/账号变化进入永久 poison。真实发送仍需用户授权测试商品和真实平台 E2E；普通回归只使用 fake socket。
- `chat.send` transport 已实现，12 项定向测试通过，类型检查通过。固定路由和 envelope、base64 文本、双接收方、单次 send、响应匹配、风险/登录分类及永久 poison 均已覆盖。
- transport 只证明协议响应，不证明跨设备最终持久化；公共路由、统一 operations 编排、页面 runtime 写分支和真实发送验收仍未完成。
- `chat.send` 编排初版已完成 3 项测试：成功幂等、未知结果不重试、排队取消不派发。发现并发调用需要数据库级派发权 claim，当前版本尚未将已有 `attempting` 与本调用新建记录区分，未接入公共路由前不宣称安全。
- operations 已增加原子派发权 `dispatching`：只有新 claim 的 service 实例可以执行 socket send；同 key 并发第二实例返回 `RESULT_UNKNOWN`，不重复派发。定向 operations 与 write service 测试通过。
- operations 派发权修复后的完整离线回归通过：`.test-results/2026-10-17T18-15-58.234Z-75523-2be1ae0a/report.json`。
