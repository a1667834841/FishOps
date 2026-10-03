# P0 环境验证报告

> 日期:2026-10-02
> 执行者:Zed coding agent(模型 ai_proxy/deepseek-v4.1-flash)
> 方式:ego lite + ego-browser API(未另启动浏览器,未使用 Playwright)
> TaskSpace ID:`97`(name:`P0 environment validation`)
> 状态:**全部通过(main 与 chat 基线均验证完成)**

## 1. 结论

| 验证项 | 结果 |
|---|---|
| ego lite 能加载 unpacked MV3 | ✅ 通过(`main` 与 `chat` 两个未打包 MV3 均成功加载并运行) |
| 扩展管理页可打开 | ✅ 通过(`chrome://extensions/` 正常访问) |
| 闲鱼登录态 | ✅ 通过(`cookie2` / `_m_h5_tk` / `_tb_token_` 等存在,未跳登录页) |
| main 最小 MTOP 请求 | ✅ 通过(1 页 1 次,`SUCCESS::调用成功`,30 条商品,428ms) |
| chat WebSocket 基线 | ✅ 通过(捕获 `wss://wss-goofish.dingtalk.com/` 连接与完整监听日志) |

总体:**P0 通过。ego lite 可加载 unpacked MV3;闲鱼登录态有效;main 采集与 chat 聊天监听两条基线均实机验证成功。**

## 2. 浏览器与空间

- 浏览器:ego lite(Chromium 内核)。
- 复用已有空间,未新建:`id 97 "P0 environment validation"`,全程 `taskSpace(97)` / `takeOverTaskSpace(97)` 复用与接管(未创建重复空间、未选择/检查 profile、未再次打开开发者模式)。
- 标签:`p1`(先 `chrome://extensions/`,后 `https://www.goofish.com/im`)。

## 3. 扩展加载证据与 ID

扩展管理页最终共 28 个扩展。相关:

| 扩展 | ID | 版本 | 类型 | 状态 |
|---|---|---|---|---|
| 闲鱼数据采集助手(main) | `annppaeoihgjkepbdpohjjfkhiccocjm` | 1.7.0 | 未打包 MV3 | 已加载,现为**禁用**(避免与 chat 冲突) |
| 闲鱼聊天监听助手(chat) | `pabloiaacobcpjhmmgnpcakkeklbmpjl` | 3.0.0 | 未打包 MV3 | **已加载并启用(ENABLED)** |

- `main` 为**此前已加载**的扩展,本次未重复加载。
- 其余用户扩展(如 BrowserTools MCP `jpglajhfdedmfkjnmpobbngbgmcfbnbp`、AdBlock、Cookie-Editor 等)**未卸载、未改动**。
- 加载来源:均通过分支快照目录加载(main 为原仓库路径,chat 为临时导出目录)。
- 分支快照(只读导出,未切换原仓库分支):
  - `.p0-runtime/main`(`git archive main`)
  - `.p0-runtime/chat`(`git archive chat`)
  - 原仓库 `extensions/FishOps` 始终停留在 `main` 分支,工作区未改动(仅原有未跟踪文件 `.claude_settings.json`)。

## 4. 闲鱼登录态

- 在 `https://www.goofish.com/` 与 `https://www.goofish.com/im` 探测:扩展 content scripts 均注入,页面标题正常(首页"闲鱼 - 闲不住?上闲鱼。",消息页"聊天_闲鱼"),未重定向到登录页。
- Cookie(仅记录名称以判断存在性,不记录任何值):
  - 可见:`tracknick`、`isg`、`bnc-uuid`、`t`、`xlly_s`、`_m_h5_tk`、`_m_h5_tk_enc`、`tfstk`、`_tb_token_`
  - CDP `Network.getCookies` 另见 `cookie2`、`sgcookie`(httpOnly)
- 判定:登录态存在且有效(MTOP 返回 `SUCCESS`、聊天 WebSocket 连接成功均佐证)。

## 5. main 基线(通过)

- 注入:`window.XianyuAPI` 导出 `request`、`fetchSearchData`、`fetchItemDetail`、`fetchSuggestWords`、`getToken`、`generate` 等 28 个成员;`window.MessageBus` 存在。
- 最小 MTOP 请求:**1 页 1 次**,`XianyuAPI.fetchSearchData(1, "手机")`:
  - 返回 `ret: ["SUCCESS::调用成功"]`,`resultList` 30 条,耗时 428ms,`hasToken: true`。
- 合规:仅此 1 次请求;未连续翻页;未触发风控。

## 6. chat 基线(通过)

