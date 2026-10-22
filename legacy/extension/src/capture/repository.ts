/**
 * 采集商品库仓储工厂（P4）。
 *
 * 优先原生 IndexedDB（无新依赖），环境不支持时优雅回退内存实现。
 */
import { createMemoryProductRepository } from '../../../shared/capture/product-repository'
import type { ProductRepository } from '../../../shared/capture/product-repository'
import { createIndexedDbProductRepository, isIndexedDbAvailable } from './indexed-db-repository'

/** 创建商品库仓储：可用时用原生 IndexedDB，否则回退内存。 */
export function createProductRepository(): ProductRepository {
  if (isIndexedDbAvailable()) {
    try {
      return createIndexedDbProductRepository()
    } catch {
      // 极少见：打开失败时回退内存，保证采集不因存储而整体失败。
    }
  }
  return createMemoryProductRepository()
}
