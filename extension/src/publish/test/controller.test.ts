/**
 * PublishController 与 FormFiller 单元测试（P8）。
 *
 * 测试目标：
 * 1. 按指定 itemId 解析商品，商品不存在时返回结构化 PRODUCT_NOT_FOUND；
 *    自营素材经 OwnedProductFallback 从当前账号在售目录只读复验，本地命中也不例外；
 * 2. 严禁私自偷偷随机选择商品；
 * 3. 准备图片接口全部可注入 mock，脱机运行，完全不发起真实网络请求；
 * 4. PublishController.submit 不提供自动提交（显式拒绝）；DOMPublishFormFiller.submit 返回结构化提交结果；
 * 5. FormFiller 适配接口验证：未登录（NOT_LOGGED_IN）、验证码/滑块（VERIFICATION_REQUIRED）、表单控件丢失（FORM_FIELD_CHANGED）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryProductRepository } from '../../../../shared/capture/product-repository'
import { PublishError } from '../../../../shared/types/publish'
import type { Product } from '../../../../shared/types/product'
import { PublishController } from './owned-product-fixture'
import {
  DefaultImageDownloader,
  type ImageDownloader,
  type OwnedProductFallback,
  type PreparedImageFile,
} from '../controller'
import {
  DOMPublishFormFiller,
  type ScriptingExecutor,
} from '../form-filler'

function createSampleProduct(itemId = 'item_888'): Product {
  return {
    itemId,
    title: '富士微单相机 XT4 黑色单机',
    price: '¥8500.00',
    priceNumber: 8500.0,
    originalPrice: '¥11000.00',
    originalPriceNumber: 11000.0,
    wantCnt: 300,
    publishTime: '2026-09-01',
    publishTimeMs: 1788200000000,
    captureTime: '2026-09-02',
    captureTimeMs: 1788286400000,
    sellerNick: '摄影爱好者',
    sellerCity: '上海',
    freeShip: '是',
    tags: '数码、相机',
    coverUrl: 'https://img.alicdn.com/cover.jpg',
    detailUrl: 'https://www.goofish.com/item?id=' + itemId,
    desc: '快门3000次，箱说全，成色充新。',
    images: ['https://img.alicdn.com/cover.jpg', 'https://img.alicdn.com/d1.jpg'],
    // 发布仅允许当前账号已确认发布商品：默认夹具标记为 my_published
    source: 'my_published',
    status: 'published',
  }
}

class MockImageDownloader implements ImageDownloader {
  public downloadedUrls: string[] = []
  public shouldFail = false
  public fakeSize = 1024 * 100 // 100KB

  async download(url: string, filename: string): Promise<PreparedImageFile> {
    if (this.shouldFail) {
      throw new Error('网络连接超时 (Mock)')
    }
    this.downloadedUrls.push(url)
    return {
      filename,
      mimeType: 'image/jpeg',
      size: this.fakeSize,
      data: new ArrayBuffer(8),
    }
  }
}

test('PublishController: 严格从 ProductRepository 获取商品，商品不存在时抛出 PRODUCT_NOT_FOUND', async () => {
  const repo = createMemoryProductRepository()
  const downloader = new MockImageDownloader()
  const controller = new PublishController({
    repository: repo,
    imageDownloader: downloader,
  })

  // 商品库为空时查询不存在的商品
  await assert.rejects(
    () => controller.preparePublishItem('non_existent_item'),
    (err: unknown) => {
      assert.ok(err instanceof PublishError)
      assert.equal((err as PublishError).code, 'PRODUCT_NOT_FOUND')
      assert.equal((err as PublishError).retryable, false)
      return true
    },
  )

  // 写入商品后再查询成功
  const sample = createSampleProduct('fuji_xt4')
  await repo.upsertProducts([sample], Date.now())

  const item = await controller.preparePublishItem('fuji_xt4')
  assert.equal(item.itemId, 'fuji_xt4')
  assert.equal(item.title, sample.title)
  assert.equal(item.price, 8500.0)
})

test('PublishController: 竞品 / legacy / 归属未确认商品一律结构化拒绝，绝不进入发布流程', async () => {
  const repo = createMemoryProductRepository()
  const controller = new PublishController({ repository: repo })

  const competitor = {
    ...createSampleProduct('comp_1'),
    source: 'captured_search' as const,
    status: 'unconfirmed',
    ownershipUnconfirmed: false,
  }
  const unconfirmedCompetitor = {
    ...createSampleProduct('comp_unknown'),
    source: 'captured_search' as const,
    status: 'unconfirmed',
    ownershipUnconfirmed: true,
  }
  const legacy = {
    ...createSampleProduct('legacy_1'),
    source: 'legacy_unconfirmed' as const,
    status: 'unconfirmed',
  }
  // 完全未打标的存量商品（查询侧会规整为 legacy_unconfirmed）
  const untagged = { ...createSampleProduct('untagged_1'), source: undefined }

  await repo.upsertProducts([competitor, unconfirmedCompetitor, legacy, untagged], Date.now())

  for (const id of ['comp_1', 'comp_unknown', 'legacy_1', 'untagged_1']) {
    await assert.rejects(
      () => controller.preparePublishItem(id),
      (err: unknown) => {
        assert.ok(err instanceof PublishError)
        assert.equal((err as PublishError).code, 'PRODUCT_SOURCE_NOT_ALLOWED')
        assert.equal((err as PublishError).retryable, false)
        return true
      },
    )
  }

  // my_published 仍然可发布（对照组）
  await repo.upsertProducts([createSampleProduct('mine_ok')], Date.now())
  const ok = await controller.preparePublishItem('mine_ok')
  assert.equal(ok.itemId, 'mine_ok')
})

test('PublishController: 严禁偷偷随机选择商品，itemId 为空或缺失时抛出 INVALID_PAYLOAD', async () => {
  const repo = createMemoryProductRepository()
  const controller = new PublishController({ repository: repo })

  await assert.rejects(
    () => controller.preparePublishItem('   '),
    (err: unknown) => {
      assert.ok(err instanceof PublishError)
      assert.equal((err as PublishError).code, 'INVALID_PAYLOAD')
      return true
    },
  )
})

test('PublishController: 图片下载与准备全部走 Mock，真实网络请求不执行', async () => {
  const repo = createMemoryProductRepository()
  const downloader = new MockImageDownloader()
  const controller = new PublishController({
    repository: repo,
    imageDownloader: downloader,
  })

  const images = ['https://img.alicdn.com/1.jpg', 'https://img.alicdn.com/2.jpg']
  const prepared = await controller.prepareImages(images)

  assert.equal(prepared.length, 2)
  assert.equal(prepared[0].filename, 'main-image.jpg')
  assert.equal(prepared[1].filename, 'detail-image-1.jpg')
  assert.deepEqual(downloader.downloadedUrls, images)
})

test('PublishController: 图片下载失败或超限分类为 IMAGE_DOWNLOAD_FAILED', async () => {
  const repo = createMemoryProductRepository()
  const downloader = new MockImageDownloader()
  downloader.shouldFail = true
  const controller = new PublishController({
    repository: repo,
    imageDownloader: downloader,
  })

  await assert.rejects(
    () => controller.prepareImages(['https://img.alicdn.com/fail.jpg']),
    (err: unknown) => {
      assert.ok(err instanceof PublishError)
      assert.equal((err as PublishError).code, 'IMAGE_DOWNLOAD_FAILED')
      return true
    },
  )
})

test('PublishController: 控制器不提供自动提交能力，调用 submit() 显式抛出 SUBMIT_DISABLED', () => {
  const repo = createMemoryProductRepository()
  const controller = new PublishController({ repository: repo })

  assert.throws(
    () => controller.submit(),
    (err: unknown) => {
      assert.ok(err instanceof PublishError)
      assert.equal((err as PublishError).code, 'SUBMIT_DISABLED')
      assert.equal((err as PublishError).retryable, false)
      return true
    },
  )
})

test('PublishController: 第 N 张图片下载失败时错误信息包含图片序号', async () => {
  const repo = createMemoryProductRepository()
  let downloadCount = 0
  const downloader: ImageDownloader = {
    async download(_url: string, filename: string): Promise<PreparedImageFile> {
      downloadCount++
      if (downloadCount === 2) {
        throw new Error('连接超时 (Mock)')
      }
      return { filename, mimeType: 'image/jpeg', size: 1024, data: new ArrayBuffer(8) }
    },
  }
  const controller = new PublishController({ repository: repo, imageDownloader: downloader })

  await assert.rejects(
    () => controller.prepareImages(['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg']),
    (err: unknown) => {
      assert.ok(err instanceof PublishError)
      assert.equal((err as PublishError).code, 'IMAGE_DOWNLOAD_FAILED')
      assert.ok((err as PublishError).message.includes('第 2 张'))
      return true
    },
  )
})

test('DefaultImageDownloader: 非 HTTPS 协议（ftp）直接拒绝且不发起网络请求', async () => {
  const downloader = new DefaultImageDownloader()

  await assert.rejects(
    () => downloader.download('ftp://img.example.com/1.jpg', 'a.jpg'),
    (err: unknown) => {
      assert.ok(err instanceof PublishError)
      assert.equal((err as PublishError).code, 'IMAGE_DOWNLOAD_FAILED')
      return true
    },
  )
})

test('DOMPublishFormFiller: 检测到验证码/滑块风控时抛出 VERIFICATION_REQUIRED', async () => {
  const mockExecutor: ScriptingExecutor = {
    async executeScript<T>() {
      return [{ result: { isPublishPage: true, isLoggedIn: true, hasCaptcha: true } as unknown as T }]
    },
  }

  const filler = new DOMPublishFormFiller({ executor: mockExecutor })

  await assert.rejects(
    () => filler.checkPageStatus(123),
    (err: unknown) => {
      assert.ok(err instanceof PublishError)
      assert.equal((err as PublishError).code, 'VERIFICATION_REQUIRED')
      assert.equal((err as PublishError).retryable, false)
      return true
    },
  )
})

test('DOMPublishFormFiller: 检测到未登录状态时抛出 NOT_LOGGED_IN', async () => {
  const mockExecutor: ScriptingExecutor = {
    async executeScript<T>() {
      return [{ result: { isPublishPage: false, isLoggedIn: false, hasCaptcha: false } as unknown as T }]
    },
  }

  const filler = new DOMPublishFormFiller({ executor: mockExecutor })

  await assert.rejects(
    () => filler.checkPageStatus(123),
    (err: unknown) => {
      assert.ok(err instanceof PublishError)
      assert.equal((err as PublishError).code, 'NOT_LOGGED_IN')
      assert.equal((err as PublishError).retryable, false)
      return true
    },
  )
})

test('DOMPublishFormFiller: 控件严重缺失时抛出 FORM_FIELD_CHANGED', async () => {
  const mockExecutor: ScriptingExecutor = {
    async executeScript<T>(injection: { args?: any[] }) {
      if (injection.args) {
        return [
          {
            result: {
              descFilled: false,
              priceFilled: false,
              origPriceFilled: false,
              mainImageUploaded: false,
              detailImagesCount: 0,
              errors: ['未找到商品图片上传区域', '未找到描述编辑器', '未找到售价输入框'],
            } as unknown as T,
          },
        ]
      }
      return [{ result: { isPublishPage: true, isLoggedIn: true, hasCaptcha: false } as unknown as T }]
    },
  }

  const filler = new DOMPublishFormFiller({ executor: mockExecutor })
  const sample = createSampleProduct('test')
  const item = {
    itemId: 'test',
    sourceTitle: sample.title,
    sourcePrice: 100,
    sourceImages: [],
    title: 'test',
    desc: 'test',
    price: 100,
    priceInCent: 10000,
    originalPrice: 500,
    originalPriceInCent: 50000,
    mainImage: 'https://img.alicdn.com/1.jpg',
    detailImages: [],
    allImages: ['https://img.alicdn.com/1.jpg'],
    confirmationStatus: 'unconfirmed' as const,
  }

  await assert.rejects(
    () => filler.fill(123, item, []),
    (err: unknown) => {
      assert.ok(err instanceof PublishError)
      assert.equal((err as PublishError).code, 'FORM_FIELD_CHANGED')
      return true
    },
  )
})

test('DOMPublishFormFiller: 表单填充成功概览与 submit() 结构化返回（不再抛禁用）', async () => {
  const mockExecutor: ScriptingExecutor = {
    async executeScript<T>(injection: { args?: any[] }) {
      if (injection.args) {
        return [
          {
            result: {
              titleFilled: true,
              descFilled: true,
              priceFilled: true,
              origPriceFilled: true,
              mainImageUploaded: true,
              detailImagesCount: 1,
              imagesUploadedCount: 2,
              imagesFailed: [],
              errors: [],
            } as unknown as T,
          },
        ]
      }
      return [{ result: { isPublishPage: true, isLoggedIn: true, hasCaptcha: false } as unknown as T }]
    },
  }

  const filler = new DOMPublishFormFiller({ executor: mockExecutor })
  const sample = createSampleProduct('test')
  const item = {
    itemId: 'test',
    sourceTitle: sample.title,
    sourcePrice: 100,
    sourceImages: [],
    title: 'test',
    desc: 'test',
    price: 100,
    priceInCent: 10000,
    originalPrice: 500,
    originalPriceInCent: 50000,
    mainImage: 'https://img.alicdn.com/1.jpg',
    detailImages: ['https://img.alicdn.com/2.jpg'],
    allImages: ['https://img.alicdn.com/1.jpg', 'https://img.alicdn.com/2.jpg'],
    confirmationStatus: 'unconfirmed' as const,
  }

  const res = await filler.fill(123, item, [{ filename: '1.jpg', mimeType: 'image/jpeg', size: 1000 }])
  assert.equal(res.ok, true)
  assert.equal(res.fillSummary.descFilled, true)
  assert.equal(res.fillSummary.priceFilled, true)
  assert.equal(res.fillSummary.mainImageUploaded, true)

  // 提交不再抛 SUBMIT_DISABLED，而是经注入返回结构化结果；
  // 本 mock 未模拟真实点击（无 args 分支返回状态对象）→ clicked:false
  const submitRes = await filler.submit(123)
  assert.equal(submitRes.clicked, false)
})

// ---- Issue19：发布候选与创建同源（商品目录 my_published → 发布创建） ----

/** 回退来源测试替身：记录解析调用，便于验证「本地命中仍调用目录复验」。 */
class MockOwnedProductFallback implements OwnedProductFallback {
  public readonly resolvedIds: string[] = []
  public errorToThrow: unknown = null
  private readonly product: Product | null

