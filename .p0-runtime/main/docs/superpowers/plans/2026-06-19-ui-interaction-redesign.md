# 闲鱼数据采集助手 UI 与交互改进 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按已确认设计规格（`docs/superpowers/specs/2026-06-19-ui-interaction-redesign-design.md`）改进 popup / options / 详情页三处 UI 与交互，统一 SVG 图标体系，移除 emoji，让对外发布的插件易上手。

**Architecture:** 纯前端改造（HTML/CSS/vanilla JS），不动业务逻辑。每页内联 SVG `<symbol>` 图标集；统一「方向 2」设计令牌；popup 采用方案 A 布局（主路径清晰、进阶收进「⋯ 更多」下拉）。无测试框架——以浏览器手动验证（加载扩展→观察）作为每步验证，不引入测试框架（符合规格第 8 节 YAGNI）。

**Tech Stack:** Chrome MV3 扩展，vanilla JS，原生 CSS（无构建步骤）。

**设计令牌（方向 2 · 品牌鲜明，全站统一）：**
```
主色 #ffe60f；主按钮渐变 linear-gradient(135deg,#ffe60f,#ffd000)
状态栏黄底 #fffdf2 / 黄边 #ffe60f；角标底 #fff8e1 / 深黄字 #b8860b
圆角 9px（按钮/卡片）；状态点 50%
间距 8px 网格；卡片柔阴影 0 1px 2px rgba(15,23,42,.05), 0 12px 32px rgba(15,23,42,.08)
主按钮柔阴影 0 2px 6px rgba(255,210,0,.4)
字体 'PingFang SC',-apple-system,sans-serif；正文 12–13px，标题 14px/600
正文色 #1a1a1a；次级 #6b7280；占位 #c2c6cc；边框 #eef0f3
成功 #34c759；危险 #f44336；深色底 #1f1f1f（详情页控制台）
```

**验证方法（每步通用）：** `chrome://extensions` → 点扩展的「重新加载」→ 点工具栏图标开 popup（或在 goofish.com/item 页验证详情页）→ 观察外观/交互 → 打开 DevTools Console 确认无报错。

---

## Task 1: 版本号统一为 1.7.0

**Files:**
- Modify: `manifest.json`

- [ ] **Step 1: 修正 manifest 版本号**

将 `manifest.json` 中 `"version": "1.5.0"` 改为 `"1.7.0"`，使其与 popup 角标一致。

```json
"version": "1.7.0",
```

- [ ] **Step 2: 验证**

Run: `chrome://extensions` → 重新加载扩展。
Expected: 扩展版本显示为 1.7.0；无报错。

- [ ] **Step 3: Commit**

```bash
git add manifest.json
git commit -m "fix: 统一版本号为 1.7.0（manifest 与 popup 角标对齐）"
```

---

## Task 2: Popup 重设计（方案 A 布局 + 方向 2 视觉 + SVG 图标）

本任务一次性改 `popup.html`（含内联 CSS 与 SVG）与 `popup.js`，使 HTML/JS 一致、可独立验证。

**Files:**
- Modify: `popup.html`（重写 body 结构 + style + 内联 SVG symbol 块）
- Modify: `popup.js`（与新结构对齐：去 emoji、按钮态用 class、移除死代码、接「⋯ 更多」下拉、结果区按数据显隐、空状态引导）

**关键现状（必须处理）：**
- `popup.js` 引用了 popup.html 不存在的元素：`lastTime`、`infoToggle`/`infoContent`/`infoToggleIcon`、`fetchSuggestBtn`。其中 `fetchSuggestBtn.addEventListener` 直接抛 `ReferenceError`。这些是死代码，本次移除。
- `popup.js` 把 `startCrawlBtn.textContent` 设为 `'🚀 开始爬取'`/`'⏸️ 停止爬取'` 并切换不存在的 `btn-pause`/`btn-start` 类。改用 `.crawling` class + 纯文字「停止」/「开始」。
- `exportCSVBtn`/`sendFeishuBtn` 设 emoji 文案，改为纯文字 + SVG 图标。

