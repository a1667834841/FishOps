# 两阶段直接发布（Direct Publish）工作台前端实现说明

## 1. 概述

本模块为 FishOps-Workbench 提供基于闲鱼官方 MTOP 业务接口的**两阶段安全发布前端交互体系**（非 DOM 填表、非纯 HTTP 模拟）。
前端通过独立消息通道（`kind: 'fishops-direct-publish'`）与扩展后台 Service Worker 通信，实现：
1. **阶段 1：自动预检与数据准备（prepare）**：点击发布后弹窗自动调用 prepare 直接展示 Loading，后台完成商品预检、真实图片直接上传、敏感词预检、获取官方账号预填发货地点与推荐类目/属性候选卡片，返回完整真实待发送草稿（Draft）与候选卡片（PropertyCards），**绝不调用发布接口**；
2. **阶段 2：人工审核编辑与统一确认（review & edit）**：展示预填草稿（标题、描述、售价、单 SKU 规格动态编辑与预览、类目候选下拉、属性候选下拉、发货地址展示微调、图片重排/删除、服务选项），**无逐项复选框门禁**，所有项仅展示可编辑，最后统一由“确认并发布”按钮一次性确认；
3. **阶段 3：权威重建与最终发布（submit）**：前端回传用户编辑确认后的业务草稿（仅需 `prepareToken`、`draft`、`confirm: true`，不伪造发送旧确认字段），后台由权威候选重新组装校验后提交平台发布，返回平台生成的真实在售商品 `itemId`。

---

## 2. 核心架构与文件结构

```
workbench/src/features/publish/
├── direct-publish-types.ts        # 前端卡片、草稿、结果与阶段状态类型定义（扩展 failureStage, missingFields）
├── direct-publish-cards.ts        # 候选卡片 (propertyCards) 归一化与属性构造纯函数
├── direct-publish-client.ts       # Service Worker 消息客户端（300s 超时、运行时感知、保守 unknown 策略）
├── direct-publish-controller.ts   # 两阶段发布生命周期控制器（自动 prepare、去逐项门禁、同源锁不可自动 retry、seq 防漂移）
├── useDirectPublish.ts            # Vue 3 响应式 Composable 封装
├── DirectPublishModal.vue         # 两阶段发布 AppModal 弹窗组件（自动 loading 预填、地址与技术字段折叠只读、统一确认并发布）
└── test/
    ├── direct-publish.test.ts     # 纯 Mock 单测（覆盖 24 大场景，含自动 prepare、保留 partial draft、unknown 禁 submit 等）
    └── publish-layout.test.ts     # 发布页与两阶段组件契约回归测试
```

---

## 3. 关键业务规则与安全防线

### 3.1 自动准备与预填（点击发布直接 Loading，去初始空地址表单）
- **自动 Prepare**：用户在发布页点击“发布商品”打开弹窗时，组件内部自动触发 `executePrepare()`，弹窗直接进入 `preparing` 阶段展示加载动画，无需用户手工预先填写空地址或经纬度表单；
- **重开保留编辑不重复上传**：若当前商品已经针对同源草稿完成 prepare 进入了 `reviewed` 状态，操作员关闭并重新打开弹窗时，控制器通过 `hasReviewedDraftFor(source)` 自动识别，保留已有草稿和编辑内容，不重复调用接口与上传图片；
- **防重复触发（Open + Source Watch 守卫）**：弹窗打开状态与商品源 watch 统一收敛为单个复合监听器，结合控制器内置 `preparing` 并发拦截，彻底避免同一时间多次发起 prepare；
- **取消与异步防漂移**：在 preparing 过程中关闭弹窗会调用 `cancel()` 自增 `prepareSequence`，迟到的在途响应被丢弃（`STALE_PREPARE`），重新打开时开启新的请求序列，杜绝 seq 漂移与状态污染。

### 3.2 契约调整与去门禁体系
- **Prepare 入参契约**：
  - `seller?`：可选字段。自动准备时前端不强制传递 seller，由后台根据当前官方账号自动解析默认预填发货地点；当操作员手动调整了地址或坐标并点击重新准备时，通过 `overrideSeller` 覆盖；
  - `confirmedNoQrCodes?`：已弃用并设为可选，图片直接上传，不需操作员在上传前勾选 checkbox；
  - `product.title?`：支持并传递独立商品标题。
- **去逐项复选框确认**：
  - 彻底去掉准备前的“承诺无二维码”复选框；
  - 彻底去掉审核阶段的“类目确认”复选框（`categoryConfirmed`）与提交阶段“图片无二维码确认”复选框（`confirmedNoQrCodes`）；
  - 规格、类目、属性、地址、坐标仅展示可编辑，最后统一由“确认并发布”按钮统一提交。
- **Submit 请求契约**：
  - 前端仅发送 `prepareToken`、`draft`、`confirm: true`；
  - 旧字段 `categoryConfirmed` 与 `confirmedNoQrCodes` 前端不伪造发送 `true`（传 undefined）。

### 3.3 地址 Review 与技术字段折叠
- **官方账号地点预填**：准备成功后，自动将后台拉取到的官方当前账号预填发货地点回填至发货地址展示区；
- **关键地址与坐标可调整**：用户可直接查看并调整省（`prov`）、市（`city`）、区（`area`）、地点商圈（`poiName`）及经纬度（`gps`）；
- **技术字段折叠只读**：底层技术字段（如 `divisionId`、`poiId` 等系统匹配标识）收拢至 `<details class="address-tech-details">` 折叠面板中以代码块只读展示，绝不出现空技术参数强求用户手填；
- **真实缺失拦截但保留内容**：若返回或用户修改后的发货地址缺少关键行政区（省市区非空），`canSubmit` 变更为 `false` 并展示清晰提示阻止提交，但输入内容完整保留，不强制清空草稿。

