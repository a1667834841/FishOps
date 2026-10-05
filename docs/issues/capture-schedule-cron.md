# Issue 正文：采集任务支持一次性或 cron 定时调度

- 目标仓库：a1667834841/FishOps
- 状态：已创建 issue #3（OPEN，label: enhancement）
- 标题：`[Feature] 采集：任务支持一次性或 cron 定时调度`
- 分类：enhancement（用户指定 feature issue，仓库已存在同名 label）
- 链接：https://github.com/a1667834841/FishOps/issues/3
- 需求确认（本次对话）：调度粒度 = 一套表单配置 + 一组关键词为一个定时任务；错过的触发跳过并记录；cron 支持 5 段标准加常用宏
- 调研证据：采集链路现状由源码核实，行号随正文记录在「实际结果」章节

---

## 问题概述

采集任务当前只有「创建即执行一次」这一种形态。需要增加一个调度开关：既可保持一次性执行，也可把同一套采集配置登记为定时任务，按 5 段 cron 表达式周期性触发。

## 环境信息

- 版本：待确认
- 运行环境（OS / 浏览器）：待确认。定时能力依赖 Manifest V3 的 `chrome.alarms`，需确认目标 Chrome 版本下限。
- 相关配置（飞书配置状态、数据源）：不适用：本需求只涉及采集调度，不改变飞书写入链路。
- 数据内容 / 规模：待确认：单个定时任务可包含的关键词数量上限。
- 复现频率：不适用：本次为新增能力，无缺陷复现。

## 复现步骤

1. 打开工作台采集页（`workbench/src/pages/CollectPage.vue`）。
2. 填写采集表单（起始页、采集页数、每页条数、价格区间、间隔等）并选择关键词。
3. 提交采集。
4. 观察提交结果与任务列表，确认没有可选的执行方式。

## 实际结果

- 采集提交是一次性的：提交后按关键词批量生成任务并立即执行；界面与数据模型里都没有调度入口。
- 任务类型 `Task`（`shared/types/task.ts:80`）与采集负载 `CapturePayload`（`shared/types/capture.ts:31`）中均无调度、计划、重复、下次运行时间相关字段。
- 下发命令只有 `CAPTURE_CREATE`（`shared/events/commands.ts:105`）。background 侧在 `extension/src/background/capture-runtime.ts:157` 收到命令，于 `:190` 创建任务、`:192` 立即 `controller.start(task.id)`，没有延迟或周期执行的分支。
- 扩展当前未使用 `chrome.alarms`：`extension/public/manifest.json:6` 的 permissions 为 `["storage", "scripting", "tabs", "cookies"]`，未声明 `alarms`。
- 任务持久化默认走 `chrome.storage.session`（`shared/task/task-store.ts:419` 的 `createDefaultTaskStore()`）：service worker 休眠不丢，但扩展 reload 会被清空。定时任务配置若沿用这一层会随之丢失。
- 采集执行侧已有互斥约束：`extension/src/capture/controller.ts:333` 的 `pump()` 保证同一时间只有一个采集任务在运行（`:334` 判定 `activeId !== null` 即返回），页间按「基础间隔 + 随机抖动」节流，默认值为 `shared/types/capture.ts:12` 的 `DEFAULT_CAPTURE_INTERVAL_MS = 500` 与 `:15` 的 `DEFAULT_CAPTURE_JITTER_MS = 500`。

## 预期结果

- 采集页提供调度开关（switch）：`一次性`（现有行为，默认）与 `定时任务`。
- 选择「定时任务」时出现 cron 表达式输入，支持 5 段标准格式（分 时 日 月 周）与常用宏（`@hourly`、`@daily`、`@weekly`、`@monthly`）；提交前校验，非法表达式给出明确提示且不允许提交。
- 定时任务到点触发时，按保存的表单配置与关键词集合执行一次批量采集，与手动提交走同一条 `CAPTURE_CREATE` 链路。
- 定时任务配置持久化在 `chrome.storage.local`（而非当前任务使用的 `chrome.storage.session`），保证扩展 reload 后调度仍然存在。
- 错过的触发点跳过并记录：浏览器关闭或 service worker 被回收期间错过的触发不补跑；恢复运行后在任务历史中留下可识别的「已跳过」记录。
- 触发粒度下限为 1 分钟，与 `chrome.alarms` 的最小周期一致；小于 1 分钟的表达式或秒级字段在提交时被拒绝并说明原因。
- 定时任务在列表中展示启用状态与「下次运行时间」。

## 证据与排查状态

- 证据：本轮对话需求（用户口述：采集任务现在是一次性的，想增加 switch 支持一次性或定时任务，定时任务支持 cron 表达式）；采集链路现状由源码核实，行号见「实际结果」。
- 已证实：当前无调度字段、无定时入口、未声明 `alarms`、任务默认存 `storage.session`、采集侧为串行单任务。
- 排查状态：不适用：本次为新增能力，未进行缺陷排查。
- 推测（待验证）：`chrome.storage.session` 在扩展 reload 后清空这一语义来自 `shared/task/task-store.ts:11-13` 的注释，尚未在浏览器中实测复现。
- 需求已在本次对话确认：调度粒度按「一套表单配置 + 一组关键词」等于一个定时任务；错过的触发跳过并记录；cron 支持 5 段标准加常用宏。

## 影响范围

- 已知：工作台采集页表单与提交逻辑、`shared/events/commands.ts` 的采集命令集、`extension/src/background/capture-runtime.ts` 的创建与启动路径、`extension/public/manifest.json` 的权限声明、任务持久化层。
- 待排查：定时触发与手动触发同时进入队列时的表现。现有 `pump()` 为单活动槽，定时触发会让手动任务排队等待，是否需要界面提示；多个定时任务时间点重合时的排队延迟是否可接受。
- 范围外：飞书写入、聊天中心、发布流程不改动；不引入服务端调度，调度完全在扩展侧完成。
- 实现前待拍定：cron 与本机时区的关系（默认按本机时区解释）；是否支持对已创建的定时任务暂停或恢复而不删除；单个定时任务的关键词数量上限。

## 验收标准

- [ ] 采集页存在调度开关，默认值为「一次性」，选择后提交行为与现状完全一致。
- [ ] 选择「定时任务」时可输入 cron 表达式；合法表达式（含 `@daily` 等宏）保存成功，非法表达式被拒绝并给出明确原因。
- [ ] 保存的定时任务在扩展 reload 后依然存在，且能在列表中查看。
- [ ] 到达触发点时确实发起一次批量采集，走 `CAPTURE_CREATE` 链路，任务记录可追溯到本次触发。
- [ ] 浏览器关闭或 service worker 被回收期间错过的触发不补跑，并在任务历史中留有「已跳过」记录。
- [ ] 小于 1 分钟粒度的表达式或秒级字段在提交时被拒绝，并说明受 `chrome.alarms` 最小周期限制。
- [ ] 列表展示定时任务的启用状态与「下次运行时间」，该时间与 cron 表达式解释一致。
- [ ] 定时触发与手动采集同时发生时，两者按现有串行队列依次执行，不产生并发采集，无任务状态错乱。