### Step 1: 重写 popup.html（结构 + SVG + 样式）

用以下结构替换 `<body>` 内全部内容（保留 `toast`、`confirmDialog` 容器）。先在 `<body>` 顶部放内联 SVG `<symbol>` 块，再放主体。

**内联 SVG 图标块（放 body 首部，display:none）：**
```html
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <symbol id="i-fish" viewBox="0 0 24 24"><path d="M6.5 12c0-2.2 2.5-4 5.5-4s5.5 1.8 5.5 4-2.5 4-5.5 4-5.5-1.8-5.5-4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M17.5 12l3.5-2.5v5L17.5 12z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="9" cy="11" r=".6" fill="currentColor"/></symbol>
    <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.3-4.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
    <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 3v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
    <symbol id="i-send" viewBox="0 0 24 24"><path d="M22 2L11 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M22 2l-7 20-4-9-9-4 20-7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
    <symbol id="i-more" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></symbol>
    <symbol id="i-gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
    <symbol id="i-list" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
    <symbol id="i-spinner" viewBox="0 0 24 24"><path d="M12 2a10 10 0 0 1 10 10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></symbol>
  </defs>
</svg>
```

**body 主体结构（方案 A）：**
```html
<div class="app">
  <!-- 头部 -->
  <header class="header">
    <div class="brand"><span class="brand-logo"><svg width="15" height="15"><use href="#i-fish"/></svg></span><span class="brand-name">闲鱼数据采集</span></div>
    <span class="ver">v1.7.0</span>
  </header>

  <!-- 状态栏 + ⋯ 更多 -->
  <div class="status-bar">
    <span class="status-text"><span class="dot"></span><span id="statusText">运行中 · 已采 <b id="itemCount">0</b> 件 · 第 <b id="pageCount">0</b> 页</span></span>
    <div class="more-wrap">
      <button id="moreBtn" class="more-btn" aria-label="更多"><svg width="16" height="16"><use href="#i-more"/></svg></button>
      <div id="moreMenu" class="more-menu">
        <button id="openConfig" class="more-menu-item"><svg width="14" height="14"><use href="#i-gear"/></svg>配置中心</button>
        <button id="clearData" class="more-menu-item danger"><svg width="14" height="14"><use href="#i-more"/></svg>清空数据</button>
      </div>
    </div>
  </div>

  <!-- 采集行 -->
  <div class="crawl-row">
    <div class="input-wrap"><svg class="input-icon" width="14" height="14"><use href="#i-search"/></svg><input id="keywordInput" type="text" placeholder="输入关键词..." autocomplete="off"></div>
    <button id="startCrawl" class="btn btn-start">开始</button>
  </div>

  <!-- 结果区：采集到数据后显示 -->
  <div id="resultArea" class="result-area" style="display:none;">
    <button id="exportCSV" class="btn btn-export"><svg width="14" height="14"><use href="#i-download"/></svg>导出 CSV</button>
    <button id="sendFeishu" class="btn btn-ghost">飞书</button>
  </div>

  <!-- 流量词 -->
  <div id="suggestWordsContainer" class="suggest" style="display:none;">
    <div class="suggest-head">流量词 <span class="suggest-tip">点击复制全部</span></div>
    <div id="suggestWordsList" class="suggest-list"></div>
    <textarea id="suggestWordsHidden" style="position:absolute;left:-9999px;"></textarea>
  </div>

  <!-- 飞书状态 -->
  <div id="feishuStatus" class="feishu-status" style="display:none;"><span id="feishuStatusText"></span></div>
</div>

<!-- toast / confirm 沿用现有结构 -->
<div id="toast" class="toast"></div>
<div id="confirmDialog" class="confirm-dialog"><div class="confirm-box"><div id="confirmTitle" class="confirm-title"></div><div id="confirmMessage" class="confirm-message"></div><div class="confirm-actions"><button id="confirmCancel" class="btn btn-ghost">取消</button><button id="confirmOk" class="btn btn-start">确定</button></div></div></div>
```

