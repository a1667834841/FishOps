# M5 legacy 发布协议取证报告

## 1. 取证范围与安全边界

本报告只做源码取证，不修改业务代码，不发送网络请求。

取证文件：

- `legacy/extension/src/background/direct-publish-page.ts`
- `legacy/extension/src/background/direct-publish-api.ts`
- `legacy/extension/src/background/published-items-reader.ts`
- `legacy/shared/types/direct-publish.ts`
- `legacy/extension/src/platform/xianyu/my-items.ts`
- `apps/extension/src/publish-page-executor.ts`
- `apps/host/src/publish-service.ts`
- `packages/protocol/src/publish.ts`

核心函数定位：

- `legacy/extension/src/background/direct-publish-page.ts`
  - `injectDirectPublishInPage()`：`:203`
  - `selectImages()`：`:570`
  - `resolveItemSource()`：`:603`
  - `normalizeAddress()`：`:637`
  - `uploadSingleImage()`：`:716`
  - `opPrepare()`：`:851`
  - `opSubmit()`：`:1542`
- `legacy/extension/src/background/direct-publish-api.ts`
  - `applySelectionToRawCards()`：`:733`
  - `sanitizeAddress()`：`:779`
  - `buildLabelItemFromCard()`：`:806`
  - `normalizeSubmitDraft()`：`:930`
  - `prepare()`：`:1845`
  - `submit()`：`:2004`
- `legacy/extension/src/background/published-items-reader.ts`
  - `findOnSaleGroupId()`：`:92`
  - `readOnSaleItems()`：`:194`
- `legacy/extension/src/platform/xianyu/my-items.ts`
  - `findOnSaleGroupId()`：`:36`
  - `readAllOnSaleCards()`：`:82`
- `legacy/shared/types/direct-publish.ts`
  - `DirectPublishReviewDraft`：`:19`
  - `DirectPublishPreparedResult`：`:81`
  - `DirectPublishSubmitRequest`：`:103`
- `apps/extension/src/publish-page-executor.ts`
  - `executePrepare()`：`:208`
  - `executeSubmit()`：`:338`
  - `executeMyItems()`：`:428`
- `apps/host/src/publish-service.ts`
  - `submitStepParams()`：`:157`
  - `collectMyItems()`：`:199`

安全边界：

- 不输出 cookie、token、签名、`unb` 明文、完整地址或商品正文。
- 本文只记录协议形状与脱敏字段名。
- 不把官方商品库读取失败解释为空列表。
- 不把 `SUCCESS` 或 URL 跳转等同于发布成功。

## 2. legacy 两阶段状态机

`legacy/shared/types/direct-publish.ts` 的 `DirectPublishPrepareRequest`、`DirectPublishPreparedResult`、`DirectPublishSubmitRequest`、`DirectPublishReviewDraft` 定义了两阶段契约。

`legacy/extension/src/background/direct-publish-api.ts` 的 `createDirectPublishApi().prepare()` 与 `.submit()`：

1. `prepare()` 先做输入校验，再按 `accountScope + idempotencyKey` 复用已准备结果。
2. `prepare()` 调用页面脚本的 `op: 'prepare'`，页面脚本执行 `opPrepare`。
3. 后台把页面结果中的 `draft/images/propertyCards/rawCards/services/address` 存入 prepared entry。
4. `prepare()` 只返回 `prepareToken/draft/propertyCards/warnings`，不返回原始 MTOP 响应。
5. `submit()` 用 `prepareToken` 找回权威 entry，调用 `normalizeSubmitDraft`，再用 `applySelectionToRawCards` 刷新推荐卡点击状态。
6. `submit()` 调用页面脚本的 `op: 'submit'`，参数为 `submitCore` 与 `rawCards`。
7. 页面脚本 `opSubmit` 组装最终请求并调用 `mtop.idle.pc.idleitem.publish`。
8. 只有 `data.itemId` 非空才返回 `published`。

