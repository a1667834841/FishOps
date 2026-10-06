# AGENTS.md

## 1. 语言规范（硬性要求）

- **思考过程必须使用中文**，不允许出现英文思考内容。
- **输出内容必须使用中文**，除非用户明确要求使用英文。
- 代码、命令、标识符、技术术语（如 `fetch`、`Promise`、`middleware`）保持原文，不翻译。
- Write in Simplified Chinese following ASD-STE100. This does not apply to code.

## 2. 本地开发环境

### 2.1 系统信息

- **操作系统**: macOS (Darwin arm64, 24.2.0)
- **Shell**: `/bin/zsh`
- **主机名**: wuwenjingdeMacBook-Air.local

### 2.2 编程语言 & 运行时

| 环境 | 版本 | 路径 |
|------|------|------|
| Go | 1.24.0 | GOROOT=`~/.goenv/versions/1.24.0`，GOPATH=`~/go/1.24.0` |
| Java | 17.0.15 LTS | `$JAVA_HOME` 未设置，使用系统默认 |
| Node.js | 25.1.0 | 通过 `node` 命令可用 |
| npm | 11.6.2 | 随 Node 安装 |
| Python | 3.9.6 | `/usr/bin/python3` |

### 2.3 工具
- 如果遇到自己不懂的知识，可以使用 web search 工具 `mcp` 来查询。
- 如果有需要查看前端网页或进行浏览器操作，可以调用 ego  lite skills。

## 4.1 代码规范
### 4.1.2 代码注释规范
- **中文注释优先**：项目中的注释应优先使用中文，确保团队成员能快速理解代码意图。
- **必要且有价值**：注释应解释“为什么这样做”、关键业务规则、边界条件、特殊兼容逻辑和不易理解的实现；避免为显而易见的代码添加冗余注释。
- **与代码同步维护**：修改代码时必须同步检查并更新相关注释，禁止保留过期、误导或与实现不一致的注释。
- **复杂逻辑需补充说明**：涉及并发、缓存、事务、权限、安全、性能优化、错误重试、状态流转等复杂逻辑时，应添加清晰的中文注释说明设计考虑。
- **公共接口需说明用途**：对外暴露的函数、方法、类型、配置项和关键常量，应使用简洁中文说明其用途、参数含义、返回值和注意事项。
- **避免无意义注释**：禁止出现仅重复代码含义的注释，例如“设置变量”“调用方法”等低价值描述。

## 5. 工作流入口

- **所有任务及恢复会话**：先读[工作流](docs/workflow.md)，按 `plan → coding → test → pr review → done` 执行，进入阶段前读对应规范并同步 Orca 状态。简单任务使用阶段内快速路径；只有 PR 已合并才进入 done。
- **需要委派或代理 review 时**：读取[代理执行](docs/workflow/agent-execution.md)，按最短有效路径闭环；越界时修正规范。


## 6. Gotchas
（每个新人都踩过的坑)
- **GitHub 写操作**：issue 的创建、更新、评论、标签统一用 `env -u GITHUB_TOKEN gh issue ...`（`GITHUB_TOKEN` 会劫持 gh 凭据报 403，该前缀让它改走 keyring 的 `gho_` token）；正文用 `--body-file` 传入，题名与八章节格式按 [Issue 规范](docs/issue-guidelines.md) 执行。MCP 的 github 写工具是交互式表单且提交后报错，只用于读取。
