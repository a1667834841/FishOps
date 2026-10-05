# 插件构建产物

GitHub Actions 工作流「构建插件」在 push、pull request 和手动运行时执行。工作流使用 Node.js 24，通过 `npm ci` 安装锁定的依赖，然后执行单元测试、类型检查、完整构建、安全回归测试和构建产物冒烟测试。任一步骤失败时，不上传插件压缩包。

单元测试使用根目录的 `npm test`，覆盖扩展的 background、platform、chat、capture、analysis、publish 模块，以及工作台。安全回归测试使用 `npm run test:security`，构建产物冒烟测试使用 `npm run test:smoke`；两者依赖编译产物，均在构建完成后执行。

`npm run build` 将扩展运行时与工作台合并输出到 `extension/dist`。CI 将该目录的内容打包为 `fishops-extension.zip`，再上传到名为 `fishops-extension` 的 Artifact，保留 30 天。压缩包根目录包含 `manifest.json` 和 `workbench.html`。

## 下载与加载

1. 打开 GitHub 仓库的 **Actions** 页面，选择「构建插件」。
2. 打开一次成功的运行，在 **Artifacts** 中下载 `fishops-extension`。
3. 解压下载的 Artifact，再解压其中的 `fishops-extension.zip`。
4. 打开 `chrome://extensions`，启用开发者模式，点击「加载已解压的扩展程序」，选择包含 `manifest.json` 的目录。

如需手动构建，在 **Actions → 构建插件 → Run workflow** 中选择分支并运行。更新已加载的插件时，重新下载并解压产物，然后在扩展管理页面点击插件的重新加载按钮。
