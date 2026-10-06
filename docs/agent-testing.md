# Agent 本地测试环境

## 固定插件目录

在任意 worktree 根目录执行：

```sh
npm run agent:build
```

命令先执行完整的 `npm run build`，再将 `extension/dist` 同步到 `~/.fishops/agent-extension`。完整替换会清除旧 chunk；构建失败时不更新固定目录。来源路径、提交号、工作区是否有未提交修改和构建时间记录在固定目录的 `.fishops-agent-build.json` 中。

固定测试副本的 `manifest.json` 还会声明本地配置中 AI 接口 Origin 的域名权限，以便脚本完成授权。只写入非敏感域名，不写入 API Key、飞书凭据或完整配置。源目录 `extension/dist` 的 manifest 保持不变，因此 CI 和 Release 包不会包含该测试域名。

CI 与 Release 继续使用原来的 `npm run build`，不写入本机测试目录。固定目录只供串行测试，多个 worktree 不得同时更新或使用这个插件做测试。运行命令前，应先结束当前插件任务。

## 本地配置

在主工作区填写 `agent-config.json.local`。该文件匹配 Git 的 `*.local` 忽略规则，不提交到仓库，也不复制进构建产物。配置包含 `ai`、`feishu`、`reply` 三组；不需要的配置组可整组删除。需要使用的组必须按设置页面要求填写完整。

- `ai`：`baseUrl`、`apiKey`、`model`、`timeoutMs`。
- `feishu`：必填 `appId`、`appSecret`、`spreadsheetToken`。每日分表模式无需 `productTableId`，可移除此字段；`sellerTableId` 为可选项。导入采用 PATCH 合并，移除字段不会清除浏览器已有旧值；迁移时先在设置页清空旧商品表 ID。
- `reply`：测试环境使用 `enabled: false` 和 `mode: "suggest"`，避免自动发送真实消息。

worktree 优先读取自身的配置文件；文件不存在时，读取 `git worktree list` 的主工作区中的同名文件。也可指定其他本地文件：

```sh
npm run agent:configure -- --config /绝对路径/agent-config.json.local
```

## Agent 安装与更新

首次使用时，在 ego lite 的扩展管理页手动加载 `~/.fishops/agent-extension`。完成后，日常更新运行 `npm run agent:setup`。命令会重新构建并同步固定目录，再通过扩展管理 API 重载已加载的固定目录实例，并导入本地配置。日常更新不会卸载插件，因此保留浏览器中的配置和任务数据，也不需要再次选择目录。

若固定目录实例未加载，脚本会输出 `INSTALL_REQUIRED` 和首次手动加载路径，然后停止；加载后再次运行 `npm run agent:setup` 即可完成重载和配置导入。`npm run agent:uninstall` 保留为显式卸载命令。卸载会清除该扩展在浏览器中的本地配置与任务数据，只有用户确实要移除测试插件时才运行。

脚本等待插件完成重载后，仅对固定测试 manifest 已声明的 AI 接口域名授予运行权限，并读取最终权限状态验证。不授予所有可选域名的访问权限。切换 AI 域名后应运行 `agent:setup`，让测试 manifest 同步更新；仅执行 `agent:configure -- --config ...` 不会更新 manifest。

配置导入使用真实扩展内页的现有命令接口，只输出配置是否存在和权限状态，不回显密钥，不自动进行 AI、飞书联网测试或远端写入。部分组导入失败时，已成功的组可能已保存；修正后可重新运行。ego 明确报告用户接管或结束空间时，Agent 必须停止，不能以自动化为由绕过停止信号。

## 后续切换 worktree

```sh
npm run agent:setup
```

每次执行「构建和同步 → 重载固定目录实例 → 导入配置」，保留已加载插件及其浏览器数据。首次加载目录后，后续 worktree 更新无需再次选择目录。

更新后需刷新已打开的闲鱼页面，让新的 content script 生效。闲鱼登录、浏览器授权及 WS 连接是否就绪仍需通过真实页面验收；配置保存成功不等于这些条件均已满足。

## 卸载测试插件

```sh
npm run agent:uninstall
```

命令卸载 ego 中同名且有本地安装路径的 FishOps，包括固定目录和旧 worktree 路径的实例。脚本从目标自身的工作台页面调用 `chrome.management.uninstallSelf`，关闭确认窗口，并从扩展管理页面验证实例已经移除。未安装时直接成功返回，因此可重复执行。卸载不依赖本地配置文件，不卸载其他品牌的插件，也不删除固定构建目录或本地配置文件。

卸载会清除该扩展在浏览器内保存的配置和任务数据。再次使用时，需在 ego lite 中手动加载固定目录，然后运行 `npm run agent:setup` 导入本地配置。

## 验证脚本

完整回归运行 `npm run regression:full`；只检查飞书、AI 等真实入口时运行 `npm run regression:e2e`。覆盖范围、配置条件与报告见[回归测试](regression-testing.md)。

```sh
npm run test:agent
```

测试覆盖切换来源后的旧文件清理、不完整构建保留旧产物、非脚本管理目录保护、并发更新拒绝、停止信号和完成标记检查、等待插件完成重载，以及仅在测试副本声明 AI 域名权限。
