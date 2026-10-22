# M5 发布链路独立复核

复核日期：2026-10-18

## 结论

当前链路不能作为可工作的发布实现。主要问题不是测试数量，而是 Host 与页面执行器使用了互不兼容的契约：

- Host 读取 `myItems` 的 `nextPage` 游标并分页，但页面执行器固定读取第 1 页，且不返回游标。
- Host 把 `prepare` 返回的“展示摘要”当作 `submit` 的“权威完整草稿”，页面执行器又只把 token 和指纹放进 MTOP 请求，导致提交内容不完整或无效。
- `prepare` 没有用 `seller.addressRef` 和源商品做真实预检，无法证明地址、商品归属和图片等关键事实。
- 提交结果确认路径无法按设计完成：基线分页除第一页外会被严格参数校验拒绝，成功条件还把“只看总数 +1”当成足够证据。
- 部分失败路径会把已经发生的平台写操作处理成可重新领取或未持久化的状态，存在重复写风险。

现有定向测试均通过，但测试只验证 Host 自己的 mock 契约，没有覆盖上述真实页面契约。

## P0

### P0-1 Host 与页面 `myItems` 分页契约不一致，完整基线和成功确认无法完成

涉及位置：

- `apps/host/src/publish-service.ts:119`：Host 要求页面返回 `items`、`hasMore`、`nextPage`。
- `apps/host/src/publish-service.ts:124-125`：`hasMore=true` 但没有 `nextPage` 直接失败。
- `apps/host/src/publish-service.ts:203-216`：第二页请求传入 `{ limit, nextPage }`。
- `apps/extension/src/publish-page-executor.ts:428-446`：页面只接受 `limit`，固定发送 `pageNum: 1`。
- `apps/extension/src/publish-page-executor.ts:535`：页面结果只返回 `{ items, hasMore }`，不返回 `nextPage`。
- `packages/protocol/src/publish.ts:350-359`：`publish.myItems` 单步参数只允许 `limit`、`maxWaitMs`、`minIntervalMs`、`tag`，没有 `nextPage`。
- `packages/protocol/src/step.ts:78-80`：发布步骤必须通过 `isPublishMyItemsParams(value.params)`，因此第二页请求会被拒绝。

触发条件：

1. 账号的在售商品第一页 `hasMore=true`。
2. Host 请求第二页，生成 `{ limit: 200, nextPage: "..." }`。
3. `isStepWire` 在扩展入口校验失败，返回 `BAD_REQUEST` 或无法进入执行器；即使勉强进入，页面执行器也永远读取第 1 页。
4. 若页面按自身实现返回 `{ items, hasMore: true }` 而不带 `nextPage`，Host 在第 119-125 行立即报 `INTERNAL`。

影响：

- `publish.myItems` 的公共结果和 `submit` 的前后基线都不能可靠完成。
- 商品多的账号无法取得完整基线，`submit` 无法确认“前后差异恰好一个 itemId”。
- 不能把当前 Host 单测中的 `nextPage: cursor-*` 当作页面真实契约；该 mock 与执行器不一致。

建议修复：

- 二选一统一契约，不能继续让两层各自定义：
  1. 页面执行器接受 Host 签发的分页参数（建议使用不透明 `pageToken`），返回 `{ items, hasMore, nextPage? }`；
  2. 或扩展内部一次执行内完成分页，Host 只接收完整 `{ items, total, hasMore: false }`，但这必须仍受 Host 调度和整体超时约束。
- 若采用第 1 种，扩展单步参数和 `isPublishMyItemsParams` 必须同时加入受控 `pageToken`，并限制长度、字符集和不可伪造性；不能直接暴露原始平台游标。
- 页面必须解析官方 `cardList[].cardData.id`、`data.nextPage` 和动态 `groupId`，不能使用当前实现假设的 `data.items` 和 `pageNum`。

应补测试：

