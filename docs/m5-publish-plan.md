# M5 发布基础契约与自动化验证计划

状态：设计证据，未接入代码，未发送真实请求，未执行真实发布。日期：2026-10-18。

目标是最终支持询价 Agent 在用户授权后发布商品，同时保持“默认不发布、失败不假成功、未知不重试”的边界。本阶段先固定契约和离线夹具矩阵，不把 legacy 的真实写入实现直接迁移到新 host/extension 架构。

## 1. 取证范围

| 文件 | 事实证据 | 迁移边界 |
| --- | --- | --- |
| `legacy/extension/src/background/direct-publish-api.ts` | `prepare`/`submit` 两阶段 API；按账号 scope 与幂等键审计；`attempting`、`unknown` 阻断重试；prepare token 使用 `storage.session`；submit 前严格校验草稿 | 可迁移状态机和 fail-closed 原则。不能直接迁移其 Chrome tab、storage 和页面注入实现 |
| `legacy/extension/src/background/direct-publish-page.ts` | MAIN world 使用 `window.lib.mtop.request`；prepare 返回 payload、draft、propertyCards、rawCards；submit 使用权威 prepare 数据重建最终 payload | 只能在固定 documentId、当前账号和授权写步骤下复用；不能把页面返回的任意 payload 当作权威输入 |
| `legacy/extension/src/background/published-items-reader.ts` | `mtop.idle.web.xyh.item.list` 读取当前账号在售商品；动态发现“在售”分组；必须读完整列表；失败不能当作发布成功 | 只读确认接口；不能用本地商品表 `+1`、URL 跳转或单个页面提示判定成功 |
| `legacy/extension/src/background/publish-runtime.ts` | 表单发布到 `waiting_confirmation` 停止；最终提交前读取官方在售基线；提交后要求数量严格 `afterCount === beforeCount + 1` 且出现可信新 itemId；无法确认标记 `unknown` 并锁定 | 这是另一条 DOM/任务运行时证据。新 API 应复用确认原则，但不能同时自动点击旧页面和调用新 direct API |
| `legacy/extension/src/publish/controller.ts` | `preparePublishItem` 必须显式 itemId；只允许当前账号已确认归属的 `my_published` 商品；`submit()` 明确拒绝 | 源商品归属复验可作为 prepare 前置；控制器的禁止 submit 是旧安全边界，不代表新 host API 可直接提交 |
| `legacy/extension/src/publish/injected-scripts.ts` | 发布页字段、按钮和只读探测；旧路径明确禁止自动 click/submit | DOM 选择器是证据，不是新 direct API 的稳定协议；不得用按钮存在或页面离开判成功 |
| `legacy/extension/src/publish/test/direct-publish-two-phase.test.ts` | mock chrome 完整覆盖 prepare 不调用 publish、草稿严格校验、token、账号漂移、重复提交、unknown 和业务拒绝 | 可迁移为新协议夹具，不作为真实平台验收 |
| `legacy/extension/src/publish/test/direct-publish-session-recovery.test.ts` | service worker 重启后恢复 prepared 条目；attempting/unknown 不重试 | 新 host 应使用 v4 `operations` 作为幂等权威，不能依赖内存 token |
| `legacy/workbench/src/features/publish/direct-publish-controller.ts` | UI 阶段 `idle → preparing → reviewed → submitting → published/unknown/rejected`；只有用户确认才 submit | 状态展示可参考；Agent API 不应把 UI 状态当平台成功证据 |
| `apps/host/src/database.ts` | v4 `operations` 提供账号、method、key、fingerprint、status、result/error 的持久记录 | 新 `publish.prepare`/`publish.submit` 必须先 reserve；`attempting` 和 `unknown` 重启后保留并阻断自动重放 |

## 2. 对外方法和安全前置

建议后续公共方法：`publish.prepare`、`publish.submit`、`publish.myItems`。本文件不注册能力、不修改 `METHODS`，直到内部单步和真实固定页面写入链路完成。

### 2.1 `publish.prepare`

输入应包含：

- 明确 `source.itemId` 或已验证的规范商品源，不允许随机选择商品。
- `idempotencyKey`，非空、长度受限；同账号同方法同 key 绑定规范参数 fingerprint。
- seller 地址或坐标；不得自动猜测当前地址、硬编码坐标或把源商品卖家地址直接当发货地址。
- 必要的人工确认字段，例如 `confirm=true`、图片无二维码确认；缺失时拒绝，不进入平台写操作。
- 价格、描述、图片、规格、服务偏好等只接受显式规范字段；未知字段拒绝。

prepare 只能读取源商品、做账号归属复验、读取类目/属性候选、准备图片和组装待审 draft；不能调用最终发布提交接口。返回必须是脱敏 draft 摘要、候选集合、prepare token/引用和 fingerprint，不返回 cookie、token 原文、签名、完整地址秘密或原始 MTOP 响应。

`prepare` 的成功不等于发布成功，也不应创建最终 `publish.result` 成功事件。prepare 失败可以是明确业务拒绝，也可以是 `unknown`；如果已经发生平台不可判定的写前动作，必须保守锁定对应 operation。

