/**
 * DOMPublishFormFiller 注入执行与严格校验测试（P8）。
 *
 * 覆盖：
 * 1. `executeScript` 返回空数组 / result undefined / host 异常，均转为结构化 SCRIPT_INJECTION_FAILED；
 * 2. 注入只通过可序列化 args 传参，func 为完全自包含的注入函数；
 * 3. ok 严格性：标题/描述/售价/原价/图片任一未通过都不得标记成功；
 * 4. submit() 经注入点击真实发布按钮并返回结构化结果，未派发点击时透传结构化原因。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PublishError, type PublishItem } from '@fishops/shared'
import {
  DOMPublishFormFiller,
  type ScriptingExecutor,
} from '../form-filler'
import {
  injectCheckPageStatus,
  injectClickPublishSubmit,
  injectFillPublishForm,
} from '../injected-scripts'

/**
 * 依据注入函数身份与是否携带 args 分派 mock 返回值。
 */
function createMockExecutor(fillResult: unknown): ScriptingExecutor {
  return {
    async executeScript<T>(injection: { func: (...args: unknown[]) => T; args?: unknown[] }) {
      if (injection.func === (injectCheckPageStatus as unknown)) {
        return [
          {
            result: { isPublishPage: true, isLoggedIn: true, hasCaptcha: false } as unknown as T,
          },
        ]
      }
      return [{ result: fillResult as unknown as T }]
    },
  }
}

function makeItem(overrides: Partial<PublishItem> = {}): PublishItem {
  return {
    itemId: 'item_1',
    sourceTitle: '来源标题',
    sourcePrice: 100,
    sourceImages: ['https://img.example.com/1.jpg'],
    title: '最终标题',
    desc: '最终描述',
    price: 120,
    priceInCent: 12000,
    originalPrice: 600,
    originalPriceInCent: 60000,
    mainImage: 'https://img.example.com/1.jpg',
    detailImages: [],
    allImages: ['https://img.example.com/1.jpg'],
    confirmationStatus: 'unconfirmed',
    ...overrides,
  }
}

const READY_STATUS = { isPublishPage: true, isLoggedIn: true, hasCaptcha: false }

async function assertScriptInjectionFailed(fn: () => Promise<unknown>) {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof PublishError)
    assert.equal((err as PublishError).code, 'SCRIPT_INJECTION_FAILED')
    assert.equal((err as PublishError).retryable, false)
    return true
  })
}

test('FormFiller: executeScript 返回空数组 → 结构化 SCRIPT_INJECTION_FAILED', async () => {
  const executor: ScriptingExecutor = {
    async executeScript() {
      return []
    },
  }
  const filler = new DOMPublishFormFiller({ executor })

  await assertScriptInjectionFailed(() => filler.checkPageStatus(1))
  await assertScriptInjectionFailed(() => filler.fill(1, makeItem(), []))
})

test('FormFiller: executeScript 返回 result undefined → 结构化 SCRIPT_INJECTION_FAILED', async () => {
  const executor: ScriptingExecutor = {
    async executeScript<T>() {
      return [{ result: undefined as unknown as T }]
    },
  }
  const filler = new DOMPublishFormFiller({ executor })

  await assertScriptInjectionFailed(() => filler.checkPageStatus(1))
})

test('FormFiller: host 侧 executeScript 抛异常 → 结构化 SCRIPT_INJECTION_FAILED', async () => {
  const executor: ScriptingExecutor = {
    async executeScript() {
      throw new Error('Cannot access contents of the page (chrome://extensions)')
    },
  }
  const filler = new DOMPublishFormFiller({ executor })

  await assertScriptInjectionFailed(() => filler.checkPageStatus(1))
  await assertScriptInjectionFailed(() => filler.fill(1, makeItem(), []))
})

test('FormFiller: 注入时仅传递可序列化 args，func 为自包含注入函数', async () => {
  let capturedArgs: unknown[] | undefined
  let capturedFunc: unknown
  const executor: ScriptingExecutor = {
    async executeScript<T>(injection: { func: (...args: unknown[]) => T; args?: unknown[] }) {
      if (injection.func === (injectCheckPageStatus as unknown)) {
        return [{ result: READY_STATUS as unknown as T }]
      }
      capturedFunc = injection.func
      capturedArgs = injection.args
      return [
        {
          result: {
            titleFilled: true,
            descFilled: true,
            priceFilled: true,
            origPriceFilled: true,
            mainImageUploaded: true,
            detailImagesCount: 0,
            imagesUploadedCount: 1,
            imagesFailed: [],
            errors: [],
          } as unknown as T,
        },
      ]
    },
  }

  const filler = new DOMPublishFormFiller({ executor })
  await filler.fill(7, makeItem(), [])

  assert.equal(capturedFunc, injectFillPublishForm)
  assert.equal(capturedArgs?.length, 1)
  const arg = capturedArgs?.[0] as Record<string, unknown>
  // 只包含可序列化的普通数据
  assert.deepEqual(Object.keys(arg).sort(), ['desc', 'imageUrls', 'originalPrice', 'price', 'title'])
  assert.equal(typeof arg.title, 'string')
  assert.equal(typeof arg.price, 'number')
  assert.ok(Array.isArray(arg.imageUrls))
})

test('FormFiller: 标题未通过回读校验时 ok 必须为 false', async () => {
  const filler = new DOMPublishFormFiller({
    executor: createMockExecutor({
      titleFilled: false,
      descFilled: true,
      priceFilled: true,
      origPriceFilled: true,
      mainImageUploaded: true,
      detailImagesCount: 0,
      imagesUploadedCount: 1,
      imagesFailed: [],
      errors: ['标题填充后回读校验失败'],
    }),
  })

  const res = await filler.fill(1, makeItem(), [])
  assert.equal(res.ok, false)
  assert.equal(res.fillSummary.titleFilled, false)
})

