# 平台请求频率与风控：现状与优化点

> 本文记录闲鱼侧请求的现状和待优化点，作为“插件提供 API 给询价 agent 调用”改造的约束输入。
> 状态：M2 已实施统一节奏队列、账号隔离缓存与风控信号；M3～M5 尚未实施。旧实现行号以 `main` @ `06dd5e2` 为准，新架构约束以 [实施契约](agent-api-contract.md) 为准。

## 1. 结论

- 搜索和聊天都**不模拟人工操作**。插件在已登录的闲鱼页面内直接调用网页版使用的内部接口：搜索走 MTOP，聊天复用页面的 WebSocket。
- 请求格式和网页一致，但没有对应的页面行为。请求过快或过多时，会触发风控。
- 现在只有“单任务内限速”和“命中风控后暂停采集”。没有全局请求预算，没有跨模块熔断，调用方可以把间隔设为 0。
- 改造为 agent API 后，调用频率由 agent 决定。插件端**只强制请求节奏**（最小间隔 + 随机增量）；其余风控信号只提示，由 agent 判断如何处理（2026-10-17 确认）。
- 优化的目标是降低请求频率和请求总量，遵守平台规则。滑块验证支持在页面内自动完成（见 [实施契约](agent-api-contract.md) 「自动滑块验证」），不伪造人工行为、不改页面指纹、不做纯协议绕过。

## 2. 现状

### 2.1 搜索与详情（MTOP）

| 项 | 现状 | 位置 |
|---|---|---|
| 调用方式 | MAIN world 内 `fetch`，带页面 cookie，用 `_m_h5_tk` 签名 | `extension/src/platform/xianyu/mtop-client.ts:79-91`、`:123-165` |
| 接口 | 搜索 `mtop.taobao.idlemtopsearch.pc.search`、详情 `mtop.taobao.idle.pc.detail`、建议词、我的在售 | `mtop-client.ts:33-56` |
| 搜索翻页间隔 | 首页立即；之后每页 `500ms + [0, 500ms]` 随机 | `shared/types/capture.ts:12-15`、`extension/src/capture/pacer.ts` |
| 间隔下限 | **没有下限**：`minIntervalMs` / `intervalJitterMs` 允许为 0 | `shared/events/codec.ts:425-426`、`extension/src/capture/controller.ts:61-74` |
| 页数上限 | **没有上限**：`pages` 只校验 `>= 1` | `shared/events/codec.ts:423` |
| 详情间隔 | 固定 1500ms，每个采集任务单独计数 | `extension/src/capture/controller.ts:500-505` |
| 平台层全局限速 | 固定 1500ms；采集搜索传 `0/0` 绕开，由 pacer 控制节奏 | `extension/src/content/platform-main.ts:31-36`、`controller.ts:538-541` |
| 旧版对照 | 旧版 autoCrawl 每页 1500ms，现在默认值**更快** | `extension/src/platform/rate-limit.ts:4-10` |

### 2.2 聊天（WebSocket / LWP）

| 项 | 现状 | 位置 |
|---|---|---|
| 读取 | 包装 `window.WebSocket`，只监听 `wss-goofish.dingtalk.com` | `extension/src/chat/websocket.ts:252-271` |
| 历史与会话 | 在同一连接上发 LWP 请求，分页间隔 300ms | `shared/chat/protocol.ts:21-40` |
| 发送 | `executeScript` 调用 `window.__FISHOPS_CHAT_SEND__`，路由 `/r/MessageSend/sendByReceiverScope`，有白名单校验，超时 10s | `extension/src/chat/send-host.ts`、`send-transport.ts` |
| 自动回复 | 默认 `suggest`，不自动发送；`auto` 模式下每会话 10 分钟最多 5 条 | `shared/types/reply.ts:95-106`、`extension/src/chat/reply-safety.ts` |
| 计数存储 | 只在内存中；SW 回收后计数归零 | `extension/src/chat/reply-safety.ts:9` |
| 全局发送上限 | **没有**：没有“每小时 / 每天新会话数”或“全局发送间隔” | — |

### 2.3 风控识别与处理

