# 聊天中心 P5 真实接线报告

> 范围：仅 `workbench/**` 与本文档。未改动 `background` / `shared` / `capture` / 根 lock / 根 `package.json`。
> 状态：代码、类型检查、构建、Node 单测已通过；**真实浏览器验证尚未进行**（由主代理统一做）。

## 1. 做了什么

`ChatCenterPage` 由「布局预览」改为读取真实 P5 数据，保留原有三栏结构、主题变量、响应式断点与键盘/读屏支持。

| 区域 | 数据来源 | 说明 |
|---|---|---|
| 顶部状态条 | `CHAT_STATUS`、`CHAT_SOCKET_STATUS` 事件 | 实时连接状态 + 本地缓存的会话/消息计数 |
| 会话列表 | `CHAT_LIST_CONVERSATIONS` | 按 store 返回顺序展示，未读数、最近消息时间 |
| 消息记录 | `CHAT_GET_MESSAGES`（`order: 'asc'`） | 仅展示属于当前选中会话的数据 |
| 买家与商品 | 会话字段 + 该会话消息 | 见 §3，缺失字段如实显示「未知 / 无」 |
| 同步会话 | `CHAT_SYNC_CONVERSATIONS` | **仅显式按钮触发** |
| 同步历史 | `CHAT_SYNC_HISTORY` | **仅显式按钮触发**，需先选中会话 |
| 实时更新 | `CHAT_MESSAGE_INGESTED` / `CHAT_CONVERSATION_UPDATED` / `CHAT_SYNC_COMPLETED` / `WORKER_STARTED` | 只当「有变化」信号，重新读 store |

### 页面状态

- **未在扩展内页**（`chrome.runtime.id` 不存在）：整页显示「需要在扩展中打开工作台」，不创建 Bridge、不发请求、不展示任何数据。
- **加载**：骨架 + `role="status"` 文案。
- **错误**：`role="alert"` + 重试；已有数据时刷新失败则保留旧数据并附错误提示。
- **空**：会话为空 / 会话无消息各有独立说明，指引显式同步。
- **同步结果**：运行中 / 成功（新增、更新数）/ 失败（`result.ok === false` 与抛异常均显示失败原因）。

### 只读约束

- 输入框与「发送」按钮 `disabled`，并有可见说明：发送属 P6，尚未实现；不发消息、不调用 AI。
- 控制器只会调用 5 条只读 CHAT 命令（有单测断言）。

## 2. 架构

```
ChatCenterPage.vue          展示
  └─ composables/useChatCenter.ts      Vue 适配：创建/释放 RuntimeClient、前台恢复订阅
       └─ features/chat/chat-center-controller.ts   纯 TS 状态机（可 Node 测试）
            └─ features/chat/chat-format.ts         纯函数：格式化、HTTPS 校验、商品/买家推导
```

控制器依赖最小接口 `ChatCenterApi { call, on, resubscribe }`，生产由 `RuntimeClient` 适配，测试用 mock。

### 并发与生命周期

| 风险 | 处理 |
|---|---|
| 异步切会话后旧响应覆盖新会话 | 每类请求递增令牌 + 校验 `selectedId`；成功与失败分支都丢弃旧响应；页面另按 `messages.sessionId === selectedId` 过滤渲染 |
| 刷新后重复订阅 | `start()` 幂等且只注册一次；「刷新本地缓存」只重新查询，不碰订阅 |
| 卸载泄漏 | `dispose()` 释放全部事件订阅、取消防抖定时器；composable 再 `client.dispose()` 关闭事件 Port；释放后在途响应不再写状态 |
| 事件风暴 | 300ms 防抖合并为一次重读 |
| STATUS 响应晚于 SOCKET_STATUS 事件 | 事件序号保护，保留事件值 |
| 重复点击同步 | 同类同步进行中直接忽略 |
| 同步结果串号 | 历史同步结果带 `sessionId`，仅在其会话下展示 |
| 同步分页耗时 > 默认 8s | 本页 Bridge 超时放宽到 30s |
| service worker 回收后 Port 断开 | 页面回到前台时 `subscribe` 重新声明；重连时 background 补发 `WORKER_STARTED`，触发重读 |

### 日志与正文

控制器与页面**不输出任何 `console` 日志**；事件负载不被读取、不保存（单测注入含「机密正文」的事件负载，断言状态序列化后不含该文本）。

## 3. 关联商品与链接安全

P5 真实结果里没有商品详情，只有 `Conversation.itemId` 与 `ChatMessage.itemId / itemTitle`（后者仅历史同步可能带）：