### 3.4 失败容错与 Partial Draft 保留
- **保留已准备部分**：prepare 失败时（如图片上传部分失败或特定接口超时），后台若返回了 partial `draft` 或 `propertyCards`，控制器原样保留展示，绝不清空界面；
- **清晰失败原因与平台验证引导**：
  - 控制器与界面展示 `failureStage`（错误阶段）与友好中文 `errorMessage`，不弹出晦涩的技术字段或堆栈信息；
  - 若需要平台登录或安全滑块验证，提供明确的操作指引（引导前往闲鱼官方发布页处理验证），并提供“重新准备发布”重试按钮；
- **重试不会提交**：点击重试准备只调用 `executePrepare()`，绝不会自动将商品提交发布。

### 3.5 Unknown 同源草稿锁定（不可自动 Retry，去掉永久锁不实描述）
- **同源草稿特征哈希**：提交发布遭遇通信失联或后台返回 `unknown` 状态时，控制器派生双 32 位 FNV-1a 不可逆哈希摘要并持久化于 `sessionStorage`；
- **修正不实文案**：文案不再称“已永久锁定”，明确告知用户为防闲鱼重复发布已锁定该草稿，严禁自动重试；
- **禁止提交与手动解锁**：在锁定状态下，`canSubmit()` 强制为 `false`，强行提交直接被拦截。操作员人工在闲鱼核实未上架后，可点击“已人工核实未上架，解除锁定”进行解锁。

### 3.6 描述优先模式与取消独立标题门禁
- **取消独立标题输入与前后缀**：主页面与两阶段审核弹窗彻底取消独立标题输入框，规则区域移除标题前缀与后缀输入（保留售价倍率与浮动加减价），以商品描述（`description`）作为发布与审核的主要文本；
- **源标题内部识别与去 30 字门禁**：来源商品的 `title` 可作为内部识别透传，但不再作为发布有效性门禁；`canSubmit()` 移除 30 字符标题限制，仅要求 `description` 非空；
- **Prepare Product 不发独立标题**：`executePrepare` 阶段向后台发送的 `source.product` 仅包含 `description`、`price`、`images`、`specifications`，不发送独立 `title`；
- **后台最终统合为描述模式**：后台 `titleDescSeparate` 设置为 `false`，标题与描述均以最终描述内容发布；前端不再用源 `title` 覆盖后台返回的 `reviewedDraft`，并对 `reviewedDraft.title` 进行 optional 安全兼容。

### 3.7 成功反馈呈现可点击官方商品链接
- **官方链接规范**：发布成功后，弹窗与主页面结果面板均展示可点击的商品链接：`https://www.goofish.com/item?id=${encodeURIComponent(itemId)}`；
- **无障碍与外链安全**：链接均采用 `target="_blank"` 与 `rel="noopener noreferrer"`，且保留真实 `itemId` 便于快速复制。

### 3.8 图片列表管理与封面同步修复
- **输入校验与快捷操作**：支持 URL 输入、`trim` 规范化、强制 `https://` 校验、去重检查、9 张上限拦截，出现非法或重复输入时提供即时友好中文提示；支持输入框回车直接添加图片；
- **画廊与草稿即时同步**：加入后直接在图片画廊呈现，并同步更新控制器草稿与后续 prepare 请求；
- **删除首图同步封面**：删除画廊首图时，强制同步将封面（`coverUrl`）更新为下一张图片，杜绝旧首图在预览区或请求体重现。

### 3.9 业务拒绝（FAIL_BIZ / DRAFT_TITLE_INVALID）同 Token 原地恢复
- **业务拒绝不切页不锁**：最终发布被平台明确业务拒绝（如 `FAIL_BIZ_TITLE_LENGTH_TOO_LONG`、敏感词拦截等，返回 `status: 'rejected'` 且 `prepareTokenValid: true`），控制器将 phase 置为 `submit_rejected`，原编辑弹窗仅以 Callout 组件呈现错误，**绝不切页到 unknown 结果页，绝不关闭弹窗，绝不锁定草稿**；
- **保留同 Token 与可编辑草稿**：保持原 `prepareToken` 与 `reviewedDraft`，避免重复执行消耗接口与图片重新上传；
- **文案规范**：统一去除“若平台准备令牌已失效，请点击下方‘重新准备发布’”的旧统一尾文案，对业务拒绝统一提示“请修改后再次点击确认并发布”；
- **修正后即时重提**：用户在当前弹窗修改标题或其他被拒字段时，触发 `onDraftEdit()` 自动将 phase 转回 `reviewed` 并清空错误；用户再次点击“确认并发布”，后台直接换用新指纹复用同 token 发送发布请求，全程仅需调用 1 次 prepare；
- **Fail-Closed 令牌失效保护**：若后台显式返回 `prepareTokenValid: false`（如审计持久化失败导致无法安全恢复），控制器清空本地 token 禁用提交（`canSubmit()` 为 false），引导用户点击“重新准备发布”，但仍完整保留用户已填草稿内容。

---

## 4. 验证测试指令

在项目根目录下运行单测与类型检查：

```bash
# 运行 workbench 全量单测（包含 direct-publish 纯 Mock 24 大测试与页面契约测试）
npm run test --workspace @fishops/workbench

# 运行全项目 TypeScript 类型检查
npm run typecheck
```
