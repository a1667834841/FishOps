# 发布失败 `SUBMIT_BUTTON_NOT_FOUND` 只读诊断报告（TaskSpace 133 · 脱敏）

- 方式：ego-browser，`takeOverTaskSpace(133)`（**复用同一空间，未新建**）。
- 扩展：ID `fmiehocngmplglipncecpiaakefglglc`，来源 `extension/dist`（**未 build、未 reload**）。
- 存储：**未清 storage**、未改配置、未改用户规则、**未改源码**。
- 合规红线（本轮全部未触碰）：**未最终提交/点击发布**、未关闭或绕过验证码、未发聊天消息、未写飞书、未重试、未 CDP 授权绕过。
- 结论：一个**确定性源码缺陷**导致“找到按钮却判为文本非发布”，另有 2 个前端/协议缺陷叠加造成“UI 卡在正在提交”“错误码被吞”。

---

## 1. 任务快照（只读 `PUBLISH_GET`，token 值不输出）

目标任务 `publish_08193f7154da42cb`（存在；非从列表另选）：

| 字段 | 值 |
| --- | --- |
| `status` | `waiting_confirmation` |
| `progress` | 100 |
| `payload.source` | `feishu` |
| `result.tabId` | **241203753** |
| `result.formUrl` | `https://www.goofish.com/publish` |
| `result.confirmationStatus` | `waiting_review` |
| `result.submit` | **`null`**（无提交记录：submit.state 不存在） |
| `result.submitToken` | **存在 = true（长度 28；值不输出）** |
| `meta.submitAttempted` | **`false`** |
| `meta.submitState` | 不存在（undefined） |
| `meta.step` | `waiting_confirmation` |
| `meta.filledTabId` | 241203753 |
| `task.error` | `null` |

`PUBLISH_LIST` 共 3 条：本任务 `waiting_confirmation`（token 在）；另 2 条 `cancelled`（token 已清）。

**判定**：`submitAttempted=false` + `result.submit=null` + token 仍在 ⇒ 走的是后台“**确定性未派发点击 → 回滚锁并保留令牌**”分支（`submitForm` 第 10 步 / `rollbackSubmitDispatching`）。

---

## 2. 真实 `/publish` 页面按钮 DOM（按 `result.tabId` 定位）

- 目标 tab `241203753`（窗口 `241203714`）**仍存在**，`status=complete`，URL 仍为 `https://www.goofish.com/publish`（**未跳转 ⇒ 未发布**）。
- 方式：从扩展内页经 `chrome.scripting.executeScript({ tabId: 241203753, func })` 注入**纯只读**探针（无点击、无导航、无状态写入），两次采样间隔 1.4s。

**失败选择器**（源码 `injected-scripts.ts:887`）：
`html.page-publish #content button[class*="publish-button"]`

**命中结果（两次采样一致，无渲染变化）**：

| 项 | 实测值 |
| --- | --- |
| 命中数量 | **1**（唯一） |
| tag | `BUTTON` |
| class | `publish-button--KBpTVopQ` |
| innerText | `发布` |
| textContent | `发布` |
| innerHTML | `<span>发布</span>` |
| children | 1 个 `SPAN`（class 空，文本 `发布`） |
| `'value' in button` | **true** |
| `button.value` | **`""`（空字符串）** |
| visible | 是（`display:flex`、`visibility:visible`、`opacity:1`、240×48、pointer-events auto） |
| disabled | 否（`disabled` prop/attr 均 false，class 不含 `disabled`） |
| shadow DOM | 否（非 shadow tree，无 own shadowRoot） |
| svg | 否 |
| 验证码/风控 | 无 |
| `html.className` | `trancy-zh-CN page-publish`（含 `page-publish`，`#content` 存在） |

**结论**：选择器、class、可见性、禁用状态**全部正常**；按钮就是真实“发布”按钮。失败**不是**选择器失效、不是多命中、不是不可见、不是禁用，也不是渲染延迟。

---

## 3. 源码对照：根因（Bug A）

失败点：`extension/src/publish/injected-scripts.ts` 的 `injectClickPublishSubmit`。

关键复用函数 `readText`（L811-822）：

```ts
const readText = (el: HTMLElement | null): string => {
  if (!el) return ''
  if ('value' in el) {                       // ← 用 'value' in el 判断“表单控件”
    const v = (el as HTMLInputElement | HTMLTextAreaElement).value
    return typeof v === 'string' ? v : String(v ?? '')
  }
  return String(el.textContent ?? '')
}
```

按钮文本校验（L913-919）：

