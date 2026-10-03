# FishOps 真实复测报告（最新 dist · TaskSpace 133 · 脱敏）

- 方式：ego-browser，`takeOverTaskSpace(133)`；**同一空间**，未新建空间。
- 扩展：ID `fmiehocngmplglipncecpiaakefglglc`，来源 `extension/dist`。
- 加载：经 `chrome://extensions` **标准 reload** 载入最新 dist（`background.js` 含 `readTrustedUserIdInPage`，manifest 05:23）；reload 后新开 Workbench 页。
- 存储：**未清 storage**，用户配置保留（AI/飞书 `configured=true`）。
- 网络：全部真实，无 mock。
- 红线：未聊天发送、未最终发布、未开 auto、未飞书 EXECUTE、未 CDP 授权/绕过、未改用户规则、未改源码。

---

## 汇总

| # | 测试 | 结果 | 一句话 |
| --- | --- | --- | --- |
| 1 | config STATUS + permission contains | **PASS（含 1 项配置不一致）** | 飞书 origin 已授权；AI origin 未授权，且端点非 HTTPS |
| 2 | 飞书 schema/query 只读 + WRITE_PREVIEW | **PASS** | 16 字段；preview `fieldCompatible=true`、无缺失/冲突 |
| 3 | currentUserId 布尔 + PREPARE + 同步 + 刷新 /im | **PASS** | 修复生效：`userIdReady=true`；刷新 /im 后 socket `open` |
| 4 | 真实 AI 手动建议一次 | **FAIL（上游策略）** | `AI_ERROR`，0 字符 |
| 5 | 本地分析一次 | **FAIL（上游 HTTP 400）** | 任务 `failed`（progress 60），上游隐私策略拒绝 |
| 6 | 读取既有 waiting_confirmation 任务 + 目标 tab | **部分** | 任务记录 reload 后丢失；目标 tab 已填表单仍在 |

---

## 1. 配置状态（只布尔，未输出 key/secret/token/baseURL）

- `AI_CONFIG_STATUS`：`configured=true`，provider=`test.ggball.top`，model=`muse-spark-1.3-contributor`，timeout=30000
- `FEISHU_CONFIG_STATUS`：`configured=true`，`hasAppId/hasAppSecret/hasSpreadsheetToken/hasProductTableId=true`，`hasSellerTableId=false`
- `chrome.permissions.contains`：
  - `https://open.feishu.cn/*` → **true（已授权）**
  - AI 端点 origin → **false（未授权）**；`https://*/*` → false
- **矛盾点**：已配置 AI `baseUrl` 方案为 **`http:`（非 HTTPS）** → `extractSafeAiOrigin` 拒绝 → `AI_CONFIG_STATUS` 不下发 `permissionOrigin`。
- 设置页（新构建）已修复“回退默认域名”：显示“**现有端点不符合 HTTPS 要求…已阻止向非安全或默认域名发起授权请求**”，不再回退请求 `api.openai.com`。因此**未产生新的授权 prompt**（按规则无需 handOff）。
- 未修改任何配置。

## 2. 飞书（只读，未 EXECUTE、未建字段）

- `DATA_SOURCE_SCHEMA {type:'feishu'}` → **ok**，16 字段：
  `多行文本:string, 关键字:string, 价格:number, 原价:number, 发布时间:datetime, 采集时间:datetime, 商品ID:string, 商品标题:string, 想要人数:number, 卖家昵称:string, 地区:string, 包邮:string, 商品标签:string, 封面URL:url, 商品详情URL:url, 曝光热度:string`
- `DATA_SOURCE_QUERY {type:'feishu'}` → **ok**，`rowCount=50`，`fieldCount=16`（未记录行内容）
- `FEISHU_PRODUCT_WRITE_PREVIEW {itemIds:[1 条显式商品]}` → **ok**（2.26s）：
  `requestedCount=1, uniqueCount=1, missingCount=0, alreadyExistsCount=0, toCreateCount=1, fieldCompatible=true, missingFields=[], typeConflicts=[], previewId 存在`
- 判定：飞书网络与表已可用；字段类型兼容、无缺失。**未 execute 写入、未创建字段。**

## 3. runtime（不输出 id）

- `platform.authState` → `{loggedIn:true, hasToken:true}`
- `platform.currentUserId` → **ok，hasUserId=true（id 未输出）** —— 修复生效（旧实现 `FAIL_SYS_ILLEGAL_ACCESS`）
- `CHAT_RUNTIME_PREPARE {force:true}`（刷新 /im 前）：`ok=true`，`tabCreated=false`（复用 `/im`），`platformReady=true`，`userIdReady=true`，`socketReady=false`（socket connecting，约 10.1s）
- **刷新 `/im`**（reload `/im` 标签，用于替换旧 host）：**未触发任何权限/通知 prompt**，ownership 保持 `agent`
- 刷新后复测：`socketStatus=open`，`CHAT_RUNTIME_PREPARE` → `ok=true, platformReady=true, socketReady=true, socketStatus=open, userIdReady=true`
- 同步：`CHAT_SYNC_CONVERSATIONS` → `added 16`（89ms）；`CHAT_SYNC_HISTORY`（首会话）→ `added 8`；`CHAT_STATUS` → `16 会话 / 8 消息`
- 影子/坑：旧 host 未刷新时 socket 停留在 `connecting`；刷新 `/im` 后恢复 `open`。

