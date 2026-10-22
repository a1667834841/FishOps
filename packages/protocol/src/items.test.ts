import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeDetail, normalizeSearch, normalizeSuggest } from '../../../apps/extension/src/modules/items.ts'
import { isReadResult } from './items.ts'

/** 与 extension 归一化测试一致的搜索原始响应，用于验证真实归一化结果。 */
const searchPayload = {
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
                args: { item_id: 'item-1', publishTime: '1700000000000', user_id: 'viewer-me' },
              },
            },
          },
        },
      },
    ],
  },
}

const detailPayload = {
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
      desc: '标准描述',
      imageInfos: [{ url: '//img.example.com/a.jpg' }, { url: '//img.example.com/a.jpg' }],
    },
    sellerDO: { sellerId: 'seller-1', nick: '李四', city: '上海市' },
  },
}

const suggestPayload = {
  ret: ['SUCCESS::调用成功'],
  data: { items: [{ suggest: ' iPhone 17 ' }, { suggest: 'iphone 17' }, { suggest: 'iPad' }] },
}

/** 合法摘要，用于构造字段级恶意输入。 */
function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  }
}

/** 合法详情，用于构造字段级恶意输入。 */
function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...summary(),
    description: '标准描述',
    images: ['https://img.example.com/a.jpg'],
    status: 'on_sale',
    browseCnt: 100,
    collectCnt: 12,
    ...overrides,
  }
}

function searchResult(items: unknown[], overrides: Record<string, unknown> = {}): unknown {
  return { items, hasMore: null, ...overrides }
}

test('真实归一化结果通过公共输出 schema', () => {
  assert.equal(isReadResult('search.items', normalizeSearch(searchPayload)), true)
  assert.equal(isReadResult('item.detail', normalizeDetail(detailPayload)), true)
  assert.equal(isReadResult('search.suggest', normalizeSuggest(suggestPayload)), true)

  // 平台明确返回的空结果同样合法，缺失字段才拒绝。
  assert.equal(isReadResult('search.items', normalizeSearch({ data: { resultList: [] } })), true)
  assert.equal(isReadResult('search.suggest', normalizeSuggest({ ret: ['SUCCESS::调用成功'], data: { items: [] } })), true)

  // 归一化输出的未知字段必须是 null，schema 也接受这种形状。
  const sparse = normalizeSearch({
    data: { resultList: [{ data: { item: { main: { exContent: { price: [] }, clickParam: { args: { item_id: 'x' } } } } } }] },
  })
  assert.equal(isReadResult('search.items', sparse), true)
})

test('拒绝未知字段与混入的 token、原始 MTOP 字段', () => {
  const extraFields = [{ token: 'x' }, { ret: ['SUCCESS::调用成功'] }, { data: { items: [] } }, { cookies: 'a=b' }, { sign: 'deadbeef' }]
  for (const extra of extraFields) {
    assert.equal(isReadResult('search.items', searchResult([summary()], extra)), false)
    assert.equal(isReadResult('search.items', searchResult([summary(extra)])), false)
    assert.equal(isReadResult('item.detail', detail(extra)), false)
  }
  for (const polluted of [['a', { suggest: 'b' }], 'not-an-array', null, 42]) {
    assert.equal(isReadResult('search.suggest', polluted), false)
  }
})

test('拒绝原型链伪装、非纯对象与非对象载体', () => {
  const inherited = Object.assign(Object.create({ token: 'leak' }), summary())
  assert.equal(isReadResult('search.items', searchResult([inherited])), false)

  // 无原型字面量与 JSON 往返结果都是纯数据，必须接受。
  const bare = Object.assign(Object.create(null), summary())
  assert.equal(isReadResult('search.items', searchResult([bare])), true)

  const ownProtoKey = JSON.parse(
    '{"itemId":"i","title":null,"price":null,"image":null,"sellerId":null,"sellerNick":null,"city":null,"wantCnt":null,"publishedAt":null,"url":null,"__proto__":{"hacked":true}}',
  )
  assert.equal(isReadResult('search.items', searchResult([ownProtoKey])), false)

  assert.equal(isReadResult('search.items', []), false)
  assert.equal(isReadResult('item.detail', { ...detail(), images: new Set() }), false)
})

test('拒绝非有限数值、负计数与数字或空白 ID', () => {
  for (const wantCnt of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '5', true]) {
    assert.equal(isReadResult('search.items', searchResult([summary({ wantCnt })])), false)
  }
  for (const publishedAt of [NaN, Infinity, -1, 1.5, '1700000000000']) {
    assert.equal(isReadResult('search.items', searchResult([summary({ publishedAt })])), false)
  }
  for (const browseCnt of [NaN, Infinity, -1, 2.5]) {
    assert.equal(isReadResult('item.detail', detail({ browseCnt })), false)
  }
  for (const itemId of [123, 0, '', '   ', null, undefined]) {
    assert.equal(isReadResult('search.items', searchResult([summary({ itemId })])), false)
    assert.equal(isReadResult('item.detail', detail({ itemId })), false)
  }
  assert.equal(isReadResult('search.items', searchResult([summary({ wantCnt: 0, publishedAt: 0 })])), true)
})

