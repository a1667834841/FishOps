/**
 * 会话对方资料与商品封面补齐（peer profiles，只读）。
 *
 * 背景：闲鱼聊天 WebSocket（LWP）协议**不携带用户头像**。真实头像来自 mtop 只读接口：
 * - `mtop.taobao.idlemessage.pc.session.sync`（v3.0）
 *   请求 `{ sessionTypes:[1], fetchNum }`（**普通单聊为 `[1]`**；`[3]` 只会返回系统会话），
 *   响应 `data.sessions[].session.{ownerInfo,userInfo}`，双方各带 `userId` / `nick` / `fishNick`
 *   / `logo`（https 绝对 URL）。以 **userId 归一后精确等于可信 self** 判定哪一侧是自己，
 *   另一侧才是对方（**不靠 owner 角色推测**）。
 * - `mtop.idle.trade.pc.message.headinfo`（v1.0）
 *   官方聊天顶部商品头信息：参数绑定 sessionId / itemId，返回 commonData.itemId 与 left.data.picUrl。
 *   批量会话接口未匹配时，按同一会话的商品 ID 精确回退，不按昵称配对。
 * - `mtop.taobao.idlemessage.pc.user.query`（v4.0）
 *   请求 `{ type:0, sessionType:1, sessionId, isOwner:false }`，响应 `data.userInfo.logo`。
 *   实测（ego-browser 只读捕获页面自身请求）：`isOwner:false` 在「自己是 owner / guest」
 *   两种角色下都返回**对方**（counterparty）资料，因此可按 sessionId 作可靠回退；
 *   响应不含 `userId`，可靠性来自 sessionId + isOwner 的会话作用域，而非客户端猜 ID。
 *
 * 安全边界：
 * - 只读调用：不发送消息、不标记已读、不写平台状态；
 * - **绝不从 DOM 昵称模糊配对**，只按 `sessionId` / `peerUserId` 精确映射；
 * - `session.sync` 的归属判断必须能唯一排除当前用户（`myUserId`），否则跳过，
 *   绝不把自己头像当对方；
 * - 图片经 HTTPS 校验，官方阿里 CDN 的 HTTP 地址先升级 HTTPS；商品封面必须带独立商品 ID；
 * - 单次失败不抛、不中断会话同步；并发有界、同一会话只查一次。
 */
import { isRecord } from '../../../shared/chat/index'
import type { Conversation } from '../../../shared/types/chat'
import { normalizeUserId, toSafeHttpsUrl } from './parser'

/** 支持的只读 mtop 接口。 */
export type PeerProfileApi = 'session.sync' | 'user.query' | 'item.headinfo'

/** 一次只读 mtop 调用。 */
export interface PeerProfileRequest {
  api: PeerProfileApi
  data: Record<string, unknown>
}

/**
 * 只读 mtop 调用依赖。
 *
 * 由宿主注入（生产环境在 goofish 页面 MAIN world 复用官方 mtop SDK 执行），
 * 返回 mtop 原始 payload（含 `ret` / `data`）；失败应 reject。
 */
export interface PeerProfileRequester {
  request(request: PeerProfileRequest): Promise<unknown>
}

/** `session.sync` 普通单聊会话类型（页面实测为 `[1]`；`[3]` 仅系统会话，不可用）。 */
export const DEFAULT_SESSION_SYNC_SESSION_TYPES = [1] as const
/** `session.sync` 默认拉取条数（与页面实测一致）。 */
export const DEFAULT_SESSION_SYNC_FETCH_NUM = 30
/** `user.query` 回退默认并发上限。 */
export const DEFAULT_PEER_PROFILE_CONCURRENCY = 3

/** 补齐结果：仅包含成功解析到的对方资料（头像 / 昵称 / 校正后的用户 ID）。 */
export interface PeerProfileUpdate {
  sessionId: string
  /** 对方用户 ID；来自 session.sync 或沿用会话已有的 peerUserId。 */
  peerUserId?: string
  /** 对方昵称（session.sync 的 fishNick / nick）；缺失时不回传。 */
  peerUserName?: string
  /** 通过 https 校验的对方头像 URL；session.sync 未返回或非法时不回传。 */
  peerAvatarUrl?: string
  /** session.sync 中该会话关联商品 ID。 */
  itemId?: string
  /** 该商品 mainPic 经 https 校验后的封面。 */
  itemCoverUrl?: string
}

/** 从 userInfo 对象提取 `logo`（经 https 校验）。 */
function logoFromUserInfo(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return safePlatformImageUrl(value['logo'])
}

/** 官方图片 CDN 支持 HTTPS；只升级明确的阿里 CDN 地址，不放宽任意 HTTP URL。 */
function safePlatformImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value)
    if (url.protocol === 'http:' && url.hostname.endsWith('.alicdn.com')) url.protocol = 'https:'
    return toSafeHttpsUrl(url.href)
  } catch { return undefined }
}