- Host 生成的第一页、第二页请求分别能被 `isStepWire` 接受，且第二页不会重复第 1 页。
- 页面执行器在 `nextPage=true` 时返回游标；Host 能按游标读取到底。
- 两页合并后重复 itemId 去重，`total` 与完整条数一致。
- 达到 20 页仍 `hasMore=true` 时返回 `RESULT_UNKNOWN`，不返回截断列表。
- 端到端夹具使用真实字段形状 `cardList`、`nextPage`、`groupName/groupId`，不要用 Host 自定义的 `items/nextPage` 自证。

### P0-2 `prepareToken` 没有绑定页面权威 prepare 数据，`submit` 无法重建完整发布内容

涉及位置：

- `apps/host/src/publish-service.ts:97-105`：Host 只校验页面返回的 `draft` 摘要和候选 refs。
- `apps/host/src/publish-service.ts:222-232`：Host 用输入 `params.draft` 生成 token 和 `draftFingerprint`，把页面返回的摘要保存为 `summary`，但提交时使用的是 `prepared.draft`，不是页面返回的权威数据。
- `apps/host/src/publish-service.ts:226`：指纹只覆盖 `accountId`、源 itemId 和调用方输入草稿，不覆盖页面实际预检结果、完整类目/属性 transport data、已上传图片、地址、服务卡和最终 payload。
- `apps/host/src/publish-service.ts:156-165`：`submitStepParams` 把 `prepared.draft` 加候选 refs 发给页面，未加 seller、图片上传结果或权威 payload。
- `apps/extension/src/publish-page-executor.ts:61-63`：页面 prepare 只返回 `draft` 和 `candidates`。
- `apps/extension/src/publish-page-executor.ts:275-309`：页面 prepare 使用 `"pending"` token 和 `"pending"` 指纹，只构造展示摘要；返回结果在 `326` 行又丢弃了 token 和指纹。
- `apps/extension/src/publish-page-executor.ts:374-384`：页面 submit 最后只发送 `prepareToken`、`draftFingerprint`、`idempotencyKey`、`uniqueCode`，没有发送 `mtop.idle.pc.idleitem.publish` 所需的完整 payload。

触发条件：

1. 正常调用 `prepare`，返回 token。
2. 调用 `submit`。
3. Host 把 `prepared.draft` 和候选 refs 传给页面。
4. 页面执行器仍只把 token/指纹作为 MTOP data，真实平台需要 `itemTextDTO`、`itemPriceDTO`、`itemAddrDTO`、`itemCatDTO`、`itemLabelExtList`、`imageInfoDOList`、`userRightsProtocols` 等字段。
5. 发布请求失败、参数错误或平台返回非成功；即使返回成功，也没有可归因的权威 payload。

影响：

- “token 不可伪造”只在 Host 存储键层面成立，没有真正绑定页面 prepare 产生的权威业务数据。
- 相同 token/指纹不能证明最终提交内容与用户审阅内容一致。
- 页面端无法按 legacy 证据重建有效发布 payload，发布链路不可用。

建议修复：

- 页面 prepare 必须返回一份经过严格 schema 校验的权威 `preparedCore`（或加密/签名后的不透明引用），至少包括：
  - 已上传图片列表和图片上传状态；
  - 来源商品归属复核结果；
  - 完整地址对象（脱敏返回或不返回明文，但 Host 必须能将其绑定到 token）；
  - 完整类目、属性 transport data；
  - 服务卡集合和启用状态；
  - 最终可提交结构或可确定性重建的字段。
- Host 的 `draftFingerprint` 必须对“页面返回的权威 prepare 核心 + 用户已确认的最终草稿 + 账号/源 itemId”做 canonical hash，不能只对调用方输入摘要做 hash。
- Host 持久化权威 prepare 记录后，submit 只能使用该记录重建 payload；页面不得自行接收前端拼接的任意 payload。
- 页面 submit 必须在固定文档内使用该权威核心重新检查账号、地址和来源归属，再构造完整 MTOP payload。

应补测试：

