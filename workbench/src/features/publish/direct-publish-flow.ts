import type { PublishDraft } from './publish-draft-store'

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
