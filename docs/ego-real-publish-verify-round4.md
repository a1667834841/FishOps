# FishOps 真实发布验收 Round 4（TaskSpace 133 · p20 · 脱敏 · 结论 FAIL）

- 方式：ego-browser，`takeOverTaskSpace(133)`（**复用同一空间，未新建 space**），**唯一浏览器操作者**。
- 扩展：ID `fmieho…`（未完整输出），来源 `extension/dist`（构建时间 20:22，晚于源码改动 20:14）。
- 加载：经 `chrome://extensions/` 对 FishOps 卡片执行**标准“重新加载”**；**未清 storage，用户配置保留**。
- 权限：manifest 新增 `cookies` + `h5api.m.goofish.com` host 权限；reload **未出现任何权限增加 / 确认弹窗**，因此**无需 handOff**。
- 红线（本轮全部未触碰）：未二次确认、未重试旧 token、未手点官方发布按钮、未关闭/绕过验证码、未伪造或选择所在地、未把收费改包邮、未发聊天 / 写飞书 / AI、**未改源码 / 未 build / 未 commit**、**未 finish（保留现场）**。
- 脱敏：不输出商品正文 / 商品 ID / 账户 ID / token。草稿身份以 8 位哈希记录：`draft#e7e09460`。

---

## 结论

**FAIL**：本轮真实发布链路在 **FILL 阶段中断**，**未进入 SUBMIT**，官方「我的商品数」**before 0 → after 0（未 +1）**。未误报修好。

---

## 1. 官方基线（PublishedItemsReader 真实口径，独立复算）

在扩展页 `p20` 上下文用 `chrome.cookies` + 带 host 权限的 `fetch` **独立复现** `PublishedItemsReader.readOnSaleItems()` 的只读调用（仅输出计数，不输出 token / 账户）：

| 时点 | 接口 | ret | 在售分组 `itemNumber` | `cardList` 去重条数 | 其他分组 |
| --- | --- | --- | --- | --- | --- |
| 操作前 | `mtop.idle.web.xyh.item.list` | `SUCCESS::调用成功`（HTTP 200） | **0** | **0** | 综合 16 / 已售出 16 |
| 操作后 | 同上 | `SUCCESS::调用成功` | **0** | **0** | — |

判定：**基线在售 = 0**，且**提交尝试后仍为 0**（无任何发布副作用）。

## 2. 草稿选择（同草稿优先、非随机）

- 从「商品库 → 飞书采集的商品库」列表，用素材行的「**发布**」按钮载入草稿（**未使用 🎲 随机选择**）。
- 选中身份 = 最近一条 `waiting_confirmation` 草稿 `draft#e7e09460`（`source: feishu`，`targetTableId` 脱敏）。
- 「自己发布的商品库」Tab 候选 = **0 件**（本地库仅收录本人已发布商品，本轮为空），故草稿只能来自飞书素材。
- 载入后编辑层显示：标题 / 售价 ¥50 / 原价计算 ¥250 / 1 张封面图，字段校验通过、主「发布」按钮可用。

## 3. 提交动作（真实 controller，且仅一次）

- 动作序列：点击主「发布」（`submit-btn-main`，aria-label=“确认发布当前商品”）→ 弹出 `确认发布商品` 弹窗 → **点击「确认发布」恰好一次**。
- 由前端 `PublishController.executeConfirmedPublish()` 串行执行 **CREATE → FILL → SUBMIT**（真实后台命令，非本地伪造）。
- **未额外手点官方页面按钮、未二次提交**；弹窗内确认按钮**只点了一次**。

## 4. 结果（FAIL 在 FILL）

| 阶段 | 命令 | 结果 |
| --- | --- | --- |
| CREATE | `PUBLISH_CREATE` | ok（任务 `publish_afc2d4eea8f9455c` 建立） |
| FILL | `PUBLISH_FILL_FORM` | **失败** `FORM_FIELD_CHANGED`，`step=filling_form`，progress=85，`submitToken` 未生成 |
| SUBMIT | `PUBLISH_SUBMIT` | **未执行**（FILL 失败即中断，未派发任何点击） |

失败原文（脱敏）：

```
[PublishError:FORM_FIELD_CHANGED] 表单填充未全部通过校验，拒绝进入 waiting_confirmation 以免假成功:
图片写入上传控件后回读确认未完全生效（页面确认 0 / 已构造 1）
```

任务快照（经 `PUBLISH_GET` / `PUBLISH_LIST` 只读拉取）：

| 字段 | 值 |
| --- | --- |
| `status` | `failed` |
| `meta.step` | `filling_form` |
| `result.submit` | **`null`（无提交记录）** |
| `meta.submitAttempted` | 未设置（**未派发点击**） |
| `result.submitToken` | 不存在 |
| `meta.filledTabId` | 未记录（FILL 未完成） |

## 5. 官方校验 DOM / 截图信号（被复用的官方发布页）

`ensurePublishTab` 复用了**已存在的**官方发布页 tab `241203753`（`https://www.goofish.com/publish`）。对其实施**纯只读探针**（`chrome.scripting.executeScript`，无点击/无导航/无写状态），实测：