  constructor(product: Product | null) {
    this.product = product
  }

  async resolve(itemId: string): Promise<Product | null> {
    this.resolvedIds.push(itemId)
    if (this.errorToThrow) throw this.errorToThrow
    if (!this.product) return null
    return this.product.itemId === itemId ? this.product : null
  }
}

test('Issue19: 本地库未命中时回退当前账号在售目录只读解析，成功组装发布项', async () => {
  const repo = createMemoryProductRepository()
  const catalogProduct = createSampleProduct('catalog_1')
  const fallback = new MockOwnedProductFallback(catalogProduct)
  const controller = new PublishController({ repository: repo, ownedProducts: fallback })

  const item = await controller.preparePublishItem('catalog_1')

  assert.equal(item.itemId, 'catalog_1')
  assert.equal(item.sourceTitle, catalogProduct.title)
  assert.equal(item.price, 8500.0)
  assert.deepEqual(fallback.resolvedIds, ['catalog_1'])
  // 只读：目录解析绝不写入本地商品库。
  const page = await repo.list({ source: 'all', limit: 10 })
  assert.equal(page.total, 0)
})

test('Issue29: 本地库命中时复验官方目录并使用官方素材', async () => {
  const repo = createMemoryProductRepository()
  const local = { ...createSampleProduct('local_1'), title: '本地采集商品' }
  await repo.upsertProducts([local], Date.now())
  const fallback = new MockOwnedProductFallback({ ...createSampleProduct('local_1'), title: '目录商品' })
  const controller = new PublishController({ repository: repo, ownedProducts: fallback })

  const item = await controller.preparePublishItem('local_1')

  assert.equal(item.sourceTitle, '目录商品')
  assert.deepEqual(fallback.resolvedIds, ['local_1'])
})