权威约束已写在 `legacy/shared/types/direct-publish.ts` 顶部注释：草稿中的 `category/attributes/images` 只是候选选择，后台必须按 prepare 缓存重建。

## 3. myItems：发现“在售”groupId 与完整分页

### 3.1 接口与请求体

`legacy/extension/src/background/published-items-reader.ts` 与 `legacy/extension/src/platform/xianyu/my-items.ts` 一致确认：

- API：`mtop.idle.web.xyh.item.list`
- 版本：`1.0`
- 每页上限：`20`
- 分页字段：`data.nextPage === true`
- 商品位置：`data.cardList[].cardData`
- 商品 id：`cardData.id`
- 商品标题：`cardData.title`
- `data.totalCount` 恒为 `0`，不可作为总数。

第一步是发现分组，见 `published-items-reader.ts` 的 `readOnSaleItems()`：

```ts
{
  needGroupInfo: true,
  pageNumber: 1,
  userId,
  pageSize,
  defaultGroup: true
}
```

从 `data.itemGroupList` 中找：

```ts
group.groupName === '在售' && typeof group.groupId === 'number'
```

`groupId` 随账号变化，绝不能硬编码。`published-items-reader.ts` 的 `findOnSaleGroupId()` 在找不到时抛错；`legacy/extension/src/platform/xianyu/my-items.ts` 的 `findOnSaleGroupId()` 在分组列表完整但未列出“在售”时返回 `null`，`readAllOnSaleCards()` 将其解释为真实 0 件。两种 legacy 语义不同，新实现应优先采用后者，但必须保留结构异常失败：

- `data.itemGroupList` 缺失或非数组：失败，不返回空。
- 分组列表存在但没有“在售”：可视为 0 件。

第二步是分页读取，见 `readOnSaleItems()` 与 `readAllOnSaleCards()`：

```ts
{
  needGroupInfo: false,
  pageNumber,
  userId,
  pageSize,
  groupName: '在售',
  groupId,
  defaultGroup: false
}
```

分页规则：

1. 每页最多 20 条。
2. `nextPage === true` 才继续。
3. 达到 `maxPages` 仍 `nextPage === true`：抛错或返回未知，不得截断冒充完整列表。
4. 按 `itemId` 去重。
5. `cardList` 结构异常不能静默降级为空列表。

### 3.2 新架构当前实现的错误

`apps/extension/src/publish-page-executor.ts` 的 `executeMyItems()` 当前发送：

```ts
{ status: 'on_sale', pageSize: params.limit, pageNum: 1 }
```

它解析 `data.items`、`data.hasMore`、`data.total`，只取第 1 页，完全不符合真实协议：

- 没有 `needGroupInfo/defaultGroup` 分组发现。
- 没有 `itemGroupList`，无法得到动态 `groupId`。
- 没有 `cardList[].cardData`。
- 没有 `nextPage`。
- 直接把 `hasMore` 当作官方分页字段，属于假定字段。

`apps/host/src/publish-service.ts` 的 `collectMyItems()` 期望页面返回 `{ items, hasMore, nextPage? }`，并通过 `nextPage` 令牌循环。该 host 形状可以保留，但页面执行器必须把官方 `pageNumber/groupId` 转成 host 内部令牌，并且只返回最小 `itemId/title`。

## 4. prepare 必须完成的接口与顺序

legacy 的真实顺序在 `legacy/extension/src/background/direct-publish-page.ts` 的 `opPrepare`：

1. 校验 host 为 `www.goofish.com`。
2. 等待 `window.lib.mtop.request`。
3. 读取登录标识 `unb`。
4. `verifyAccount('prepare')` 校验账号未漂移。
5. 调用 `mtop.idle.pc.idleitem.prepublish.check`，版本 `1.0`。
   - `data.limited === true` 时必须停止，要求实人认证或人工处理。
6. 调用 `mtop.idle.pc.idleitem.preget`，版本 `1.0`。
   - 非登录、非风控失败只记录 warning。
   - 登录、验证码、风控类失败必须中断。
