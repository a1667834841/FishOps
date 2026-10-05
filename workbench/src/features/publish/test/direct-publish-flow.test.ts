import assert from "node:assert/strict"
import test from "node:test"
import type { PublishDraft } from "../publish-draft-store"
import { createDirectPublishFlowState, draftFlowKey, enterDraftFlow } from "../direct-publish-flow"
import { PublishDraftStore } from "../publish-draft-store"
import { publishProductDraft } from "../products-publish-entry"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const draft: PublishDraft = { source: "my_published", itemId: "item-1", title: "测试商品", desc: "描述", price: 10, imageUrls: ["cover"] }

test("单品发布进入核对 modal，同源切出再进入不重复 prepare", () => {
  const page = readFileSync(fileURLToPath(new URL("../../../pages/PublishPage.vue", import.meta.url)), "utf8")
  assert.match(page, /if \(d && enterDraftFlow\(directFlow, d\)\) onOpenPublishModal\(\)/)
  assert.match(page, /if \(key === lastLoadedDraftKey\) return/)
  assert.match(page, /<DirectPublishModal[\s\S]*:controller="directController"/)
  assert.match(page, /draftKey: ''[\s\S]*preparingKey: ''/)
  const state = createDirectPublishFlowState()
  assert.equal(enterDraftFlow(state, draft), true)
  state.modalOpen = false
  assert.equal(enterDraftFlow(state, draft), false)
  assert.equal(state.modalOpen, true)
  assert.equal(draftFlowKey(draft), 'my_published|||item-1')
})

test("商品库生产入口设置草稿并导航，不直接调用发布", () => {
  const store = new PublishDraftStore()
  const navigations: string[] = []
  publishProductDraft(draft, store, (page) => navigations.push(page))
  assert.equal(store.getDraft()?.itemId, draft.itemId)
  assert.deepEqual(navigations, ["publish"])
})


test("卸载清理订阅，发布队列及其按钮已移除", () => {
  const page = readFileSync(fileURLToPath(new URL("../../../pages/PublishPage.vue", import.meta.url)), "utf8")
  const products = readFileSync(fileURLToPath(new URL("../../../pages/ProductsPage.vue", import.meta.url)), "utf8")
  assert.match(page, /onUnmounted\(\(\) => \{[\s\S]*unsubscribeDraftStore\(\)/)
  assert.doesNotMatch(page, /publish-queue-store|queueState|unsubscribeQueue/)
  assert.doesNotMatch(products, /批量加入发布队列|title="加入发布队列"|>入队</)
})
