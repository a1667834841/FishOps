/**
 * 采集测试夹具：构造与旧实现口径一致的搜索结果页、可注入平台与可控时钟。
 */
import type { CapturePlatform, CaptureSearchParams } from '../controller'

export interface ListItemOptions {
  itemId: string
  title?: string
  priceText?: string
  oriPrice?: string
  wantCnt?: number
  freeShip?: boolean
  publishTime?: number
  picUrl?: string
  sellerNick?: string
  sellerCity?: string
  /** 商品真实卖家 ID（写入 `exContent.userId`）。 */
  sellerId?: string
  /**
   * 埋点 `clickParam.args.user_id` —— 浏览该条目的账号 ID（搜索者 / 当前账号），**不是卖家 ID**。
   * 默认回落到 `sellerId` 以兼容既有夹具；真实数据中它与 `sellerId` 往往不同。
   */
  clickParamUserId?: string
  extraTags?: string[]
}

/** 构造一条搜索结果条目（`data.item.main` 结构，与闲鱼 MTOP 返回一致）。 */
export function makeListItem(options: ListItemOptions): unknown {
  const {
    itemId,
    title = `商品${itemId}`,
    priceText = '¥100',
    oriPrice = '',
    wantCnt = 0,
    freeShip = false,
    publishTime = 1700000000000,
    picUrl = '//img.example.com/a.jpg',
    sellerNick = '卖家',
    sellerCity = '杭州',
    sellerId,
    clickParamUserId = sellerId,
    extraTags = [],
  } = options

  const tagList = [
    { data: { content: `${wantCnt}人想要` } },
    ...extraTags.map((content) => ({ data: { content } })),
    ...(freeShip ? [{ data: { content: 'freeShippingIcon' } }] : []),
  ]

  return {
    data: {
      item: {
        main: {
          exContent: {
            title,
            price: [{ text: priceText }],
            oriPrice,
            picUrl,
            userNickName: sellerNick,
            area: sellerCity,
            userId: sellerId,
            fishTags: { r1: { tagList } },
          },
          clickParam: {
            args: {
              item_id: itemId,
              publishTime: String(publishTime),
              ...(clickParamUserId ? { user_id: clickParamUserId } : {}),
              ...(freeShip ? { tag: 'freeship' } : {}),
            },
          },
        },
      },
    },
  }
}

/** 构造一页搜索结果（`data.resultList`）。 */
export function makePage(items: unknown[]): unknown {
  return { ret: ['SUCCESS::调用成功'], data: { resultList: items } }
}

/** 可注入的 mock 平台：按页返回数据、可注入错误 / 阻塞钩子，并记录调用。 */
export class MockPlatform implements CapturePlatform {
  available = true
  readonly pages = new Map<number, unknown>()
  readonly errors = new Map<number, unknown>()
  readonly hooks = new Map<number, () => Promise<void> | void>()
  readonly searchCalls: number[] = []
  readonly detailCalls: string[] = []
  /** suggest 调用记录（关键词）。 */
  readonly suggestCalls: string[] = []
  /** suggest 默认返回值（未设置 suggestImpl 时使用）。 */
  suggestWords: string[] = []
  /** 自定义 suggest 实现（用于验詁去重 / 并发 / 乱序响应）。 */
  suggestImpl?: (keyword: string) => Promise<string[]>
  /** suggest 需要抛出的错误（未设置 suggestImpl 时使用）。 */
  suggestError: unknown = null
  detailPayload: unknown = {
    data: {
      itemDO: {
        browseCnt: 11,
        collectCnt: 2,
        wantCnt: 5,
        categoryId: 'cat-1',
        desc: '描述',
        imageInfos: [{ url: '//img.example.com/detail.jpg' }],
      },
      sellerDO: { sellerId: 'sid-1', nick: '详情卖家', uniqueName: 'unique-1' },
    },
  }

  isAvailable(): boolean {
    return this.available
  }

  async search(params: CaptureSearchParams): Promise<unknown> {
    this.searchCalls.push(params.pageNumber)
    const hook = this.hooks.get(params.pageNumber)
    if (hook) await hook()
    const error = this.errors.get(params.pageNumber)
    if (error) throw error
    return this.pages.get(params.pageNumber) ?? makePage([])
  }

  async detail(itemId: string): Promise<unknown> {
    this.detailCalls.push(itemId)
    return this.detailPayload
  }

  async suggest(keyword: string): Promise<string[]> {
    this.suggestCalls.push(keyword)
    if (this.suggestImpl) return this.suggestImpl(keyword)
    if (this.suggestError) throw this.suggestError
    return this.suggestWords
  }
}

/** 可确定性控制的时钟 / 休眠，用于验证限速。 */
export function makeClock(): {
  sleeps: number[]
  now: () => number
  sleep: (ms: number) => Promise<void>
  advance: (ms: number) => void
} {
  let time = 0
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      if (ms > 0) sleeps.push(ms)
      time += Math.max(0, ms)
    },
    advance: (ms: number) => {
      time += ms
    },
  }
}