test('FormFiller: 图片存在失败时 ok 必须为 false（不假成功）', async () => {
  const filler = new DOMPublishFormFiller({
    executor: createMockExecutor({
      titleFilled: true,
      descFilled: true,
      priceFilled: true,
      origPriceFilled: true,
      mainImageUploaded: false,
      detailImagesCount: 0,
      imagesUploadedCount: 1,
      imagesFailed: [{ index: 2, url: 'https://img.example.com/2.jpg', error: 'HTTP 404' }],
      errors: ['存在图片处理失败: 第 2 张'],
    }),
  })

  const res = await filler.fill(1, makeItem(), [])
  assert.equal(res.ok, false)
  assert.equal(res.fillSummary.mainImageUploaded, false)
  assert.equal(res.imagesFailed?.length, 1)
})

test('FormFiller: 全部字段与图片通过时 ok 为 true', async () => {
  const filler = new DOMPublishFormFiller({
    executor: createMockExecutor({
      titleFilled: true,
      descFilled: true,
      priceFilled: true,
      origPriceFilled: true,
      mainImageUploaded: true,
      detailImagesCount: 1,
      imagesUploadedCount: 2,
      imagesFailed: [],
      errors: [],
    }),
  })

  const res = await filler.fill(1, makeItem(), [])
  assert.equal(res.ok, true)
  assert.equal(res.fillSummary.titleFilled, true)
  assert.equal(res.fillSummary.mainImageUploaded, true)
})

test('FormFiller: 图片存在失败明细时即使布尔均为 true，ok 也必须为 false（不假成功）', async () => {
  const filler = new DOMPublishFormFiller({
    executor: createMockExecutor({
      titleFilled: true,
      descFilled: true,
      priceFilled: true,
      origPriceFilled: true,
      mainImageUploaded: true,
      detailImagesCount: 0,
      imagesUploadedCount: 2,
      imagesFailed: [{ index: 2, url: 'https://img.example.com/2.jpg', error: '回读确认数量不足' }],
      errors: ['图片写入上传控件后回读确认未完全生效'],
    }),
  })

  const res = await filler.fill(1, makeItem(), [])
  assert.equal(res.ok, false)
  assert.equal(res.imagesFailed?.length, 1)
})

test('FormFiller: submit() 注入点击真实发布按钮并返回结构化结果', async () => {
  let capturedFunc: unknown
  const executor: ScriptingExecutor = {
    async executeScript<T>(injection: { func: (...args: unknown[]) => T; args?: unknown[] }) {
      capturedFunc = injection.func
      return [
        {
          result: {
            clicked: true,
            buttonClass: 'publish-button',
            clickedAt: 1700000000000,
          } as unknown as T,
        },
      ]
    },
  }
  const filler = new DOMPublishFormFiller({ executor })

  const result = await filler.submit(7)
  assert.equal(capturedFunc, injectClickPublishSubmit)
  assert.equal(result.clicked, true)
  assert.equal(result.buttonClass, 'publish-button')
  assert.equal(result.clickedAt, 1700000000000)
})

test('FormFiller: submit() 未派发点击时透传结构化原因', async () => {
  const executor: ScriptingExecutor = {
    async executeScript<T>() {
      return [
        {
          result: {
            clicked: false,
            code: 'SUBMIT_BUTTON_NOT_FOUND',
            reason: '未找到真实发布按钮',
            clickedAt: 1,
          } as unknown as T,
        },
      ]
    },
  }
  const filler = new DOMPublishFormFiller({ executor })

  const result = await filler.submit(1)
  assert.equal(result.clicked, false)
  assert.equal(result.code, 'SUBMIT_BUTTON_NOT_FOUND')
})

test('FormFiller: submit() 无执行器时抛结构化 SCRIPT_INJECTION_FAILED', async () => {
  const filler = new DOMPublishFormFiller()
  await assert.rejects(
    () => filler.submit(1),
    (err: unknown) => {
      assert.ok(err instanceof PublishError)
      assert.equal((err as PublishError).code, 'SCRIPT_INJECTION_FAILED')
      return true
    },
  )
})

test('FormFiller: submit() 注入返回空数组 → 结构化 SCRIPT_INJECTION_FAILED', async () => {
  const executor: ScriptingExecutor = {
    async executeScript() {
      return []
    },
  }
  const filler = new DOMPublishFormFiller({ executor })

  await assertScriptInjectionFailed(() => filler.submit(1))
})

test('FormFiller: executeScript 返回 rejected Promise → 结构化 SCRIPT_INJECTION_FAILED', async () => {
  const executor: ScriptingExecutor = {
    async executeScript<T>() {
      return [{ result: Promise.reject(new Error('injected promise rejected')) as unknown as T }]
    },
  }
  const filler = new DOMPublishFormFiller({ executor })

  await assertScriptInjectionFailed(() => filler.checkPageStatus(1))
})

test('FormFiller: executeScript 返回非数组 → 结构化 SCRIPT_INJECTION_FAILED', async () => {
  const executor = {
    async executeScript<T>() {
      return { result: READY_STATUS } as unknown as Array<{ result: T }>
    },
  } as ScriptingExecutor
  const filler = new DOMPublishFormFiller({ executor })

  await assertScriptInjectionFailed(() => filler.checkPageStatus(1))
})

test('FormFiller: executeScript 数组含空项 → 结构化 SCRIPT_INJECTION_FAILED', async () => {
  const executor = {
    async executeScript<T>() {
      return [null] as unknown as Array<{ result: T }>
    },
  } as ScriptingExecutor
  const filler = new DOMPublishFormFiller({ executor })

  await assertScriptInjectionFailed(() => filler.checkPageStatus(1))
})
