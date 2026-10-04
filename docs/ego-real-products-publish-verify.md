# FishOps 商品库分页真实复测（TaskSpace 133 · p18 · 脱敏 · 修复后）

- 方式：ego-browser，复用 **TaskSpace 133**（`FishOps runtime publish verification`），**未新建空间**（`takeOverTaskSpace(133)`）。
- 后台根因修复：飞书 `records/search` 的 **`page_size` / `page_token` 改为 query 参数**（此前放 body 被忽略 → 一次返回全表）；body 仅承载 `filter` / `sort`；并新增护栏「返回条数 > 请求 pageSize → `INVALID_RESPONSE`」。
  - 源码 `shared/data-source/feishu-data-source.ts` 修改于 **17:37**；`extension/dist/background.js` 构建于 **17:39**（含 `url.searchParams.append("page_size", …)`）。
- 加载：经 `chrome://extensions` 对 `FishOps Workbench (P1)`（ID `fmiehocngmplglipncecpiaakefglglc`）执行**标准“重新加载”**（穿透 shadow DOM 点击官方 reload 按钮）；**未清 storage，用户配置保留**。
- 页面：扩展 reload 会关闭原 Workbench 页（`p16`/`p17`），在同一空间新建 **`p18`** 打开最新 dist 复用。
- 命令观测：仅在扩展页 `p18` 内对 `chrome.runtime.sendMessage` 做**只读计数包装**（命令名 / requestId / 非敏感字段存在性 / 响应计数），不改源码、不改后台。
- 红线：**未穷举 pageSize**（只用默认 20）；**未**写飞书 / publish fill / submit / AI / chat；未改源码/build/commit；**未 finish**。
- 脱敏：不输出商品正文/标题/描述/URL/recordId 明文；recordId 仅以 8 位哈希用于“跨页是否不同”的判定。

---

## 汇总（本轮真实复测）

| # | 检查项 | 结果 | 依据（脱敏） |
| --- | --- | --- | --- |
| 1 | 商品库默认请求 20 条首屏 | **PASS** | 唯一请求 `{ps:20, pt:false, tt:false, kw:false}`；响应 `rowsLen=20` |
| 2 | 首页真实 rows ≤ 20 | **PASS** | `.table tbody tr = 20`（distinct 20） |
| 3 | `hasMore` / `total` 按 API 真实返回 | **PASS** | 响应 `hasMore=true`、`total=281`（来自飞书 `data.has_more` / `data.total`），`nextPageToken` 存在 |
| 4 | 下一页携 `pageToken` + `targetTableId` 再取 20 且 recordId 不同 | **PASS** | 请求 `{ps:20, pt:true, tt:true}`；响应 `rowsLen=20`；与第 1 页 recordId **重叠 0** |
| 5 | 上一页重新请求正确 | **PASS** | 回第 1 页请求 `{ps:20, pt:false, tt:true}`；`rowsLen=20`；recordId 集合与第 1 页**完全一致** |
| 6 | keyword 单页搜索（服务端、单次请求） | **PASS** | 唯一请求 `{ps:20, kw:true, pt:false}`；响应 `rowsLen=20`、`hasMore=true`、`total=241`；`rows=20` |

> 说明：`hasMore` / `total` 均为飞书 search 响应字段的真实透传（`total` 仅 API 返回时给出，不在前端估算）。

## 逐页证据（脱敏）

| 动作 | 请求 payload | 响应 | 渲染行 | 翻页态 | 页码 |
| --- | --- | --- | --- | --- | --- |
| 进入商品库（默认） | `pageSize=20, 无 token/绑定, 无 keyword` | `ok, rowsLen=20, hasMore=true, total=281, nextToken=true, targetTableId=true` | 20 | 下一页可用 / 上一页禁用 | 第 1 页 / 15 页 |
| 下一页 | `pageSize=20, pageToken=true, targetTableId=true` | `ok, rowsLen=20, hasMore=true, total=281` | 20 | 上一页可用 | 第 2 页 / 15 页 |
| 上一页 | `pageSize=20, pageToken=false, targetTableId=true` | `ok, rowsLen=20, hasMore=true, total=281` | 20 | 上一页禁用 | 第 1 页 / 15 页 |
| keyword 搜索 | `pageSize=20, keyword=true, 无 token` | `ok, rowsLen=20, hasMore=true, total=241, nextToken=true` | 20 | 单页 | 第 1 页 / 13 页 |

- 第 1 页 ↔ 第 2 页 recordId 哈希集合交集 = **0**（确为不同记录）。
- 上一页恢复后第 1 页 recordId 哈希集合与初次 **完全一致**（`page1RestoredIdentical=true`）。
- 搜索后状态栏显示“匹配…”，清空搜索后恢复 `badge=281`、`rows=20`（回到全量第 1 页）。

## 关键 selector

- 列表：`table.table`、`table.table tbody tr`、`.table caption`
- 翻页：`button[aria-label="上一页"]`、`button[aria-label="下一页"]`、`.pager__info`
- 搜索：`#products-keyword`、`button[aria-label="搜索商品"]`、`button[aria-label="清除搜索"]`
- 状态：`.status`、`.tab-btn__badge`

---

## 前一轮（修复前）与更早结论（保留追溯）

- 修复前同一空间复测：`FEISHU_PRODUCTS_PAGE` 的 `pageSize` 取 1/5/20/50/100 均返回 **281** 行、`hasMore=false`、`total=281` → 分页/批量为 **FAIL**（已由本轮修复解决）。
- **行“发布”导航 → PublishPage → `FEISHU_PRODUCT_GET` 素材填入编辑**：先前 **PASS**（本轮按要求**未重跑**）。
- **本地编辑标题/描述/售价/原价/封面 → preview 一致并恢复 draft**：先前 **PASS**（未重跑）。
- **导航/编辑期间无 PUBLISH_CREATE/FILL_FORM/SUBMIT、无飞书写入**：先前 **PASS**（未重跑）。
- **390 布局无横向溢出**：先前 **PASS**（未重跑）。

## 未执行 / 保持未做（本轮）

- 未穷举多种 pageSize（仅默认 20）。
- 未写飞书、未点 publish fill / submit、未调用 AI、未发聊天消息。
- 未清 Cookie/cache/storage；未改源码；未 build；未 commit；**未 finish（空间 133 保持占用）**。

## Space / Pages

- **spaceId 133**（`takeOverTaskSpace(133)` 后 ownership=`agent`）
- `p2` goofish `/publish`、`p5` 商品详情、`p6` `/im`、`p10` `chrome://extensions/`、**`p18` Workbench（本轮，最新 dist）**