7. 解析来源：
   - `source.product` 直接归一化。
   - `source.itemId` 调用 `mtop.taobao.idle.pc.detail`，版本 `1.0`，参数 `{ itemId }`。
   - 从 `data.itemDO` 取 `desc/title`、`soldPrice`、`imageInfos[].url`、`itemLabelExtList`。
8. 生成 partial draft，即使后续失败也可返回已准备部分。
9. 调用违禁词检查：
   - API：`mtop.taobao.idleitem.badwords.prepubcheck`
   - 版本：`2.0`
   - 参数：`{ title: finalDescription, scene: 'pcPublish', sessionId: Date.now() + unb }`
   - `data.forbidPublish === true` 必须拒绝。
   - 无有效 `data` 必须 fail-closed。
10. 下载并真实上传图片。
11. 调用类目/属性推荐。
12. 校验类目卡。
13. 选择类目与属性。
14. 读取或归一化发货地址。
15. 调用服务卡接口。
16. 返回 `payload/draft/propertyCards/rawCards/accountScope/itemCount/catId/warnings`。

### 4.0 账号、图片、类目、属性、地址、服务卡的顺序

按 `opPrepare` 的实际执行顺序归纳：

1. 账号：校验 host、SDK、`unb`，派生 `accountScope`，再调用 `verifyAccount('prepare')`。
2. 来源：`preget` 后解析 `source.product` 或 `source.itemId` 的详情。
3. 文案：先拼接“描述 + 规格”用于 prepare 期检查，最终 submit 时再从原始描述追加一次。
4. 违禁词：在图片上传前对 prepare 期最终描述执行 `badwords.prepubcheck`。
5. 图片：下载、校验大小与 MIME、读取真实宽高、逐张上传，第一张设 `major=true`。
6. 类目与属性：用已上传图片和描述调用 `kgraph.property.recommend`，先归一化候选，再选择类目，最后选择属性。
7. 地址：在类目、属性 label items 完成后处理；显式地址优先，其次是显式坐标对应 `selectedPoi`，其余 `reviewMode` 才读取账号默认 `selectedPoi`。
8. 服务卡：最后用 `rawCards`、完整 `intermediateItemInfo` 调用 `service.cards.list`，服务默认关闭，`AI_SALE` 强制关闭。
9. 输出：prepare 只返回已准备草稿与候选，不调用最终 publish。

### 4.1 图片处理

`direct-publish-page.ts` 的 `selectImages()` 与 `uploadSingleImage()`：

- 最多 9 张。
- 单张不超过 10MB。
- 允许 `image/jpeg`、`image/jpg`、`image/png`、`image/webp`、`image/gif`。
- 远程图片只允许 HTTPS；已知阿里/闲鱼媒体主机可把 HTTP 升级为 HTTPS。
- 下载超时 30 秒。
- 上传超时 30 秒。
- 图片必须取得真实像素宽高，取不到就失败，不能伪造尺寸。
- 上传成功必须来自上传响应 `success === true` 且有 `object`。
- 最终图片对象必须包含：

```ts
{
  extraInfo: { isH: 'false', isT: 'false', raw: 'false' },
  isQrCode: false,
  url: string,
  heightSize: number,
  widthSize: number,
  major: boolean,
  type: 0,
  status: 'done'
}
```

prepare 返回的 `draft.images` 是真实上传结果；未上传的源图只能以 `{ url, pending: true }` 出现在 partial draft，不能提交。

### 4.2 类目与属性推荐

`opPrepare` 调用：

- API：`mtop.taobao.idle.kgraph.property.recommend`
- 版本：`2.0`
- 参数：

```ts
{
  title: finalDescription,
  description: finalDescription,
  imageInfos: uploadedImages,
  lockCpv: false,
  multiSKU: false,
  publishScene: 'mainPublish',
  scene: 'newPublishChoice',
  uniqueCode: generatedCode
}
```