| 项 | 现状 | 位置 |
|---|---|---|
| 错误分类 | `RGV587`、`FAIL_SYS_USER_VALIDATE`、`x5sec`、`punish` 等归为 `captcha` | `extension/src/platform/errors.ts:86-91` |
| 滑块检测 | 只识别和广播 `FISHOPS_CAPTCHA_DETECTED`，不拖动、不关闭 | `extension/src/platform/captcha-detector.ts`、`content/platform-main.ts:52-70` |
| 采集处理 | `captcha` / `unauthorized` / `token-expired` 时暂停任务并保留断点 | `extension/src/capture/controller.ts:551-559` |
| 跨模块处理 | **没有**：采集命中风控后，聊天、详情、发布等其他请求继续发送 | — |
| 冷却期 | **没有**：用户可以马上恢复任务，没有等待时间 | — |

## 3. 优化点

按 [Agent API 设计](agent-api-design.md) 的轻量方向整理：插件强制节奏，其余只提示。

### 3.1 插件强制执行

1. **统一节奏队列**
   - 所有闲鱼请求（搜索、详情、聊天读取、新建会话、发送、发布）按类别排队，串行执行，间隔为“最小间隔 + 随机增量”。
   - 搜索翻页最小间隔改为 1500ms（现在默认 500ms，调用方还可以设为 0）。
   - agent 只能把间隔调大。类别和数值见 [Agent API 设计 §4.2](agent-api-design.md)。
   - 涉及：`resolveCaptureBaseIntervalMs`、`isCaptureCreatePayload`、`rate-limit.ts`、`pacer.ts`。

2. **单次调用只做一件事**
   - 搜索一次一页，详情一次一个，发送一次一条。翻页、批量、停止条件由 agent 决定，插件不运行长任务。

### 3.2 减少请求量

3. **缓存**：搜索结果 15 分钟，详情 30 分钟，保存在 SQLite，按账号隔离；`maxAgeSec: 0` 强制刷新。缓存命中不占调度槽，不在公共响应中伪造平台返回。
4. **复用会话**：已有会话的商品不再新建会话。
5. **发送幂等**：`chat.send` 必须带 `idempotencyKey`，agent 恢复后重复调用不会重复发送。
6. **只用实时消息**：新消息来自页面 WebSocket 推送，不定时轮询历史接口。

### 3.3 风控提示（不拦截）

7. **每个响应都带 `meta.risk`**：`level`（`ok` / `caution` / `blocked`）、最近的风控信号、各类别用量和建议上限。
8. **SSE 推送 `risk.signal`**：接口返回风控码、页面出现滑块、用量超过建议上限、连续发送失败时推送。
9. **请求记录**：每次闲鱼请求写入 SQLite `requests` 表，记录方法、类别、结果、风控信号和耗时。不记录 cookie、token 和完整响应。

### 3.4 不做

- 全局熔断、冷却期、人工确认门禁：由 agent 根据风控提示判断。
- 伪造人工操作：不改 `navigator.webdriver`、不伪造指纹、不隐藏平台弹窗绕过检测。非滑块类验证（短信、扫码、人脸）不自动处理。

## 4. 与 API 改造的关系

- 接口、节奏类别、风控提示的格式和 SQLite 表结构，见 [Agent API 设计](agent-api-design.md)。
- 节奏队列和请求记录放在 native host 中；扩展只执行请求，并上报风控事件。
- 询价 agent 的能力缺口（主动建聊等）见 [AI 询价 Agent 后台与执行能力现状调研](ai-inquiry-agent-backend-recon.md)。

## 5. 待确认

- 节奏间隔和建议上限采用初始建议值（2026-10-17 确认），没有实测；上线后在真实账号上小流量观察，再调整配置。

## 6. 统一实施约束（2026-10-17）

以 [实施契约](agent-api-contract.md) 为准：账号级单一调度器同时约束总间隔、类别间隔与最大在途数；重启保留最近派发时间和用量，每个内部网络请求单独授权。仅请求节奏强制执行的已确认策略不变，风控信号仍由 Agent 决定停止，不新增强制冷却。

M1 没有平台观测，risk 返回 unobserved，不能把空 usage 或 system.status 本地成功解释为平台健康。搜索与详情缓存必须按账号隔离；退出后不暴露上一账号记录。固定节奏和建议额度不是不触发风控的保证。