### 2.2 `publish.submit`

输入必须绑定一次成功 prepare：

- `prepareToken` 或 host 生成的不可伪造引用；不能只接受客户端自行构造的 payload。
- `idempotencyKey` 与 prepare 绑定；最终 draft fingerprint 必须与本次确认输入一致。
- `confirm=true` 和必要的二维码/人工确认必须显式为真。
- submit 只能使用 prepare 阶段缓存的权威候选、图片上传结果、类目属性和服务集合重建 payload；不能接受前端伪造 `transportData`、任意图片对象或未知服务。
- prepare 账号 scope、当前账号、固定 tab/documentId 在发包前后均须一致。

submit 成功只允许在平台返回明确成功且 `itemId` 合法、并通过“我的商品库”只读确认后返回 `published`。如果无法获得提交前完整在售基线，禁止先发后猜，直接拒绝为 `unknown` 或 `PAGE_NOT_READY`，不报告成功。

### 2.3 `publish.myItems`

这是只读确认方法，不执行写操作：

- 必须绑定当前账号，不接受调用者提供的账号 scope 作为权限边界。
- 动态发现账号的“在售”分组，不硬编码其他账号的 groupId。
- 按官方 pageSize 上限分页读取，遇到 `nextPage=true` 但达到安全上限必须返回 `unknown`，不能把截断列表当完整列表。
- 结果只包含最小 `itemId` 和可选标题；不返回 cookie、签名、原始响应和私密店铺字段。
- 未登录、接口失败、风控、权限不足、响应结构不完整均为明确失败/unknown，不能返回空列表冒充“当前没有商品”。

## 3. 操作状态、幂等和未知边界

统一使用 v4 `operations`，键为账号范围、方法和 `idempotencyKey`，fingerprint 对规范参数计算，不能包含秘密或未规范化字段。

| 阶段 | 可见状态 | 允许重试 |
| --- | --- | --- |
| 未 reserve | `NOT_STARTED` | 可 reserve |
| prepare 已 reserve，尚未完成 | `attempting` | 禁止自动重试；重启后仍阻断 |
| prepare 明确业务拒绝且未发生不可判定写入 | `failed` 或明确 rejected | 仅用户修改输入后使用新 fingerprint/key；不得自动重放 |
| submit 已发包但响应丢失、超时、页面销毁 | `unknown` | 禁止自动重试；必须用户/人工确认或新授权流程 |
| 平台明确 captcha/verification/login | `action_required` 映射为持久终态或 `unknown` | 不自动绕过、不自动重试；用户完成处理后需明确新动作 |
| 明确平台业务拒绝且确认未生效 | `failed/rejected` | 可由用户明确修改草稿后继续，但必须确认 token/operation 是否仍有效 |
| 明确成功且官方 myItems 证实新 itemId | `succeeded/published` | 同 key 返回既有结果，不再次发包 |

相同 key 不同 fingerprint 必须 `IDEMPOTENCY_CONFLICT`。相同 key 相同 fingerprint：`succeeded` 返回原结果，`attempting`/`unknown` 返回锁定状态，不能因为进程重启、页面重载或 Agent 超时而再发包。账号切换只允许新账号使用新 operation 范围；旧 operation 不迁移。

### 不能猜测的事项

- 不能根据页面离开发布页、按钮消失、HTTP 200、MTOP ret 的不完整文本或返回 URL 猜测成功。
- 不能用本地商品库新增一条、在售数量不完整、单个 itemId 未完成归属核验来猜测成功。
- 不能把验证码、登录失效、风控拦截或连接断开当作 rejected；这些属于 action required/unknown。
- 不能把明确业务拒绝都视作可重试；只有确认没有发生平台提交且 token 恢复证据完整时，才允许用户明确重提。
- 不能猜测发货地址、价格单位、图片上传状态、类目/属性 transportData、服务卡含义或当前账号。
- 不能把 prepare 成功当作 submit 成功，也不能将旧 DOM 表单状态当作 direct API 结果。

## 4. 内部步骤设计

后续内部 step 建议：

- `publish.prepare`：只做准备和必要只读接口；绑定 `{accountId,tabId,documentId}`。
- `publish.submit`：唯一允许写平台接口的步骤；必须带 host 已验证的 prepare 引用，页面只接受规范化 payload。
- `publish.myItems`：只读分页步骤；与 submit 分开调度和计数。

所有步骤使用现有 `request-step`/`step-result` 终结语义。`apps/extension/src/page-runtime.ts` 当前针对商品读操作、单次 fetch、文档锁和账号前后核验，不能直接承载发布写入；必须新增发布专用页面执行器，明确写操作终结、页面销毁和 poison 状态。不能将聊天或商品 `chat.sync.page` 的 data 透传当作发布成功。

平台请求最多一次；host HTTP 超时不等于页面写请求终结。已发写请求的等待结束后，operation 保持 `attempting` 或转 `unknown`，不能释放槽位后立即新发相同操作。只有确定页面请求已终结或固定文档已销毁，才允许执行器生命周期清理；这仍不允许自动重试原 publish。

