# Issue 19 修复：自营发布候选与创建同源（商品目录 my_published）

- Issue：[#19 [Bug] 发布：自营候选与商品目录数据源不一致导致无法创建任务](https://github.com/a1667834841/FishOps/issues/19)
- worktree：`/Users/wuwenjing/orca/workspaces/FishOps-Workbench/fix-issue-19-publish-catalog`
- 分支：`a1667834841/fix-issue-19-publish-catalog`，基线 HEAD `17f9b52`（不含尚未合并的 PR #10 / Issue #6 修复）。主代理复核 `git merge-base --is-ancestor 5a7c8b32629226c9cc520a5b743e5eaf84ff640d HEAD` 返回 1；此前派工误称已包含该修复。
- 真实环境：Workbench v0.9.1，Ego Chromium，Bridge 已连接，测试账号已登录

## 1. 根因

发布页的自营候选来自本地商品库 `PRODUCT_LIST({source:'my_published'})`，发布创建
`PUBLISH_CREATE` → `PublishController.preparePublishItem` 同样只查本地 `ProductRepository`；
而当前账号真实在售商品只能经官方只读目录 `PRODUCT_CATALOG_QUERY({source:'my_published'})`
读取（会话内存快照，不写入本地库）。两条读取路径来源不一致，本地库为空时：

- 发布页候选 0 件（真实 9 件在售）；
- 即使拿到合法 itemId，`preparePublishItem` 也查不到商品，无法创建任务。

本项目不存在「把目录快照写进本地商品库」的受支持同步入口，因此不能靠持久化补齐，
只能让候选与创建都使用同一来源契约（官方只读目录），并保留原本地库发布路径。

## 2. 实现（最小改动）

| 文件 | 改动 |
| --- | --- |
| `shared/data-source/catalog-product-mapping.ts`（新增） | `mapCatalogProductToProduct(CatalogProduct): Product \| null`：仅映射 `my_published` 且 itemId 非空的条目；缺图片/描述保留空值，绝不伪造；不写本地库 |
| `shared/capture/normalizer.ts` | 本地时间格式化导出为 `formatProductTime`（供映射复用，行为不变） |
| `shared/types/publish.ts` | 新增错误码 `PRODUCT_SOURCE_UNAVAILABLE`（目录读取失败，区别于 `PRODUCT_NOT_FOUND`） |
| `extension/src/background/product-catalog-runtime.ts` | 新增只读方法 `resolveMyPublishedItem(itemId)`：复用会话快照按 itemId 精确匹配；未命中返回 null；未登录 / 切号 / 平台失败抛 `PlatformError`，绝不降级为空 |
| `extension/src/publish/controller.ts` | `preparePublishItem` 先查本地库（原行为），未命中时经注入的 `OwnedProductFallback` 只读解析；目录读取失败 → `PRODUCT_SOURCE_UNAVAILABLE`；仍强制 `source === 'my_published'` |
| `extension/src/background/publish-runtime.ts` | 依赖新增 `ownedProducts`，注入 `PublishController` |
| `extension/src/background/index.ts` | 接线：`ownedProducts.resolve = getProductCatalogRuntime().resolveMyPublishedItem + mapCatalogProductToProduct` |
| `workbench/src/features/publish/publish-controller.ts` | `loadProducts()` 合并本地库（`PRODUCT_LIST`）与官方目录（`PRODUCT_CATALOG_QUERY`，分页读至读完或 5 页上限）；本地记录优先、按 itemId 去重；加载 / 空结果 / 读取失败可区分 |
| `workbench/src/pages/PublishPage.vue` | 单来源失败显示非阻断告警 + 目录 warnings；真实空结果显示空候选提示；两源都失败仍为 error 回退态 |
| `workbench/src/features/contracts.ts` | 导出 `mapCatalogProductToProduct`（沿用工作台唯一契约出口） |

边界（硬性，全部保持）：

- 只读：目录解析绝不写入本地商品库、不直写 storage、不做隐式全量同步；
- 创建时由**后台重新解析**商品，绝不接受客户端传入的商品数据（不绕过来源校验）；
- 图片 / 描述 / 价格来自真实平台数据，不伪造；缺失字段保留空值，由现有发布规则校验。缺图片候选拒绝创建，未补齐描述的候选不代表完整详情已验证。

## 3. 失败回归（红）与修复后（绿）

红：临时 `git stash` 掉 6 个实现文件（保留新增测试与新映射模块）后运行新增用例，
针对修复行为的 19 条新用例中 **15 条失败**（另 4 条为旧路径保护用例，两态均通过）：

- `extension/src/publish/test/controller.test.ts`：5 条失败（回退未接线 → `PRODUCT_NOT_FOUND`）；
- `extension/src/background/__tests__/product-catalog-runtime.test.ts`：4 条失败（`runtime.resolveMyPublishedItem is not a function`）；
- `extension/src/publish/test/publish-runtime.test.ts`：2 条失败（无回退 → 创建被拒）；
- `workbench/src/features/publish/test/publish-controller.test.ts`：4 条失败（目录候选未读取）。

绿（当前代码）：

```sh
npm run typecheck                     # 退出码 0（shared / extension / workbench）
npm test                              # 退出码 0，8 组 1460 条全部通过
npm run build                         # 退出码 0，extension/dist + workbench/dist 生成
npm run agent:setup                   # 退出码 0，输出 SETUP_COMPLETED
```

新增 / 补充用例共 24 条（均以 `Issue19:` 命名）：

- `catalog-product-mapping.test.ts`（新增，5 条）：字段保真、多图与封面回填、空值不伪造、飞书与脏条目返回 null、详情地址回填；
- `controller.test.ts`（+6 条）：目录回退成功且不写本地库、本地命中优先（旧采集本地发布路径保留）、两源均未命中 → `PRODUCT_NOT_FOUND`、非 `my_published` 拒绝、目录读取失败 → `PRODUCT_SOURCE_UNAVAILABLE`（可重试）、缺图片候选不误创建；
- `product-catalog-runtime.test.ts`（+4 条）：会话快照复用命中 / 未命中、空 itemId 不读平台、切号后旧 itemId 不再命中、未登录 / 读取失败抛错不降级；
- `publish-runtime.test.ts`（+2 条）：真实运行时 `PUBLISH_CREATE` 经目录回退创建任务（不写本地库）、目录读取失败结构化拒绝且不创建任务；
- `publish-controller.test.ts`（+7 条）：候选合并本地库与目录、同 itemId 本地优先、真实空结果区别于失败、单来源失败保留候选并暴露错误、两源失败为 error、飞书 / 脏条目不混入、目录 warnings 透出。

## 4. 真实环境验收（当前代码已部署）

部署：本次 E2E 前在 worktree 根执行 `npm run agent:setup`，退出码 0 且输出 `SETUP_COMPLETED`；
固定目录 `~/.fishops/agent-extension` 构建标记指向本 worktree 与 `17f9b52a`（`builtAt 2026-10-06T08:33:12Z`），
`PublishPage-B1VDnOII.js` 与本次 build 产物一致；浏览器仅加载该固定目录实例
（`lnkgjbkfdimiloglccfmeefcclfgifbo`，ENABLED）。未读取或输出 token / cookie / 配置密钥。

### 4.1 通过：候选加载与创建契约

- `PRODUCT_CATALOG_QUERY({source:'my_published'})` 官方只读返回 9 件真实在售商品，`ok:true`；
  9 件均有封面图（`images>=1`），5 件在预算内补齐描述 / 卖家地区，4 件超出 8s 详情预算并如实给出
  warning「本次已跳过 4 件商品的详情补齐（超出预算），可稍后刷新重试」；
- `PRODUCT_LIST({source:'my_published'})` 本地库仍为 0 件（未改动其语义）；
- 发布页显示「显式选择自营商品：(共 9 件候选)」，候选来自官方目录并可显式选择（不自动偷选）；
  截图：[issue-19-publish-candidates.png](images/issue-19-publish-candidates.png)；
- 正常创建（真实运行时，非 mock）：`PUBLISH_CREATE` 单次 15 ms 创建成功，`meta.sourceProductSnapshot`
  标题 30 字符、价格 `8300`，与目录条目一致 → 证明创建读取的是同一官方目录来源；
- 双并发：两个 `PUBLISH_CREATE` 并发发起，均成功（3 ms / 7 ms，价格 `3200` / `2530`），
  创建后本地商品库仍为 0 件（只读、未落库）；
- 任务列表与刷新持久性：UI「发布任务历史」显示「共 2 条任务」，整页 reload 后重新进入发布页仍为 2 条（`chrome.storage.local` 持久化）；
  截图：[issue-19-publish-tasks.png](images/issue-19-publish-tasks.png)。

### 4.2 未通过 / 未完成：真实发布（0 件）

用户授权本轮最多真实发布 1 件。唯一正常 UI 提交路径为「安全核对并发布当前商品」→ 两阶段直接发布
（prepare → 人工核对 → submit）。prepare 在**商品详情读取阶段**稳定失败，本轮共 3 次尝试全部失败，
未执行任何 submit，本轮真实发布 0 件（此前 0 件）：

| 尝试 | 入口 | 结果 |
| --- | --- | --- |
| 1 | UI 首次 prepare（itemId `…59088`） | `准备发布未完成：…：接口超时`，失败阶段「商品详情读取阶段」，错误码 `TIMEOUT` |
| 2 | UI「重新准备发布」 | 同上（错误码 `TIMEOUT`，附带 `缺失字段：source`） |
| 3 | 直接调用真实后台 `getProduct`（只读）探针 | 3 个不同真实 itemId 全部失败：`20587 ms / 20815 ms / 21000 ms` → `ok:false`、`status:'unknown'`、`code:'TIMEOUT'`、`message:'接口超时'`、`product:null` |

根因证据与边界：

- 观测点在 `extension/src/background/direct-publish-page.ts:537`：注入请求失败且耗时 ≥ 20 s 时把 code 记为
  `TIMEOUT`；三个不同商品耗时几乎一致（≈20.6–21.0 s）。已确认该读取路径连续超时，具体根因待确认，
  不能仅凭耗时断言是平台故障或排除商品数据问题；
- 同一批商品的详情经商品目录路径（`PlatformMethods.DETAIL`，goofish 页面 MAIN world）读取**成功**
  （5 件补齐描述与卖家地区），说明账号登录与会话本身有效；
- 历史文档 `docs/direct-publish-api-real-test.md` 记录该 API 于 2026-10-04 发布成功；本次未直接修改
  `direct-publish-api.ts` / `direct-publish-page.ts`。这些事实不能单独排除本轮改动的间接影响；
  未完成基线对照，因此超时是否为既有故障仍待确认；
- UI 未返回可核对草稿，故未进行任何图片上传 / 提交；失败证据截图：
  [issue-19-publish-prepare-timeout.png](images/issue-19-publish-prepare-timeout.png)。

结论：本轮「有真实自营商品时可选并创建任务」已取得真实运行证据；并发列表完整性未通过，详见下节。
「真实发布 1 件」受直接发布详情读取超时阻塞，具体原因待确认。按重试规则停止，当前不 Commit、Push 或创建 PR，
等待人工决策。用户随后明确授权提交 PR，按当前真实验证边界交付并等待人工 Review，不宣称完整发布验收通过；不通过换用非 UI 入口或伪造数据绕过（进入 `source.product` 入口可跳过
商品详情读取，但会绕过 UI 的人工图片核对，本轮不采用）。

### 4.3 观察到的既有缺陷（不在本 Issue 范围，未修复）

双并发创建 2 个发布任务时，原始存储出现 **1 个实体未进入索引**：

- `chrome.storage.local`：实体键 3 个（`fishops.publish:task:publish_…2543ed`、`…f84685`、`…684a8a`），
  索引 `fishops.publish:task_index` 只有 2 个（缺 `…f84685`）；
- `PUBLISH_LIST` 与 UI 均只返回 2 条；等待后再次读取仍为 2 条（未见自愈）；
- 代码位置：`shared/task/task-store.ts` `AdapterTaskStore.save()` 对索引键做「读-改-写」非原子操作，
  并发保存会互相覆盖；`list()` 只按索引读取，不会从实体键重建。
- 该行为属于 Issue 6 的任务索引范围，本次不扩大范围修复，仅记录证据。

## 5. 残留与副作用（本轮真实操作）

- 新增发布任务 3 个（实体 3 / 索引 2），均为 `pending`（待准备），**未执行任何填表与提交**：
  `…2543ed`（itemId `…59088`）、`…f84685`（itemId `…85252`，未进索引）、`…684a8a`（itemId `…78907`）；
- 未取消 / 未删除任何既有商品任务，未发送任何消息，未做飞书远程写入，未触发无关采集或 LLM 调用；
- 直接发布：0 件创建、0 件提交、0 件上架；无残留 draft（prepare 失败未产生草稿），jobs 列表为空；
- 固定扩展目录在部署前已备份：`/tmp/issue19-extension-backup/agent-extension-20261006T083300Z`
  （恢复 = 覆盖回 `~/.fishops/agent-extension` 后重新 `npm run agent:setup`）。

## 6. 截图说明

三张截图均来自上述真实 Workbench 会话（TaskSpace 278），仅裁剪到发布中心相关区域，
不含账号标识、token、cookie 或配置密钥；截图中的商品标题 / 价格为测试账号自身在售商品真实数据，
未替换、未伪造。