test('Issue19: 本地库与在售目录均未命中 → PRODUCT_NOT_FOUND（空结果不误创建）', async () => {
  const repo = createMemoryProductRepository()
  const fallback = new MockOwnedProductFallback(null)
  const controller = new PublishController({ repository: repo, ownedProducts: fallback })

  await assert.rejects(
    () => controller.preparePublishItem('gone_1'),
    (err: unknown) => {
      assert.ok(err instanceof PublishError)
      assert.equal((err as PublishError).code, 'PRODUCT_NOT_FOUND')
      return true
    },
  )
  assert.deepEqual(fallback.resolvedIds, ['gone_1'])
})

test('Issue19: 目录回退返回其他来源商品 → PRODUCT_SOURCE_NOT_ALLOWED，绝不误发', async () => {
  const repo = createMemoryProductRepository()
  const competitor = {
    ...createSampleProduct('comp_9'),
    source: 'captured_search' as const,
    status: 'unconfirmed',
  }
  const controller = new PublishController({
    repository: repo,
    ownedProducts: new MockOwnedProductFallback(competitor),
  })

  await assert.rejects(
    () => controller.preparePublishItem('comp_9'),
    (err: unknown) => {
      assert.ok(err instanceof PublishError)
      assert.equal((err as PublishError).code, 'PRODUCT_SOURCE_NOT_ALLOWED')
      return true
    },
  )
})