```ts
const buttonText = readText(publishButton).trim()
if (buttonText !== '发布') {
  return notClicked('SUBMIT_BUTTON_NOT_FOUND',
    `命中元素文本非“发布”（实际“${buttonText}”），拒绝点击以免误触包装器 / 其它按钮`)
}
```

**缺陷**：`HTMLButtonElement` 也有 `value` 属性（未设 `value` 时默认 `""`）。因此 `'value' in button === true`，`readText(button)` 返回 `button.value === ""`，而不是 `textContent` 的 `"发布"`。于是 `buttonText===''` ≠ `'发布'` ⇒ 命中“唯一 + 文本非发布”，返回 `SUBMIT_BUTTON_NOT_FOUND`，**在 `publishButton.click()`（L963）之前直接 return，绝不点击**。

**在真实页面直接复算源码判定（red 信号）**：

```
exists: true
hasValueInOperator: true
buttonValue: ""
buttonTextContent: "发布"
readTextReturns: ""          ← readText(button)
readTextTrimmed: ""
sourceCheckWouldFail: true   ← readText(button).trim() !== "发布"
spanHasValueIn: false
spanReadText: "发布"          ← 同样的 readText 用在子 span 上则正确
```

即：**在当前健康的 DOM 上，源码判定依然失败**——这是确定性缺陷，与“当时 DOM 恰好为空”无关。

**测试盲区**：单测沙箱 `injected-scripts.test.ts` 的 `createInjectionSandbox` 用 `makeElement('BUTTON', { textContent: '发布', ... })` 构造假按钮，**FakeElement 没有 `value` 属性** ⇒ `'value' in el === false` ⇒ 单测走 `textContent` 分支通过。真实 DOM 与测试替身在这一点上不同构，导致缺陷逃逸。

---

## 4. 是否实际派发 click / 远端是否已发布

**均否（确定性判定，非“未知”）**：

1. 注入侧返回 `clicked:false`（`SUBMIT_BUTTON_NOT_FOUND`）⇒ 后台走回滚分支，**未调用 `.click()`**。
2. 任务态佐证：`meta.submitAttempted=false`、`result.submit=null`、token 仍在（若是“已派发/未知”，这三项分别为 true / 有记录 / 令牌被清）。
3. 目标 tab 仍停留在 `https://www.goofish.com/publish`，**未跳转**（`observeSubmitOutcome` 以“离开发布页”判定 `submitted`）。

⇒ **远端未产生任何发布**；可安全让用户修正后重试（后台状态可重试）。

---

## 5. UI 状态：为什么同时出现“正在提交”和错误（Bug B）

p18（发布中心，`chrome-extension://…/workbench.html`）当前 DOM（只读采集）：

- `.publish-submit-panel` 内为 **`.in-progress-box`**：`正在提交发布中，请稍候…`（场景 C，锁定、**没有“发布”按钮**）。
- 同时页面级存在 `.callout--error`：`扩展处理失败 / [PublishError:SUBMIT_BUTTON_NOT_FOUND] 命中元素文本非“发布”（实际“”）… · INTERNAL`。
- 确认面板内**无** `.human-confirm-box`、无 `.submit-btn-main`（即无法重试）。

按模板（`PublishPage.vue`）：
- 场景 C（`in-progress-box`）条件 `isInProgress`（L108-114 = `isSubmitting || currentTask.result.submit.state==='in_progress' || submitOutcome.outcome==='in_progress'`）。
- 场景 D（含发布按钮 + `.submit-error-callout`）是 `v-else`。

**由排除法推得（inference）**：`currentTask.result.submit` 现为 `null`（PUBLISH_GET），且 `submittingTaskId` 在 `submitPublish` 的 catch 中已复位为 `null`（controller L896-903），故 `isInProgress` 只能来自 **`submitOutcome.outcome === 'in_progress'`**。

其来源：后台 `publish-runtime.ts` 订阅 TaskManager 变更，对**每次** `persistSubmitRecord`（`pause`/`updateProgress`/`waitForConfirmation`）广播 `TASK_CHANGED` 与 `PUBLISH_TASK_CHANGED`（L268-304）。提交开始时会先落盘 **dispatching 记录**（`result.submit.state='in_progress'`，L1124-1133）并广播；前端 `PublishController.handleTaskUpdated`（L212-250）据此把 `submitOutcome` 置为 `in_progress`：

```ts
let submitOutcome = s.submitOutcome
if (task.result?.submit && (currentTask?.id === task.id || s.submitOutcome?.taskId === task.id)) {
  const sub = task.result.submit
  submitOutcome = { taskId: task.id, outcome: sub.state === 'submitted' ? 'submitted'
    : sub.state === 'unknown' ? 'unknown' : 'in_progress', message: (sub as any).message }
}
```