- 页面 prepare 返回完整核心后，Host 保存并返回的 token 在重启后仍能恢复同一核心。
- 修改任一权威字段（价格、图片、类目、地址、服务）后，旧 token 指纹不匹配，`submit` 返回 `BAD_REQUEST` 且不调用平台。
- 伪造 token、篡改指纹、跨账号 token 均返回明确冲突，写请求为 0。
- 页面 submit 的 MTOP data 必须包含完整 payload，且不含调用方自造字段。
- prepare 页面返回的 token/fingerprint 即使固定为 `"pending"` 也不能影响 Host 结果；测试应断言 Host 不信任它们。

### P0-3 `prepare` 未核验 `seller`、源商品归属和图片，可能发布到错误地址或错误账号

涉及位置：

- `packages/protocol/src/publish.ts:217-225`：协议只校验 `source.itemId` 和 `seller.addressRef` 的形状。
- `apps/host/src/publish-service.ts:146-154`：`prepareStepParams` 虽然传了 `seller`，但页面 prepare 完全没有使用。
- `apps/extension/src/publish-page-executor.ts:208-267`：prepare 只调用 precheck、类目推荐、服务卡，没有读取源商品详情、校验商品归属、解析地址或上传图片。
- `apps/extension/src/publish-page-executor.ts:279-307`：摘要直接由调用方参数生成，不能证明地址和源商品存在或属于当前账号。
- `apps/host/src/publish-service.ts:227-232`：生成的权威记录没有包含 seller 校验结果。

触发条件：

- 调用方传入任意格式合法的 `seller.addressRef`，即使该地址不是当前账号可用地址。
- 调用方传入其他账号或已删除商品的 `source.itemId`。
- 图片 URL 合法但未真实上传、未检查二维码、未检查平台限制。

影响：

- 可能出现“假准备”：prepare 成功，但提交时地址、源商品或图片事实未知。
- 在上架场景中，错误地址是实际副作用，不能靠 Host 层 token 阻止。
- 当前协议声称 `seller` 只接受候选引用，但执行器从未验证它是否来自候选集合。

建议修复：

- 页面 prepare 必须先读取当前账号的 POI/地址候选，确认 `seller.addressRef` 属于该账号；不能接受未验证 ref。
- 读取源商品详细信息和归属，确认是当前账号的已发布商品，并解析允许复制的字段。
- 对图片执行受控上传或明确返回“未上传”状态；只有上传完成后才能生成可提交 token。
- 将上述结果纳入权威 prepare 核心和指纹；不完整或不可验证时返回明确失败，不生成 token。

应补测试：

- 非当前账号源商品、错误地址 ref、未上传图片、图片含二维码均为准备失败，写请求为 0。
- `seller.addressRef` 有效但属于另一账号时拒绝。
- prepare 页面返回的地址与调用方 ref 不一致时拒绝。
- 源商品详情缺失、被删除或状态不是允许发布时拒绝。

### P0-4 成功确认只看“数量 +1”，会把并发上架或删除误判为本次发布

涉及位置：

- `apps/host/src/publish-service.ts:327-332`：前后完整列表差集必须恰好一个，且总数必须严格 `before + 1`。
- `apps/host/src/publish-service.ts:329-331`：新增 itemId 采用列表差异中的唯一项，但未校验它是由本次提交产生的。

触发条件：

1. 提交写请求成功，但提交后列表在确认窗口内因另一操作新增了一件商品。
2. 或者本次提交新增的商品尚未出现在列表中，同时另一操作新增了一件商品。
3. 前后数量恰好 +1，差异恰好一个 itemId。
4. Host 会把另一操作的新品当作本次发布成功结果。

影响：

- 这是“假成功”的直接来源：平台可能实际拒绝了本次发布，或实际新增了不同商品，Host 仍返回 `published`。
- 若本次提交新增 A，同时另一操作删除 B、新增 C，数量条件可能不满足而报未知；此时虽不假成功，但也会掩盖真实结果。
- 仅靠 itemId 字符串和数量无法证明归属；legacy 也没有把数量作为唯一证据。

建议修复：