/** 商品头信息按返回商品 ID 校验，不能把其它商品图片映射到当前会话。 */
export function parseItemHeadCover(payload: unknown, itemId: string): string | undefined {
  if (!isRecord(payload) || !isRecord(payload['data'])) return undefined
  const data = payload['data']
  const common = data['commonData']
  if (!isRecord(common) || sessionIdOf(common['itemId']) !== itemId) return undefined
  const left = data['left']
  if (!isRecord(left) || !isRecord(left['data'])) return undefined
  return safePlatformImageUrl(left['data']['picUrl'])
}

/**
 * 从 userInfo 对象提取昵称：优先 `fishNick`（闲鱼昵称），回退 `nick`；均为空返回 undefined。
 * 仅做 trim，不做任何猜测性拼接。
 */
function nickFromUserInfo(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const fish = value['fishNick']
  if (typeof fish === 'string' && fish.trim().length > 0) return fish.trim()
  const nick = value['nick']
  if (typeof nick === 'string' && nick.trim().length > 0) return nick.trim()
  return undefined
}

/** 从 `session.sync` / `user.query` 响应解析 userId（字符串化为原始值）。 */
function userIdOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const raw = value['userId']
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return undefined
}

/** 会话 ID 归一为字符串（session.sync 返回 number，会话模型为 string）。 */
function sessionIdOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * 解析 `mtop.taobao.idlemessage.pc.user.query` v4.0 响应，提取 `data.userInfo` 的头像与昵称。
 *
 * 可靠性说明：v4.0 响应**不含 `userId`**，无法在客户端按 ID 核对；可靠性来自请求的会话作用域
 * （`sessionId` + `isOwner:false` 经页面实测稳定返回对方）。因此调用方必须已确认该 sessionId
 * 对应普通单聊，且本地已知对方身份方向。
 */
export function parseUserQueryProfile(payload: unknown): { peerAvatarUrl?: string; peerUserName?: string } {
  if (!isRecord(payload)) return {}
  const data = payload['data']
  if (!isRecord(data)) return {}
  const userInfo = data['userInfo']
  if (!isRecord(userInfo)) return {}
  const logo = logoFromUserInfo(userInfo)
  const nick = nickFromUserInfo(userInfo)
  return {
    ...(logo === undefined ? {} : { peerAvatarUrl: logo }),
    ...(nick === undefined ? {} : { peerUserName: nick }),
  }
}

/**
 * 解析 `mtop.taobao.idlemessage.pc.session.sync` 响应，按会话提取**对方**头像。
 *
 * 归属规则（安全优先）：必须在 `myUserId` 已知时，确认 `ownerInfo` / `userInfo`
 * 中恰好一方是当前用户，另一方才是对方；否则该会话跳过，绝不猜测、绝不混淆自己。
 * 结果按 `sessionId` 去重（同会话取先出现者）。
 */
export function parseSessionSyncProfiles(payload: unknown, myUserId?: string): PeerProfileUpdate[] {
  if (!isRecord(payload)) return []
  const data = payload['data']
  if (!isRecord(data) || !Array.isArray(data['sessions'])) return []

  const me = normalizeUserId(myUserId)
  const out: PeerProfileUpdate[] = []
  const seen = new Set<string>()

  for (const entry of data['sessions'] as unknown[]) {
    if (!isRecord(entry)) continue
    // 实测：ownerInfo / userInfo 位于 entry.session 内（不在 entry 上）。
    const session = entry['session']
    if (!isRecord(session)) continue

    const sessionId = sessionIdOf(session['sessionId'])
    if (!sessionId || seen.has(sessionId)) continue

    // 缺少当前用户 ID 时无法判断归属：跳过，不猜。
    if (!me) continue

    const owner = session['ownerInfo']
    const guest = session['userInfo']
    // 双方 ID 均归一后比较，容忍 @goofish 后缀 / 类型差异，避免因格式不一致误判归属而跳过。
    const ownerId = normalizeUserId(userIdOf(owner))
    const guestId = normalizeUserId(userIdOf(guest))

    let peerInfo: unknown
    let peerId: string | undefined
    if (ownerId === me && guestId.length > 0 && guestId !== me) {
      peerInfo = guest
      peerId = guestId
    } else if (guestId === me && ownerId.length > 0 && ownerId !== me) {
      peerInfo = owner
      peerId = ownerId
    } else {
      // 无法唯一确认对方（含双方都/都不是自己）：跳过。
      continue
    }

    // 归属已确认即可回传：即使 logo 缺失，也回传 peerId / 昵称用于纠正会话元数据，
    // 其头像由后续 user.query（按 peerId）尝试补齐。
    seen.add(sessionId)
    const logo = logoFromUserInfo(peerInfo)
    const nick = nickFromUserInfo(peerInfo)
    const itemInfo = isRecord(session['itemInfo']) ? session['itemInfo'] : {}
    const itemId = sessionIdOf(itemInfo['itemId'])
    const itemCoverUrl = itemId ? safePlatformImageUrl(itemInfo['mainPic']) : undefined
    out.push({
      sessionId,
      ...(itemId ? { itemId } : {}),
      ...(itemCoverUrl === undefined ? {} : { itemCoverUrl }),
      ...(peerId === undefined ? {} : { peerUserId: peerId }),
      ...(nick === undefined ? {} : { peerUserName: nick }),
      ...(logo === undefined ? {} : { peerAvatarUrl: logo }),
    })
  }

  return out
}

