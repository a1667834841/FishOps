# Issue #36：采集详情筛选验收

## 任务与范围

- Issue：https://github.com/a1667834841/FishOps/issues/36。
- 认领评论：https://github.com/a1667834841/FishOps/issues/36#issuecomment-6029302818。认领前 Issue 为 OPEN，无负责人、无认领评论、无关联 PR；提交前再次核对，未发现重复 PR。
- 当前 worktree：`/Users/wuwenjing/orca/workspaces/FishOps-Workbench/auto-issue-pr-run-23-20261007T0200`，直接复用自动化创建的独立目录。
- 分支：`fix/issue-36-capture-detail-filter`。
- 实现与回归 Commit：`0d3829b`；证据文档通过后续文档提交交付。
- 基线：fetch 后的 `origin/main`，Commit `2aa4b99a2cc37b3fdbf0f97e5fc6bd2b223f0bc8`；主分支未修改。
- 分级：B。仅修改既有控制器中详情补全后的局部筛选逻辑，无协议、存储结构、页面、初始化或集成变更。
- 规范：仓库已无 `docs/development-testing.md`，采用现行 `docs/workflow/test.md` 和 `docs/regression-testing.md` 的分类与交付检查。

## 根因与筛选语义

控制器先按列表值筛选，增加 valid、登记去重标记，再请求详情。详情可以覆盖 wantCnt，随后直接入库并形成快照；同步按快照读取，因此不合格值贯穿整个下游。

保留列表预筛选契约：列表值不符合条件时，不请求详情，即使详情可能高于阈值也不纳入本轮。此行为以测试固定，不扩大详情请求数量。列表通过后，在可选详情阶段结束时再次应用同一筛选；详情缺字段或请求失败时仍按保留的列表字段判断。筛除商品同时减少 valid、增加 filtered、撤销本轮候选去重标记，再进入归属标记和入库流程。不会清理历史商品或旧任务数据。

## 验收动作与结果

均使用真实 CaptureController、TaskManager、MemoryTaskStore 和 MemoryProductRepository，平台请求及飞书同步替换为 Mock；不产生真实网络写入。

| 动作 | 任务状态与结果 | 副作用 |
| --- | --- | --- |
| 列表 10、详情 1、下限 5 | completed；fetched=1、filtered=1、valid=stored=0 | 商品、快照、storedIds、capturedRecords、同步入参均为空 |
| 详情高于或等于下限 | completed；filtered=0、valid=stored=1 | 商品和同步快照使用最终详情值 |
| 详情缺 wantCnt | completed；valid=stored=1 | 保留列表值 10 |
| 详情请求失败 | completed；failed=detailFailed=1、valid=stored=1 | 保留列表值，不吞失败统计 |
| 未启用详情 | completed；valid=stored=1 | 不请求详情，按列表值入库和同步 |
| 列表 1、详情可返回 10、下限 5 | completed；filtered=1、valid=stored=0 | 不请求详情，无入库及同步商品 |
| 同商品跨三页：首轮详情 1，第二轮 6，第三轮重复 | completed；fetched=3、filtered=1、valid=stored=1、duplicates=1 | 两次详情请求，一个合格快照，同步值为 6；筛除不会阻止再次采集 |

## 检查记录

全部命令在本 worktree 根目录执行，业务代码最终修改后未再变更。

- 失败回归：控制器共 41 条，其中 39 通过、2 个 Bug 回归失败；分别为详情低于阈值仍 valid=1，以及筛除后后续页未重新采集。日志：`.task-evidence/issue-36/before.log`，退出码 1。此前编写测试时误用了仓储查询接口，核对实际接口后修正两次；最终失败记录只包含上述 Bug。
- 修复后定向检查：`node --import ./extension/src/capture/test/register.mjs --test extension/src/capture/test/controller.test.ts`，41/41 通过，新增 8 条。退出码 0，日志：`.task-evidence/issue-36/after.log`。
- 首次 `npm run regression` 失败：工作区未安装依赖；测试缺 vue，typecheck 缺 tsc，构建缺 vite。报告：`.regression/2026-10-07T02-03-17-540Z-27748/report.json`，退出码 1。未把失败或被阻断的检查计为通过。
- 调整方案：执行 `npm ci`，按锁文件安装 56 个包，退出码 0，日志：`.task-evidence/issue-36/install.log`；未修改依赖声明或锁文件。
- 最终交付回归：`npm run regression`，退出码 0，报告 `.regression/2026-10-07T02-04-04-041Z-29623/report.json`；入口日志 `.task-evidence/issue-36/regression-final.log`，各检查日志在报告同目录。报告记录基线 Commit 且 dirty=true，因为当时最终业务改动尚未提交；测试内容与 `0d3829b` 一致，之后仅补证据文档，无源码变化。

| 检查 | 退出码与结论 |
| --- | --- |
| `npm test` | 0；task 26、background 160、platform 116、chat 317、capture 100、analysis 127、publish 282、workbench 401、agent 7、regression 编排 4，全部通过 |
| `npm run typecheck` | 0；三个工作包全部通过 |
| `npm run build` | 0；扩展和工作台实际产物生成成功 |
| `npm run test:security` | 0；通过 |
| `npm run test:smoke` | 0；通过 |
| `npm run test:capture:smoke` | 0；通过 |
| `npm run test:sw-startup` | 0；通过 |
| `git diff --check` | 0；通过 |

自查覆盖 Issue 的全部验收项、列表预筛选语义、详情失败回退、去重释放、统计与快照一致性。仅提交控制器、对应回归测试和本证据，无本地配置、凭据、依赖或无关重构。

## 会话与验证边界

