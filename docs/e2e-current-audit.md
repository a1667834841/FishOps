# 当前 E2E 验收审计

本记录按实际证据区分覆盖范围，不代替各里程碑契约。整体仍未完成，不能进入 done。

## 最新门禁核验（2026-10-19）

- `regression:full` 已支持显式扩展重载与生命周期触发器。使用隔离部署、`FISHOPS_BROWSER_RELOAD=1` 和 `FISHOPS_LIFECYCLE_TRIGGER` 的真实完整门禁通过，退出码0：`.test-results/2026-10-19T00-57-34.839Z-98803-db1aee3c/report.json`。
- 报告内 locally checks、真实只读冒烟、同步状态和浏览器关闭重开均为 passed；运行中构建身份与磁盘产物一致，29条基线事件保留，账号稳定。
- 未设置显式开关时仍失败关闭：不自动重载或关闭浏览器，生命周期保持 blocked。默认 CI只执行离线 regression。
- 最近明确指定隔离部署的真实状态验收：`chat-sync-status-1792368366052-38285/report.json`，第二页进度通过。
- 最新页面解析取证：`parser-named-shape-1792368816736/report.json`，未知非空结构导致缺口，尚未解决。后续本地采集解耦、监视器拒绝帧告警和诊断计数上限修复尚未部署。
- 后文原“当前部署”字段是历史快照，不能作为最新构建身份；以报告中的 buildId 和对应证据范围为准。

## 历史部署与代码

- 工作分支：`feat/agent-api-host`；工作区包含未提交及未跟踪改动。
- 隔离扩展当前运行构建：`7001062b-b25c-43c7-818e-9894ad910b40`，本地 API 端口 28791。
- 最新本地回归：`.test-results/2026-10-18T23-23-25.926Z-92918-ba3ce5e1`；typecheck、unit、integration、build、artifacts、install 全部通过。
- 最新隔离部署只读冒烟：`.test-results/chrome-live-1792365844007-94150/report.json`；SSE 历史续传、keepalive、鉴权、页面与账号存在性全部通过。
- 最新同步行为：`.test-results/chat-sync-behavior-1792346108473-84656/report.json`；分页续读、范围拒绝、提交重放、凭证篡改拒绝和标签关联全部通过。
- 最新同步状态行为：`.test-results/chat-sync-status-1792346119422-84787/report.json`；非法任务、未知任务、真实同步和已提交进度查询全部通过。

## 要求与证据

| 要求 | 当前结论 | 证据与限制 |
| --- | --- | --- |
| 查询商品 | 真实搜索与详情通过 | `chat-pagination-20261018/latest-search-detail.json`，搜索 30 项且详情 ID 一致；搜索末页未验证 |
| 本地会话查询 | 通过已测分页契约 | `local-chat-contract-1792339411638-75993/report.json`，两页无重叠及非法参数；不证明所有筛选组合 |
| 本地消息查询 | 已测范围通过 | `chat-pagination-20261018/local-message-pagination-latest.json`，两页无重叠、范围一致、字段白名单 |
| 会话历史同步 | 到达平台明确末页 | `chat-pagination-20261018/limit100-after-fix-complete.json`，900 项，10 页；群聊未消费，partial 保留 |
| 消息历史同步 | 一个已有单聊到达末页 | `chat-pagination-20261018/message-sync-latest.json`，11 项；非文本未消费，partial 保留 |
| 管理对话写操作 | 真实发送、重启后重放与冲突拒绝通过 | `authorized-send-20261019-1792365429257/report.json`、`send-restart-behavior-1792365529458/report.json`；消息 ID 与历史 sourceId 不一致，强关联核验仍待完成 |
| 发布商品 | 本轮验收暂停 | 不因持续目标恢复发布，不调用 prepare/submit 制造新副作用 |
| 风控与恢复 | 部分覆盖 | 已有账号熔断、未知不重放等回归；不承诺不会触发平台风控，不将自动验证码通过作为已验收能力 |
| SSE 与鉴权 | 最新部署只读冒烟通过 | `chrome-live-1792339786251-82459/report.json`，续传、心跳与权限门禁 |
| 生命周期 | 扩展停用启用恢复通过；强制关闭 SW 后需显式唤醒 | `.test-results/chrome-lifecycle-1792343642530-41321/report.json`，在线/离线/恢复、历史事件与账号一致；CDP 强制关闭 SW 后没有独立事件触发重建，手动重新加载扩展后只读冒烟恢复通过；完整浏览器重启已通过 `chrome-lifecycle-1792365462270-85800/report.json`，15 条事件保留且账号一致；自然休眠、登录变化和静默观察尚未验证 |
| 完整自动验证 | 主路径通过，仍有专项缺口 | `regression:full` 在显式隔离部署下已通过；真实发布暂停、发送消息 ID 强关联、缺口清除闭环及自然休眠/账号切换仍未完成 |
| 交付门禁 | 未完成 | 无本次审计证明的 PR 合并；Orca 未运行，阶段同步不可用 |

表内证据路径均相对 `.test-results/`。报告只证明自身记录的输入、版本和范围。

## 契约差异更新

- `mode`、`sessionId`、`committedPages` 已补齐并通过本地及真实只读同步行为验证；`gapCleared` 仍固定为 `false`。
- 失败后的 run 进度查询和缺口覆盖证书仍未实现，不能把同步结果解释为全局缺口已恢复。

## 当前实施顺序

1. 完成缺口代次、范围与覆盖证书基础模块，再接入页面、outbox、Host 和同步恢复状态机；设计见 `m3-gap-recovery-next.md`。基础测试不是生产恢复证明。
2. 新发送已改为平台 messageId；旧键结果保留。真实新发送与历史 ID 对照仍待验收，不能用旧键重放代替。浏览器退出请求被取消后不强杀、不绕过取消。
3. 发布继续暂停；不从自动目标恢复 prepare/submit。此前发送和关闭浏览器已有明确授权，不再错误记录为从未授权。
4. 新代码接入后执行定向行为测试和全仓回归；自然休眠、账号切换、完整缺口恢复与真实发布仍须独立证据。
5. 完成 PR review 和合并前不进入 done。Orca 未运行，阶段同步失败。

## 历史失败归因与关闭情况

早期五项滑块测试失败已查明为 DOM 替身缺少 getBoundingClientRect，并已修复、通过回归，不再列为当前代码失败。该修复不证明真实平台滑块自动通过。保留风控停止与人工验证边界。

会话标签缺陷已修复并真实验证：同标签关联、错误标签隔离、重启持久化与分页通过，详见 `behavior-e2e-results.md`。历史失败报告只用于追溯，不覆盖最新通过报告。
