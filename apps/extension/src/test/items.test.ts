import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ItemNormalizationError,
  normalizeDetail,
  normalizeSearch,
  normalizeSuggest,
} from '../modules/items.ts'

describe('normalizeSearch', () => {
  it('按 legacy 的 data.resultList 结构迁移商品字段', () => {
    const result = normalizeSearch({
      ret: ['SUCCESS::调用成功'],
      data: {
        hasMore: true,
        resultList: [
          {
            data: {
              item: {
                main: {
                  exContent: {
                    itemId: 'fallback-item',
                    title: ' iPhone 17 ',
                    price: [{ text: '¥' }, { text: '5999' }, { text: '.00' }],
                    picUrl: '//img.example.com/p.jpg',
                    userNickName: '张三',
                    area: '上海',
                    sellerId: 888001,
                    fishTags: {
                      r1: {
                        tagList: [
                          { data: { content: '1,234人想要' } },
                          { data: { content: 'freeShippingIcon' } },
                        ],
                      },
                    },
                  },
                  clickParam: {
                    args: {
                      item_id: 'item-1',
                      publishTime: '1700000000000',
                      // 浏览者 ID 不是卖家 ID，归一化绝不能读取它。
                      user_id: 'viewer-me',
                    },
                  },
                },
              },
            },
          },
        ],
      },
    })

    assert.equal(result.hasMore, true)
    assert.deepEqual(result.items, [
      {
        itemId: 'item-1',
        title: 'iPhone 17',
        price: '¥5999.00',
        image: 'https://img.example.com/p.jpg',
        sellerId: '888001',
        sellerNick: '张三',
        city: '上海',
        wantCnt: 1234,
        publishedAt: 1700000000000,
        url: 'https://www.goofish.com/item?id=item-1',
      },
    ])
  })

  it('缺失 resultList、结构错误或 MTOP 失败都拒绝，不伪装为空成功', () => {
    for (const payload of [
      null,
      {},
      { data: {} },
      { data: { resultList: null } },
      { ret: ['FAIL_SYS_USER_VALIDATE::需要验证'] },
    ]) {
      assert.throws(() => normalizeSearch(payload), ItemNormalizationError)
    }

    assert.deepEqual(normalizeSearch({ data: { resultList: [] } }), {
      items: [],
      hasMore: null,
    })
  })

  it('跳过广告/非商品，但商品结构缺 itemId 时整页失败，不伪造 ID', () => {
    assert.deepEqual(
      normalizeSearch({
        data: {
          resultList: [
            null,
            { data: { item: {} } },
            { data: { item: { main: null } } },
            { data: { item: { main: '不是商品对象' } } },
            { data: { item: { main: [{ exContent: { title: '数组不是商品' } }] } } },
            { template: 'ad-card' },
          ],
        },
      }).items,
      [],
    )

    assert.throws(
      () =>
        normalizeSearch({
          data: {
            resultList: [
              {
                data: {
                  item: {
                    main: {
                      exContent: { title: '缺少 ID 的商品' },
                      clickParam: { args: { user_id: 'viewer-me' } },
                    },
                  },
                },
              },
            ],
          },
        }),
      ItemNormalizationError,
    )
  })

  it('按 itemId 去重并保留首次出现', () => {
    const result = normalizeSearch({
      data: {
        resultList: [
          product('same', '第一次'),
          product('other', '另一个'),
          product('same', '重复项'),
        ],
      },
    })
    assert.deepEqual(
      result.items.map((item) => [item.itemId, item.title]),
      [
        ['same', '第一次'],
        ['other', '另一个'],
      ],
    )
  })

  it('未知字段为 null，hasMore 只接受明确布尔值且发布时间不取当前时间', () => {
    const result = normalizeSearch({
      data: {
        hasMore: 'true',
        resultList: [
          {
            data: {
              item: {
                main: {
                  exContent: {
                    price: [],
                    picUrl: 'javascript:alert(1)',
                    sellerId: 9007199254740992,
                  },
                  clickParam: { args: { item_id: 'missing-fields', user_id: 'viewer-me' } },
                },
              },
            },
          },
        ],
      },
    })

    assert.equal(result.hasMore, null)
    assert.deepEqual(result.items[0], {
      itemId: 'missing-fields',
      title: null,
      price: null,
      image: null,
      sellerId: null,
      sellerNick: null,
      city: null,
      wantCnt: null,
      publishedAt: null,
      url: 'https://www.goofish.com/item?id=missing-fields',
    })
  })
})