- 成功确认必须至少满足：
  - 平台 submit 返回明确成功且给出合法 itemId；
  - 该 itemId 在提交前完整基线中不存在；
  - 提交后完整列表中该 itemId 存在；
  - 该 itemId 与页面 submit 返回的 itemId 完全一致；
  - 对新增 itemId 做归属和内容辅助校验（例如标题/源商品映射），但不得用标题猜测。
- 不要仅用“总数 +1”作为成功条件；数量只作为辅助一致性检查。
- 对基线读取加时间边界和快照标识；若前后列表无法归因，返回 `unknown` 而不是 `published`。

应补测试：

- 提交返回 itemId A，列表中新增 A，同时有另一个新增 B：必须 `RESULT_UNKNOWN`，不能返回 `published`。
- 提交返回 itemId A，列表只新增 B：必须 `RESULT_UNKNOWN`。
- 提交未返回 itemId，列表新增唯一 A：当前设计的 `outcome` 也可接受，但必须要求 A 不在基线且页面有明确成功证据；测试不能让“缺 itemId + 任意新增”直接成功。
- 提交返回 A，列表中 A 不存在但总数 +1：必须 `RESULT_UNKNOWN`。
- 同一账号并发两件发布、商品删除与新增交错时不得假成功。

### P0-5 提交失败或未知后没有可靠消费 token，换幂等键可再次提交同一 prepare

涉及位置：

- `apps/host/src/publish-service.ts:294-344`：`submit` 只在成功路径 `335-338` 把 prepared 记录改为 `consumed`。
- `apps/host/src/publish-service.ts:340-343`：任何异常路径只调用 `settle` 处理 operation，不消费 `prepared.status`。
- `apps/host/src/publish-service.ts:308-310`：后续提交只检查 `prepared.status === 'prepared'`、指纹和过期时间。

触发条件：

1. 第一次 `submit` 已派发页面写步骤，平台返回超时/断线/未知，或提交后确认失败。
2. operation 因 `dispatched=true` 变为 `unknown`。
3. 调用方使用新的 `idempotencyKey`，复用同一个 `prepareToken`。
4. `prepared.status` 仍为 `prepared`，Host 再次调用页面 `publish.submit`。

影响：

- “同 key 不重放”成立，但“同一 prepare 只能提交一次”不成立。
- 这是实际重复写平台的高风险路径，尤其当第一次请求已到达平台但响应未知时。
- legacy 在 submit 前先消耗 token，未知结果保持 consumed；当前实现把顺序反过来且失败不回写。

建议修复：

- 在任何页面写步骤派发前，先原子地把 prepared 记录从 `prepared` 改为 `consuming`（或 `consumed`），并将 token 与 operation key 绑定。
- 失败不能自动恢复 token；只有平台明确拒绝且能证明未提交时才允许人工恢复，且必须有独立状态。
- 同一 token 的不同 idempotencyKey 重复 submit 必须返回 `IDEMPOTENCY_CONFLICT` 或明确 `BAD_REQUEST`，不能再次派发。
- 如果采用 `prepareId` 作为 submit 幂等范围，应在 operation 层增加账号 + prepareId 唯一约束，而不只是 key。

应补测试：

- 第一次 submit 已派发并超时，第二次用新 key 同 token：第二次必须 0 次页面 submit。
- 第一次确认失败（平台 accepted 但列表无新增），第二次用新 key：必须 0 次页面 submit。
- 明确平台拒绝后，是否允许恢复必须由独立测试固定；不能默认再次提交。
- 进程重启后 `consuming/consumed` 状态仍阻断同 token。

### P0-6 页面 submit 的超时/未知会保持文档锁，Host 却把写操作当成可结束并可能释放调度槽

涉及位置：

- `apps/extension/src/page-runtime.ts:369-397`：发布动作的 `outcome.ok=false` 时，除 `BAD_REQUEST`/`PAGE_NOT_READY` 外都直接 `markPoisoned` 并返回一个永不 settle 的 Promise。
- `apps/extension/src/page-runtime.ts:467-478`：`Promise.race` 的超时只结束本次等待，锁内步骤继续执行。
- `apps/host/src/server.ts:135-149`：HTTP 连接关闭时 abort controller，Host 只结束请求记录，不会等待页面真实终结。
- `apps/host/src/publish-service.ts:314-343`：页面写步骤超时后 `dispatched=true`，操作记录为 `unknown`，但 Host 没有保留“页面写仍在途”的可查询槽位。

