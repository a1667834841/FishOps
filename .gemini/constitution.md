

# i 浏览器插件开发宪法

# Version: 1.0, Ratified: 2026-01-18

本文件定义了本项目插件开发不可动摇的核心原则。所有 AI Agent 在进行技术规划和代码实现时，必须无条件遵循。

---

## 第一条：极简主义与资源原则 (Minimalism & Performance)

**核心：** 插件不应成为用户的系统负担。性能损耗必须降至最低。

* **1.1 (按需加载):** 严禁在 `manifest.json` 中声明不必要的权限。仅在需要时通过 `optional_permissions` 请求权限。
* **1.2 (零依赖优先):** 严禁为了简单功能引入大型库（如 jQuery, Lodash, Bootstrap）。优先使用原生 Web APIs (Fetch, DOM API)。
* **1.3 (事件驱动):** 必须使用 `Manifest V3`。Background Service Workers 必须保持无状态，且只在事件触发时运行，严禁在后台常驻长任务。

---

## 第二条：通信契约与测试先行 (Message Passing & TDD)

**核心：** 插件各组件（Popup, Background, Content）之间的通信必须像 API 一样稳定。

* **2.1 (消息 Schema):** 所有消息传递（`runtime.sendMessage`）必须有明确的操作类型（Action Type）和数据结构定义。
* **2.2 (Mock 环境测试):** 由于插件环境特殊，必须使用 `jest-chrome` 或类似的 Mock 工具，在不启动浏览器的情况下测试核心逻辑。
* **2.3 (端到端验证):** 对于核心交互流程，必须编写基于 `Puppeteer` 或 `Playwright` 的 E2E 测试，验证插件在真实浏览器环境中的表现。

---

## 第三条：安全性与防御性编程 (Security & Defense)

**核心：** 插件是系统安全的潜在缺口。必须遵循最高安全准则。

* **3.1 (拒绝 innerHTML):** **不可协商**：严禁使用 `innerHTML`。所有 DOM 操作必须使用 `textContent` 或 `createElement`。涉及外部数据注入时，必须进行严格的消毒（Sanitize）。
* **3.2 (显式错误边界):** 在 Content Script 中，必须对所有的 DOM 查询和 API 调用包裹 `try...catch`，确保插件崩溃不会导致用户当前网页功能失效。
* **3.3 (CSP 遵循):** 严禁尝试绕过内容安全策略。禁止使用 `eval()`、内联脚本或从外部域名加载代码。

---

## 第四条：职责分离与单向数据流 (Separation of Concerns)

**核心：** 明确各脚本的边界，严禁逻辑混乱。

* **4.1 (逻辑隔离):**
* **Content Script:** 仅负责 DOM 交互和 UI 注入。
* **Background:** 负责网络请求、跨域处理和持久化存储。
* **Popup/Options:** 仅负责用户配置和交互展示。


* **4.2 (单向通信):** 推荐采用“请求-响应”模式进行通信。Content Script 永远不应直接操作插件的全局状态，必须通过 Background 代理。

---

## 第五条：存储与同步 (Storage & Sync)

**核心：** 尊重用户数据，确保持久化逻辑清晰。

* **5.1 (存储选型):** 用户配置使用 `chrome.storage.sync`（限制大小，支持多端同步）；大量数据或缓存使用 `chrome.storage.local` 或 `IndexedDB`。
* **5.2 (版本迁移):** 任何涉及数据结构变更的更新，必须在 `runtime.onInstalled` 事件中编写显式的数据迁移逻辑（Migration Logic）。

---

## 治理 (Governance)

本宪法具有最高优先级。任何代码提交前必须通过以下“合宪性”审查：

1. **权限最小化：** `manifest.json` 中是否有多余权限？
2. **安全扫描：** 代码中是否存在 `innerHTML` 或 `eval()`？
3. **消息解耦：** 消息传递是否有明确的类型定义？
4. **无状态检查：** Service Worker 是否依赖了全局持久变量？

---

**您是否需要我为您生成一个基于 Manifest V3 的、符合此宪法的插件骨架代码？（包含消息类型定义和原生 DOM 操作示例）**