test('Issue19: 目录读取失败 → PRODUCT_SOURCE_UNAVAILABLE（区别于商品不存在，可重试）', async () => {
  const repo = createMemoryProductRepository()
  const fallback = new MockOwnedProductFallback(null)
  fallback.errorToThrow = new Error('未登录或登录状态已失效')
  const controller = new PublishController({ repository: repo, ownedProducts: fallback })

  await assert.rejects(
    () => controller.preparePublishItem('catalog_2'),
    (err: unknown) => {
      assert.ok(err instanceof PublishError)
      assert.equal((err as PublishError).code, 'PRODUCT_SOURCE_UNAVAILABLE')
      assert.equal((err as PublishError).retryable, true)
      return true
    },
  )
})

test('Issue19: 目录候选缺少可用图片 → IMAGE_DOWNLOAD_FAILED，无效候选不误创建', async () => {
  const repo = createMemoryProductRepository()
  const noImage = { ...createSampleProduct('no_img_1'), coverUrl: '', images: [] }
  const controller = new PublishController({
    repository: repo,
    ownedProducts: new MockOwnedProductFallback(noImage),
  })

  await assert.rejects(
    () => controller.preparePublishItem('no_img_1'),
    (err: unknown) => {
      assert.ok(err instanceof PublishError)
      assert.equal((err as PublishError).code, 'IMAGE_DOWNLOAD_FAILED')
      return true
    },
  )
})
