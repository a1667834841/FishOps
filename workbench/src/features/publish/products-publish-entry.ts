import type { PublishDraft } from './publish-draft-store'
import { PublishDraftStore } from './publish-draft-store'

export interface DirectPublishFlowState {
  draftKey: string
  modalOpen: boolean
  preparingKey: string
}

export function createDirectPublishFlowState(): DirectPublishFlowState {
  return { draftKey: '', modalOpen: false, preparingKey: '' }
}

export function draftFlowKey(draft: PublishDraft | null): string {
  if (!draft) return ''
  return `${draft.source}|${draft.targetTableId ?? ''}|${draft.recordId ?? ''}|${draft.itemId ?? ''}`
}

/** 草稿进入发布页即打开人工核对界面；重复进入同一草稿不重复准备。 */
export function enterDraftFlow(state: DirectPublishFlowState, draft: PublishDraft): boolean {
  const key = draftFlowKey(draft)
  state.modalOpen = true
  if (state.draftKey === key) return false
  state.draftKey = key
  state.preparingKey = key
  return true
}

/** 生产入口：单品发布写入共享草稿后导航；不调用 prepare/submit，门禁仍由发布页控制器负责。 */
export function publishProductDraft(
  draft: PublishDraft,
  draftStore: Pick<PublishDraftStore, 'setDraft'>,
  navigate: (page: 'publish') => void,
): void {
  draftStore.setDraft(draft)
  navigate('publish')
}
