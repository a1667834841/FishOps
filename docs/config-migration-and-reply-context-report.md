# 旧配置安全迁移 + P6 建议上下文/图片组装 报告

> 目标：在 `FishOps-Workbench` 内实现两项**后台**能力：
> (A) 安全迁移旧扩展 AI / 飞书配置；(B) 完善 `CHAT_GET_REPLY_SUGGESTION` 的上下文 / 图片信息组装。
> **不含 Workbench UI；不执行真实 AI / 飞书网络请求。**

## 1. 关键事实：chrome.storage.local 按 extension ID 隔离

- 新扩展**无法**通过 `chrome.storage.local.get` 读取旧扩展的存储（不同 extension ID 各自隔离）。
  因此迁移**不读任何 storage**，也不伪称能跨 ID 读取。
- 真实迁移机制：由**受信上下文**（旧扩展页面 / DevTools 隔离执行环境）**只读取白名单键**后，
  构造「受信迁移载荷」，经 `MIGRATE_LEGACY_CONFIG` 命令传入新扩展，在**内存**中转移到新扩展专用键。
- 现有 ego API 未被用于自动化搬运 secret（避免把 key 写入 terminal / tool / 报告）；
  本实现采用**受信载荷命令 + 严格校验**，并明确需要**用户手动入口**（UI 未做，见 §6）。

旧分支真实配置键（只读 `git show` 确认，仅用于说明载荷采集范围，代码不读取）：

| 来源 | 键 | 说明 |
| --- | --- | --- |
| `chat:shared/config.js` / `chat:background/index.js` | `autoReplyGlobalConfig` | 含 `aiApiKey/aiBaseUrl/aiModel/aiTimeout`、`xgjAppId/xgjAppKey/xgjAppSecret`、`enabled/defaultCooldown/defaultDelay/blacklist` |
| `chat:background/index.js` | `autoReplyRules` | 规则对象可能内嵌 `aiApiKey` |
| `chat:background/index.js` | `aiPauseConfig` | AI 暂停（本次不迁移） |
| `main:background.js:820` | `appId/appSecret/spreadsheetToken/productTableId/sellerTableId/enabled` | 飞书扁平键 |

## 2. 迁移命令契约

`MIGRATE_LEGACY_CONFIG`

```ts
type MigrateLegacyConfigPayload = {
  legacy?: LegacyConfigTransfer // 受信载荷（受信上下文采集的白名单数据）
  dryRun?: boolean              // true 或缺省（未 confirm）→ 仅预览
  confirm?: boolean             // true → 执行写入
  overwrite?: boolean           // 需同时 confirm=true（二次确认）才覆盖已有新配置
}
```

流程：
1. `{legacy}`（或 `{legacy, dryRun:true}`）→ 校验载荷 → 只返回存在性预览，并在**内存**缓存来源。
2. `{confirm:true}` → 复用内存来源（或本次携带的 `legacy`）执行写入；结束后立即清空内存来源。
3. `{confirm:true, overwrite:true}` → 覆盖已有新配置。
4. 未先预览且未携带 `legacy` 的确认、`overwrite` 未配 `confirm` → 结构化 `INVALID_PAYLOAD`。

安全默认（强制，不可被载荷绕过）：
- 迁移的规则**一律 `enabled=false`**；
- 全局配置强制 **`enabled=false`、`mode='suggest'`**，仅迁移 `defaultCooldown/defaultDelay/blacklist`。

预览 / 结果**只回布尔与派生值**：`exists/hasApiKey/hasBaseUrl/hasModel/provider/count/fields/configured`；
**不返回** apiKey / appSecret / baseUrl / model 值（派生 `provider` 由 baseUrl 主机名推断，非敏感）。

## 3. 生成建议上下文 / 图片

- `extension/src/chat/reply-context.ts`：结构化上下文 + 脱敏 + 上限（条数 / 正文 / 商品 / 图片数量与 URL 长度）。
- `extension/src/chat/ai-prompt.ts`：`buildReplyMessages()` 产出 OpenAI 兼容多模态 `messages`；
  规则可提供 `userPromptTemplate` 渲染当前用户轮。
- `extension/src/chat/ai-service.ts`：`resolveProviderParams()`（DashScope/Qwen 关 thinking；DeepSeek reasoner 不发 temperature）。
- `extension/src/background/reply-runtime.ts`：建议附 `diagnostics.contextSummary`，广播非敏感事件
  `CHAT_REPLY_SUGGESTION_GENERATED`（不含正文 / 图片 URL / 凭据）。
- `reply-runtime.reloadConfig()`：迁移后刷新 P6 内存缓存（避免用户重载）。

## 4. 迁移后自动刷新（避免用户重载）

`background/index.ts` 在迁移命令返回 `mode:'applied'` 后：
- 若已创建 P6 运行时 → `reloadConfig()` 重新加载全局/规则/凭据（共享同一配置存储单例）；
- 若已创建 P7 分析运行时 → `updateFeishuConfig()` 更新飞书数据源；
- P7 `getApiKey` 已接线到 **P6 AI 专用 provider 键**（`fishops.reply.aiProvider`）。

## 5. 改动文件

| 文件 | 说明 |
| --- | --- |
| `shared/types/legacy-migration.ts` | 受信载荷类型 + 迁移领域类型（不读 storage 的说明） |
| `shared/events/codec.ts` | `isLegacyConfigTransfer` / `isMigrateLegacyConfigPayload` 严格白名单校验 |
| `shared/events/commands.ts`、`events.ts` | 迁移命令/结果、建议 `includeImages`、建议事件 |
| `shared/types/reply.ts`、`shared/reply/validate.ts` | 上下文上限/摘要、`userPromptTemplate`、图片字段 |
| `extension/src/data-source/legacy-config-source.ts` | `PayloadLegacyConfigSource`（受信载荷→内存来源）+ 内存来源 |
| `extension/src/data-source/legacy-config-migration.ts` | 迁移服务（安全默认 / 不覆盖 / 结构化失败） |
| `extension/src/data-source/feishu-config-store.ts` | 飞书专用键 `fishops.analysis.feishuConfig` |
| `extension/src/background/migration-runtime.ts` | 迁移命令运行时（内存来源缓存 + TTL + 清空） |
| `extension/src/background/{message-router,index,reply-runtime}.ts` | 命令路由、迁移/P6/P7 刷新接线、`reloadConfig` |
| `extension/src/chat/{reply-context,ai-prompt,ai-service,reply-engine}.ts` | 上下文/图片/多模态/provider 适配 |

## 6. 剩余接线项

- **需要用户手动入口**：受信载荷需由旧扩展页面 / DevTools 隔离环境采集后，经
  `MIGRATE_LEGACY_CONFIG` 传入；Workbench 设置页入口（含预览→确认→覆盖二次确认）未做。
- 未执行真实浏览器搬运 secret（避免 key 进入 terminal / tool / 报告）。
- 迁移的既有 Workbench 页面需监听 `CHAT_RULES_UPDATED` / `CHAT_REPLY_SUGGESTION_GENERATED` 刷新（UI 未做）。
