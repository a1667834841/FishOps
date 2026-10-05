/**
 * PublishPage 发布草稿生命周期回归测试（P0）。
 *
 * 背景：商品成功发布后切换到其他菜单，再回到发布中心会再次触发发布准备（prepare），
 * 存在对已发布商品重复准备甚至重复发布的风险。根因：
 * 1. 发布成功后未清理 App 的 pendingDraft 与 typed store，页面重新挂载时恢复旧草稿；
 * 2. 页面未注销 publishDraftStore 订阅，切换页面会累积旧回调，放大重复加载；
 * 3. 同一草稿被 props.draft 初始加载与 store 订阅的 immediate 回调重复 loadDraft。
 *
 * 项目当前没有组件运行测试环境（无 @vue/test-utils），沿用 publish-layout.test.ts
 * 的源码级断言模式，锁定 PublishPage.vue 中的关键生命周期不变量。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { startPublishReturnCountdown } from '../direct-publish-countdown'

const here = dirname(fileURLToPath(import.meta.url))
const pageSource = readFileSync(resolve(here, '../../../pages/PublishPage.vue'), 'utf8')

/** 取出 onUnmounted(...) 回调体，用于断言卸载清理逻辑。 */
function onUnmountedBody(sfc: string): string {
  const start = sfc.indexOf('onUnmounted(')
  assert.ok(start >= 0, 'PublishPage.vue 必须注册 onUnmounted 生命周期钩子')
  const end = sfc.indexOf('\n})', start)
  assert.ok(end > start, '未找到 onUnmounted 回调结束位置')
  return sfc.slice(start, end)
}

test('P0 回归：发布成功后清理跨页面待发布草稿，避免切页回来再次 prepare', () => {
  assert.ok(pageSource.includes('watch(directPhase'), '必须监听 directPhase 以感知发布成功')
  const watchBlock = pageSource.match(/watch\(directPhase,[\s\S]{0,240}?\}/)
  assert.ok(watchBlock, '未找到 watch(directPhase) 代码块')
  assert.ok(watchBlock![0].includes("'published'"), '成功态判定必须是 published')
  assert.ok(
    watchBlock![0].includes("emit('clearDraft')"),
    'published 成功后必须 emit clearDraft 清理 App pendingDraft 与 store，使切页回来不再恢复已发布商品',
  )

  // 清理动作必须发生在成功态分支，而不是在成功前清空（否则会丢失当前页面成功反馈）
  const publishedIdx = watchBlock![0].indexOf("'published'")
  const emitIdx = watchBlock![0].indexOf("emit('clearDraft')")
  assert.ok(emitIdx > publishedIdx, 'clearDraft 必须在 published 分支内触发')
})