响应必须从 `data.cardList` 读取。推荐卡归一化为 `propertyCards`：

```ts
{
  cardType: string,
  propertyId: string,
  propertyName: string,
  isCategory: boolean,
  isBook: boolean,
  supportWebPublish: boolean,
  tips: string,
  values: Array<{
    valueId: string,
    valueName: string,
    transportData: Record<string, unknown>,
    isCategory: boolean,
    catId?: string,
    channelCatId?: string,
    catName?: string,
    leafId?: string,
    tbCatId?: string
  }>
}
```

类目限制：

- 类目卡 `propertyId === '-10000'`。
- 只支持 `cardType === '20401'`。
- `isBook === true` 拒绝。
- `supportWebPublish === false` 拒绝。
- 无有效 `catId` 拒绝。

候选构造见 `buildCandidate()`：

- 类目的 `valueId` 取 `channelCatId || catId || valueId`。
- 属性的 `valueId` 取 `valueId || id`。
- `transportData` 必须深拷贝原值，不能信任前端重传。

### 4.3 发货地址

`opPrepare` 与 `direct-publish-api.ts` 的 `sanitizeAddress()` 都要求 7 个字段：

```ts
prov, city, area, divisionId, poiName, poiId, gps
```

`gps` 必须是 `lat,lng`，纬度范围 `[-90, 90]`，经度范围 `[-180, 180]`。

地址来源优先级：

1. 显式 `seller.address`：白名单归一化后使用。
2. 显式 `seller.coordinates`：调用 `mtop.taobao.idle.local.poi.get`，版本 `1.0`。
   - 参数为 `{ longitude, latitude }`。
   - 只接受 `data.selectedPoi`。
   - 不接受 `commonAddresses` 或 `nearbyAddresses`。
3. `reviewMode` 且没有 seller：空参调用 `poi.get`。
   - 同样只接受 `data.selectedPoi`。
   - 不继承源商品卖家地址。
4. 都没有：拒绝，要求配置地址或坐标。

### 4.4 服务卡

`opPrepare` 调用：

- API：`mtop.idle.item.publish.service.cards.list`
- 版本：`1.0`
- 参数：

```ts
{
  cpvList: JSON.stringify(rawCardList),
  itemInfoJson: JSON.stringify(intermediateItemInfo),
  param: JSON.stringify({
    multiSkuEditingMode: 'false',
    settingsPreferences: null,
    supportDefaultOpen: true
  })
}
```

`intermediateItemInfo` 必须使用已经上传的图片、已选地址、类目、属性与最终描述，形如：

```ts
{
  freebies: false,
  itemTypeStr: 'b',
  quantity: '1',
  simpleItem: 'true',
  itemTextDTO: {
    desc: finalDescription,
    title: finalDescription,
    titleDescSeparate: false
  },
  itemPriceDTO: { priceInCent },
  itemPostFeeDTO: {
    canFreeShipping: true,
    supportFreight: true,
    onlyTakeSelf: false
  },
  itemAddrDTO,
  itemCatDTO,
  itemLabelExtList,
  imageInfoDOList,
  defaultPrice: false,
  publishScene: 'mainPublish'
}
```

服务候选来自 `data.services`，每项至少取 `code`。prepare 返回的 `draft.services` 默认全部关闭；`AI_SALE` 永远强制 `false`。

## 5. prepare 必须产出的权威数据

`legacy/shared/types/direct-publish.ts` 的 `DirectPublishReviewDraft` 是人工审核草稿，不是最终可信 payload。它的字段：

- `title`：已废弃，submit 忽略。
- `description`：原始文案，不含规格追加。
- `price`：元字符串。
- `specifications`：`{ name, value }[]`。
- `category`：类目选择，必须命中候选。
- `attributes`：属性选择快照，提交前必须按候选重建。
- `address`：7 字段地址。
- `images`：真实上传图片对象。
- `services`：`{ serviceCode, enable }[]`。

prepare 还必须返回并缓存：

