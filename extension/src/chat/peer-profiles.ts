/**
 * 会话对方头像补齐（peer profiles，只读）。
 *
 * 背景：闲鱼聊天 WebSocket（LWP）协议**不携带用户头像**。真实头像来自 mtop 只读接口：
 * - `mtop.taobao.idlemessage.pc.session.sync`（v3.0）
 *   请求 `{ sessionTypes, fetchNum }`，响应 `data.sessions[].session.{ownerInfo,userInfo}`，
 *   双方各带 `userId` 与 `logo`（https 绝对 URL）。
 * - `mtop.taobao.idlemessage.user.query`（v1.0）
 *   请求 `{ type, userId, sessionId }`，响应 `data.userInfo.logo`。按传入 `userId` 精确查询，
 *   返回的 `userInfo` 即该 peer，因此不会把当前用户头像混淆成对方。
 *
 * 安全边界：
 * - 只读调用：不发送消息、不标记已读、不写平台状态；
 * - **绝不从 DOM 昵称模糊配对**，只按 `sessionId` / `peerUserId` 精确映射；
 * - `session.sync` 的归属判断必须能唯一排除当前用户（`myUserId`），否则跳过，
 *   绝不把自己头像当对方；
 * - 只接受通过 https 校验的 `logo`；已有头像一律保留（只补缺失）；
 * - 单次失败不抛、不中断会话同步；并发有界、同一会话只查一次。
 */
import { isRecord } from '../../../shared/chat/index'
import type { Conversation } from '../../../shared/types/chat'
import { toSafeHttpsUrl } from './parser'

/** 支持的只读 mtop 接口。 */
export type PeerProfileApi = 'session.sync' | 'user.query'

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

/** `session.sync` 单聊会话类型（与页面实测一致）。 */
export const DEFAULT_SESSION_SYNC_SESSION_TYPES = [3] as const
/** `session.sync` 默认拉取条数（与页面实测一致）。 */
export const DEFAULT_SESSION_SYNC_FETCH_NUM = 30
/** `user.query` 回退默认并发上限。 */
export const DEFAULT_PEER_PROFILE_CONCURRENCY = 3

/** 补齐结果：仅包含成功解析到的对方头像。 */
export interface PeerProfileUpdate {
  sessionId: string
  /** 对方用户 ID；来自 session.sync 或沿用会话已有的 peerUserId。 */
  peerUserId?: string
  /** 通过 https 校验的对方头像 URL。 */
  peerAvatarUrl: string
}

/** 从 userInfo 对象提取 `logo`（经 https 校验）。 */
function logoFromUserInfo(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return toSafeHttpsUrl(value['logo'])
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
 * 解析 `mtop.taobao.idlemessage.user.query` 响应，返回 `data.userInfo.logo`。
 *
 * 因为请求按 `userId` 精确查询，返回的 `userInfo` 即该 peer，无需再判断归属。
 */
export function parseUserQueryAvatar(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const data = payload['data']
  if (!isRecord(data)) return undefined
  return logoFromUserInfo(data['userInfo'])
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

  const out: PeerProfileUpdate[] = []
  const seen = new Set<string>()

  for (const entry of data['sessions'] as unknown[]) {
    if (!isRecord(entry)) continue
    const session = entry['session']
    if (!isRecord(session)) continue

    const sessionId = sessionIdOf(session['sessionId'])
    if (!sessionId || seen.has(sessionId)) continue

    // 缺少当前用户 ID 时无法判断归属：跳过，不猜。
    if (!myUserId) continue

    const owner = session['ownerInfo']
    const guest = session['userInfo']
    const ownerId = userIdOf(owner)
    const guestId = userIdOf(guest)

    let peerInfo: unknown
    let peerId: string | undefined
    if (ownerId === myUserId && guestId !== undefined && guestId !== myUserId) {
      peerInfo = guest
      peerId = guestId
    } else if (guestId === myUserId && ownerId !== undefined && ownerId !== myUserId) {
      peerInfo = owner
      peerId = ownerId
    } else {
      // 无法唯一确认对方（含双方都/都不是自己）：跳过。
      continue
    }

    const logo = logoFromUserInfo(peerInfo)
    if (!logo) continue

    seen.add(sessionId)
    out.push({ sessionId, ...(peerId === undefined ? {} : { peerUserId: peerId }), peerAvatarUrl: logo })
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
 * 会话对方头像补齐器。
 *
 * 调用顺序：
 * 1. `session.sync` 批量拉取（一次请求覆盖多个会话，最高效且含 userId 自证归属）；
 * 2. 对仍缺失、且已知 `peerUserId` 的会话，用 `user.query` 按 peerId 精确回退。
 *
 * 已存在头像的会话不处理；任何单条失败都只跳过该条，不影响其它会话，也不抛给调用方。
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

  /** 为缺失头像的会话补齐对方头像；返回仅含成功补齐项的更新列表。 */
  async resolveMissing(conversations: readonly Conversation[]): Promise<PeerProfileUpdate[]> {
    // 只处理缺头像、且有 sessionId 的会话；按 sessionId 去重。
    const targets = new Map<string, Conversation>()
    for (const conv of conversations) {
      if (!conv.sessionId) continue
      if (conv.peerAvatarUrl && conv.peerAvatarUrl.length > 0) continue
      if (!targets.has(conv.sessionId)) targets.set(conv.sessionId, conv)
    }
    if (targets.size === 0) return []

    const updates = new Map<string, PeerProfileUpdate>()

    // 阶段 1：session.sync 批量（失败静默降级到阶段 2）。
    await this.applySessionSync(targets, updates)

    // 阶段 2：user.query 按 peerId 精确回退（仅剩余目标；并发有界、失败隔离）。
    await this.applyUserQuery(targets, updates)

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
        data: { sessionTypes: [...DEFAULT_SESSION_SYNC_SESSION_TYPES], fetchNum: this.fetchNum },
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
      updates.set(profile.sessionId, {
        sessionId: profile.sessionId,
        ...(profile.peerUserId === undefined
          ? target.peerUserId === undefined
            ? {}
            : { peerUserId: target.peerUserId }
          : { peerUserId: profile.peerUserId }),
        peerAvatarUrl: profile.peerAvatarUrl,
      })
    }
  }

  private async applyUserQuery(
    targets: Map<string, Conversation>,
    updates: Map<string, PeerProfileUpdate>,
  ): Promise<void> {
    const queue = [...targets.values()].filter((conv) => {
      if (updates.has(conv.sessionId)) return false
      return typeof conv.peerUserId === 'string' && conv.peerUserId.length > 0
    })
    if (queue.length === 0) return

    const results = await runWithConcurrency(queue, this.concurrency, async (conv) => {
      try {
        const payload = await this.requester.request({
          api: 'user.query',
          data: { type: 0, userId: conv.peerUserId, sessionId: conv.sessionId },
        })
        const logo = parseUserQueryAvatar(payload)
        if (!logo) return null
        return { sessionId: conv.sessionId, peerUserId: conv.peerUserId, peerAvatarUrl: logo } satisfies PeerProfileUpdate
      } catch {
        // 单条失败只上报粗粒度诊断，不影响其它会话。
        this.onRequestFailure?.('user.query', 'REQUEST_FAILED')
        return null
      }
    })

    for (const update of results) {
      if (update && !updates.has(update.sessionId)) updates.set(update.sessionId, update)
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