**`<style>` 内联 CSS（应用设计令牌，方案 A + 方向 2）：** 重写 `<style>` 块。关键类：
- `.app` 宽 340px，padding 16px，背景 #fff，圆角 14px，卡片柔阴影。
- `.btn-start` 主按钮：渐变 `linear-gradient(135deg,#ffe60f,#ffd000)`，色 #1a1a1a，圆角 9px，高 36px，柔阴影 `0 2px 6px rgba(255,210,0,.4)`。
- `.btn-start.crawling` 采集态：背景 `#1f1f1f`，色 `#ffe60f`，文字「停止」。
- `.btn-export` 同主按钮渐变（导出为主）；`.btn-ghost` 描边次级（白底+#eef0f3 边，色 #6b7280）。
- `.status-bar`：黄底 `#fffdf2`+黄边 `#ffe60f`，圆角 9px，padding 8px 11px；`.dot` 绿点 `#34c759` 带 `box-shadow:0 0 0 3px rgba(52,199,89,.16)`。
- `.more-menu`：绝对定位下拉，默认 `display:none`，`.open` 显示；白底+#eef0f3 边，圆角 9px，卡片柔阴影。
- `.more-menu-item.danger`：色 `#f44336`。
- `.suggest-list` 流量词标签：inline-block，黄底 `#fff8e1`，圆角 8px；`.suggest-word-more` `+N`。
- `.ver`：浅黄底 `#fff8e1`+深黄字 `#b8860b`，圆角 10px。
- `.feishu-status` 成功/失败色由 JS 行内设（保留现有逻辑）。
- `.toast`/`.confirm-dialog` 沿用原样式（保留 toast 动画类）。

### Step 2: 重写 popup.js（与新结构对齐）

在现有 `popup.js` 基础上做以下修改（保留所有业务消息收发逻辑不变）：

**2a. 移除死代码：**
- 删除 `lastTimeEl` 相关（`const lastTimeEl = ...` 及 updateStats 中对它的赋值，line ~87、~114-116）。
- 删除「折叠面板」整块（`infoToggle`/`infoContent`/`infoToggleIcon`，line ~139-155）。
- 删除「爬取流量词按钮」整块（`fetchSuggestBtn.addEventListener(...)`，line ~402-457）——该按钮在 popup.html 中不存在，且会抛 ReferenceError。保留 `fetchSuggestWords()`/`displaySuggestWords()`/`copyAllSuggestWords()` 函数（采集时自动调用）。

**2b. 按钮态改用 class（去 emoji）：**
- `startCrawlBtn.textContent = '🚀 开始爬取'` → `startCrawlBtn.textContent = '开始'; startCrawlBtn.classList.add('crawling');`（CSS 让 `.crawling` 显示「停止」可由 `::after` 或直接设 textContent 为「停止」）。**采用直接设文字：** 开始采集时 `startCrawlBtn.textContent='停止'; startCrawlBtn.classList.add('crawling')`；停止时 `startCrawlBtn.textContent='开始'; startCrawlBtn.classList.remove('crawling')`。删除所有 `btn-pause`/`btn-start` 的 classList 切换（`btn-start` 是基础类保留，只切 `crawling`）。
- 三处出现（onMessage CRAWL_COMPLETED/STOPPED、startCrawl 停止分支、START_AUTO_CRAWL 失败分支）统一替换。
- `exportCSVBtn.textContent = '⚙️ 生成中...'` → `'生成中...'`；恢复为 `'导出 CSV'`（按钮内 SVG 在重写 textContent 时会丢失——改用：按钮结构为 `<svg>导出 CSV</svg>`，加载时给按钮加 `.loading` class，CSS 用 `.loading` 隐藏 svg 并显示伪元素「生成中…」；或更简单：加载时 `btn.innerHTML='生成中...'`，完成后 `btn.innerHTML='<svg ...>导出 CSV'`）。**采用：** 封装一个 `setBtnContent(btn, iconName, label)` 工具函数统一处理，避免重复 SVG 字符串。

