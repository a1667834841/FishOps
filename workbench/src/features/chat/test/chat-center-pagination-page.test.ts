/**
 * ChatCenterPage 历史分页的源码级规则测试。
 *
 * 项目没有组件测试环境（无 jsdom / @vue/test-utils），页面行为用源码级断言锁定，
 * 与既有 `chat-center-reply-rules.test.ts` / `app-chat-bootstrap.test.ts` 一致。
 *
 * 锁定的两条不变量：
 * 1. 分页只能由带用户意图的真实手势触发（wheel 向上 / 键盘向上 / 触摸拖动 / 指针拖动滚动条）；
 *    程序 layout 滚动（短首屏未溢出、锚点补偿）不得自动拉取历史，否则会把历史一次拉完；
 *    且同一手势序列只能消费一次意图，防止惯性滚动反复抵达顶部而连续拉取多页。
 * 2. 消息追加与历史前插必须区分：尾 id 变化（append）优先滚底，首 id 变化（prepend）才做锚点补偿。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const pagePath = fileURLToPath(new URL('../../../pages/ChatCenterPage.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')

/** 截取从 `start` 起、到 `end` 首次出现为止的源码片段；缺失 start 直接失败。 */
function section(start: string, end: string): string {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `ChatCenterPage.vue 缺少片段起始标记：${start}`)
  const to = source.indexOf(end, from + start.length)
  return source.slice(from, to === -1 ? source.length : to)
}

test('ChatCenterPage：scroll 只在带用户意图且到顶时触发分页，程序化滚动不触发', () => {
  const body = section('function onThreadScroll', '\nfunction ')
  assert.ok(body.includes('stickToBottom'), 'scroll 仍需跟踪吸底状态')
  assert.ok(body.includes('captureAnchor'), 'scroll 仍需记录滚动锚点')
  assert.ok(body.includes('hasScrollIntent'), 'scroll 必须以用户滚动意图为前提')
  assert.ok(body.includes('consumeScrollIntent'), '同一手势序列只能消费一次意图')
  assert.ok(body.includes('requestOlder'), '用户手势到顶时应触发分页')
  assert.ok(body.includes('scrollTop'), '需先确认已到顶部')
  // 程序化滚动（吸底 / 锚点补偿）前必须清除用户意图，避免 layout scroll 误触发分页。
  assert.ok(source.includes('clearScrollIntent'), '程序化滚动前需清除用户意图')
})

test('ChatCenterPage：wheel / 键盘 / 触摸 / 指针都记录用户意图并可在顶部触发分页', () => {
  const wheel = section('function onWheelScroll', '\nfunction ')
  assert.ok(wheel.includes('deltaY < 0'), 'wheel 仅在向上滚动时记录意图')
  assert.ok(wheel.includes('markScrollIntent'), 'wheel 向上应记录用户意图')
  assert.ok(wheel.includes('requestOlder'), 'wheel 已在顶部时应直接触发分页')

  const keydown = section('function onThreadKeydown', '\nfunction ')
  assert.ok(keydown.includes('ArrowUp'), '键盘向上应触发分页')
  assert.ok(keydown.includes('PageUp'), 'PageUp 应触发分页')
  assert.ok(keydown.includes('requestOlder'), '键盘向上应触发分页')

  const touch = section('function onThreadTouchMove', '\nfunction ')
  assert.ok(touch.includes('markScrollIntent'), '触摸拖动应记录用户意图')
  assert.ok(touch.includes('requestOlder'), '短首屏触摸到顶应触发分页')

  const pointer = section('function onThreadPointerDown', '\nfunction ')
  assert.ok(pointer.includes('markScrollIntent'), '指针按下（含滚动条拖动）应记录用户意图')

  // 模板必须绑定全部用户手势入口（scroll 仍需保留用于吸底跟踪）。
  assert.ok(source.includes('@wheel'), '模板需要 wheel 监听')
  assert.ok(source.includes('@keydown'), '模板需要 keydown 监听')
  assert.ok(source.includes('@touchstart'), '模板需要 touchstart 监听')
  assert.ok(source.includes('@touchmove'), '模板需要 touchmove 监听')
  assert.ok(source.includes('@pointerdown'), '模板需要 pointerdown 监听（滚动条拖动）')
  assert.ok(source.includes('@scroll'), '模板需要保留 scroll 监听以跟踪吸底')
})

test('ChatCenterPage：watch 区分 append 与 prepend，append 优先滚底', () => {
  const watchBody = section('watch(', '</script>')
  assert.ok(watchBody.includes('tailId'), 'watch 需依赖尾消息 id 以识别新消息追加')
  assert.ok(watchBody.includes('headId'), 'watch 需依赖首消息 id 以识别历史前插')
  assert.ok(watchBody.includes('appended'), 'watch 需计算 append 标志')
  assert.ok(watchBody.includes('prepended'), 'watch 需计算 prepend 标志')
  // append 分支必须先于/独立于 stickToBottom 判断：历史视图下的实时新消息也要滚底。
  const appendedIndex = watchBody.indexOf('appended')
  const stickIndex = watchBody.indexOf('stickToBottom')
  assert.notEqual(stickIndex, -1, 'watch 仍需保留吸底逻辑')
  assert.ok(appendedIndex !== -1, 'watch 需存在 append 分支')
})