export interface PeerProfileResolverDeps {
  requester: PeerProfileRequester
  /** 当前登录用户 ID；缺失时 session.sync 归属判断不可用（安全跳过）。 */
  myUserId?: string
  /** 失败诊断仅上报接口与粗粒度阶段，不包含响应、异常文本或凭据。 */
  onRequestFailure?: (api: PeerProfileApi, code: 'REQUEST_FAILED') => void
  /** `session.sync` 拉取条数，默认 {@link DEFAULT_SESSION_SYNC_FETCH_NUM}。 */
  fetchNum?: number
  /** `user.query` 回退并发上限，默认 {@link DEFAULT_PEER_PROFILE_CONCURRENCY}。 */
  concurrency?: number
}

/**
 * 会话对方资料解析 / 校正器。
 *
 * 调用顺序：
 * 1. `session.sync`（`sessionTypes:[1]`）批量核对买家身份及 itemInfo 商品关联；
 * 2. 对仍缺昵称或头像的会话，用 `pc.user.query` v4.0（`isOwner:false`）按 sessionId 回退；
 * 3. 对仍缺封面的关联商品，使用官方商品头信息接口核对商品 ID 后补齐。
 *
 * 与旧行为的区别：不再仅补「缺头像」的会话。当会话的对方 ID 缺失 / 等于自己（身份变化遗留
 * 的错 peer）时也会重新解析，用 session.sync 的可靠结果**纠正 peerUserId / 昵称 / 头像**。
 * 任何单条失败都只跳过该条，不影响其它会话，也不抛给调用方。
 */
export class PeerProfileResolver {
  private readonly requester: PeerProfileRequester
  private myUserId?: string
  private readonly onRequestFailure?: PeerProfileResolverDeps['onRequestFailure']
  private readonly fetchNum: number
  private readonly concurrency: number

  constructor(deps: PeerProfileResolverDeps) {
    this.requester = deps.requester
    this.myUserId = deps.myUserId
    this.onRequestFailure = deps.onRequestFailure
    this.fetchNum = deps.fetchNum ?? DEFAULT_SESSION_SYNC_FETCH_NUM
    this.concurrency = Math.max(1, deps.concurrency ?? DEFAULT_PEER_PROFILE_CONCURRENCY)
  }

  /** 更新当前用户 ID；用于登录态变化后按最新身份校验 session.sync 归属。 */
  setMyUserId(myUserId: string | undefined): void {
    this.myUserId = myUserId
  }

  /**
   * 解析并按需纠正会话的对方资料；返回需要写入的更新列表（含 peerUserId / 昵称 / 头像）。
   *
   * 每次同步都按 sessionId 核对商品关联，避免资料完备时漏掉商品变化。
   * user.query 只用于仍缺昵称或头像的会话，批量读取失败不影响现有会话。
   */
  async resolveMissing(conversations: readonly Conversation[]): Promise<PeerProfileUpdate[]> {
    const targets = new Map<string, Conversation>()
    for (const conv of conversations) {
      if (!conv.sessionId) continue
      if (!targets.has(conv.sessionId)) targets.set(conv.sessionId, conv)
    }
    if (targets.size === 0) return []

    const updates = new Map<string, PeerProfileUpdate>()

    // 阶段 1：session.sync 批量（失败静默降级到阶段 2）。
    await this.applySessionSync(targets, updates)

    // 阶段 2：user.query 按 sessionId 回退；商品头信息按 sessionId + itemId 回退，均有界并发。
    await this.applyUserQuery(targets, updates)
    await this.applyItemHeadInfo(targets, updates)

    return [...updates.values()]
  }