- `itemId`：优先取会话字段，其次取最新带 itemId 的消息；
- 标题：仅当存在 itemId 匹配的消息带 `itemTitle` 时才显示，否则不显示；价格/图片等一律不展示，并有「扩展目前只提供商品 ID」提示；
- 链接：`itemId` 须匹配 `^[A-Za-z0-9_-]{1,64}$`，生成 `https://www.goofish.com/item?id=<id>`（与仓库 `shared/capture/normalizer.ts` 一致），再经 `safeHttpsUrl` 校验（仅 https、拒绝账号密码）；不合法只显示 ID 文本；
- 图片消息：仅当 `imageUrl` 通过 https 校验时显示「在新标签页查看图片」链接，**不内联加载第三方图片**；
- 所有外链 `target="_blank" rel="noopener noreferrer"`；所有文本走插值转义，无 `v-html`。

## 4. 文件清单

新增：

- `workbench/src/features/chat/types.ts`
- `workbench/src/features/chat/chat-format.ts`
- `workbench/src/features/chat/chat-center-controller.ts`
- `workbench/src/composables/useChatCenter.ts`
- `workbench/src/features/chat/test/register.mjs`
- `workbench/src/features/chat/test/resolve-hook.mjs`
- `workbench/src/features/chat/test/chat-center-controller.test.ts`
- `workbench/src/features/chat/test/chat-format.test.ts`
- `docs/chat-ui-report.md`

修改：

- `workbench/src/pages/ChatCenterPage.vue`（替换占位）
- `workbench/package.json`（仅新增 `test` 脚本，无新依赖）

## 5. 验证结果（实际运行）

| 命令（在 `workbench/` 下） | 结果 |
|---|---|
| `npm test` | 35 项全部通过（控制器 25 + 格式化 10），0 失败 |
| `npm run typecheck`（`vue-tsc --noEmit`） | 通过，无输出错误 |
| `npm run build`（`vite build`） | 通过，73 modules；产物写入 `extension/dist`（`emptyOutDir: false`，仅追加） |

未执行：根 `npm run build` / `clean`、根级 `test:chat` / `test:security`、真实浏览器验证。

## 6. 风险与待验证项

1. **未做真实浏览器验证**：Vue 渲染、样式（深浅色、窄屏）、可访问性（焦点、读屏）、真实 Bridge 往返均未在浏览器确认。SFC 仅经类型检查与构建；无组件级自动化测试（无新依赖约束下未引入 DOM 测试环境）。
2. **Port 无自动重连**：`ChromeRuntimeTransport` 在 Port 断开后不主动重连（该包在写集之外，未改）。当前靠「回到前台重新订阅」+「`WORKER_STARTED` 补发」缓解；页面一直可见且 worker 被回收时，实时更新可能暂停，需手动点「刷新本地缓存」。
3. **同步依赖已打开并登录的闲鱼页面**：否则 `result.ok=false` 或命令报错，页面会显示后端返回的 code/message，具体文案以真实环境为准。
4. **本地缓存为 `chrome.storage.session`**：关闭浏览器后清空，重新打开会显示「本地还没有会话」，属预期，需点同步。
5. **客户端超时不取消后台同步**：30s 超时只终止等待，后台可能仍在写入；之后的 `CHAT_SYNC_COMPLETED` 事件会触发重读，但页面不会补显这次同步的失败原因（事件负载的 `error` 目前未展示）。
6. **会话排序**依赖 store（`sortIndex` 再 `lastMessageTime` 倒序），页面不二次排序。
7. **商品链接格式**沿用仓库已有 `goofish.com/item?id=` 约定，未对真实 itemId 样本逐一验证；itemId 含非常规字符时只显示文本。
8. **`extension/dist` 累积旧哈希产物**：workbench 构建不清空输出目录，反复构建会留下旧 `assets/workbench-*.js`；根 `npm run build` 的 clean 会统一清理（本次按要求未执行）。
9. 消息列表一次取全量缓存（store 上限 500 条/会话数据量级），未做虚拟滚动。

## 7. 主代理浏览器验证建议清单

1. 以 `chrome-extension://<id>/workbench.html` 打开 → 聊天中心：状态条、会话列表加载。
2. 无闲鱼页面时点「同步会话」→ 应显示红色失败文案，不应显示「同步完成」。
3. 打开登录后的闲鱼 IM 页 → 同步会话 → 选会话 → 同步历史 → 消息出现。
4. 快速连续点击不同会话 → 右侧始终是最后点击的会话。
5. 在聊天中心与其他页面来回切换若干次，在 `chrome://extensions` 的 service worker 检查中确认事件 Port 数量不累积。
6. 深色模式、窄屏（<720px）、键盘 Tab 顺序、输入框/发送按钮禁用提示。