触发条件：

- 页面发布 MTOP 请求超时或异常，页面执行器进入 poison 状态。
- Host 的 `executePage` 因等待超时/连接断开结束。
- 页面真实请求后来可能成功，但 Host 已经返回未知并结束本次调用。

影响：

- Host 的 `unknown` 与页面真实在途状态脱节；后续相同/不同 token 的提交可能被页面锁阻止，但 Host 无法给出稳定状态。
- 如果 Host 重启或页面重建，operation 和历史请求无法证明平台请求是否终结，容易在人工处理时产生错误判断。
- 这不是简单的“未知不重试”问题，而是未知状态没有持久、可审计的归属。

建议修复：

- 页面发布写请求必须有独立于 HTTP 请求生命周期的持久化/可查询状态，至少区分 `not_sent`、`sent_pending`、`terminal_ok`、`terminal_error`、`unknown_page_lost`。
- Host 在页面写步骤超时后应保留 operation 的 `dispatching/unknown`，并明确记录“页面请求可能仍在途”，不能只写一个错误码。
- 页面文档销毁/重载时，Host 必须通过固定文档和账号范围将 in-flight 状态转为不可重放的 `unknown`。
- 调度器释放必须绑定“页面真实终结或文档销毁”，不能以 HTTP 等待结束为准。

应补测试：

- 页面 submit 永不 settle，Host 超时后 operation 仍为 `unknown`，同 token 新 key 0 次写。
- 页面 submit 在 Host 超时后成功返回，随后页面结果不得被当作新的成功提交，也不能允许重放。
- 页面文档销毁与页面锁 poison 后的 Host 状态可查询，且不会自动迁移到新页面。

## P1

### P1-1 `prepare` 的页面摘要不是权威草稿，Host 丢失 seller、规格、图片等信息

涉及位置：

- `apps/host/src/publish-service.ts:224`：`draft = params.draft ?? {}`。
- `apps/host/src/publish-service.ts:229-230`：记录保存的 `draft` 是调用方输入，不是页面实际准备结果。
- `apps/extension/src/publish-page-executor.ts:279-309`：摘要只包含 title、description、price、imageCount、categoryName、attributeNames、serviceNames；没有 seller、完整图片、specs、图片上传结果、类目/属性 transport data。
- `apps/host/src/publish-service.ts:156-165`：submit 只发送摘要中的 `draft` 和候选 refs。

触发条件：

- 草稿含 `seller`、图片、规格、服务偏好，或用户修改了 prepare 返回的摘要。
- submit 时页面只能看到摘要，无法还原完整发布内容。

影响：

- “审阅草稿”和“实际提交草稿”不是同一份数据。
- 用户在 prepare 后看到的是脱敏摘要，但 submit 使用的是摘要加输入参数，可能混淆或漏字段。

建议修复：

- 在 Host 持久化权威 prepare 草稿，至少区分 `displaySummary` 与 `submitCore`。
- `submitCore` 只能来自页面权威预检和用户已确认的规范化输入，不能用摘要反推。
- submit 返回前再次确认 `submitCore` 指纹与 prepare 时锁定值一致。

应补测试：

- 修改摘要字段不影响权威 submitCore，修改 submitCore 必须触发指纹冲突。
- seller、图片、规格、服务、类目/属性完整往返一致。

### P1-2 页面 `myItems` 使用错误的官方请求形状，且固定第 1 页

涉及位置：

- `apps/extension/src/publish-page-executor.ts:440-447`：请求体 `{ status: 'on_sale', pageSize, pageNum }`。
- `legacy/extension/src/background/published-items-reader.ts:202-233`：真实读取器需要 `needGroupInfo`、`userId`、`pageNumber`、`groupName`、`groupId`、`defaultGroup`，并通过 `nextPage` 翻页。

