/**
 * 官方「我的商品库」只读读取器契约测试。
 *
 * 以 space133 当前账号的**真实响应字段**为准（非假定）：
 * - `data.itemGroupList[].{groupName,groupId,itemNumber}` 用于发现「在售」分组（groupId 随账号而变）；
 * - `data.cardList[].cardData.{id,title}` 为商品项；
 * - **`data.totalCount` 恒为 0、不可信**：计数必须以 cardList / itemGroupList 为准。
 *
 * 同时验证安全边界：缺 token / 未登录 / 接口非 SUCCESS 时必须抛错（调用方据此判 unknown），
 * 且请求 URL **绝不包含 token 原文**。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { MTOP_APP_KEY, generateSignature } from '../../platform/xianyu/sign'
import {
  MY_ITEMS_API,
  ON_SALE_GROUP_NAME,
  createPublishedItemsReader,
} from '../../background/published-items-reader'

const TOKEN = 'abcdef123456'
const TOKEN_COOKIE_VALUE = `${TOKEN}_1771742309496`
const USER_ID = '2214221898611'
const NOW = 1771742309496

const GROUP_PROBE = {
  ret: ['SUCCESS::调用成功'],
  data: {
    itemGroupList: [
      { groupName: '综合', groupId: 14645106, itemNumber: 16 },
      { groupName: '在售', groupId: 14645107, itemNumber: 2 },
      { groupName: '已售出', groupId: 14645108, itemNumber: 16 },
    ],
    cardList: [],
    totalCount: 0,
    nextPage: false,
  },
}

const PAGE_WITH_ITEMS = {
  ret: ['SUCCESS::调用成功'],
  data: {
    // 真实实测：totalCount 恒为 0，计数以 cardList 为准。
    totalCount: 0,
    nextPage: false,
    cardList: [
      { cardData: { id: '111', title: '商品一', priceInfo: { price: '10' } } },
      { cardData: { id: '222', title: '商品二' } },
      { cardData: { title: '缺少 id 的脏项' } },
    ],
  },
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

function makeCookies(values: Record<string, string>) {
  return {
    get: async ({ name }: { name: string }) =>
      name in values ? { value: values[name] } : null,
  }
}

function decodeBody(body: string): Record<string, unknown> {
  return JSON.parse(decodeURIComponent(body.replace(/^data=/, '')))
}

test('官方商品库读取器：发现「在售」分组 groupId（不硬编码）并解析真实 cardList 字段', async () => {
  const calls: Array<{ url: string; body: string }> = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = String(init?.body ?? '')
    calls.push({ url: String(url), body })
    const data = decodeBody(body)
    if (data.needGroupInfo === true) return jsonResponse(GROUP_PROBE)
    return jsonResponse(PAGE_WITH_ITEMS)
  }) as unknown as typeof fetch

  const reader = createPublishedItemsReader({
    cookies: makeCookies({ _m_h5_tk: TOKEN_COOKIE_VALUE, unb: USER_ID }),
    fetchImpl,
    now: () => NOW,
  })

  const items = await reader.readOnSaleItems()

  // totalCount 为 0，但 cardList 有 2 条有效项（脏项被忽略）
  assert.deepEqual(items, [
    { itemId: '111', title: '商品一' },
    { itemId: '222', title: '商品二' },
  ])

  // 先探测分组，再按发现的在售 groupId 查询
  assert.equal(calls.length, 2)
  const pageData = decodeBody(calls[1]!.body)
  assert.equal(pageData.groupName, ON_SALE_GROUP_NAME)
  assert.equal(pageData.groupId, 14645107)
  assert.equal(pageData.defaultGroup, false)

  // 请求打到真实接口，且 URL 绝不包含 token 原文
  const firstUrl = new URL(calls[0]!.url)
  assert.ok(firstUrl.pathname.includes(MY_ITEMS_API))
  assert.ok(!calls[0]!.url.includes(TOKEN), '请求 URL 绝不包含 token')

  // 签名与真实签名公式一致（md5(token & t & appKey & data)）
  const dataStr = decodeURIComponent(calls[0]!.body.replace(/^data=/, ''))
  const expectedSign = generateSignature(dataStr, {
    token: TOKEN,
    timestamp: String(NOW),
    appKey: MTOP_APP_KEY,
  }).sign
  assert.equal(firstUrl.searchParams.get('sign'), expectedSign)
})

test('官方商品库读取器：nextPage=true 时分页拉全在售商品', async () => {
  const calls: Array<string> = []
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = String(init?.body ?? '')
    calls.push(body)
    const data = decodeBody(body)
    if (data.needGroupInfo === true) return jsonResponse(GROUP_PROBE)
    if (data.pageNumber === 1) {
      return jsonResponse({
        ret: ['SUCCESS::调用成功'],
        data: { totalCount: 0, nextPage: true, cardList: [{ cardData: { id: 'p1', title: 'A' } }] },
      })
    }
    return jsonResponse({
      ret: ['SUCCESS::调用成功'],
      data: { totalCount: 0, nextPage: false, cardList: [{ cardData: { id: 'p2', title: 'B' } }] },
    })
  }) as unknown as typeof fetch

  const reader = createPublishedItemsReader({
    cookies: makeCookies({ _m_h5_tk: TOKEN_COOKIE_VALUE, unb: USER_ID }),
    fetchImpl,
    now: () => NOW,
  })

  const items = await reader.readOnSaleItems()
  assert.deepEqual(items, [
    { itemId: 'p1', title: 'A' },
    { itemId: 'p2', title: 'B' },
  ])
  assert.equal(calls.length, 3) // 1 次分组探测 + 2 页
})

test('官方商品库读取器：缺少 token（未登录）时抛错，绝不返回空数组冒充 0 件', async () => {
  const reader = createPublishedItemsReader({
    cookies: makeCookies({ unb: USER_ID }),
    fetchImpl: (async () => jsonResponse(PAGE_WITH_ITEMS)) as unknown as typeof fetch,
    now: () => NOW,
  })
  await assert.rejects(() => reader.readOnSaleItems(), /token/)
})

test('官方商品库读取器：缺少用户 ID（未登录）时抛错', async () => {
  const reader = createPublishedItemsReader({
    cookies: makeCookies({ _m_h5_tk: TOKEN_COOKIE_VALUE }),
    fetchImpl: (async () => jsonResponse(GROUP_PROBE)) as unknown as typeof fetch,
    now: () => NOW,
  })
  await assert.rejects(() => reader.readOnSaleItems(), /用户 ID/)
})

test('官方商品库读取器：接口 ret 非 SUCCESS 时抛错（含真实参数超限错误码）', async () => {
  const reader = createPublishedItemsReader({
    cookies: makeCookies({ _m_h5_tk: TOKEN_COOKIE_VALUE, unb: USER_ID }),
    fetchImpl: (async () =>
      jsonResponse({
        ret: ['FAIL_BIZ_FORBIDDEN::||最大可查看页数或者每页最大可查看商品数超限'],
        data: {},
      })) as unknown as typeof fetch,
    now: () => NOW,
  })
  await assert.rejects(() => reader.readOnSaleItems(), /FAIL_BIZ_FORBIDDEN/)
})

test('官方商品库读取器：响应缺少「在售」分组时抛错', async () => {
  const reader = createPublishedItemsReader({
    cookies: makeCookies({ _m_h5_tk: TOKEN_COOKIE_VALUE, unb: USER_ID }),
    fetchImpl: (async () =>
      jsonResponse({
        ret: ['SUCCESS::调用成功'],
        data: {
          itemGroupList: [{ groupName: '综合', groupId: 14645106, itemNumber: 16 }],
          cardList: [],
          totalCount: 0,
        },
      })) as unknown as typeof fetch,
    now: () => NOW,
  })
  await assert.rejects(() => reader.readOnSaleItems(), /在售/)
})

test('官方商品库读取器：cookie 查询优先取目标 API 域（h5api），不硬假 www', async () => {
  const cookieQueries: string[] = []
  const cookies = {
    get: async ({ url, name }: { url: string; name: string }) => {
      cookieQueries.push(`${name}@${new URL(url).hostname}`)
      if (name === '_m_h5_tk') return { value: TOKEN_COOKIE_VALUE }
      if (name === 'unb') return { value: USER_ID }
      return null
    },
  }
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const data = decodeBody(String(init?.body ?? ''))
    return jsonResponse(data.needGroupInfo === true ? GROUP_PROBE : PAGE_WITH_ITEMS)
  }) as unknown as typeof fetch

  const reader = createPublishedItemsReader({ cookies, fetchImpl, now: () => NOW })
  await reader.readOnSaleItems()

  // 首选目标 API 域（h5api），不硬假 www（读取顺序：先 userId 后 token）
  assert.equal(cookieQueries[0], 'unb@h5api.m.goofish.com')
  assert.equal(cookieQueries[1], '_m_h5_tk@h5api.m.goofish.com')
  // 断言不涉及任何真实 secret（测试 token 为假值）
  assert.ok(!cookieQueries.join(',').includes(TOKEN))
})

test('官方商品库读取器：分页达到上限仍 nextPage=true → 抛错（绝不截断条数冒充 total）', async () => {
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const data = decodeBody(String(init?.body ?? ''))
    if (data.needGroupInfo === true) return jsonResponse(GROUP_PROBE)
    return jsonResponse({
      ret: ['SUCCESS::调用成功'],
      data: {
        totalCount: 0,
        nextPage: true,
        cardList: [{ cardData: { id: `page_${data.pageNumber}`, title: 'T' } }],
      },
    })
  }) as unknown as typeof fetch

  const reader = createPublishedItemsReader({
    cookies: makeCookies({ _m_h5_tk: TOKEN_COOKIE_VALUE, unb: USER_ID }),
    fetchImpl,
    now: () => NOW,
    maxPages: 3,
  })
  await assert.rejects(() => reader.readOnSaleItems(), /分页超过上限/)
})