- `propertyCards`：权威类目/属性候选，包含 `transportData`。
- `rawCards`：推荐接口原始 `cardList`，submit 前的服务卡请求必须使用。
- 真实上传 `images`。
- 可用服务集合。
- 7 字段 `address`。
- `accountScope` 与后台 token 绑定。

`legacy/extension/src/background/direct-publish-api.ts` 的 `DirectPublishPreparedEntry` 明确保存：

```ts
{
  accountScope,
  draft,
  images,
  propertyCards,
  rawCards,
  services,
  address
}
```

`basePayload` 只用于旧一步式；`toStoredPreparedEntry()` 明确说明 submit 不依赖它，持久化时也不保存它。

## 6. submit 最终 payload 的重建过程

最终 payload 不能由调用方直接拼。必须按以下步骤重建。

### 6.1 校验草稿

`direct-publish-api.ts` 的 `normalizeSubmitDraft()`：

1. `description` 必须是字符串，trim 后非空。
2. `title` 一律忽略。
3. `price` 必须是元字符串，最多两位小数，数值大于 0。
4. `specifications` 每项 `name/value` 必须非空。
5. 最终描述为：

```ts
description + '\n' + specifications.map(s => `${s.name}：${s.value}`).join('\n')
```

规格只追加一次，拼接后总长度不超过 `DRAFT_DESCRIPTION_MAX = 5000`。

### 6.2 重建类目

类目必须命中 prepare `propertyCards` 中的类目卡候选。重建字段：

```ts
itemCatDTO = {
  catId: candidate.catId || candidate.valueId,
  catName: candidate.catName || candidate.valueName,
  channelCatId: candidate.channelCatId || candidate.valueId,
  leafId: candidate.leafId || '0',
  tbCatId: candidate.tbCatId || ''
}
```

### 6.3 重建属性 label item

属性必须按 `propertyId + valueId` 命中 prepare 候选。`buildLabelItemFromCard()` 使用候选 `transportData` 重建：