触发条件：

- 生产环境调用 `publish.myItems`。

影响：

- 返回结构、分页、在售分组发现均不符合真实接口证据。
- 即使接口忽略错误参数返回数据，也无法保证是“在售”分组，可能把其他分组或第一页不完整数据当基线。

建议修复：

- 按 legacy 读取器的已验证形状实现：先发现在售 `groupId`，再按 `pageNumber/pageSize` 读取，并校验 `nextPage`。
- `pageSize` 使用官方上限（证据为 20），不要使用当前 `MY_ITEMS_LIMIT=200`。
- 响应解析必须使用 `cardList[].cardData.id/title`，并保留 `itemGroupList` 完整性检查。

应补测试：

- 使用真实字段夹具，断言 `needGroupInfo` 首次探测与后续 `groupId` 翻页。
- 缺 `itemGroupList`、缺在售分组、缺 `cardList`、`nextPage` 非布尔时全部失败。
- 第 1 页最多 20 条，20 页上限，超过返回 unknown。

### P1-3 `prepare` 页面摘要的 `price`、`categoryName`、`attributeNames` 不是可验证事实

涉及位置：

- `apps/extension/src/publish-page-executor.ts:280-306`：直接使用调用方参数生成摘要。
- `packages/protocol/src/publish.ts:64-73`：摘要字段被定义为“已确认草稿摘要”，但没有说明哪些来自平台。

触发条件：

- 调用方传入价格、类目、属性；页面 prepare 未读取或未返回平台推荐结果。
- Host 将摘要返回给用户，用户误以为平台已确认。

影响：

- 摘要可能与平台实际推荐/校验结果不一致。
- 无法支持“只使用 prepare 返回候选”的安全模型。

建议修复：

- 页面 prepare 返回的 summary 必须明确标注来源：用户输入、平台推荐或无法确认。
- 任何“已确认”字段必须来自平台成功响应，不能由输入直接回填。
- 类目/属性 ref 必须与候选集合交叉校验；不在候选集合中的 ref 拒绝。

应补测试：

- 输入类目/属性不在平台候选集合时拒绝。
- 平台返回推荐类目与输入不一致时，摘要必须反映平台结果或明确冲突，不得静默使用输入。
- 价格、图片、服务卡缺失时摘要为 `null`/空，不伪造。

### P1-4 页面执行器测试缺失，当前只测了 page-runtime 通用锁，不测发布方法

涉及位置：

- `apps/extension/src/test/page-runtime.test.ts`：现有测试只覆盖商品读取、聊天和通用锁；没有 `publish.prepare/submit/myItems` 的端到端断言。
- `apps/host/src/publish-service.test.ts:29-37`：Host 使用自定义 `PageHandler` 返回 `{ items, hasMore, nextPage }`，与真实执行器不一致。

触发条件：

- 任何发布相关回归。

影响：

- 当前 36 个定向测试和 `npm run typecheck` 全通过，但没有发现 P0-1/P0-2/P0-5。
- 类型检查无法发现 Host 与页面运行时 schema 的运行期不一致。

建议修复：

- 增加 `publish-page-executor.test.ts`，覆盖真实 MTOP 请求形状、ret 分类、账号漂移、分页和 payload。
- 增加一个不 mock 掉页面层契约的集成测试：真实 `createPageRuntime` + 模拟 `mtopRequest`，由 Host 调用。

应补测试：

- prepare 不调用 `idleitem.publish`；submit 只调用一次；myItems 只读。
- MTOP 非成功、缺 itemId、缺 data、ret 非数组、超时、账号变化的行为。
- myItems 分页真实字段与 Host 游标互通。
- 提交前基线失败写请求 0 次。

### P1-5 `prepare` 页面执行器使用固定 `"pending"` 值，容易被误认为真实 token

涉及位置：

- `apps/extension/src/publish-page-executor.ts:275-277`、`292-293`。