```js
const SVG = { download:'#i-download', send:'#i-send', gear:'#i-gear' };
function setBtnContent(btn, iconId, label){
  btn.innerHTML = iconId ? `<svg width="14" height="14"><use href="${iconId}"/></svg>${label}` : label;
}
```
- `exportCSVBtn`：初始 `setBtnContent(exportCSVBtn, SVG.download, '导出 CSV')`；加载 `exportCSVBtn.textContent='生成中...'`；完成 `setBtnContent(exportCSVBtn, SVG.download, '导出 CSV')`。
- `sendFeishuBtn`：加载 `sendFeishuBtn.textContent='发送中...'`；恢复 `setBtnContent(sendFeishuBtn, SVG.send, '飞书')`。

**2c. 「⋯ 更多」下拉：**
```js
const moreBtn = document.getElementById('moreBtn');
const moreMenu = document.getElementById('moreMenu');
moreBtn.addEventListener('click', (e) => { e.stopPropagation(); moreMenu.classList.toggle('open'); });
document.addEventListener('click', (e) => { if (!moreMenu.contains(e.target)) moreMenu.classList.remove('open'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') moreMenu.classList.remove('open'); });
```

**2d. 结果区按数据显隐 + 空状态引导：**
```js
const resultArea = document.getElementById('resultArea');
const statusText = document.getElementById('statusText');
function renderStatus(itemCount, pageCount){
  if (itemCount > 0) {
    resultArea.style.display = 'flex';
    statusText.innerHTML = `运行中 · 已采 <b>${itemCount}</b> 件 · 第 <b>${pageCount}</b> 页`;
  } else {
    resultArea.style.display = 'none';
    statusText.innerHTML = `输入关键词，点开始采集`;
  }
}
```
在 `updateStats()` 中用 `renderStatus(response.itemCount||0, response.pageCount||0)` 替换原直接设值。`CRAWL_COMPLETED`/`CRAWL_STOPPED` 消息回调里也调用一次 `updateStats()`。

**2e. openConfig/clearData 现挂载在 more-menu-item 上**——`getElementById('openConfig')`/`getElementById('clearData')` 的引用不变，事件绑定代码原样保留（openConfig 开 options.html、clearData 走 showConfirm→CLEAR_DATA）。

### Step 3: 验证

Run: `chrome://extensions` → 重新加载 → 打开 popup（在 goofish.com 标签页）。
Expected:
- 主路径清晰：关键词框 + 开始；无采集数据时状态栏显示「输入关键词，点开始采集」，导出/飞书区隐藏。
- 「⋯ 更多」点击展开「配置中心 / 清空数据」，点外部/Esc 收起；点配置中心打开 options.html。
- 全程无 emoji，图标为 SVG；DevTools Console 无报错（确认 ReferenceError 消失）。
- 在 goofish.com 输入关键词点开始：按钮变「停止」+深色态；采集后状态栏显示件数/页数，导出/飞书区出现。
- 导出 CSV 正常下载；飞书按钮在无配置时给提示。

### Step 4: Commit

```bash
git add popup.html popup.js
git commit -m "feat(popup): 方案A布局+方向2视觉+SVG图标，修复html/js不同步

- 主路径清晰，进阶(配置/清空)收进「⋯ 更多」下拉
- emoji 全换内联 SVG 线性图标
- 结果区按数据显隐，空状态引导文案
- 移除死代码(lastTime/infoToggle/fetchSuggestBtn)消除 ReferenceError
- 按钮态改用 .crawling class"
```

---

## Task 3: 配置中心视觉刷新（方向 2 + 飞书可选 + SVG 图标）