```ts
{
  ...candidate.transportData,
  propertyName: card.propertyName,
  propertyId: card.propertyId,
  isUserClick: '1',
  isUserCancel: '0',
  text: candidate.valueName,
  properties: `${card.propertyId}##${card.propertyName}:${candidate.valueId}##${candidate.valueName}`
}
```

类目 label item 额外补 `channelCateId/channelCateName`；普通属性补 `valueId/valueName`。`itemLabelExtList` 的顺序是类目在前，属性在后。

前端传来的 `transportData`、`imageInfoDOList`、`itemCatDTO` 都不能信任。

### 6.4 重建地址与图片

- 地址再次走 `sanitizeAddress()`，只保留 7 字段。
- 图片只能按 `url` 命中 prepare 缓存。
- 图片去重，最多 9 张。
- 第一张 `major = true`，其余 `false`。

### 6.5 重建服务

- 只能启用 prepare 已确认可用的 `serviceCode`。
- 重复服务去重。
- `AI_SALE` 强制 `false`。
- submit 前重新调用 `service.cards.list`。
- 已开启但复检不可用：返回 `SERVICE_UNAVAILABLE`，不静默删除。
- 复检新出现但用户未确认的服务：不自动追加。

### 6.6 刷新 rawCards

`direct-publish-api.ts` 的 `applySelectionToRawCards()` 从 prepare 原始 `rawCards` 深拷贝，再按最终选择更新：

- 类目 `valueId` 取 `channelCatId || catId || valueId`。
- 属性 `valueId` 取 `valueId || id`。
- 命中项设 `isClicked = '1'`，并设 `isUserClick = '1'`。
- 未命中项设 `isClicked = '0'`。

这一步用于 submit 前的 `service.cards.list`，避免旧推荐状态被复用。

### 6.7 页面最终 payload

`direct-publish-page.ts` 的 `opSubmit` 在提交前重新执行：

1. `prepublish.check`。
2. 违禁词复检。
3. 价格转分。
4. 组装 `intermediateItemInfo`。
5. `service.cards.list` 复检。
6. 组装最终 payload。
7. 最终账号核验。
8. 调用 `mtop.idle.pc.idleitem.publish`，版本 `1.0`。

最终 payload 形状：

```ts
{
  freebies: false,
  itemTypeStr: 'b',
  quantity: '1',
  simpleItem: 'true',
  itemTextDTO: {
    desc: finalDescription,
    title: finalDescription,
    titleDescSeparate: false
  },
  itemPriceDTO: { priceInCent },
  itemPostFeeDTO: {
    canFreeShipping: true,
    supportFreight: true,
    onlyTakeSelf: false
  },
  itemAddrDTO,
  itemCatDTO,
  itemLabelExtList,
  imageInfoDOList,
  publishScene: 'pcMainPublish',
  userRightsProtocols,
  sourceId: 'pcMainPublish',
  bizcode: 'pcMainPublish',
  uniqueCode: generatedCode
}
```

成功判据只有一个：`mtop.idle.pc.idleitem.publish` 返回的 `ret[0]` 以 `SUCCESS` 开头，且 `data.itemId` 非空。

超时、网络异常、`SUCCESS` 但缺 `itemId` 都返回 `unknown`，禁止自动重试。

新架构另外要求“提交后官方在售列表新增唯一 itemId”作为最终验收，见 `apps/host/src/publish-service.ts` 的 `submit()`；该 host 判据比 legacy 页面 `opSubmit` 的 `data.itemId` 更严格。

## 7. legacy 与新架构差异

### 7.1 prepare

`apps/extension/src/publish-page-executor.ts` 的 `executePrepare()` 当前只有：

1. `prepublish.check`。
2. `mtop.taobao.idle.pc.category.recommend`，版本 `1.0`，参数 `{ itemId }`。
3. `service.cards.list`，参数 `{ itemId }`。

它与 legacy 不一致：

- legacy 使用 `mtop.taobao.idle.kgraph.property.recommend`，不是 `category.recommend`。
- legacy 从 `source.itemId` 调 `mtop.taobao.idle.pc.detail` 读取源商品。
- legacy 必须执行 `preget`、违禁词、图片下载与上传、地址 `poi.get`、推荐、服务卡完整链路。
- 当前 executor 不产出真实图片对象、`propertyCards`、`rawCards`、地址与服务默认值。
- 当前 executor 返回 `prepareToken = 'pending'`、`draftFingerprint = 'pending'`，不可用于真实 submit。
- 当前 executor 的 `extractStringArray()` 从 `categoryRefs/attributeRefs/serviceRefs` 取值，疑似假定字段；legacy 使用 `cardList/services`，二者不兼容。

### 7.2 submit

`apps/extension/src/publish-page-executor.ts` 的 `executeSubmit()` 当前发送：

```ts
{
  prepareToken,
  draftFingerprint,
  idempotencyKey,
  uniqueCode
}
```

这不是平台发布 payload。真实 submit 必须由 host 内部 prepared 上下文重建：

- 最终描述
- `itemPriceDTO`
- `itemAddrDTO`
- `itemCatDTO`
- `itemLabelExtList`
- `imageInfoDOList`
- `userRightsProtocols`
- 刷新后的 `rawCards`

`apps/host/src/publish-service.ts` 的 `submitStepParams()` 当前只传：

```ts
{
  prepareToken,
  draftFingerprint,
  source: { itemId },
  draft,
  candidates,
  confirm
}
```

这些是 host 级参数，不是平台 payload。它也没有保存 legacy 所需的 `rawCards/images/propertyCards.transportData/address/services` 权威集合，因此无法独立重建最终发布请求。

### 7.3 myItems

当前 executor 的 `executeMyItems()` 协议错误，见第 3 节。host 的 `collectMyItems()` 已实现分页令牌循环与完整基线校验，但页面执行器没有提供正确的官方 `itemGroupList/cardList/nextPage` 读取。

## 8. 不能直接跨进程传递的 legacy 字段

以下对象或数据属于页面运行时、凭据或页面专用能力，不能通过 `chrome.scripting.executeScript`、host、native 或公共协议直接传递：

- `window.lib.mtop.request`、`window`、SDK 实例、函数、闭包。
- DOM、`Image`、`XMLHttpRequest`、`FormData`、`Blob`、`AbortController`、object URL。
- Cookie、`unb` 明文、MTOP token、签名、`sessionId` 中的明文登录标识。
- 原始 MTOP 响应、原始异常、完整请求 URL。
- 完整商品正文、完整地址、cookie 派生 secret。
- prepareToken 的真实随机值由 host/扩展内部签发，不能由页面或调用方伪造。
- `accountScope` 必须由 host 绑定当前账号；调用方不得指定 `accountId/userId`。
- legacy `basePayload/preparedPayload` 只属于旧一步式内存路径，新架构不应依赖或跨进程传递。
- `cardData.isClicked/isUserClick` 不能直接复用旧推荐状态；必须按最终选择从 `rawCards` 克隆并重算。

可以跨 `executeScript` 传递但必须作为内部权威数据保存、不得暴露给外部 Agent 的结构：

- `propertyCards` 与 `transportData`。
- `rawCards`。
- 真实上传图片对象。
- `itemCatDTO`、`itemLabelExtList`。
- 7 字段地址。

这些数据可以被 structured clone，但不应进入公共协议结果、日志或持久化明文。

## 9. 实现真实 prepare/submit/myItems 的必需改造要点

1. `executeMyItems()` 改成两阶段读取：
   - 先 `needGroupInfo/defaultGroup` 发现“在售”groupId。
   - 再按 `pageNumber/groupId/groupName` 分页。
   - 返回 host 内部 `{ items, hasMore, nextPage }`，不暴露 userId/token。
2. `executePrepare()` 按 legacy `opPrepare` 顺序补齐：
   - `preget`
   - 源商品详情
   - 违禁词
   - 图片上传
   - `kgraph.property.recommend`
   - 类目卡校验
   - 地址 `poi.get`
   - 服务卡
3. prepare 返回不可直接提交的草稿与权威候选，host 保存：
   - 真实上传图片
   - `propertyCards`
   - `rawCards`
   - 可用服务
   - 地址
   - accountScope 绑定
4. `submitStepParams()` 不能只传 token/draft；必须由 host 内部 prepared 上下文重建最终平台 payload，或向页面传递可验证的内部引用与完整权威集合。
5. `executeSubmit()` 必须按第 6 节组装真实 `mtop.idle.pc.idleitem.publish` payload，不能把 `prepareToken/draftFingerprint` 发给平台。
6. host 必须继续以“提交前后官方在售列表新增唯一 itemId”确认发布成功；页面 `data.itemId` 只能作为辅助证据。

## 10. 风险与待验证项

- 当前 executor 的 myItems 协议错误，真实环境会读到空或失败结果。
- 当前 executor 的 prepare 使用错误推荐接口与假定字段，无法产出真实可提交候选。
- 当前 executor 的 submit payload 错误，不能真实发布。
- host 当前 prepared 记录只保存脱敏摘要与 refs，不足以重建最终 payload；真实 submit 需要新增 host 内部权威 prepared 上下文。
- `rawCards/transportData` 属于内部权威数据，不能通过公开协议泄露。
- `totalCount` 不可信，不能用于分页终止或总数展示。
- “在售”分组缺失存在两种 legacy 语义：`published-items-reader.ts` 抛错，`platform/xianyu/my-items.ts` 视为 0 件。建议新实现采用后者，但保留 `itemGroupList/cardList` 结构异常失败。
- 官方 SDK 可能内部重放请求；超时或断线必须返回 unknown，不自动重试。
- 当前报告基于源码取证，未执行真实网络请求，也未验证平台接口现状是否已变化。