触发条件：

- 直接调用 `runPublishPrepare` 或未来复用该函数。

影响：

- 返回对象在 `executePrepare` 内部校验通过后又被裁掉，但中间态存在固定 token/fingerprint，审计和测试若直接观察可能误以为已绑定。
- 类型上 `PublishPrepareResult` 要求 token，容易诱导后续实现直接返回它。

建议修复：

- 页面层只返回 `PublishPreparePageResult`，不要临时构造完整 `PublishPrepareResult`。
- 若需要复用 schema 校验，单独定义页面结果 schema，不复用 Host 签发结果的 schema。

应补测试：

- 页面入口返回值不得包含 `prepareToken`/`draftFingerprint`。
- 直接伪造 `"pending"` token 不得通过 Host 校验。

## P2

### P2-1 失败码分类过宽，`LOGIN_REQUIRED` 在已派发后仍被当作可解释失败

涉及位置：

- `apps/host/src/publish-service.ts:67-75`：`FAILED_CODES` 包含 `LOGIN_REQUIRED`、`PLATFORM_REJECTED`。
- `apps/host/src/publish-service.ts:238-240`：只有 `!dispatched && FAILED_CODES` 才 `failed`。

触发条件：

- 页面已经派发请求，随后返回登录失效、风控或平台拒绝。

影响：

- `dispatched=true` 时仍记 unknown，这点是保守的；但 `PLATFORM_REJECTED` 在页面已经发送后是否为“明确未提交”缺乏证据。
- 若平台在收到请求后返回拒绝，可能已有部分副作用（例如草稿/上传），不能简单视为未发生写操作。

建议修复：

- 区分“请求未被平台接收”与“平台明确拒绝业务参数”；只有能证明未到达平台写接口的拒绝才能记 `failed`。
- 页面执行器应返回结构化阶段（precheck、upload、publish），Host 根据阶段和 dispatch 状态决定终态。

应补测试：

- precheck 拒绝、上传拒绝、publish 返回 `FAIL_BIZ_*` 三种路径分别断言 operation 状态。
- 任何 `dispatched=true` 的拒绝都不能被当作可自动重试。

### P2-2 `prepare` 的 operation 结果在页面返回后、持久化前存在崩溃窗口

涉及位置：

- `apps/host/src/publish-service.ts:280`：页面 prepare 已返回。
- `apps/host/src/publish-service.ts:284-285`：先写 prepared record，再写 operation succeeded。

触发条件：

- 进程在两次写入之间崩溃。

影响：

- operation 可能停留在 `dispatching`，重启后仍阻断重放，但 prepared record 可能已经存在。
- 不会假成功，但恢复语义不一致：用户可能拿到 token 之前进程崩溃，token 状态不可解释。

建议修复：

- 用一个 SQLite 事务同时写 prepared record 和 operation 成功结果；或先在 operation 中保存完整结果，再写 prepared 索引。
- 增加恢复扫描，确保 `succeeded` 必然有对应 prepared record，`dispatching` 不会留下孤立 token。

应补测试：

- 模拟第二次写失败，断言不会留下可提交 token。
- 重启后 `dispatching` 的 prepare 不返回 token，且不会自动重放。

### P2-3 `collectMyItems` 分页时没有校验 `nextPage` 是否造成循环

涉及位置：

- `apps/host/src/publish-service.ts:203-216`：支持 20 页，但如果页面反复返回同一个游标，会重复请求直到上限。
- `apps/host/src/publish-service.ts:213-214`：只按 itemId 去重，不检测游标重复。

触发条件：

- 页面返回固定或循环 `nextPage`。

影响：

- 最多 20 次无意义平台读取，增加风控暴露，最终报 unknown。
- 不影响成功判定，但应快速失败。

建议修复：

- 记录已见游标集合；重复游标立即 `RESULT_UNKNOWN`。
- 对游标数量、长度和来源做限制。

应补测试：

- 同一 `nextPage` 重复返回时只请求一次或两次即失败，不跑满 20 页。