  private async applySessionSync(
    targets: Map<string, Conversation>,
    updates: Map<string, PeerProfileUpdate>,
  ): Promise<void> {
    let payload: unknown
    try {
      payload = await this.requester.request({
        api: 'session.sync',
        data: { sessionTypes: [...DEFAULT_SESSION_SYNC_SESSION_TYPES], fetchNum: Math.max(this.fetchNum, targets.size) },
      })
    } catch {
      this.onRequestFailure?.('session.sync', 'REQUEST_FAILED')
      return
    }

    // myUserId 缺失时解析函数会返回空数组（安全跳过，不猜归属）。
    for (const profile of parseSessionSyncProfiles(payload, this.myUserId)) {
      const target = targets.get(profile.sessionId)
      if (!target || updates.has(profile.sessionId)) continue
      // session.sync 以 sessionId 精确对应目标，且双方身份已由 myUserId 校验；其 peerId 可校正旧会话元数据。
      const peerUserId = profile.peerUserId ?? target.peerUserId
      updates.set(profile.sessionId, {
        sessionId: profile.sessionId,
        ...(peerUserId === undefined ? {} : { peerUserId }),
        ...(profile.peerUserName === undefined ? {} : { peerUserName: profile.peerUserName }),
        ...(profile.peerAvatarUrl === undefined ? {} : { peerAvatarUrl: profile.peerAvatarUrl }),
        ...(profile.itemId === undefined ? {} : { itemId: profile.itemId }),
        ...(profile.itemCoverUrl === undefined ? {} : { itemCoverUrl: profile.itemCoverUrl }),
      })
    }
  }

  private async applyItemHeadInfo(targets: Map<string, Conversation>, updates: Map<string, PeerProfileUpdate>): Promise<void> {
    const queue = [...targets.values()].flatMap(conv => {
      const update = updates.get(conv.sessionId)
      const itemId = update?.itemId ?? conv.itemId
      const cover = update?.itemCoverUrl ?? (itemId === conv.itemId ? conv.itemCoverUrl : undefined)
      return itemId && !cover ? [{ sessionId: conv.sessionId, itemId }] : []
    })
    const results = await runWithConcurrency(queue, this.concurrency, async ({ sessionId, itemId }) => {
      try {
        // 批量接口不覆盖所有 LWP 会话，回退到官方聊天页同款只读商品头信息。
        const payload = await this.requester.request({ api: 'item.headinfo', data: { itemId, sessionId, sessionType: 1 } })
        const itemCoverUrl = parseItemHeadCover(payload, itemId)
        return itemCoverUrl ? { sessionId, itemId, itemCoverUrl } : null
      } catch {
        this.onRequestFailure?.('item.headinfo', 'REQUEST_FAILED')
        return null
      }
    })
    for (const update of results) {
      if (update) updates.set(update.sessionId, { ...updates.get(update.sessionId), ...update })
    }
  }

  private async applyUserQuery(
    targets: Map<string, Conversation>,
    updates: Map<string, PeerProfileUpdate>,
  ): Promise<void> {
    // 回退条件：仍缺昵称或头像、且有 sessionId 的会话（本层会话均为普通单聊，sessionType=1）。
    // isOwner:false 经页面实测在两种角色下都返回对方，因此无需（也无从）按 userId 猜。
    const queue = [...targets.values()].filter((conv) => {
      if (!conv.sessionId) return false
      const existing = updates.get(conv.sessionId)
      const samePeer = !existing?.peerUserId || normalizeUserId(existing.peerUserId) === normalizeUserId(conv.peerUserId)
      const avatar = existing?.peerAvatarUrl || (samePeer ? conv.peerAvatarUrl : undefined)
      const name = existing?.peerUserName || (samePeer ? conv.peerUserName : undefined)
      return !avatar || !name
    })
    if (queue.length === 0) return

    const results = await runWithConcurrency(queue, this.concurrency, async (conv) => {
      try {
        const payload = await this.requester.request({
          api: 'user.query',
          data: { type: 0, sessionType: 1, sessionId: conv.sessionId, isOwner: false },
        })
        const profile = parseUserQueryProfile(payload)
        if (profile.peerAvatarUrl === undefined && profile.peerUserName === undefined) return null
        return { sessionId: conv.sessionId, ...profile } satisfies PeerProfileUpdate
      } catch {
        // 单条失败只上报粗粒度诊断，不影响其它会话。
        this.onRequestFailure?.('user.query', 'REQUEST_FAILED')
        return null
      }
    })

    for (const update of results) {
      if (!update) continue
      const existing = updates.get(update.sessionId)
      // 合并到 session.sync 已给出的校正结果上（保留其 peerUserId）。
      updates.set(update.sessionId, existing ? { ...existing, ...update } : update)
    }
  }
}

/**
 * 有界并发执行：最多 `limit` 个任务同时进行，保持与输入同序返回结果。
 * 单个任务的 reject 由调用方在任务体内处理；此处只负责调度。
 */
async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const size = Math.min(limit, items.length)
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await task(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}