**Files:**
- Modify: `options.html`（套方向 2 样式、飞书标题加「（可选）」、内联 SVG symbol、4 个导航项保留）

**说明：** `options.js` 逻辑不变（导航切换、loadConfig/saveConfig/测试连接均保留）。仅改 HTML/CSS。

### Step 1: options.html 加内联 SVG symbol 块（与 popup 相同的 fish/gear/list/download/send，复用同一 symbol 定义）

### Step 2: 套方向 2 设计令牌
- 侧边导航 `.nav-item.active` 用主色：左侧 3px 黄色指示条 `#ffe60f` + 浅黄底 `#fffdf2`；非 active 项色 `#6b7280`。
- 主按钮「保存配置」用 `.btn-start` 渐变；次级「恢复默认」用 `.btn-ghost` 描边。
- 输入框：圆角 9px，边框 `#eef0f3`，focus 边框 `#ffe60f`。
- 飞书面板标题由「飞书设置」改为「飞书同步（可选）」，并在标题下加一行说明：「CSV 为主输出，飞书同步为可选功能」。
- 角标/分区标题套统一字体与色阶（标题 14px/600 #1a1a1a；说明 12px #9aa0a6）。
- 「代理设置」「高级设置」两个空占位面板保留（标题 + 「暂无配置」文案不变），套统一卡片样式（圆角 14px、卡片柔阴影）。

### Step 3: 验证

Run: 扩展选项页（或 popup「⋯ 更多」→配置中心）。
Expected: 4 个导航项都在；飞书面板标题为「飞书同步（可选）」并有说明；视觉为方向 2（黄色点缀、柔阴影、SVG 图标、9px 圆角）；保存配置/恢复默认/测试连接功能正常；Console 无报错。

### Step 4: Commit

```bash
git add options.html
git commit -m "style(options): 方向2视觉刷新+飞书标注可选+SVG图标

- 导航保留4项(代理/高级空占位不移除)
- 飞书标题改「飞书同步(可选)」并加说明
- 统一黄色主色/柔阴影/9px圆角/SVG图标"
```

---

## Task 4: 详情页 emoji→SVG + 发布降级 + 视觉对齐

**Files:**
- Modify: `item-download.js`（按钮/control innerHTML 的 emoji 换 SVG；发布按钮加次级 class）
- Modify: `item-download.css`（发布按钮次级样式；与方向 2 对齐的圆角/阴影微调）

### Step 1: item-download.js 顶部注入或复用 SVG symbol
详情页是注入到 goofish.com 页面的脚本，不能引用扩展 popup 的 symbol。在创建浮动按钮/控制台时，用内联 SVG 字符串。定义一个常量供复用：
```js
const ICON = {
  download: '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M12 3v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  list: '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  refresh: '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M23 4v6h-6M1 20v-6h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close: '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  send: '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M22 2L11 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M22 2l-7 20-4-9-9-4 20-7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  check: '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  x: '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>'
};
```

### Step 2: 替换所有 emoji
- 下载按钮初始 `innerHTML='⬇️'` → `ICON.download`；成功态 `'✓'` → `ICON.check`；错误态 `'✗'` → `ICON.x`；恢复态 `⬇️` → `ICON.download`（`showButtonSuccess`/`showButtonError` 两处 setTimeout 内的 `'⬇️'`）。
- 控制台标题 `<h3>📋 下载记录</h3>` → `<h3>${ICON.list} 下载记录</h3>`。
- 刷新按钮 `🔄 刷新` → `${ICON.refresh} 刷新`；清空 `🗑️ 清空` → `${ICON.trash} 清空`；关闭 `✖` → `${ICON.close}`。
- 表格操作列 `🚀 发布` → `${ICON.send} 发布`；`🗑️ 删除` → `${ICON.trash} 删除`。
- 空记录文案「暂无下载记录」下补一行说明：`<div class="console-empty">暂无下载记录<div class="console-empty-sub">在商品详情页点下载，记录会出现在这里</div></div>`。