## 5. 验证契约与夹具矩阵

所有自动化夹具必须默认离线：mock Chrome tabs/scripting/storage、mock MAIN SDK、mock `myItems` 只读响应和可控时钟；网络探针断言没有真实请求。每个夹具记录输入 fingerprint、发送次数、账号/documentId、operation 状态和结果，不记录 cookie、签名、完整地址或原始 payload。

| 夹具场景 | 预期结果 | 必须断言的副作用 |
| --- | --- | --- |
| prepare 合法自有商品 | 返回 prepared/draft，未调用最终 submit | 平台写接口 0 次；operation 不进入 submit succeeded |
| source itemId 缺失/随机源 | BAD_REQUEST/PRODUCT_NOT_FOUND | 0 次平台写请求 |
| 非当前账号 `my_published` / ownership 未确认 | PRODUCT_SOURCE_NOT_ALLOWED | 0 次写请求 |
| 地址、坐标、价格、图片、规格或服务字段非法 | BAD_REQUEST/REJECTED | 不猜测、不补值、不写 operation 成功 |
| prepare 同 key 同 fingerprint | 返回同一结果或明确复用 | 0 次重复准备请求（按设计选择；不能重复写） |
| prepare 同 key 不同 fingerprint | IDEMPOTENCY_CONFLICT | 0 次平台请求 |
| submit 缺 token/confirm/draft | BAD_REQUEST | 0 次平台写请求 |
| submit 非 prepare 候选类目、属性、图片或服务 | REJECTED | 0 次平台写请求 |
| submit 账号切换/documentId 变化 | ACCOUNT_CHANGED/PAGE_NOT_READY | 0 次或已发步骤不重试 |
| submit 平台明确成功 + myItems 新 itemId | PUBLISHED | 一次写请求；完整 myItems 基线与确认；同 key 不重复写 |
| submit 平台明确成功但 myItems 查询失败 | UNKNOWN | operation 锁定；不报告 published，不重试 |
| submit 超时/断线/页面销毁 | UNKNOWN | no retry；attempting/unknown 保留；不猜成功 |
| 平台 captcha/verification/login | ACTION_REQUIRED/UNKNOWN | 不绕过、不自动重试、不清理锁定证据 |
| 平台明确业务拒绝且未提交 | REJECTED | 仅按显式 retryable 规则允许用户修改后继续 |
| submit 同 key 同 fingerprint 已 succeeded | 返回既有结果 | 平台写请求 0 次 |
| submit 同 key 不同 fingerprint | IDEMPOTENCY_CONFLICT | 平台写请求 0 次 |
| account A / B 同 key | 各自独立 operation | 不交叉读取或复用 token/result |
| host/SW 重启后 attempting | UNKNOWN/LOCKED | 0 次自动重放 |
| myItems 分页截断、totalCount 不可信 | UNKNOWN | 不伪造完整基线 |
| myItems 空列表且响应明确成功 | 空列表 | 与请求失败区分，允许后续基线计算 |
| myItems 缺 ret/data/group/itemId | UNKNOWN | 不当空列表 |
| 重复 itemId、标题缺失 | 按 itemId 去重；标题只作辅助 | 不用标题缺失阻断已明确 ID，但不能猜归属 |
| 风控信号/限流 | RISK_BLOCKED/UNKNOWN | 停止 Agent 后续动作，不自动退避重试平台请求 |

## 6. 真实授权与验收门槛

真实发布属于外部副作用，必须在单独验收窗口获得明确授权，并使用专门测试商品、专门账号、可回收素材和人工确认。授权前只允许运行离线夹具、协议验证、页面状态探测和 `myItems` 只读验证。

真实验收步骤必须先记录当前账号和完整在售基线，再由用户明确确认最终 submit；只允许一次受控写请求。提交后使用官方 `myItems` 完整分页确认新 itemId，并保存脱敏证据。任何超时、断线、账号漂移、风控、验证码、基线失败都停止，不自动再次提交。

真实成功证据至少包含：

1. prepare 输入 fingerprint 与账号 scope 匹配；
2. submit 前后 documentId、账号未变化；
3. 写请求发送计数为 1；
4. 官方在售列表提交前后差异严格可解释，新 itemId 明确出现；
5. operation 为 succeeded/published，result 不含秘密；
6. 重复同 key 调用不产生第二次平台写请求。

本设计不授权真实发布，也不声称 legacy 测试等于当前架构 E2E。完成上述离线契约和矩阵后，再由主代理实现协议、固定页面执行器、host 编排、路由和受控真实验收。

## 当前实施状态（2026-10-18 更新）

本文件前文保留初始设计背景，其中“未接入代码”不再表示当前状态。
当前已实现公共发布方法、内部步骤协议、Host 幂等编排、官方在售列表确认、
页面预检与真实上传适配。实现细节、证据和未完成门槛以
[M5 实施记录](m5-publish-implementation-report.md) 为准。
尚未完成真实发布业务 E2E，不能据离线夹具宣告交付。