## 4. 真实 AI 手动建议（一次；只生成不发送）

- `CHAT_GET_REPLY_SUGGESTION`（首会话，`respectPause:false`）→ **result.ok=false，code=`AI_ERROR`**，`contentChars=0`，`hasContextSummary=false`，耗时 **814ms**
- `enabled=false`、`mode=suggest`、`rules=[]`；命令未再被 `disabled` 拦截（新构建改为 fallback AI）。
- **未发送**、**未开 auto**（`CHAT_AUTO_REPLY_STATUS.enabled=false` 发送前后一致）。
- 无显式 HTTP 状态返回；同一 AI 配置的“分析”调用（见 5）返回了上游 HTTP 400，推测建议走同一上游失败路径（**推断，未重复调用验证**）。

## 5. 本地分析（一次）

- 使用已有合法规则 `rule_high_demand_low_competition`（未改用户规则），`dataSourceType='local'`，`sampleLimit=5`
- 任务 `analysis_034229d5e6c54fe9`：`pending(0)` → **`failed`（progress 60）**
- 错误（真实上游）：**`AI 接口 HTTP 错误 (400): Upstream request failed: This Go model trains on request data. Allow paid endpoints that train on request data in your workspace's Privacy settings to use it.`**
- `ANALYSIS_RESULT_GET` → 无结构化结果（`{}`）
- 判定：**AI 端点网络可达**，失败源于**上游模型/工作区策略（HTTP 400）**，非扩展网络层。

## 6. 发布（不新建）

- `PUBLISH_LIST` → **total=0**：上一轮 `waiting_confirmation` 任务记录在扩展 reload 后**丢失**（任务存储为会话级）。
- 目标 tab `241203753`（窗口 241203714）**仍在**且保留已填表单（只读核对）：
  - 描述 `contenteditable` 长度 **88**；`价格 *=13`、`原价=65`、`邮费*=""`；
  - 首图已上传（上传区文本“添加细节图”，无“添加首图”）；官方“发布”按钮存在（**未点击**）。
- 未随机新建发布任务。

---

## 结论与阻塞（给主/修复代理）

1. **`currentUserId` 修复生效**：改为页内受信 cookie（`unb`/`havana_lgc2_*`）解析，`userIdReady=true`、PREPARE `ok=true`；**刷新 `/im` 后 socket open**。
2. **飞书链路恢复**：schema/query 成功；WRITE_PREVIEW 字段兼容、无缺失/冲突；未执行写入。
3. **AI 调用阻塞在上游策略**：分析返回 **HTTP 400**（“模型训练于请求数据”需工作区隐私设置允许付费端点，或更换模型）。建议/分析各 1 次调用，未盲重试。
4. **AI 端点非 HTTPS（配置不一致）**：已配置 `baseUrl` 为 `http:` → `permissionOrigin` 不下发、设置页拒绝授权；但运行时 HTTP 请求仍可达上游。用户称“HTTPS 已处理”**未反映在存储配置**（`baseUrl` 仍为 http）。
5. **发布任务会话级**：reload 会清空 `PUBLISH_LIST`；已填官方 tab 不受影响。
6. **`/im` 旧 host**：扩展 reload 后需刷新 `/im` 才能让 socket `open`。

## Space / Pages（未 finish）

- **spaceId 133**（ownership `agent`）
- p2 `/publish`（空，241203754）、p5 商品详情、p6 `/im`、p10 `chrome://extensions/`、p11 Workbench；空间外窗口 241203714：`/`(241203715)、已填 `/publish`(241203753)

---

## 附：本轮真实命令结果码（摘要）

- `DATA_SOURCE_SCHEMA(feishu)` ok；`DATA_SOURCE_QUERY(feishu)` ok(50)
- `FEISHU_PRODUCT_WRITE_PREVIEW` ok(fieldCompatible=true)
- `platform.currentUserId` ok(hasUserId=true)
- `CHAT_RUNTIME_PREPARE` ok（刷新后 socket open）
- `CHAT_SYNC_CONVERSATIONS` ok(added 16)；`CHAT_SYNC_HISTORY` ok(added 8)
- `CHAT_GET_REPLY_SUGGESTION` fail(AI_ERROR)（0 字）
- `ANALYSIS_CREATE/GET` fail(HTTP 400 upstream)；`ANALYSIS_RESULT_GET` 无结果
- `PUBLISH_LIST` total=0（reload 清空）；目标 tab 表单保留