### Step 3: 发布按钮降为次级
- `.publish-btn` 改为次级视觉：描边 `1px solid #eef0f3`，白底，色 `#6b7280`，hover 浅黄底；移除原醒目黄底（让导出类主操作与发布区分）。
- `.delete-btn` 保持危险色 `#f44336` 描边。
- 控制台与浮动按钮保留深色 `#1f1f1f`+黄 `#ffe60f` 配色（契合方向 2）；统一圆角 9px、卡片柔阴影。

### Step 4: 验证

Run: 打开任意 `goofish.com/item?id=...` 页。
Expected:
- 右下角下载按钮为 SVG 图标（非 emoji）；点击下载成功显示 ✓（SVG），2s 后恢复下载图标；控制台无报错。
- 控制台标题「下载记录」前为列表 SVG；刷新/清空/关闭均为 SVG；无记录时显示「暂无下载记录 + 在商品详情页点下载…」。
- 表格内「发布」按钮为次级描边样式（非醒目黄底），「删除」为危险描边。
- 发布功能正常（保存 pending 并打开发布页）。

### Step 5: Commit

```bash
git add item-download.js item-download.css
git commit -m "style(item-download): emoji换SVG图标+发布降为次级+空状态引导

- 下载/记录/刷新/清空/关闭/发布/删除 全部 emoji→SVG
- 发布按钮次级描边，与主操作区分
- 空记录补说明文案"
```

---

## Task 5: 全站验收（对照规格第 10 节）

**Files:** 无（仅验证）

- [ ] **Step 1: 逐条核对验收标准**

在三个界面操作，确认：
1. popup 主路径（关键词→开始→导出 CSV）一目了然；清空/配置在「⋯ 更多」内。
2. 全站无 emoji（搜 `🐟|⬇️|📋|🚀|⚙️|📄|🔄|🗑️|✖|✓|✗` 应只剩注释或无）。
3. 三处视觉统一（黄色主色、柔阴影、9px 圆角、统一字重）。
4. 配置中心 4 导航项在；飞书为「飞书同步（可选）」。
5. 详情页浮动按钮位置/尺寸不变；「发布」为次级视觉。
6. manifest 与 popup 角标均为 1.7.0。
7. 未采集 / 无记录时有引导文案。
8. 采集、导出、飞书同步、下载、发布功能行为不变（端到端走一遍）。

- [ ] **Step 2: 全站 emoji 残留扫描**

Run: 在项目根 `grep -rn "🐟\|⬇️\|📋\|🚀\|⚙️\|📄\|🔄\|🗑️\|✖" popup.html popup.js options.html item-download.js item-download.css`
Expected: 无匹配（或仅注释）。

- [ ] **Step 3: 最终提交（如有遗漏修补）**

如验收中发现小遗漏，修补后：
```bash
git add -A
git commit -m "chore: UI 改造验收收尾"
```

---

## 自审（对照规格）

- **规格覆盖**：第 3 节 popup → Task 2；第 4 节 options → Task 3；第 5 节详情页 → Task 4；第 6 节图标体系 → Task 2/3/4 各自内联 SVG；第 7 节引导一致性 → Task 2d/Task 4 Step2 + Task 1 版本；第 8 节 YAGNI → 未引入测试框架/向导/多语言；第 10 节验收 → Task 5。全部覆盖。
- **占位符扫描**：关键 JS 逻辑（menu toggle、renderStatus、setBtnContent、ICON 常量）均给出完整代码；视觉层用「设计令牌 + 关键类说明」指向规格确切值，无 TBD/TODO。
- **类型/命名一致性**：popup 用 `startCrawl`/`exportCSV`/`sendFeishu`/`clearData`/`openConfig`/`moreBtn`/`moreMenu`/`resultArea`/`statusText`，HTML 与 JS 一致；`.crawling` class 在 CSS/JS 一致。
