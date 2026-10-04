/**
 * 原生 IndexedDB 商品库仓储（P4）。
 *
 * 优先使用浏览器原生 IndexedDB（MV3 service worker 可用），避免引入新依赖。
 * 复用 `shared/capture/product-repository.ts` 的接口、排序与分页逻辑。
 *
 * 数据布局（DB: `fishops-products` v1）：
 * - `products`（keyPath: itemId）
 * - `snapshots`（keyPath: id，索引 itemId）
 */
import { buildProductSnapshot } from '../../../shared/capture/normalizer'
import { mergeProductForUpsert, queryProducts } from '../../../shared/capture/product-repository'
import type { ProductRepository } from '../../../shared/capture/product-repository'
import type {
  Product,
  ProductListQuery,
  ProductPage,
  ProductSnapshot,
  ProductUpsertResult,
} from '../../../shared/types/product'

const DB_NAME = 'fishops-products'
const DB_VERSION = 1
const PRODUCT_STORE = 'products'
const SNAPSHOT_STORE = 'snapshots'
const SNAPSHOT_ITEM_INDEX = 'itemId'

/** 当前环境是否可用原生 IndexedDB。 */
export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined'
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'))
  })
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PRODUCT_STORE)) {
        db.createObjectStore(PRODUCT_STORE, { keyPath: 'itemId' })
      }
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        const store = db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' })
        store.createIndex(SNAPSHOT_ITEM_INDEX, 'itemId', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'))
  })
}

/** 基于原生 IndexedDB 的商品库仓储。 */
export class IndexedDbProductRepository implements ProductRepository {
  private dbPromise: Promise<IDBDatabase> | null = null

  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDatabase()
    return this.dbPromise
  }

  /** 在指定 store 上执行单个请求（单请求事务，避免事务提前关闭）。 */
  private async withStore<T>(
    storeName: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.getDb()
    const transaction = db.transaction(storeName, mode)
    // 请求成功不代表事务已提交；快照引用只能在事务提交后写入任务断点。
    return new Promise<T>((resolve, reject) => {
      const request = run(transaction.objectStore(storeName))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务已中止'))
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'))
    })
  }

  async upsertProducts(products: readonly Product[], capturedAt: number): Promise<ProductUpsertResult> {
    let added = 0
    let updated = 0
    let snapshots = 0

    for (const product of products) {
      if (!product.itemId) continue

      const existing = await this.withStore(
        PRODUCT_STORE,
        'readonly',
        (store) => store.get(product.itemId) as IDBRequest<Product | undefined>,
      )
      const stored = mergeProductForUpsert(existing, product)
      await this.withStore(PRODUCT_STORE, 'readwrite', (store) => store.put(stored) as IDBRequest<IDBValidKey>)
      if (existing) updated += 1
      else added += 1

      // 当次采集内容与商品目录的合并策略隔离，恢复同步仍读取原始快照。
      const snapshot = buildProductSnapshot(product.captureKeyword === undefined ? stored : product, capturedAt)
      const existingSnapshot = await this.withStore(
        SNAPSHOT_STORE,
        'readonly',
        (store) => store.get(snapshot.id) as IDBRequest<ProductSnapshot | undefined>,
      )
      // 新采集的完整快照不可覆盖；旧分析快照保留原覆盖规则。
      if (!existingSnapshot || product.captureKeyword === undefined) {
        await this.withStore(SNAPSHOT_STORE, 'readwrite', (store) => store.put(snapshot) as IDBRequest<IDBValidKey>)
      }
      if (!existingSnapshot) snapshots += 1
    }

    return { added, updated, snapshots }
  }

  async list(query: ProductListQuery = {}): Promise<ProductPage> {
    const products = await this.withStore(
      PRODUCT_STORE,
      'readonly',
      (store) => store.getAll() as IDBRequest<Product[]>,
    )
    return queryProducts(products, query)
  }

  async getSnapshots(itemId: string): Promise<ProductSnapshot[]> {
    const db = await this.getDb()
    const transaction = db.transaction(SNAPSHOT_STORE, 'readonly')
    const index = transaction.objectStore(SNAPSHOT_STORE).index(SNAPSHOT_ITEM_INDEX)
    const snapshots = await requestToPromise(index.getAll(itemId) as IDBRequest<ProductSnapshot[]>)
    return snapshots.sort((a, b) => a.capturedAt - b.capturedAt)
  }

  async count(): Promise<number> {
    return this.withStore(PRODUCT_STORE, 'readonly', (store) => store.count())
  }

  async clear(): Promise<void> {
    await this.withStore(PRODUCT_STORE, 'readwrite', (store) => store.clear() as IDBRequest<undefined>)
    await this.withStore(SNAPSHOT_STORE, 'readwrite', (store) => store.clear() as IDBRequest<undefined>)
  }
}

/** 创建原生 IndexedDB 商品库仓储。 */
export function createIndexedDbProductRepository(): ProductRepository {
  return new IndexedDbProductRepository()
}