describe('normalizeDetail', () => {
  it('迁移 itemDO/sellerDO 字段，图片去重并保留价格字符串', () => {
    const detail = normalizeDetail({
      ret: ['SUCCESS::调用成功'],
      data: {
        itemDO: {
          itemId: 888003,
          title: '详情商品',
          soldPrice: '35000.00',
          gmtCreate: 1700000000000,
          browseCnt: 100,
          collectCnt: 12,
          wantCnt: '1,234人想要',
          city: '杭州市',
          prov: '浙江省',
          desc: '标准描述',
          description: '别名描述',
          imageInfos: [
            { url: '//img.example.com/a.jpg' },
            { url: '//img.example.com/a.jpg' },
            { url: 'ftp://img.example.com/b.jpg' },
            { url: 'https://img.example.com/c.jpg' },
          ],
        },
        sellerDO: { sellerId: 'seller-1', nick: '李四', city: '上海市' },
      },
    })

    assert.deepEqual(detail, {
      itemId: '888003',
      title: '详情商品',
      price: '35000.00',
      image: 'https://img.example.com/a.jpg',
      sellerId: 'seller-1',
      sellerNick: '李四',
      city: '杭州市',
      wantCnt: 1234,
      publishedAt: 1700000000000,
      url: 'https://www.goofish.com/item?id=888003',
      description: '标准描述',
      images: ['https://img.example.com/a.jpg', 'https://img.example.com/c.jpg'],
      status: 'unknown',
      browseCnt: 100,
      collectCnt: 12,
    })
  })

  it('缺失可选字段为 null，status 只接受明确已知值', () => {
    const detail = normalizeDetail({
      data: {
        itemDO: { itemId: 'd-1', status: '未知状态' },
        sellerDO: {},
      },
    })
    assert.deepEqual(detail, {
      itemId: 'd-1',
      title: null,
      price: null,
      image: null,
      sellerId: null,
      sellerNick: null,
      city: null,
      wantCnt: null,
      publishedAt: null,
      url: 'https://www.goofish.com/item?id=d-1',
      description: null,
      images: null,
      status: 'unknown',
      browseCnt: null,
      collectCnt: null,
    })

    assert.equal(
      normalizeDetail({ data: { itemDO: { itemId: 'd-2', status: '在售' } } }).status,
      'on_sale',
    )
    assert.equal(
      normalizeDetail({ data: { itemDO: { itemId: 'd-3', status: '已售' } } }).status,
      'sold',
    )
  })

  it('详情缺 itemDO 或商品 ID 时拒绝，不伪造结果', () => {
    for (const payload of [
      null,
      {},
      { data: {} },
      { data: { itemDO: null } },
      { data: { itemDO: { title: '无 ID' } } },
      { ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'] },
    ]) {
      assert.throws(() => normalizeDetail(payload), ItemNormalizationError)
    }
  })
})

describe('normalizeSuggest', () => {
  it('提取 data.items[].suggest，过滤空值并大小写不敏感去重', () => {
    assert.deepEqual(
      normalizeSuggest({
        ret: ['SUCCESS::调用成功'],
        data: {
          items: [
            { suggest: ' iPhone 17 ' },
            { suggest: 'iphone 17' },
            { suggest: '' },
            { other: '不是建议词' },
            { suggest: 'iPad' },
            { suggest: 42 },
          ],
        },
      }),
      ['iPhone 17', 'iPad'],
    )
  })

  it('缺 ret/data/items 或 items 类型错误时拒绝，只有明确空数组才返回空', () => {
    for (const payload of [
      null,
      { data: { items: [] } },
      { ret: ['SUCCESS::调用成功'] },
      { ret: ['SUCCESS::调用成功'], data: {} },
      { ret: ['SUCCESS::调用成功'], data: { items: null } },
      { ret: ['SUCCESS::调用成功'], data: { items: 'wrong' } },
      { ret: ['SUCCESS::调用成功'], data: { items: {} } },
      { ret: ['FAIL_SYS_USER_VALIDATE::需要验证'] },
    ]) {
      assert.throws(() => normalizeSuggest(payload), ItemNormalizationError)
    }

    assert.deepEqual(
      normalizeSuggest({ ret: ['SUCCESS::调用成功'], data: { items: [] } }),
      [],
    )
  })
})

function product(itemId: string, title: string): Record<string, unknown> {
  return {
    data: {
      item: {
        main: {
          exContent: { title },
          clickParam: { args: { item_id: itemId } },
        },
      },
    },
  }
}
