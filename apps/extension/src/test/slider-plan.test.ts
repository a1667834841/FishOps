import { test } from 'node:test'
import assert from 'node:assert/strict'
import { locateSlider, sliderDialogVisible, sliderMoveTrack } from '../slider-plan.ts'
import type { SliderDom, SliderElement } from '../slider-plan.ts'

/** 按选择器表构造替身 DOM；rect 决定可见性与位移计算。 */
function domOf(table: Record<string, { left: number; top: number; width: number; height: number } | null>): SliderDom {
  const elements = new Map<string, SliderElement | null>()
  for (const [selector, rect] of Object.entries(table)) {
    elements.set(selector, rect === null ? null : { getBoundingClientRect: () => rect })
  }
  return {
    querySelector(selector: string) {
      return elements.get(selector) ?? null
    },
  }
}

/** 平台真实量级的滑块布局：弹窗 + 手柄 40px + 轨道 300px。 */
const LAYOUT = {
  '.baxia-dialog': { left: 100, top: 100, width: 400, height: 300 },
  '#nc_1_n1z': { left: 160, top: 260, width: 40, height: 40 },
  '.nc_scale': { left: 140, top: 250, width: 300, height: 50 },
}

test('有缺口时按缺口左边界计算位移，不用最大行程', () => {
  const dom = domOf({ ...LAYOUT, '.nc_1_n1t': { left: 300, top: 210, width: 40, height: 40 } })
  const plan = locateSlider(dom)
  assert.notEqual(plan, null)
  assert.equal(plan!.reason, 'gap')
  // 缺口左 300 减去手柄左 160 = 140。
  assert.equal(plan!.distance, 140)
  assert.equal(plan!.from.x, 180)
  assert.equal(plan!.to.x, 320)
  assert.ok(plan!.path.length > 1)
})

test('缺口不可见时退到轨道最大行程', () => {
  const dom = domOf(LAYOUT)
  const plan = locateSlider(dom)
  assert.notEqual(plan, null)
  assert.equal(plan!.reason, 'track')
  // 轨道右 440 减手柄右 200 = 240。
  assert.equal(plan!.distance, 240)
  assert.equal(plan!.to.x, 420)
})

test('缺口在手柄左侧（距离非正）时不按缺口拖，退到最大行程', () => {
  const dom = domOf({ ...LAYOUT, '.nc_1_n1t': { left: 120, top: 210, width: 40, height: 40 } })
  const plan = locateSlider(dom)
  assert.equal(plan!.reason, 'track')
  assert.equal(plan!.distance, 240)
})

test('没有弹窗容器时不定位，避免误拖页面其它滑块控件', () => {
  const dom = domOf({ '#nc_1_n1z': LAYOUT['#nc_1_n1z'], '.nc_scale': LAYOUT['.nc_scale'] })
  assert.equal(locateSlider(dom), null)
})

test('有弹窗但找不到滑块手柄时不定位', () => {
  const dom = domOf({ '.baxia-dialog': LAYOUT['.baxia-dialog'], '.nc_scale': LAYOUT['.nc_scale'] })
  assert.equal(locateSlider(dom), null)
})

test('滑块与轨道都不可见（零尺寸）时不定位', () => {
  const dom = domOf({
    '.baxia-dialog': LAYOUT['.baxia-dialog'],
    '#nc_1_n1z': { left: 160, top: 260, width: 0, height: 0 },
    '.nc_scale': LAYOUT['.nc_scale'],
  })
  assert.equal(locateSlider(dom), null)
})

test('DOM 形状非法时安全返回 null，不抛异常', () => {
  assert.equal(locateSlider(null as unknown as SliderDom), null)
  assert.equal(locateSlider({} as unknown as SliderDom), null)
  assert.equal(locateSlider({ querySelector: 'x' } as unknown as SliderDom), null)
})

test('轨迹首尾精确落在起点与终点，中段非匀速', () => {
  const from = { x: 0, y: 50 }
  const path = sliderMoveTrack(from, 200, 24)
  assert.equal(path.length, 24)
  assert.equal(path[0]!.x, from.x + 200 * (1 / 24) ** 2 * 2)
  // 末点必须精确落在目标，抵消 overshoot 偏移。
  assert.equal(path[path.length - 1]!.x, 200)
  assert.equal(path[path.length - 1]!.y, 50)
  // 中段速度必须快于首段：easeInOutQuad 的第 12 步进应大于第 1 步进。
  const firstStep = path[0]!.x - from.x
  const midStep = path[12]!.x - path[11]!.x
  assert.ok(midStep > firstStep, `中段步进 ${midStep} 应大于首段步进 ${firstStep}`)
})

test('轨迹在终点前略微越过再回落，避免一次机械到位', () => {
  const path = sliderMoveTrack({ x: 0, y: 0 }, 200, 24)
  // 倒数第二点叠加了正向 overshoot，应越过它自己的渐进位置。
  // 形态必须是「渐进 → 越过 → 回落 → 精确到位」：path[21] 越过、path[22] 回落、path[23] 精确命中。
  assert.equal(path[21]!.x.toFixed(2), '201.22', '越过点应超过渐进值 199.31')
  assert.equal(path[22]!.x.toFixed(2), '199.31', '越过后回落到渐进位置')
  assert.equal(path[23]!.x, 200, '终点精确命中目标')
})

test('位移非正或参数非法时返回空轨迹', () => {
  assert.deepEqual(sliderMoveTrack({ x: 0, y: 0 }, 0), [])
  assert.deepEqual(sliderMoveTrack({ x: 0, y: 0 }, -10), [])
  assert.deepEqual(sliderMoveTrack({ x: Number.NaN, y: 0 }, 100), [])
  assert.deepEqual(sliderMoveTrack({ x: 0, y: 0 }, 100, 2), [])
})

test('弹窗可见性只判断容器，不要求滑块元素存在', () => {
  assert.equal(sliderDialogVisible(domOf({ '.baxia-dialog': LAYOUT['.baxia-dialog'] })), true)
  assert.equal(sliderDialogVisible(domOf({ '#nc_1_wrapper': LAYOUT['.baxia-dialog'] })), true)
  assert.equal(sliderDialogVisible(domOf({})), false)
  assert.equal(sliderDialogVisible(domOf({ '.baxia-dialog': { left: 0, top: 0, width: 0, height: 0 } })), false)
  assert.equal(sliderDialogVisible(null as unknown as SliderDom), false)
})