test('拒绝超长文本与超限集合，保留边界值', () => {
  assert.equal(isReadResult('search.items', searchResult([summary({ itemId: 'a'.repeat(129) })])), false)
  assert.equal(isReadResult('search.items', searchResult([summary({ itemId: 'a'.repeat(128) })])), true)
  assert.equal(isReadResult('search.items', searchResult([summary({ title: 'a'.repeat(2001) })])), false)
  assert.equal(isReadResult('search.items', searchResult([summary({ title: 'a'.repeat(2000) })])), true)
  assert.equal(isReadResult('search.items', searchResult([summary({ sellerNick: 'a'.repeat(2001) })])), false)
  assert.equal(isReadResult('search.items', searchResult([summary({ price: 'a'.repeat(101) })])), false)
  assert.equal(isReadResult('search.items', searchResult([summary({ price: 'a'.repeat(100) })])), true)
  assert.equal(isReadResult('item.detail', detail({ description: 'a'.repeat(100001) })), false)
  assert.equal(isReadResult('item.detail', detail({ description: 'a'.repeat(100000) })), true)

  const manyImages = Array.from({ length: 101 }, (_, index) => `https://img.example.com/${index}.jpg`)
  assert.equal(isReadResult('item.detail', detail({ images: manyImages })), false)
  assert.equal(isReadResult('item.detail', detail({ images: manyImages.slice(0, 100) })), true)

  const manyItems = Array.from({ length: 31 }, () => summary())
  assert.equal(isReadResult('search.items', searchResult(manyItems)), false)
  assert.equal(isReadResult('search.items', searchResult(manyItems.slice(0, 30))), true)

  assert.equal(isReadResult('search.suggest', Array.from({ length: 21 }, (_, index) => `词${index}`)), false)
  assert.equal(isReadResult('search.suggest', Array.from({ length: 20 }, (_, index) => `词${index}`)), true)
  assert.equal(isReadResult('search.suggest', ['a'.repeat(81)]), false)
  assert.equal(isReadResult('search.suggest', ['a'.repeat(80)]), true)
})

test('URL 只接受 http/https，images 不重复且元素必须是安全 URL', () => {
  for (const image of ['javascript:alert(1)', 'ftp://img.example.com/a.jpg', '//img.example.com/a.jpg', 'not-a-url', '']) {
    assert.equal(isReadResult('search.items', searchResult([summary({ image })])), false)
  }
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'not-a-url']) {
    assert.equal(isReadResult('search.items', searchResult([summary({ url })])), false)
  }
  assert.equal(isReadResult('search.items', searchResult([summary({ image: null, url: null })])), true)
  assert.equal(isReadResult('search.items', searchResult([summary({ image: 'http://img.example.com/a.jpg' })])), true)

  assert.equal(isReadResult('item.detail', detail({ images: null })), true)
  assert.equal(isReadResult('item.detail', detail({ images: [] })), true)
  assert.equal(isReadResult('item.detail', detail({ images: ['https://a/1.jpg', 'https://a/1.jpg'] })), false)
  assert.equal(isReadResult('item.detail', detail({ images: ['https://a/1.jpg', null] })), false)
  assert.equal(isReadResult('item.detail', detail({ images: ['https://a/1.jpg', 'http://b/2.jpg'] })), true)
})

test('status 与 hasMore 只接受明确值，缺少必需字段拒绝', () => {
  for (const status of ['ON_SALE', 'pending', 'sold_out', '', 1, null]) {
    assert.equal(isReadResult('item.detail', detail({ status })), false)
  }
  for (const status of ['on_sale', 'sold', 'unknown']) {
    assert.equal(isReadResult('item.detail', detail({ status })), true)
  }
  for (const hasMore of ['true', 1, undefined]) {
    assert.equal(isReadResult('search.items', searchResult([summary()], { hasMore })), false)
  }
  for (const hasMore of [true, false, null]) {
    assert.equal(isReadResult('search.items', searchResult([summary()], { hasMore })), true)
  }

  const { title, ...missing } = summary()
  assert.equal(isReadResult('search.items', searchResult([missing])), false)
  assert.equal(isReadResult('search.items', { items: [summary()] }), false)
  assert.equal(isReadResult('item.detail', { ...detail(), status: undefined }), false)
})

test('建议词拒绝重复、空串与非字符串，只接受三个只读方法', () => {
  assert.equal(isReadResult('search.suggest', ['a', 'A']), false)
  assert.equal(isReadResult('search.suggest', ['a', '']), false)
  assert.equal(isReadResult('search.suggest', ['a', 1]), false)
  assert.equal(isReadResult('search.suggest', ['a', 'b']), true)
  assert.equal(isReadResult('search.suggest', []), true)

  assert.equal(isReadResult('chat.send', {}), false)
  assert.equal(isReadResult('search.items', { items: [], hasMore: null, extra: 1 }), false)
  assert.equal(isReadResult('item.detail', normalizeSearch(searchPayload)), false)
  assert.equal(isReadResult('search.suggest', normalizeDetail(detailPayload)), false)
})
