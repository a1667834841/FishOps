import type { ProductRepository } from '../../../../shared/capture/product-repository'
import { PublishController as RealPublishController, type PublishControllerDeps, type OwnedProductFallback } from '../controller'
import { createPublishRuntime as realCreatePublishRuntime, type PublishRuntimeDeps } from '../../background/publish-runtime'

/** 离线生命周期测试的目录替身；真实归属回归必须显式注入独立目录。 */
function fixtureDirectory(repository: ProductRepository): OwnedProductFallback {
  return { resolve: async (itemId) => {
    const page = await repository.list({source:'all',keyword:itemId,limit:50})
    const product = page.products.find(p=>p.itemId===itemId)
    return product?.source === 'my_published' ? product : null
  } }
}

/** 为旧有规则测试提供显式的离线目录依赖。 */
export class PublishController extends RealPublishController {
  constructor(deps: PublishControllerDeps) {
    super({...deps,ownedProducts:deps.ownedProducts ?? fixtureDirectory(deps.repository)})
  }
}

/** 为旧有生命周期测试提供显式的离线目录依赖。 */
export function createPublishRuntime(deps: PublishRuntimeDeps) {
  return realCreatePublishRuntime({...deps,ownedProducts:deps.ownedProducts ?? fixtureDirectory(deps.repository)})
}
