/**
 * 发布草稿小型类型化 Store（P8 跨页面数据传递）。
 *
 * 职责：
 * 1. 承载从商品库（ProductsPage）飞书 Tab 或自营 Tab 点击“发布”时传递的选中条目；
 * 2. 精确记录 recordId 与 targetTableId（飞书来源）或真实 itemId（自营来源），绝不为飞书素材伪造假 itemId；
 * 3. 纯 TypeScript 实现，支持在 Node 单测中独立验证，亦可供 Vue 组件订阅；
 * 4. 仅作为发布准备草稿使用，绝不自动发起任务创建、表单填充或发布提交。
 */

export interface PublishDraft {
  /** 来源类型：飞书素材商品库 或 当前账号已发布商品库 */
  source: 'feishu' | 'my_published'
  /** 飞书记录 ID（作为行稳定 identity，飞书来源必须提供） */
  recordId?: string
  /** 飞书目标数据表 ID（飞书来源精准携带） */
  targetTableId?: string
  /** 闲鱼真实商品 ID（仅自营或飞书明确包含闲鱼 ID 时提供，绝不造假） */
  itemId?: string
  /** 商品标题 */
  title: string
  /** 商品描述 */
  desc?: string
  /** 售价数值 */
  price: number
  /** 划线原价数值 */
  originalPrice?: number
  /** 封面图片 URL */
  coverUrl?: string
  /** 图片 URL 列表（支持多图） */
  imageUrls?: string[]
}

export class PublishDraftStore {
  private draft: PublishDraft | null = null
  private readonly listeners = new Set<(draft: PublishDraft | null) => void>()

  setDraft(draft: PublishDraft): void {
    this.draft = {
      ...draft,
      imageUrls: draft.imageUrls ? [...draft.imageUrls] : draft.coverUrl ? [draft.coverUrl] : [],
    }
    this.notify()
  }

  getDraft(): PublishDraft | null {
    if (!this.draft) return null
    return {
      ...this.draft,
      imageUrls: this.draft.imageUrls ? [...this.draft.imageUrls] : [],
    }
  }

  clearDraft(): void {
    this.draft = null
    this.notify()
  }

  subscribe(listener: (draft: PublishDraft | null) => void): () => void {
    this.listeners.add(listener)
    listener(this.getDraft())
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    const current = this.getDraft()
    for (const listener of [...this.listeners]) {
      listener(current)
    }
  }
}

/** 单例导出，供整个 Workbench 跨组件使用 */
export const publishDraftStore = new PublishDraftStore()