回滚后 `result.submit` 被清除，但该分支要求 `task.result?.submit` 为真才进入 ⇒ **`submitOutcome` 不会被重置为 null**，`in_progress` 残留。于是：

- 确认面板锁定为“正在提交中”（**用户无法再点发布**，即使后台本可重试）；
- catch 写入的 `action.error` 又让页面级 Callout 报错；
- 两者并存 ⇒ 用户截图“发布失败 + UI 正在提交”。

---

## 6. 错误码被吞（Bug C）

- 后台 `publish-runtime.ts handleError`（L1534-1542）：`PublishError` 一律把协议 `error.code` 写为 `'INTERNAL'`，把真实业务码放到 `error.businessCode`。
- 前端 `workbench/src/features/shared/bridge-api.ts`（L65-73）构造异常时**只取 `code/message/category/retCode`，丢弃 `businessCode`**：
  ```ts
  throw new CommandError(error?.code ?? 'INTERNAL', error?.message ?? '未知错误',
    error?.category, error?.retCode)   // ← businessCode 被丢
  ```
- `publish-controller.submitPublish` catch（L878-894）读 `errObj.businessCode || errObj.code` ⇒ 得 `'INTERNAL'` ⇒ 无法命中 `SUBMIT_BUTTON_NOT_FOUND` 的精准提示分支，只显示通用“扩展处理失败”。
- `Callout.vue`（L28-30）渲染 `{{ view.detail }} · {{ view.code }}` ⇒ 界面出现 `· INTERNAL`。

`shared/events/protocol.ts`（L55-67）本就定义了 `businessCode`（注释明确为 `SUBMIT_BUTTON_NOT_FOUND` 精准分支而设），链路中段被丢弃。

---

## 7. 给修复代理的根因清单（建议，未改源码）

| # | 严重度 | 位置 | 根因 | 建议修复 |
| --- | --- | --- | --- | --- |
| A | 阻断发布 | `extension/src/publish/injected-scripts.ts` `readText`（L811-822）+ 按钮校验（L913-919） | `'value' in HTMLButtonElement === true` 且默认 `""`，按钮文本被读成空，误判“非发布” | 按钮文本改为直接读 `publishButton.textContent`/`innerText`（或按 `tagName==='BUTTON'` 分支），不要复用表单控件的 `value` 启发式 |
| A' | 测试盲区 | `extension/src/publish/test/injected-scripts.test.ts` `makeElement('BUTTON', …)` | 假按钮没有 `value` 属性，与真实 `HTMLButtonElement` 不同构 | FakeElement 增加 `value: ''`（默认）以覆盖该分支 |
| B | UI 死锁 | `workbench/src/features/publish/publish-controller.ts` `handleTaskUpdated`（L212-250） | 回滚清除 `result.submit` 后，`submitOutcome` 的 `in_progress` 不被重置 | 当 `task.result?.submit` 缺失/回滚时显式 `submitOutcome=null`（或仅在存活态保留），使失败后可回到场景 D 允许重试 |
| C | 诊断/分支失效 | `workbench/src/features/shared/bridge-api.ts`（L65-73） | 丢弃 `ProtocolError.businessCode` | `CommandError` 增加并透传 `businessCode`，controller 优先用其分支 |

**次要**：后台把全部 `PublishError` 的协议 `code` 都压成 `INTERNAL`，仅在 `businessCode` 携带真码——若前端不接 `businessCode`，任何发布业务失败都表现为通用错误。

---

## 8. 复现 / 验证方式（不触发发布）

- 只读复现（当前页面即可，无需点击）：
  1. `PUBLISH_GET {id:'publish_08193f7154da42cb'}` → `meta.submitAttempted=false`、`result.submit=null`、token 存在。
  2. 对 tab `241203753` 注入只读探针，复算 `readText(button)` → `''`，`源校验失败`。
- 修复后应满足：对同一个 `<button class="publish-button--…">发布</button>`，按钮文本读取为 `"发布"`，源校验通过（此时**仅**在得到用户明确授权后才允许真实点击，本轮不做）。

## 9. 本轮已执行 / 未执行动作

- 已执行：接管 space133（用户本请求授权）；`PUBLISH_GET`/`PUBLISH_LIST` 只读；`chrome.tabs`/`chrome.windows` 只读；对目标 tab 注入**纯只读** DOM 探针；读取 p18 DOM 与源码。
- 未执行：任何 `PUBLISH_SUBMIT`、任何真实点击、关闭/绕过验证码、发送消息、写飞书、build、reload、清 storage、改源码、改配置。