test('P0 回归：离开发布页注销 store 订阅并取消在途 prepare', () => {
  // 约束 3：保存 subscribe 返回的取消函数
  assert.ok(
    /const\s+unsubscribeDraftStore\s*=\s*publishDraftStore\.subscribe\(/.test(pageSource),
    '必须保存 publishDraftStore.subscribe 返回的取消函数',
  )

  const body = onUnmountedBody(pageSource)
  assert.ok(
    body.includes('unsubscribeDraftStore()'),
    'onUnmounted 必须注销 publishDraftStore 订阅，避免切页累积旧回调放大重复加载',
  )
  assert.ok(
    body.includes('directController.cancel()'),
    'onUnmounted 必须取消在途 prepare，避免离开页面后继续请求',
  )
})

test('P0 回归：submitting 不受卸载取消影响（cancel 内部对 submitting 直接返回）', () => {
  // PublishPage 直接调用既有 cancel()，其内部在 submitting 阶段不取消提交，
  // 保证离开页面不会中断正在进行的发布提交。
  const body = onUnmountedBody(pageSource)
  assert.ok(body.includes('directController.cancel()'), 'onUnmounted 应调用 cancel()')
  assert.ok(
    !body.includes('directController.manualUnlockDraft()'),
    '卸载时绝不应调用 manualUnlockDraft，避免误解除 unknown 锁',
  )
})

test('P0 回归：props.draft 初始加载与 store immediate 回调不会重复 loadDraft', () => {
  assert.ok(pageSource.includes('lastLoadedDraftKey'), '必须按 draft identity 记录最近载入草稿以去重')
  assert.ok(pageSource.includes('function ensureLoadDraft'), '必须通过统一的 ensureLoadDraft 载入草稿')

  const subscribeIdx = pageSource.indexOf('publishDraftStore.subscribe(')
  const initIdx = pageSource.indexOf('ensureLoadDraft(initialDraft)')
  assert.ok(subscribeIdx >= 0, '必须订阅 publishDraftStore')
  assert.ok(initIdx > subscribeIdx, '应先订阅 store（immediate）再初始载入，同一草稿不会重复 loadDraft')

  // 草稿被清空时应重置去重键，允许同款草稿之后再次载入
  assert.ok(
    /if\s*\(!d\)\s*\{[\s\S]{0,120}?lastLoadedDraftKey\s*=\s*''/.test(pageSource),
    '收到 null 草稿时必须重置去重键，保证清空后同款草稿可再次载入',
  )
})

test('发布成功后 5 秒倒计时，结束时自动展开任务历史（纯前端，无重复 interval）', () => {
  // 倒计时状态：秒数 + 任务历史展开标记
  assert.ok(/const\s+countdownSeconds\s*=\s*ref\(0\)/.test(pageSource), '必须用 countdownSeconds ref 保存剩余秒数')
  assert.ok(/const\s+taskHistoryOpen\s*=\s*ref\(true\)/.test(pageSource), '发布中心默认展示任务列表：taskHistoryOpen 初始必须为 true')
  assert.ok(pageSource.includes('clearCountdownTimer'), '必须保存计时器清理函数，便于卸载清理')

  // 明确的中文倒计时提示
  assert.ok(pageSource.includes('秒后返回发布中心任务列表'), '必须展示“N 秒后返回发布中心任务列表”中文提示')

  // 倒计时结束后展开任务历史，且 details 通过 :open 绑定
  assert.ok(pageSource.includes('taskHistoryOpen'), '倒计时状态必须包含发布任务历史展开控制')
  assert.ok(pageSource.includes(':open="taskHistoryOpen"'), 'details 必须通过 :open 绑定 taskHistoryOpen')

  // 仅从“非 published”进入 published 时启动一次，避免重复创建 interval
  assert.ok(
    pageSource.includes("previousPhase !== 'published'"),
    '必须仅在非 published -> published 跃迁时启动倒计时，避免重复启动',
  )
  assert.ok(
    /function\s+startReturnCountdown[\s\S]{0,120}?clearCountdownTimer\(\)/.test(pageSource),
    'startReturnCountdown 必须先清理旧计时器，避免重复创建 interval',
  )

  // 页面卸载必须清理计时器，避免倒计时中离开页面残留
  const body = onUnmountedBody(pageSource)
  assert.ok(body.includes('clearCountdownTimer()'), 'onUnmounted 必须清理倒计时计时器')
})

test('发布中心默认展开任务列表，且默认仍走正常选品流程（区分默认展开与成功后视图）', () => {
  // 默认任务列表：taskHistoryOpen 初始 true
  assert.ok(
    /const\s+taskHistoryOpen\s*=\s*ref\(true\)/.test(pageSource),
    '发布中心默认展示任务列表：taskHistoryOpen 初始必须为 true',
  )
  // 成功后“仅任务列表”视图标记：默认 false，不阻止新挂载/从商品库进入时选品
  assert.ok(
    /const\s+showTaskListOnly\s*=\s*ref\(false\)/.test(pageSource),
    'showTaskListOnly 必须默认 false，保证新挂载或从商品库进入时正常选品',
  )
  // details 仍通过 :open 绑定，条件渲染清晰
  assert.ok(pageSource.includes(':open="taskHistoryOpen"'), 'details 必须通过 :open 绑定 taskHistoryOpen')
})

test('成功后 5 秒关闭整个外层核对弹窗，再次发布可重新打开；计时结束进入历史列表', async () => {
  assert.ok(pageSource.includes('startPublishReturnCountdown('), '页面必须使用可测试的成功倒计时模块')
  assert.ok(
    /function onOpenPublishModal\(\): void \{[\s\S]*?showTaskListOnly\.value = false/.test(pageSource),
    '重新打开核对弹窗时必须退出仅历史视图',
  )
  const watchBlock = pageSource.match(/watch\(directPhase,[\s\S]*?\n\}\)/)
  assert.ok(watchBlock?.[0].includes("emit('clearDraft')"), '只在真实 published 状态清理跨页草稿')
  assert.ok(watchBlock?.[0].includes('publishDraftStore.clearDraft()'), '只在真实 published 状态清理草稿 store')

  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  let tick: (() => void) | undefined
  let timerCount = 0
  globalThis.setInterval = ((callback: TimerHandler) => {
    timerCount += 1
    tick = callback as () => void
    return timerCount
  }) as unknown as typeof setInterval
  globalThis.clearInterval = (() => { timerCount -= 1 }) as typeof clearInterval
  try {
    const state = { countdownSeconds: 0, isPublishModalOpen: true, modalOpen: true, showTaskListOnly: false, taskHistoryOpen: false }
    let completions = 0
    const clear = startPublishReturnCountdown(state, { onComplete: () => { completions += 1 } })
    assert.equal(state.countdownSeconds, 5)
    for (let second = 0; second < 4; second += 1) tick?.()
    assert.equal(state.isPublishModalOpen, true)
    assert.equal(state.countdownSeconds, 1)
    tick?.()
    assert.equal(state.isPublishModalOpen, false)
    assert.equal(state.modalOpen, false)
    assert.equal(state.showTaskListOnly, true)
    assert.equal(state.taskHistoryOpen, true)
    assert.equal(state.countdownSeconds, 0)
    assert.equal(completions, 1)
    clear()

    const reopened = { countdownSeconds: 0, isPublishModalOpen: true, modalOpen: true, showTaskListOnly: false, taskHistoryOpen: true }
    let clearActive = startPublishReturnCountdown(reopened)
    assert.equal(timerCount, 1, '新一轮成功只保留一个新计时器')
    clearActive = startPublishReturnCountdown(reopened)
    assert.equal(timerCount, 1, '重复进入成功计时先清除旧 timer')
    clearActive()
    assert.equal(timerCount, 0, '切出/卸载调用清理函数后不残留 timer')
    clear()
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
})



test('倒计时结束切到“仅任务列表”视图，隐藏选品/结果/弹窗且不重复触发发布', () => {
  // 倒计时归零分支设置 showTaskListOnly = true
  const countdownTail = pageSource.match(/startPublishReturnCountdown\([\s\S]{0,800}?onComplete:[\s\S]{0,140}?clearCountdownTimer = \(\) => \{\}/)
  assert.ok(countdownTail, '未找到倒计时归零处理代码块')
  assert.ok(countdownTail, '倒计时完成后必须清理计时器')
  assert.ok(
    !countdownTail![0].includes('directController.'),
    '倒计时结束只做纯前端视图切换，绝不调用发布控制器触发 prepare/submit',
  )

  // 三处条件渲染：选品区、结果区、DirectPublishModal 都要受 showTaskListOnly 控制
  assert.ok(
    /v-if="!showTaskListOnly"\s*\n\s*title="选择发布素材"/.test(pageSource),
    '“选择发布素材”区域必须用 v-if="!showTaskListOnly" 隐藏',
  )
  assert.ok(
    /v-if="!showTaskListOnly && \(directSubmitResult/.test(pageSource),
    '成功结果区域必须受 showTaskListOnly 控制隐藏',
  )
  assert.ok(
    /v-if="hasDraftOrProduct && !showTaskListOnly"/.test(pageSource),
    'DirectPublishModal 在“仅任务列表”视图必须不渲染',
  )
})

test('用户主动重新选品可退出“仅任务列表”视图，避免成功状态永久隐藏发布入口', () => {
  const clearBody = pageSource.match(/function onClearDraft\(\): void \{[\s\S]{0,240}?\n\}/)
  assert.ok(clearBody, '未找到 onClearDraft 实现')
  assert.ok(
    clearBody![0].includes('showTaskListOnly.value = false'),
    '用户主动清草稿/重新选品必须重置 showTaskListOnly，恢复选品入口',
  )
  // 任务列表视图上必须有恢复按钮，且仅在 showTaskListOnly 时出现
  assert.ok(
    /v-if="showTaskListOnly"[\s\S]{0,160}?重新选择素材/.test(pageSource),
    '“仅任务列表”视图必须提供“重新选择素材”恢复入口',
  )
})
