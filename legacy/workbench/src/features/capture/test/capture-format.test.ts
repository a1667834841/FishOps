/**
 * capture-format 单测：表单校验、采集负载组装、任务展示推导。
 *
 * 重点验证「不臆造数据」：缺少断点 / 统计时返回 null，界面据此显示「暂无」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildBatchCapturePayloads,
  buildCapturePayload,
  defaultCaptureForm,
  formatTaskDuration,
  formatTaskValidCount,
  paginateTasks,
  parseKeywordTags,
  pickDefaultTask,
  toCaptureTaskView,
} from '../capture-format'
import type { Task } from '../../contracts'

test('defaultCaptureForm：默认不采集商品详情，需用户主动勾选', () => {
  assert.equal(defaultCaptureForm().fetchDetail, false)
})

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

test('parseKeywordTags：支持回车/逗号/顿号/换行分隔，保留词内空格，去空去重，上限20词与60字', () => {
  // 中英文逗号、顿号、换行分隔
  const input = '机械键盘, 苹果 手机，华为 手表、小米 平板\r\n联想 电脑'
  const res = parseKeywordTags(input)
  assert.deepEqual(res.tags, ['机械键盘', '苹果 手机', '华为 手表', '小米 平板', '联想 电脑'])

  // 重复词与去空
  const dup = parseKeywordTags(['机械键盘', '  ', '机械键盘', ' 鼠标 '], ['机械键盘'])
  assert.deepEqual(dup.tags, ['机械键盘', '鼠标'])

  // 超长单词拦截（> 60）
  const longWord = 'a'.repeat(61)
  const longRes = parseKeywordTags([longWord, '有效词'])
  assert.deepEqual(longRes.tags, ['有效词'])
  assert.ok(longRes.error?.includes('超过 60 个字符'))

  // 超过 20 词上限
  const manyWords = Array.from({ length: 25 }, (_, i) => `词语${i + 1}`)
  const manyRes = parseKeywordTags(manyWords)
  assert.equal(manyRes.tags.length, 20)
  assert.ok(manyRes.error?.includes('最多支持 20 个'))
})

test('buildBatchCapturePayloads：基础间隔与随机增量默认0.5s转换为500ms确定值并校验非负有限', () => {
  // 默认合法组装：默认 0.5s / 0.5s 转换为 500ms / 500ms 确定值
  const defaultResult = buildBatchCapturePayloads({
    ...defaultCaptureForm(),
    keywords: ['ipad'],
  })
  assert.equal(defaultResult.ok, true)
  if (!defaultResult.ok) return
  assert.equal(defaultResult.payloads[0].minIntervalMs, 500)
  assert.equal(defaultResult.payloads[0].intervalJitterMs, 500)

  // 自定义秒数：0.6s / 0.3s -> 600ms / 300ms 确定值，不允许随机
  const okResult = buildBatchCapturePayloads({
    ...defaultCaptureForm(),
    keywords: ['ipad', 'iphone'],
    baseIntervalSec: '0.6',
    randomIntervalSec: '0.3',
  })
  assert.equal(okResult.ok, true)
  if (!okResult.ok) return
  assert.equal(okResult.payloads.length, 2)
  assert.equal(okResult.payloads[0].keyword, 'ipad')
  assert.equal(okResult.payloads[0].minIntervalMs, 600)
  assert.equal(okResult.payloads[0].intervalJitterMs, 300)
  assert.equal(okResult.payloads[1].keyword, 'iphone')
  assert.equal(okResult.payloads[1].minIntervalMs, 600)
  assert.equal(okResult.payloads[1].intervalJitterMs, 300)

  // 负数间隔报错
  const badBase = buildBatchCapturePayloads({
    ...defaultCaptureForm(),
    keywords: ['ipad'],
    baseIntervalSec: '-0.5',
  })
  assert.equal(badBase.ok, false)
  if (!badBase.ok) assert.ok(badBase.errors.baseIntervalSec)

  // 非数字间隔报错
  const badRandom = buildBatchCapturePayloads({
    ...defaultCaptureForm(),
    keywords: ['ipad'],
    randomIntervalSec: 'abc',
  })
  assert.equal(badRandom.ok, false)
  if (!badRandom.ok) assert.ok(badRandom.errors.randomIntervalSec)
})

test('parseKeywordTags：对existingTags同样校验超长，duplicate先判重再判数量，超额阻止', () => {
  // existingTags 超长应报错
  const longTag = 'x'.repeat(61)
  const existingLong = parseKeywordTags([], [longTag])
  assert.ok(existingLong.error?.includes('超过 60 个字符'))

  // duplicate 先判重再判数量：已有 20 个标签，传入一个重复词，不应报“最多支持 20 个”错误
  const twentyTags = Array.from({ length: 20 }, (_, i) => `词${i + 1}`)
  const dupInTwenty = parseKeywordTags('词1', twentyTags)
  assert.equal(dupInTwenty.error, undefined)
  assert.equal(dupInTwenty.tags.length, 20)

  // 传入第 21 个不同词，才报最多支持 20 个错误
  const overflow = parseKeywordTags('新词21', twentyTags)
  assert.ok(overflow.error?.includes('最多支持 20 个'))
  assert.equal(overflow.tags.length, 20)

  // buildBatchCapturePayloads 包含 error 时必须阻止提交（ok: false）
  const blockedBuild = buildBatchCapturePayloads({
    ...defaultCaptureForm(),
    keywords: ['合法词'],
    keywordInput: 'y'.repeat(65),
  })
  assert.equal(blockedBuild.ok, false)
  if (!blockedBuild.ok) {
    assert.ok(blockedBuild.errors.keyword?.includes('超过 60 个字符'))
  }
})

test('suggest 追加标签与批量上限：已达 20 词上限时追加新建议词应被拦截', () => {
  const existing20 = Array.from({ length: 20 }, (_, i) => `建议词${i + 1}`)
  const addSuggestOverflow = parseKeywordTags(['新建议词'], existing20)
  assert.ok(addSuggestOverflow.error?.includes('最多支持 20 个'))
  assert.equal(addSuggestOverflow.tags.length, 20)

  // 超长建议词拦截
  const longSuggest = 's'.repeat(61)
  const addLongSuggest = parseKeywordTags([longSuggest], ['现有词'])
  assert.ok(addLongSuggest.error?.includes('超过 60 个字符'))
  assert.deepEqual(addLongSuggest.tags, ['现有词'])
})

test('formatTaskDuration 与 formatTaskValidCount：旧任务 missing started/ended/stored 均显示—', () => {
  // 1. 未启动任务（pending）
  const pendingView = toCaptureTaskView(task({ status: 'pending', createdAt: 1000, startedAt: undefined }))
  assert.equal(formatTaskDuration(pendingView, 5000), '—')
  assert.equal(formatTaskValidCount(pendingView), '—')

  // 2. 运行中任务缺失 startedAt：耗时显示 —
  const runningMissingStarted = toCaptureTaskView(task({
    status: 'running',
    startedAt: undefined,
  }))
  assert.equal(formatTaskDuration(runningMissingStarted, 5000), '—')

  // 3. 已完成任务缺失 endedAt：耗时显示 —
  const completedMissingEnded = toCaptureTaskView(task({
    status: 'completed',
    startedAt: 1000,
    endedAt: undefined,
  }))
  assert.equal(formatTaskDuration(completedMissingEnded, 5000), '—')

  // 4. 旧任务缺失 stored 字段：入库数显示 —
  const missingStored = toCaptureTaskView(task({
    status: 'completed',
    startedAt: 1000,
    endedAt: 26000,
    result: { fetched: 10, valid: 5, filtered: 5, duplicates: 0, failed: 0 },
  }))
  assert.equal(formatTaskValidCount(missingStored), '—')

  // 5. 正常运行中任务：随 now 递增
  const runningView = toCaptureTaskView(task({
    status: 'running',
    createdAt: 1000,
    startedAt: 2000,
    meta: {
      capture: {
        stats: { fetched: 10, valid: 8, stored: 7, filtered: 2, duplicates: 0, failed: 0 },
      },
    },
  }))
  assert.equal(formatTaskValidCount(runningView), '7')
  assert.equal(formatTaskDuration(runningView, 15000), '13s')
  assert.equal(formatTaskDuration(runningView, 75000), '1m 13s')

  // 6. 正常已完成任务：耗时固定
  const completedView = toCaptureTaskView(task({
    status: 'completed',
    createdAt: 1000,
    startedAt: 2000,
    endedAt: 26000,
    result: { fetched: 10, valid: 5, stored: 4, filtered: 5, duplicates: 0, failed: 0 },
  }))
  assert.equal(formatTaskValidCount(completedView), '4')
  assert.equal(formatTaskDuration(completedView, 999999), '24s')
})

test('formatTaskDuration 与 formatTaskValidCount：恢复排队任务与取消从未启动任务边界验证', () => {
  // 1. 取消从未启动任务（cancelled 且 startedAt 为 undefined）：耗时显示 —，入库显示 —
  const cancelledNeverStarted = toCaptureTaskView(task({
    status: 'cancelled',
    createdAt: 1000,
    startedAt: undefined,
  }))
  assert.equal(formatTaskDuration(cancelledNeverStarted, 5000), '—')
  assert.equal(formatTaskValidCount(cancelledNeverStarted), '—')

  // 2. 恢复排队任务（pending 状态，但已有 startedAt 且已有 stored 统计）：
  // 验证应继续计时，且如实展示已有 stored 数量
  const resumingPending = toCaptureTaskView(task({
    status: 'pending',
    createdAt: 1000,
    startedAt: 2000,
    meta: {
      capture: {
        stats: { fetched: 20, valid: 16, stored: 15, filtered: 4, duplicates: 0, failed: 0 },
      },
    },
  }))
  // 耗时：now 为 17000 时，17000 - 2000 = 15s
  assert.equal(formatTaskDuration(resumingPending, 17000), '15s')
  // 入库数如实展示 15，绝不隐藏为 —
  assert.equal(formatTaskValidCount(resumingPending), '15')
})


test('采集完成展示飞书同步数量，旧任务不伪报同步成功', () => {
  const synced = toCaptureTaskView(task({ status: 'completed', result: { feishuSync: { createdCount: 2, skippedCount: 1 } } }))
  assert.equal(synced.note, '已同步到飞书：新增 2 条，已存在跳过 1 条')
  assert.equal(toCaptureTaskView(task({ status: 'completed' })).note, null)
})
