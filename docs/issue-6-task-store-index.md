# Issue #6：任务存储索引一致性修复证据

## 修复范围与运行入口

修改 `shared/task/task-store.ts` 的 `AdapterTaskStore`：对每个底层存储区域对象和前缀维护进程内 Promise 队列，串行化 `save`、`saveBatch`、`delete`、`clear`、`list`。Chrome Session/Local adapter 暴露底层 `StorageArea` 对象身份，因此分别构造的包装 adapter 仍共享队列。队列拒绝会被消费为后续操作的起点；当前调用仍原样 reject。

`list` 合并索引与 `${prefix}:task:` 实体键扫描结果，按实体修复索引并保留有效实体顺序、去重。`clear` 按前缀扫描实体键，避免索引遗漏时孤儿实体残留。更新已有任务不额外写索引。

实际装配点：`extension/src/background/index.ts` 调用 `createPersistentTaskStore('fishops.publish')`，使用 `chrome.storage.local`；常规 `TaskManager` 默认调用 `createDefaultTaskStore()`，扩展环境使用 session adapter。运行入口仍为现有扩展 Vite build 输出 `extension/dist`，工作台产物也写入该目录。

## 场景与证据

- 用户动作：同一 store 用 `Promise.all` 写入两个任务 → 状态变化：两实体及两个 ID 均保留 → 可见页面/组件：store `list()` 返回完整集合 → 副作用：先直接读取原始 `concurrent:task_index` 并检查两个实体键，再调用 list，避免 list 自愈掩盖覆盖缺陷。测试：`AdapterTaskStore 并发写入保持索引一致并按实体键自愈`。
- 用户动作：同一 `StorageArea` 分别包装为两个 Chrome Local adapter/store 并发保存 → 先断言原始索引含两个 ID 且两实体键存在，再检查 list；另覆盖同一 adapter 多 store、Chrome Session 不同 wrapper 同区域。使用另一前缀或另一存储区域写入不串扰。测试：`AdapterTaskStore 的同 StorageArea 多实例共用索引协调且错误后队列可继续`。
- 用户动作：直接遗留一个未入索引的实体键后列举 → 状态变化：实体被发现且索引自愈 → 列表展示孤儿对应任务 → 不丢历史实体。由上述并发写入测试覆盖。
- 用户动作：批量保存含重复 ID，再次更新已存在 ID → 列表仍仅一份且保留索引顺序；已有任务 save 不触发索引写。测试：上述多实例测试中的顺序与索引写计数断言。立即调用 `save`/`saveBatch` 后修改输入，再等待 Promise，验证持久值与任务 ID、实体键和索引均保持调用时快照；该新增测试修复前失败、修复后通过。
- 用户动作：分别按 save 后 clear、clear 后 save 顺序操作，并发 clear/save；确认确定的先后结果。清理时同时验证孤儿任务实体被删除，其他前缀实体和同前缀非任务键保留。覆盖 save→clear、clear→save、delete→save 同 ID、save→delete 同 ID；同适配器多个 store 也共享队列。测试：上述多实例测试。
- 用户动作：索引写入 mock 一次失败，观察该操作 reject 后继续 save → 原错误 `index failed` 如实传播，后续操作继续且 list 通过实体扫描找回前次已写入任务。测试：上述多实例测试。

## 红灯/绿灯与命令结果

- 红灯先行：初次并发索引回归在修复前运行时，9 项中 7 通过、2 失败；两失败均实际列表只含 `2`，预期包含 `1`,`2`，复现索引读改写丢失更新。后续增加调用时输入快照回归，在修复快照捕获之前该测试失败（实际 payload 为 `after`，预期 `before`），证明调用入参异步读取的语义回归；修复后定向测试通过。
- 依赖安装：`npm ci` 退出码 0，56 个包安装完成。日志：`/tmp/issue6-npm-ci.log`。
- 定向绿灯：`node --test shared/task/task.test.ts` 最终 10/10 通过，命令退出码 0。日志：`/tmp/issue6-task-parent.log`。
- 仓库测试脚本：`npm test` 退出码 0。各 suite：background 139/139、platform 116/116、chat 306/306、capture 92/92、analysis 115/115、publish 274/274、workbench 384/384；suite 测试可能重复计数，合计各 suite 执行数 1426，不能称为全仓唯一测试数。最终修改后重跑通过，日志：`/tmp/issue6-test-parent.log`。
- 全仓类型检查：`npm run typecheck` 退出码 0，shared、extension、workbench 均完成。日志：`/tmp/issue6-typecheck-parent.log`。
- 全仓构建：`npm run build` 退出码 0，Extension 与 Workbench 构建完成，产物在 `extension/dist`。日志：`/tmp/issue6-build-parent.log`。
- 差异格式：`git diff --check` 退出码 0。

任务测试没有被仓库默认 `npm test` 纳入，因此确认并单独执行入口：`node --test shared/task/task.test.ts`。注：`shared/package.json` 的 `typecheck` tsconfig 仅 include `events`，独立 task 测试由 Node 执行；全仓测试命令本身也不包含该文件。

## 边界与未验证范围

队列是当前 JavaScript realm 内的内存协调，不承诺跨 worker、跨 realm 或多个扩展上下文的全局互斥；代码通过 `extension/src/background/index.ts` 的 service-worker 内装配使用，未发现该存储由多个 realm 共享写入的调用路径。该局部方案不引入跨 realm 锁或更换持久化模型。

使用 mock StorageArea，不做真实 Chrome 扩展运行验收；浏览器实际装载待用户验证。修改后应重新运行 `npm run build`，然后重载已安装的扩展并刷新/重开工作台页面，以确保 Chrome 加载 `extension/dist` 新产物。未验证跨 realm 并发，也未验证真实 Chrome StorageArea 运行时行为。