| 项 | 实测值 |
| --- | --- |
| 描述回读长度 | 96，且**包含本次草稿标题**（`descContainsDraftTitle=true`）⇒ 确认本 tab 即本轮 FILL 目标 |
| 表单 `form-item-explain` | **“商品描述不能包含emoji”** |
| 页面 toast | **“当前分类不支持网页端发布”**、**“商品描述不能包含emoji”** |
| 上传区 | `添加首图` 提示**消失**；`[class*="upload"] img` 计数 **0**；`img[src^="blob:"/"data:"]` = **0** |
| `input[type=file]` | 存在、未 `disabled` / 未 `readOnly`、`files.length=0` |
| 配送单选 | `checked.value = "0"`（**包邮**，天然避开“非包邮缺费用”红线） |
| 所在地 | `"外滩"`（**账号默认地址，未被修改/伪造**） |
| 验证码 / 滑块 | **未出现** |
| 对照：新建发布页 tab `241203754`（p2） | 有 `添加首图`、无校验错误（未被本轮 FILL 使用，`descLen=0`） |

- 截图证据：`.p0-runtime/publish-fill-fail-modal.png`（Workbench 失败弹窗 + 错误 Callout 现场，**弹窗保持打开未确认**）。
- **官方页像素截图未能获取**：`chrome.tabs.captureVisibleTab` 需 `<all_urls>` / `activeTab` 权限，本扩展不具备——**按规则不新增权限**，故以**完整官方校验 DOM** 作为截图信号替代。

## 6. 根因分析（事实与推断分离）

**事实（实测）**

1. FILL 时图片“已构造 1 / 页面确认 0”，且该官方发布页 tab 的**图片上传区不再提供“添加首图”**（`img`=0），同时官方报 **“当前分类不支持网页端发布”**。
2. 该 tab 是 `ensurePublishTab` **复用**的旧发布页（此前多轮任务共用），描述已被本轮内容覆盖。

**推断（标注为 inference，未再跑验证）**

- 图片回读为 0 的最可能原因：**该发布页处于“当前分类不支持网页端发布”状态，上传区被移除/停用**，因此向 `input[type=file]` 写入文件后页面**不产生任何预览**，`countUploadedImages()` 回读 0。图片失败是**结果**，真实阻断是**官方分类不支持网页端发布**。
- 上游 `readText`（按钮文本）缺陷已在本轮 dist 修复（源码 L1050-1068 已按 `tagName` 分支），但本轮**未走到按钮定位**，故该修复**未被本轮真实验证**。

## 7. 本轮“fill 失败不重试”处置（按用户规则）

- **未再次确认弹窗**；弹窗保持打开，错误 Callout 保留（截图为证）。
- **未重试**、**未复用旧 token**、**未点击官方发布按钮**。
- 已读取官方 validation DOM（上表）。

## 8. 历史任务现状（均未触碰）

| 任务 | 状态 | 提交记录 | token | 处置 |
| --- | --- | --- | --- | --- |
| `publish_afc2d4eea8f9455c`（本轮） | failed | 无 | 无 | 未重试 |
| `publish_fcf388531a5f4325` | waiting_confirmation | `submit.state=unknown`（submitAttempted） | 已清 | **未重试** |
| `publish_fbefc682fb2d470b` | waiting_confirmation | `submit.state=unknown`（submitAttempted） | 已清 | **未重试** |
| `publish_d0e3dd1de67142f6` | waiting_confirmation | `submit.state=unknown`（submitAttempted） | 已清 | **未重试** |
| `publish_08193f7154da42cb` | waiting_confirmation | 无 | 存在 | **未重试** |

> 说明：存在 3 条 **unknown** 旧任务（前几轮），本轮**严格未重试其 token**；官方在售计数未增，佐证这些 unknown 提交**未真正发布**。

## 9. 给修复代理的建议（仅建议，本轮未改源码）

1. **FILL 应识别官方“当前分类不支持网页端发布”**：在注入侧探测该 toast / 校验态并返回结构化码（如 `CATEGORY_UNSUPPORTED`），而不是退化为 `FORM_FIELD_CHANGED` 图片回读错误——否则真实阻断被掩盖，用户无法定位。
2. **图片回读失败的诊断增强**：当上传区缺“添加首图”/ `input` 存在但页面不接受文件时，区分“页面不接受/上传区被停用”与“文件构造失败”，并在错误信息中给出可行动指引。
3. **发布页 tab 复用策略**：`ensurePublishTab` 复用旧发布页可能继承脏状态（如上一轮的分类/校验残留）。建议在 FILL 前对复用 tab 做一次**只读状态重置或新鲜度判定**，必要时新建 tab。
4. **素材侧**：所选草稿的标题/分类命中“不支持网页端发布”，且校验报 emoji；建议发布前对素材做**分类可发布性 + emoji 预检**，避免无谓的真实提交尝试。

## 10. Space / Pages（未 finish，保留现场）

- **spaceId 133**（ownership `agent`）：managed `p2`（goofish `/publish`）、`p5`（商品详情）、`p6`（`/im`）、`p10`（`chrome://extensions`）、`p20`（Workbench 发布中心，**弹窗保持打开**）；untracked `127.0.0.1:5174`（用户页）。
- 空间外窗口 `241203714`：`241203753`（本轮 FILL 目标官方发布页，**保留**）。
