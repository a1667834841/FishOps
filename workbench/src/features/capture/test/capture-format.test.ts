/**
 * capture-format 单测：表单校验、采集负载组装、任务展示推导。
 *
 * 重点验证「不臆造数据」：缺少断点 / 统计时返回 null，界面据此显示「暂无」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildCapturePayload,
  defaultCaptureForm,
  paginateTasks,
  pickDefaultTask,
  toCaptureTaskView,
} from '../capture-format'
import type { Task } from '../../contracts'

function task(extra: Partial<Task> = {}): Task {
  return {
    id: 't1',
    type: 'capture',
    status: 'running',
    progress: 0,
    createdAt: 1000,
    updatedAt: 1000,
    payload: {},
    ...extra,
  }
}

test('buildCapturePayload：合法输入组装关键字、页数与过滤条件', () => {
  const built = buildCapturePayload({
    ...defaultCaptureForm(),
    keyword: '  iPhone 15 ',
    pages: '3',
    rowsPerPage: '20',
    minWantCnt: '5',
    minPrice: '10',
    maxPrice: '99',
    onlyFreeShip: true,
    fetchDetail: true,
  })
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.equal(built.payload.keyword, 'iPhone 15')
  assert.equal(built.payload.startPage, 1)
  assert.equal(built.payload.pages, 3)
  assert.equal(built.payload.rowsPerPage, 20)
  assert.equal(built.payload.fetchDetail, true)
  assert.deepEqual(built.payload.filter, { minWantCnt: 5, minPrice: 10, maxPrice: 99, onlyFreeShip: true })
})

test('buildCapturePayload：不填过滤条件时不生成 filter 字段', () => {
  const built = buildCapturePayload({ ...defaultCaptureForm(), keyword: 'x' })
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.equal(built.payload.filter, undefined)
})

test('buildCapturePayload：空关键词与非法页数逐字段报错', () => {
  const empty = buildCapturePayload(defaultCaptureForm())
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.ok(empty.errors.keyword)

  const badPages = buildCapturePayload({ ...defaultCaptureForm(), keyword: 'x', pages: '0', rowsPerPage: '999' })
  assert.equal(badPages.ok, false)
  if (!badPages.ok) {
    assert.ok(badPages.errors.pages)
    assert.ok(badPages.errors.rowsPerPage)
  }
})

test('buildCapturePayload：最低价高于最高价时报错', () => {
  const built = buildCapturePayload({ ...defaultCaptureForm(), keyword: 'x', minPrice: '100', maxPrice: '1' })
  assert.equal(built.ok, false)
  if (!built.ok) assert.equal(built.errors.maxPrice, '最高价格不能低于最低价格')
})

test('toCaptureTaskView：进度、页数与统计全部来自任务快照', () => {
  const view = toCaptureTaskView(
    task({
      status: 'running',
      progress: 42,
      payload: { keyword: 'phone', pages: 5, fetchDetail: true },
      meta: {
        capture: {
          keyword: 'phone',
          startPage: 1,
          totalPages: 5,
          nextPage: 3,
          pagesCompleted: 2,
          stats: { fetched: 60, valid: 30, filtered: 20, duplicates: 5, failed: 1 },
        },
      },
    }),
  )
  assert.equal(view.keyword, 'phone')
  assert.equal(view.progress, 42)
  assert.equal(view.totalPages, 5)
  assert.equal(view.pagesCompleted, 2)
  assert.equal(view.nextPage, 3)
  assert.deepEqual(view.stats, { fetched: 60, valid: 30, filtered: 20, duplicates: 5, failed: 1 })
  assert.equal(view.fetchDetail, true)
  assert.equal(view.canPause, true)
  assert.equal(view.canResume, false)
  assert.equal(view.canCancel, true)
})

test('toCaptureTaskView：后台未上报断点时页面显示「暂无」而不是编造数字', () => {
  const view = toCaptureTaskView(task({ payload: {} }))
  assert.equal(view.pagesCompleted, null)
  assert.equal(view.totalPages, null)
  assert.equal(view.nextPage, null)
  assert.equal(view.stats, null)
  assert.equal(view.keyword, '')
})

test('toCaptureTaskView：失败原因识别为平台类别，暂停原因按 captcha 归类', () => {
  const failed = toCaptureTaskView(task({ status: 'failed', error: '平台层未就绪：未找到可用的闲鱼页面' }))
  assert.equal(failed.problem?.code, 'host-unavailable')
  assert.equal(failed.canCancel, false)

  const paused = toCaptureTaskView(task({ status: 'paused', meta: { pauseReason: '触发验证码，请手动完成验证' } }))
  assert.equal(paused.problem?.code, 'captcha')
  assert.equal(paused.canResume, true)
})

test('pickDefaultTask：优先进行中 / 已暂停的任务，空列表返回 null', () => {
  assert.equal(pickDefaultTask([]), null)
  const tasks = [task({ id: 'a', status: 'completed' }), task({ id: 'b', status: 'paused' })]
  assert.equal(pickDefaultTask(tasks), 'b')
})

test('paginateTasks：分页切片与起止边界计算', () => {
  const list = ['t1', 't2', 't3', 't4', 't5']
  const p1 = paginateTasks(list, 1, 2)
  assert.equal(p1.paging.total, 5)
  assert.equal(p1.paging.totalPages, 3)
  assert.equal(p1.paging.page, 1)
  assert.equal(p1.paging.hasPrev, false)
  assert.equal(p1.paging.hasNext, true)
  assert.deepEqual(p1.pagedItems, ['t1', 't2'])

  const p2 = paginateTasks(list, 3, 2)
  assert.equal(p2.paging.page, 3)
  assert.equal(p2.paging.hasPrev, true)
  assert.equal(p2.paging.hasNext, false)
  assert.deepEqual(p2.pagedItems, ['t5'])

  // 超出范围安全限制
  const pOver = paginateTasks(list, 999, 2)
  assert.equal(pOver.paging.page, 3)
  assert.deepEqual(pOver.pagedItems, ['t5'])
})