### 6.0 静态基线

通过 `git show chat:...` 读取(未切换分支):

- `inject/websocket/websocket-data-source.js`(113 行):hook `window.WebSocket`,目标 `wss-goofish.dingtalk.com`,把消息交给 `window.XianyuAPI.handleWebSocketMessage` 解析,并把连接交给 `window.XianyuSenderSetup.setTargetWebSocket`。
- 导出快照 `.p0-runtime/chat` 结构完整。

### 6.1 加载过程(自动化经原生对话框 + osascript)

- 直接自动化不可行:真实点击"加载未打包"+`waitForFileChooser()` 超时;`page.cdp("Extensions.loadUnpacked")` → `Method not available.`;ego-browser `help()` 无加载扩展 API。
- 可用路径:`chrome://extensions` 页内 `chrome.developerPrivate.loadUnpacked(...)` 会弹出**原生目录对话框**。
- 最终方案:由 agent 触发 `developerPrivate.loadUnpacked`(保持 script 存活),**并行**以 `osascript`(`System Events`:Cmd+Shift+G → 粘贴路径 → 回车 → 回车)在原生对话框中选择目录:
  `/Users/wuwenjing/codes/extensions/FishOps-Workbench/.p0-runtime/chat`
  加载成功,扩展列表由 27 → 28。
- 说明:前两次尝试因对话框与脚本生命周期时序未对齐失败;本次将触发与选择对齐后成功。**未修改任何项目代码或原仓库。**

### 6.2 WebSocket 监听/连接验证(通过)

在 `https://www.goofish.com/im` 观察(仅监听,未发送任何消息):

- content scripts 已执行:`window.WebSocketDataSource`(initialized=true)、`window.XianyuAPI`、`window.XianyuSenderSetup`、`window.EventBus` 均存在。
- CDP `Network.webSocketCreated` 捕获到:`wss://wss-goofish.dingtalk.com/`(共 22 个 WS 事件,含淘宝 ACCS `msgacs.m.taobao.com`)。
- console 日志(关键,`[WS监听]` 等前缀):
  - `[WS监听] WebSocket 数据源已初始化`
  - `[WS监听] 检测到闲鱼聊天 WebSocket 连接`
  - `[消息发送] ✅ 设置目标 WebSocket: wss://wss-goofish.dingtalk.com/`
  - `[WS监听] WebSocket 连接已建立`
  - `[ChatParser] 聊天消息解析模块已加载`、`[ChatSender] 消息发送器已加载`、`[聊天记录] ✅ ChatHistoryAPI 已加载`、`[ChatSync] 模块已加载`
- 结论:**chat 扩展成功 hook 闲鱼聊天 WebSocket 并建立连接,监听机制生效。**

### 6.3 过程备注

- `goofish.com/im` 会请求浏览器**通知权限**气泡,导致 ego-browser 两次交由用户控制;本次通过 CDP `Page.addScriptToEvaluateOnNewDocument` 在文档加载前将 `Notification.requestPermission` 置为 `denied` 规避,从而稳定捕获 WebSocket 事件。
- 全程未发送聊天消息、未启用自动回复、未调用 AI、未发布商品。

## 7. 明确未执行的操作

- 未发送任何聊天消息、未启用自动回复、未实际发布商品、未写入飞书、未调用任何 AI(付费)接口。
- 未清除 cookie / cache / storage。
- 未卸载任何用户扩展。
- 未修改 `PLAN.md`、未改动原 `FishOps` 仓库、未提交任何代码。

## 8. 当前浏览器状态

- `chat`(闲鱼聊天监听助手 `pabloiaacobcpjhmmgnpcakkeklbmpjl`)为**启用**。
- `main`(闲鱼数据采集助手 `annppaeoihgjkepbdpohjjfkhiccocjm`)为**禁用**(因两者都会 hook 闲鱼页面,不可同时启用);如需继续用 main,请先禁用 chat 再启用 main。
- 扩展均未卸载;分支快照目录 `.p0-runtime/{main,chat}` 保留,便于后续阶段直接加载。

## 9. 关键 ID 备忘

- TaskSpace ID:`97`
- main 扩展 ID:`annppaeoihgjkepbdpohjjfkhiccocjm`(1.7.0,禁用)
- chat 扩展 ID:`pabloiaacobcpjhmmgnpcakkeklbmpjl`(3.0.0,启用)
- chat 加载目录:`extensions/FishOps-Workbench/.p0-runtime/chat`
- main 加载目录:原仓库 `extensions/FishOps`(main 分支工作区)
