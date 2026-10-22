/**
 * 归一化（normalizer）单测：对照旧 `processListData` 的字段口径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildProductSnapshot,
  mergeProductImages,
  normalizeDetailPatch,
  normalizeProductFromSearchItem,
  normalizeProductsFromSearchPayload,
  normalizeUrl,
} from '../../../../shared/capture/normalizer'

test('normalizeUrl 处理协议相对地址与空白', () => {
  assert.equal(normalizeUrl('//img.example.com/a.jpg'), 'https://img.example.com/a.jpg')
  assert.equal(normalizeUrl(' https://x/y '), 'https://x/y')
  assert.equal(normalizeUrl(undefined), '')
  assert.equal(normalizeUrl(123), '')
})

test('normalizeProductsFromSearchPayload 提取 data.resultList', () => {
  const payload = {
    ret: ['SUCCESS::调用成功'],
    data: {
      resultList: [
        {
          data: {
            item: {
              main: {
                exContent: {
                  title: 'iPhone 17',
                  price: [{ text: '¥' }, { text: '5999' }],
                  oriPrice: '¥6999',
                  picUrl: '//img.example.com/p.jpg',
                  userNickName: '张三',
                  area: '上海',
                  fishTags: {
                    r1: { tagList: [{ data: { content: '12人想要' } }, { data: { content: 'freeShippingIcon' } }] },
                    r2: { tagList: [{ data: { content: '全新' } }] },
                  },
                },
                clickParam: { args: { item_id: 'item-1', publishTime: '1700000000000', tag: 'freeship' } },
              },
            },
          },
        },
      ],
    },
  }

  const products = normalizeProductsFromSearchPayload(payload, 1700000001000)
  assert.equal(products.length, 1)
  const p = products[0]!
  assert.equal(p.itemId, 'item-1')
  assert.equal(p.title, 'iPhone 17')
  assert.equal(p.price, '¥5999')
  assert.equal(p.priceNumber, 5999)
  assert.equal(p.originalPrice, '¥6999')
  assert.equal(p.originalPriceNumber, 6999)
  assert.equal(p.wantCnt, 12)
  assert.equal(p.freeShip, '是')
  assert.equal(p.tags, '包邮、全新')
  assert.equal(p.sellerNick, '张三')
  assert.equal(p.sellerCity, '上海')
  assert.equal(p.coverUrl, 'https://img.example.com/p.jpg')
  assert.equal(p.detailUrl, 'https://www.goofish.com/item?id=item-1')
  assert.equal(p.captureTimeMs, 1700000001000)
  assert.equal(p.publishTimeMs, 1700000000000)
})

test('缺少 itemId 的条目被丢弃（不臆造）', () => {
  const payload = { data: { resultList: [{ data: { item: { main: { exContent: {}, clickParam: { args: {} } } } } }] } }
  assert.deepEqual(normalizeProductsFromSearchPayload(payload, 1), [])
})

test('结构不符 / 空数据返回空数组', () => {
  assert.deepEqual(normalizeProductsFromSearchPayload(null, 1), [])
  assert.deepEqual(normalizeProductsFromSearchPayload({ data: {} }, 1), [])
  assert.equal(normalizeProductFromSearchItem({}, 1), null)
})

test('normalizeDetailPatch 只填充真实存在的字段', () => {
  const patch = normalizeDetailPatch({
    data: {
      itemDO: { browseCnt: 100, wantCnt: 0, city: '北京', imageInfos: [{ url: '//a/1.jpg' }, { url: '' }] },
      sellerDO: { sellerId: 123, nick: '李四' },
    },
  })
  assert.equal(patch.browseCnt, 100)
  assert.equal(patch.wantCnt, 0)
  assert.equal(patch.sellerCity, '北京')
  assert.deepEqual(patch.images, ['https://a/1.jpg'])
  // sellerId 为数字 → 统一转字符串保留（避免丢失卖家身份）
  assert.equal(patch.sellerId, '123')
  assert.equal(patch.sellerNick, '李四')
  assert.equal(patch.desc, undefined)

  assert.deepEqual(normalizeDetailPatch(null), {})
})

test('normalizeDetailPatch 图片全量规范化、去重保序', () => {
  const patch = normalizeDetailPatch({
    data: {
      itemDO: {
        imageInfos: [
          { url: '//img.example/a.jpg' },
          { url: '//img.example/a.jpg' },
          { url: 'https://img.example/b.jpg' },
          { url: '//img.example/a.jpg' },
          { url: '' },
        ],
      },
    },
  })
  // 协议相对地址规范化 + 去重 + 保留首次出现顺序 + 丢弃空值。
  assert.deepEqual(patch.images, ['https://img.example/a.jpg', 'https://img.example/b.jpg'])
})

test('mergeProductImages 已有在前、追加去重保序，不覆盖已有集合', () => {
  assert.deepEqual(mergeProductImages(['https://a/1.jpg'], ['//a/1.jpg', '//a/2.jpg']), [
    'https://a/1.jpg',
    'https://a/2.jpg',
  ])
  assert.deepEqual(mergeProductImages(undefined, ['https://a/1.jpg', 'https://a/1.jpg']), [
    'https://a/1.jpg',
  ])
  assert.deepEqual(mergeProductImages(['https://a/1.jpg'], undefined), ['https://a/1.jpg'])
})

test('buildProductSnapshot 生成稳定快照 ID', () => {
  const snapshot = buildProductSnapshot(
    {
      itemId: 'i1',
      title: '',
      price: '¥10',
      priceNumber: 10,
      originalPrice: '',
      originalPriceNumber: 0,
      wantCnt: 3,
      publishTime: '',
      publishTimeMs: 0,
      captureTime: '',
      captureTimeMs: 100,
      sellerNick: '',
      sellerCity: '',
      freeShip: '否',
      tags: '',
      coverUrl: '',
      detailUrl: '',
    },
    100,
  )
  assert.equal(snapshot.id, 'i1@100')
  assert.equal(snapshot.wantCnt, 3)
  assert.equal(snapshot.priceNumber, 10)
})

test('sellerId 只取明确卖家字段：绝不把埋点 clickParam.user_id（当前账号）当卖家', () => {
  const payload = {
    data: {
      resultList: [
        {
          data: {
            item: {
              main: {
                // 真实卖家来自 exContent.userId
                exContent: { title: '他人商品', userId: 'seller_real_777' },
                // 埋点浏览者（当前登录账号），与卖家不同
                clickParam: { args: { item_id: 'i-1', user_id: 'viewer_me_123' } },
              },
            },
          },
        },
      ],
    },
  }

  const [p] = normalizeProductsFromSearchPayload(payload, 1)
  assert.equal(p!.sellerId, 'seller_real_777')
})

test('仅有埋点 user_id 而无卖家字段：sellerId 留空（不臆断卖家身份）', () => {
  const payload = {
    data: {
      resultList: [
        {
          data: {
            item: {
              main: {
                exContent: { title: '未知卖家' },
                clickParam: { args: { item_id: 'i-2', user_id: 'viewer_me_123' } },
              },
            },
          },
        },
      ],
    },
  }

  const [p] = normalizeProductsFromSearchPayload(payload, 1)
  assert.equal(p!.sellerId, undefined)
})

test('sellerId 采纳明确的 exContent.sellerId / exContent.userId，其次 clickParam.seller_id', () => {
  const payload = {
    data: {
      resultList: [
        { data: { item: { main: { exContent: { title: 'A', sellerId: 'seller_explicit' }, clickParam: { args: { item_id: 'a' } } } } } },
        { data: { item: { main: { exContent: { title: 'B' }, clickParam: { args: { item_id: 'b', seller_id: 'seller_click' } } } } } },
        { data: { item: { main: { exContent: { title: 'C', userId: 'seller_userid' }, clickParam: { args: { item_id: 'c', seller_id: 'seller_click_c' } } } } } },
      ],
    },
  }

  const products = normalizeProductsFromSearchPayload(payload, 1)
  assert.equal(products[0]!.sellerId, 'seller_explicit')
  assert.equal(products[1]!.sellerId, 'seller_click')
  // exContent 的卖家字段优先于 clickParam.seller_id
  assert.equal(products[2]!.sellerId, 'seller_userid')
})

test('sellerId 兼容数字类型：数字卖家 ID 统一转字符串保留（搜索与详情）', () => {
  const payload = {
    data: {
      resultList: [
        // exContent.userId 为数字
        { data: { item: { main: { exContent: { title: 'N1', userId: 888001 }, clickParam: { args: { item_id: 'n1' } } } } } },
        // clickParam.seller_id 为数字
        { data: { item: { main: { exContent: { title: 'N2' }, clickParam: { args: { item_id: 'n2', seller_id: 888002 } } } } } },
      ],
    },
  }
  const products = normalizeProductsFromSearchPayload(payload, 1)
  assert.equal(products[0]!.sellerId, '888001')
  assert.equal(products[1]!.sellerId, '888002')

  const patch = normalizeDetailPatch({ data: { sellerDO: { sellerId: 888003 } } })
  assert.equal(patch.sellerId, '888003')
})

test('normalizeDetailPatch 兼容真实描述字段（desc / description）', () => {
  // 标准字段 desc。
  assert.equal(normalizeDetailPatch({ data: { itemDO: { desc: '标准描述' } } }).desc, '标准描述')
  // 部分响应使用 description 别名。
  assert.equal(normalizeDetailPatch({ data: { itemDO: { description: '别名描述' } } }).desc, '别名描述')
  // 同时存在时标准字段优先。
  assert.equal(
    normalizeDetailPatch({ data: { itemDO: { desc: '标准', description: '别名' } } }).desc,
    '标准',
  )
  // 无描述时不写入（不臆造）。
  assert.equal(normalizeDetailPatch({ data: { itemDO: {} } }).desc, undefined)
})

test('normalizeDetailPatch 地区兼容 prov：缺失 city 时用省份兜底（不臆造）', () => {
  // 真实详情响应可能只返回省份 `prov`（见 goods-api.js：`itemDO.prov || itemDO.city`）。
  assert.equal(normalizeDetailPatch({ data: { itemDO: { prov: '浙江省' } } }).sellerCity, '浙江省')
  // city（市）优先于 prov（省），更具体。
  assert.equal(
    normalizeDetailPatch({ data: { itemDO: { city: '杭州市', prov: '浙江省' } } }).sellerCity,
    '杭州市',
  )
  // 地区也可能放在 sellerDO。
  assert.equal(normalizeDetailPatch({ data: { sellerDO: { prov: '广东省' } } }).sellerCity, '广东省')
  // 无任何地区字段时不写入（不臆造）。
  assert.equal(normalizeDetailPatch({ data: { itemDO: {} } }).sellerCity, undefined)
})

test('normalizeDetailPatch 想要人数兼容数值与字符串（含千分位 / 「人想要」）', () => {
  assert.equal(normalizeDetailPatch({ data: { itemDO: { wantCnt: 0 } } }).wantCnt, 0)
  assert.equal(normalizeDetailPatch({ data: { itemDO: { wantCnt: 12 } } }).wantCnt, 12)
  assert.equal(normalizeDetailPatch({ data: { itemDO: { wantCnt: '12人想要' } } }).wantCnt, 12)
  assert.equal(normalizeDetailPatch({ data: { itemDO: { wantCnt: '1,234' } } }).wantCnt, 1234)
  // 无法解析时不写入（不臆造 0）。
  assert.equal(normalizeDetailPatch({ data: { itemDO: { wantCnt: '暂无' } } }).wantCnt, undefined)
})
