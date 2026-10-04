/**
 * 当前账号在售商品读取（my-items）单测（无真实网络）：
 * - 分组发现（在售 groupId 随账号而变；未列出「在售」→ 视为真实 0 件）；
 * - cardList 结构强校验（缺失抛 api，绝不静默降级为空）；
 * - nextPage 分页读全 + id 去重；nextPage 非布尔视为 false；
 * - 达到上限仍 nextPage=true → 抛错（不截断冒充总数）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MtopClient } from '../xianyu/mtop-client'
import {
  findOnSaleGroupId,
  parseOnSaleCards,
  readAllOnSaleCards,
  ON_SALE_GROUP_NAME,
} from '../xianyu/my-items'

function makeClient(responses: unknown[]): {
  client: MtopClient
  calls: Array<{ apiType: string; data: Record<string, unknown> }>
} {
  const calls: Array<{ apiType: string; data: Record<string, unknown> }> = []
  let index = 0
  const client = {
    requestRaw: async (apiType: string, data: Record<string, unknown>) => {
      calls.push({ apiType, data })
      return responses[index++]
    },
  } as unknown as MtopClient
  return { client, calls }
}

const GROUP_PROBE = {
  ret: ['SUCCESS::调用成功'],
  data: {
    itemGroupList: [
      { groupName: '综合', groupId: 14645106, itemNumber: 16 },
      { groupName: '在售', groupId: 14645107, itemNumber: 2 },
    ],
    cardList: [],
  },
}

test('findOnSaleGroupId：发现「在售」；未列出该分组返回 null；itemGroupList 缺失抛错', () => {
  assert.equal(findOnSaleGroupId(GROUP_PROBE), 14645107)
  // 官方未列出「在售」分组（如无在售商品）→ null（视为真实 0 件，不抛错）。
  assert.equal(findOnSaleGroupId({ data: { itemGroupList: [{ groupName: '综合', groupId: 1 }] } }), null)
  assert.equal(findOnSaleGroupId({ data: { itemGroupList: [] } }), null)
  assert.throws(() => findOnSaleGroupId({ data: {} }), /itemGroupList/)
})

test('parseOnSaleCards：保留原始卡片；cardList / data 缺失抛 api 错误', () => {
  const cards = parseOnSaleCards({
    data: {
      cardList: [{ cardData: { id: 'a', title: 'A' } }, { cardData: {} }, { notCard: true }, { cardData: 'x' }],
    },
  })
  assert.equal(cards.length, 2)
  assert.equal(cards[0]!['id'], 'a')
  // 结构缺失绝不静默降级为空。
  assert.throws(() => parseOnSaleCards({ data: {} }), /cardList/)
  assert.throws(() => parseOnSaleCards({}), /data/)
})

test('readAllOnSaleCards：分组发现 → nextPage 分页读全并去重 id', async () => {
  const { client, calls } = makeClient([
    GROUP_PROBE,
    {
      ret: ['SUCCESS::x'],
      data: { nextPage: true, cardList: [{ cardData: { id: 'p1' } }, { cardData: { id: 'dup' } }] },
    },
    {
      ret: ['SUCCESS::x'],
      data: { nextPage: false, cardList: [{ cardData: { id: 'dup' } }, { cardData: { id: 'p2' } }] },
    },
  ])

  const cards = await readAllOnSaleCards(client, 'u1', { pageSize: 20 })

  // 跨页重复 id 被去重。
  assert.deepEqual(cards.map((c) => c['id']), ['p1', 'dup', 'p2'])
  assert.equal(calls.length, 3)
  assert.equal(calls[0]!.data['needGroupInfo'], true)
  assert.equal(calls[1]!.data['groupName'], ON_SALE_GROUP_NAME)
  assert.equal(calls[1]!.data['groupId'], 14645107)
  assert.equal(calls[2]!.data['pageNumber'], 2)
})

test('readAllOnSaleCards：官方未列出「在售」分组 → 视作真实 0 件（空集合，不再翻页）', async () => {
  const { client, calls } = makeClient([
    { data: { itemGroupList: [{ groupName: '综合', groupId: 1 }], cardList: [] } },
  ])
  const cards = await readAllOnSaleCards(client, 'u1')
  assert.deepEqual(cards, [])
  assert.equal(calls.length, 1)
})

test('readAllOnSaleCards：nextPage 非布尔一律视为 false（不误翻页）', async () => {
  const { client } = makeClient([
    GROUP_PROBE,
    { ret: ['SUCCESS::x'], data: { nextPage: 'yes', cardList: [{ cardData: { id: 'p1' } }] } },
  ])
  const cards = await readAllOnSaleCards(client, 'u1')
  assert.deepEqual(cards.map((c) => c['id']), ['p1'])
})

test('readAllOnSaleCards：达到翻页上限仍 nextPage=true → 抛错（不截断冒充总数）', async () => {
  const { client } = makeClient([
    GROUP_PROBE,
    { ret: ['SUCCESS::x'], data: { nextPage: true, cardList: [{ cardData: { id: 'p1' } }] } },
  ])
  await assert.rejects(() => readAllOnSaleCards(client, 'u1', { maxPages: 1 }), /分页超过上限/)
})

test('readAllOnSaleCards：pageSize 上限收敛到 20', async () => {
  const { client, calls } = makeClient([
    GROUP_PROBE,
    { ret: ['SUCCESS::x'], data: { nextPage: false, cardList: [] } },
  ])
  await readAllOnSaleCards(client, 'u1', { pageSize: 999 })
  assert.equal(calls[0]!.data['pageSize'], 20)
})