### P2-4 `myItemsPage` 没有校验 `nextPage` 与 `hasMore=false` 的一致性

涉及位置：

- `apps/host/src/publish-service.ts:119-126`：`hasMore=false` 时仍允许携带 `nextPage`。

触发条件：

- 页面返回 `{ items, hasMore: false, nextPage: "cursor" }`。

影响：

- Host 会忽略 `nextPage` 并认为列表完整；若页面字段矛盾，可能掩盖截断。
- 严格协议应拒绝矛盾状态。

建议修复：

- `hasMore=false` 时禁止 `nextPage`；`hasMore=true` 时必须存在合法 `nextPage`。
- 同时校验 `nextPage` 不是当前游标。

应补测试：

- `hasMore=false + nextPage`、`hasMore=true + nextPage 为空`、`nextPage` 类型错误全部失败。

### P2-5 `submitOutcome` 对 `accepted` 缺少任何平台证据

涉及位置：

- `apps/host/src/publish-service.ts:129-143`：`accepted` 可以完全不带 itemId 或平台 ret 细节。
- `apps/host/src/publish-service.ts:323-333`：Host 主要依赖 myItems 差异确认。

触发条件：

- 页面返回 `{ outcome: 'accepted' }`，但实际平台未成功。

影响：

- 若 myItems 因并发变化产生假阳性，`accepted` 会放大假成功。
- 若 myItems 返回不可用，Host 会 unknown，这点是安全的；但 `accepted` 本身不应被当作成功证据。

建议修复：

- 将页面结果定义为 `{ platform: 'accepted'|'rejected'|'unknown', itemId?, retCode? }`，并明确 `accepted` 只是“明确成功响应”，不是最终 published。
- Host 成功结果必须同时满足明确平台成功和 myItems 确认；缺少任何一项都返回 unknown。

应补测试：

- `accepted` + myItems 未确认不得 published。
- `rejected` + myItems 有新增也不得 published。
- `accepted` + itemId 与 myItems 不一致必须 unknown。

## 现有验证结果

已执行，均未发真实网络请求：

```sh
node --test --test-timeout=15000 packages/protocol/src/publish.test.ts packages/protocol/src/step.test.ts apps/host/src/publish-service.test.ts
npm run typecheck
```

结果：

- 36 个定向测试通过。
- 类型检查通过。
- `git diff --check` 对审查文件无空白错误。

但是：

- Host 测试的 `PageHandler` 是自定义 mock，不验证真实页面执行器。
- 没有 `publish-page-executor` 测试。
- 没有 Host + 页面运行时真实契约的集成测试。
- 没有“提交后列表并发新增/删除”与“新 key 复用旧 token”的回归测试。

## 复核限制

- 未连接真实闲鱼，未发送网络请求，未执行真实发布。
- 未修改业务代码。
- Orca 状态同步失败：`orca worktree set` 返回“Orca is not running”，因此本次只产出复核报告，未改变任务状态。

## 建议修复顺序

1. 先修 P0-1 分页契约、P0-2 token 权威绑定、P0-5 token 消费顺序。这三项决定链路是否可安全工作。
2. 再修 P0-3 地址/归属/图片预检、P0-4 成功确认、P0-6 在途状态。
3. 补 P1-4 页面执行器与 Host 联合测试后，才考虑真实受控验收。
4. 最后处理 P2 的严格性和恢复窗口问题。

## 后续修复状态（2026-10-18 更新）

前文为历史独立复核，行号和描述对应复核时版本，不代表当前全部问题仍未修复。
后续已修内部单步参数拒绝、分页形状、prepareRef/Host 指纹绑定、引用消费、
唯一新增 itemId 确认、明确风控分类传播、图片上传与超时、数字坐标和售价兼容。
MAIN world 直接访问扩展存储的错误接线已移除；可信会话通道尚未完成。
最终状态以 [M5 实施记录](m5-publish-implementation-report.md) 及最新回归报告为准。
仍需完整业务 E2E 与当前实现独立复核，不能将历史问题的修复意图视为验收通过。