本次终端 handle 为 `term_1cf93b33-0374-4f91-a230-dd5e9ea23adb`。先按当前 worktree 列出终端，再读取屏幕核对本次请求，调用 `orca terminal switch --terminal <handle> --json`，返回 navigated=true。没有操作其他任务终端，没有关闭本次终端或清除会话。

本次 Codex 会话 ID：`01a11417-9281-7680-8ff0-af87f5e8d194`。执行对话副本保存在当前目录 `.task-evidence/issue-36/conversation.jsonl.local`，认领正文为 `claim.md.local`，均仅本地保留，不提交 GitHub；可在当前 Orca 终端继续对话。

按 B 类规范执行模块回归和本地交付检查，未执行真实 Chrome/飞书 E2E、真实采集或外部写入；Mock 同步只证明最终输入集合一致。真实平台列表与详情差异频率仍未验证。CI 状态以 GitHub 实际执行为准。PR 创建后保持 pr review，等待人工 Review，不自动 Merge，不进入 done。

## 真实 Chrome / 飞书补充验收（2026-10-07）

用户追加要求真实 E2E，并授权恢复及在原空间不存在后新建测试空间。最终在空间 354 串行完成部署、页面、真实接口、采集及远端回读。源码仍为 `0d3829b`，部署来源为本 worktree 的 `a8fc255`，没有业务代码变化；此前「未执行真实 E2E」描述仅适用于首次交付阶段，本节为最新验证结论。

`npm run agent:setup` 在本工作区构建、同步固定目录、重载和导入配置成功，包含 `SETUP_COMPLETED`。已读取真实运行中任务检查，无任务才部署。测试扩展入口为 `chrome-extension://lnkgjbkfdimiloglccfmeefcclfgifbo/workbench.html`，闲鱼页面已登录。AI、飞书配置存在，自动回复关闭。

自动编排最初受旧配置空间及部署脚本结束空间后标签未重新接入影响，保留失败结果，未将入口失败标为通过。依据已有恢复授权在同一空间接回真实工作台标签，执行原 `scripts/regression-browser.mjs` 检查逻辑，仅延后空间结束动作供业务专项继续；13 项全部通过：4 个真实读取命令、7 个页面导航、设置页真实 AI 接口和飞书 Schema 连接。

| 真实动作 | 实际结果 | 写入与验证边界 |
| --- | --- | --- |
| 页面创建「手机」，1 页、10 条、最低想要数 5、采集详情 | completed，fetched=10、filtered=4、valid=stored=6、detailFailed=6；飞书 createdCount=6 | 详情被闲鱼滑块阻断，保留列表值；6 条飞书回读与本地原观测一致，不能证明详情成功 |
| 用户处理滑块后，真实详情 API 检查 | SUCCESS，真实商品 wantCnt=6 | 未修改或伪造平台响应 |
| 页面再次创建相同「手机」条件 | completed，fetched=10、filtered=4、valid=stored=6、detailFailed=failed=0；飞书 createdCount=0、skippedCount=6 | 6 次详情成功；同小时按商品和关键词去重，飞书保留首次观测。重复操作不产生远端重复行，不能声称本轮详情值覆盖旧行 |
| 页面创建「荣耀Magic8」，1 页、5 条、最低想要数 1、采集详情 | completed，fetched=valid=stored=5、filtered=detailFailed=failed=0；飞书 createdCount=5、skippedCount=0 | 5 次详情成功并首次同步；真实飞书查询回读 5 条，商品 ID、采集时间、关键词、想要数逐条与本地一致 |
| 再次进入商品库、返回采集页 | 页面加载通过；读取运行中任务数为 0 | 最后结束测试空间 354，保留 Orca 执行会话 |

最后一轮真实想要数为 2、1、3、16、3，全部 >=1，包含等于阈值的 1。checkpoint 的 storedIds、capturedRecords 均为 5。匹配真实飞书结果按商品 ID 和本次原始采集时间完成，`hasMore=false`，未用 Mock、注入数据或 fixture 替代。

本轮副作用：创建 3 个采集任务、保存对应本地观测，真实飞书新增 11 条采集记录，重复轮跳过 6 条。保留验收数据，不删除，不发布商品，不发送消息。测试账号授权沿用 `docs/workflow/test-authorization.md`。验证码由用户处理；记录未包含凭据、聊天或商品描述。

可覆盖的真实 Chrome/飞书基线、正常详情采集、等阈值保留、列表筛选、详情失败回退、重复同步去重和首次同步回读均通过。**真实数据没有出现列表通过但详情低于阈值的组合，也没有覆盖详情缺字段及跨页去重释放边界；这些由 8 条新增模块回归覆盖，不称为真实验证。** 同小时远端去重保留首次观测为现有语义，本次未扩大范围修改。

详细本地证据均在本 worktree：

- `.regression/2026-10-07T13-48-13-398Z-78071/setup.log`：实际构建、部署和完成标记；同目录 report.json 保留编排失败。
- `.task-evidence/issue-36/real-checks-354.log`：13 项真实基线逐项结果。
- `.task-evidence/issue-36/capture-final.json.local`、`feishu-readback.json.local`：首次列表降级入库与飞书回读。
- `.task-evidence/issue-36/capture-detail-success.json.local`：详情成功及重复同步跳过，新的采集时间在飞书没有新增观测，非回读失败。
- `.task-evidence/issue-36/capture-fresh-detail.json.local`：5 条首次详情写入及逐条一致回读。
- `.task-evidence/issue-36/conversation.jsonl.local`：本工作区执行对话副本。

CI 在追加文档前已通过；补充验收提交只修改文档，源码与实际测试版本一致，复用此前本地全量回归、定向测试和真实部署结果。PR 更新后继续等待人工 Review，不自动 Merge。
