/**
 * Vue Composable: 直接发布（两阶段）控制器适配。
 */

import { onUnmounted, ref, shallowRef } from 'vue'
import {
  DirectPublishController,
  type DirectPublishControllerOptions,
} from './direct-publish-controller'

let sharedController: DirectPublishController | null = null

export function useDirectPublish(options?: DirectPublishControllerOptions) {
  const controller = options ? new DirectPublishController(options) : (sharedController ??= new DirectPublishController())

  const phase = ref(controller.getPhase())
  const sourceProduct = shallowRef(controller.getSourceProduct())
  const sellerForm = ref(controller.getSellerForm())
  const preConfirmedNoQrCodes = ref(controller.getPreConfirmedNoQrCodes())
  const prepareToken = ref(controller.getPrepareToken())
  const reviewedDraft = ref(controller.getReviewedDraft())
  const preparedImages = shallowRef(controller.getPreparedImages())
  const propertyCards = shallowRef(controller.getPropertyCards())
  const warnings = ref(controller.getWarnings())
  const failureStage = ref(controller.getFailureStage())
  const missingFields = ref(controller.getMissingFields())
  const categoryConfirmed = ref(controller.isCategoryConfirmed())
  const submitConfirmedNoQrCodes = ref(controller.isSubmitConfirmedNoQrCodes())
  const submitResult = shallowRef(controller.getSubmitResult())
  const publishedItemId = ref(controller.getPublishedItemId())
  const errorCode = ref(controller.getErrorCode())
  const errorMessage = ref(controller.getErrorMessage())
  const actionRequired = ref(controller.getActionRequired())
  const isDraftLocked = ref(controller.isDraftLocked())
  const canStartPrepare = ref(controller.canStartPrepare())
  const canSubmit = ref(controller.canSubmit())

  const sync = () => {
    phase.value = controller.getPhase()
    sourceProduct.value = controller.getSourceProduct()
    sellerForm.value = controller.getSellerForm()
    preConfirmedNoQrCodes.value = controller.getPreConfirmedNoQrCodes()
    prepareToken.value = controller.getPrepareToken()
    reviewedDraft.value = controller.getReviewedDraft()
    preparedImages.value = controller.getPreparedImages()
    propertyCards.value = controller.getPropertyCards()
    warnings.value = controller.getWarnings()
    failureStage.value = controller.getFailureStage()
    missingFields.value = controller.getMissingFields()
    categoryConfirmed.value = controller.isCategoryConfirmed()
    submitConfirmedNoQrCodes.value = controller.isSubmitConfirmedNoQrCodes()
    submitResult.value = controller.getSubmitResult()
    publishedItemId.value = controller.getPublishedItemId()
    errorCode.value = controller.getErrorCode()
    errorMessage.value = controller.getErrorMessage()
    actionRequired.value = controller.getActionRequired()
    isDraftLocked.value = controller.isDraftLocked()
    canStartPrepare.value = controller.canStartPrepare()
    canSubmit.value = controller.canSubmit()
  }

  const unsubscribe = controller.subscribe(sync)
  onUnmounted(() => {
    unsubscribe()
  })

  return {
    controller,
    phase,
    sourceProduct,
    sellerForm,
    preConfirmedNoQrCodes,
    prepareToken,
    reviewedDraft,
    preparedImages,
    propertyCards,
    warnings,
    failureStage,
    missingFields,
    categoryConfirmed,
    submitConfirmedNoQrCodes,
    submitResult,
    publishedItemId,
    errorCode,
    errorMessage,
    actionRequired,
    isDraftLocked,
    canStartPrepare,
    canSubmit,
  }
}
