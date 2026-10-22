import { isChatMessage, type ChatMessage } from '../../../packages/protocol/src/chat.ts'

/** 解析失败分类；不携带原始帧、凭据或异常正文。 */
export type ChatParseError = 'NOT_STRING' | 'EMPTY_INPUT' | 'FRAME_TOO_LARGE' | 'INVALID_JSON' |
  'LIMIT_EXCEEDED' | 'INVALID_ENCODING' | 'UNSUPPORTED_ENCODING' | 'INVALID_MESSAGE' |
  'MISSING_SOURCE_ID' | 'CONFLICTING_MESSAGE'
/** 控制帧显式忽略；消息批次全有或全无，失败不返回部分结果。 */
export type ChatParseResult = { kind: 'messages'; messages: ChatMessage[] } |
  { kind: 'ignored' } | { kind: 'error'; code: ChatParseError }
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true })
function fail(code: ChatParseError): never { throw code }
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
function bounded(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (depth > 16 || ++budget.nodes > 10000) fail('LIMIT_EXCEEDED')
  if (value && typeof value === 'object') for (const child of Object.values(value)) bounded(child, depth + 1, budget)
}
function json(raw: string): unknown {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return fail('INVALID_JSON') }
  bounded(value); return value
}

/** 有界 MessagePack 子集：map/array、UTF-8 字符串、整数、浮点、bool/null；不支持 bin/ext。 */
function unpack(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0, nodes = 0
  function take(n: number): number {
    if (offset + n > bytes.length) fail('INVALID_ENCODING')
    const start = offset; offset += n; return start
  }
  function uint(n: number): number {
    const at = take(n)
    return n === 1 ? view.getUint8(at) : n === 2 ? view.getUint16(at) : view.getUint32(at)
  }
  function read(depth: number): any {
    if (depth > 16 || ++nodes > 10000) fail('LIMIT_EXCEEDED')
    const tag = uint(1)
    if (tag <= 0x7f) return tag
    if (tag >= 0xe0) return tag - 256
    function text(n: number) { const at = take(n); try { return decoder.decode(bytes.subarray(at, at + n)) } catch { return fail('INVALID_ENCODING') } }
    function array(n: number) { if (n > 10000) fail('LIMIT_EXCEEDED'); return Array.from({ length: n }, () => read(depth + 1)) }
    function map(n: number) {
      if (n > 10000) fail('LIMIT_EXCEEDED')
      const value = Object.create(null)
      for (let i = 0; i < n; i++) {
        const key = read(depth + 1)
        if (typeof key !== 'string' || Object.hasOwn(value, key)) fail('INVALID_ENCODING')
        value[key] = read(depth + 1)
      }
      return value
    }
    if ((tag & 0xe0) === 0xa0) return text(tag & 31)
    if ((tag & 0xf0) === 0x90) return array(tag & 15)
    if ((tag & 0xf0) === 0x80) return map(tag & 15)
    if (tag === 0xc0) return null
    if (tag === 0xc2 || tag === 0xc3) return tag === 0xc3
    if (tag >= 0xcc && tag <= 0xce) return uint(2 ** (tag - 0xcc))
    if (tag >= 0xd0 && tag <= 0xd2) {
      const n = 2 ** (tag - 0xd0), at = take(n)
      return n === 1 ? view.getInt8(at) : n === 2 ? view.getInt16(at) : view.getInt32(at)
    }
    if (tag === 0xcf || tag === 0xd3) {
      const at = take(8), value = tag === 0xcf ? view.getBigUint64(at) : view.getBigInt64(at)
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) fail('UNSUPPORTED_ENCODING')
      return Number(value)
    }
    if (tag === 0xca || tag === 0xcb) { const at = take(tag === 0xca ? 4 : 8); return tag === 0xca ? view.getFloat32(at) : view.getFloat64(at) }
    if (tag >= 0xd9 && tag <= 0xdb) return text(uint(2 ** (tag - 0xd9)))
    if (tag === 0xdc || tag === 0xdd) return array(uint(tag === 0xdc ? 2 : 4))
    if (tag === 0xde || tag === 0xdf) return map(uint(tag === 0xde ? 2 : 4))
    return fail('UNSUPPORTED_ENCODING')
  }
  const result = read(0)
  if (offset !== bytes.length) fail('INVALID_ENCODING')
  return result
}
function decode(value: string): unknown {
  if (!value || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('INVALID_ENCODING')
  let bytes: Uint8Array
  try { bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0)) } catch { return fail('INVALID_ENCODING') }
  if (bytes[0] === 123 || bytes[0] === 91) {
    let text: string
    try { text = decoder.decode(bytes) } catch { return fail('INVALID_ENCODING') }
    return json(text)
  }
  return unpack(bytes)
}
function normalize(data: unknown, stage: (value: string) => void): ChatMessage {
  stage('MESSAGE_SHAPE')
  if (!record(data)) fail('INVALID_MESSAGE')
  stage('MESSAGE_ROOT')
  if (!record(data['1'])) {
    // 只记录预设数字字段的类型，不输出未知键名或任何业务值。
    const shape = ['1', '2', '3', '4', '5', '6', '10'].map(key => {
      const value = data[key]
      const type = !Object.hasOwn(data, key) ? 'absent' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      return `${key}_${type}`
    }).join('_')
    stage(`ROOT_SHAPE_${shape}`)
    const named = ['message', 'messageId', 'cid', 'content', 'extension', 'type', 'data', 'sync', 'syncPushPackage', 'headers', 'body', 'redReminder', 'systemNotice'].map(key => {
      const value = data[key]
      return `${key}_${!Object.hasOwn(data, key) ? 'absent' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`
    }).join('_')
    stage(`ROOT_SHAPE_NAMED_${named}`)
    stage(`ROOT_SHAPE_KEYS_${Object.keys(data).length === 0 ? 'EMPTY' : 'NONEMPTY'}`)
    const keys = Object.keys(data)
    const numeric = keys.filter(key => /^\d+$/.test(key))
    const maxNumeric = numeric.length ? Math.max(...numeric.map(key => Number(key)).filter(Number.isSafeInteger)) : -1
    stage(`ROOT_KEY_CLASS_${numeric.length ? 'NUMERIC' : 'NONNUMERIC'}_${numeric.length}_${maxNumeric}_${keys.length}`)
    const three = data['3']
    stage(record(three) && three.systemNotice ? 'CONTROL_SYSTEM_CANDIDATE' :
      record(three) && three.redReminder ? 'CONTROL_ORDER_CANDIDATE' :
      Array.isArray(data['1']) ? 'CONTROL_ARRAY_CANDIDATE' : 'MESSAGE_ROOT_UNKNOWN')
    fail('INVALID_MESSAGE')
  }
  stage('MESSAGE_INFO')
  if (!record(data['1']['10'])) fail('INVALID_MESSAGE')
  const one = data['1'], info = one['10']
  if (typeof one['3'] !== 'string' || !one['3'].trim()) fail('MISSING_SOURCE_ID')
  stage('MESSAGE_URL')
  let url: URL | undefined
  if (typeof info.reminderUrl === 'string') {
    try { url = new URL(info.reminderUrl) } catch { fail('INVALID_MESSAGE') }
  }
  stage('MESSAGE_CONTENT')
  let text: unknown = info.reminderContent
  const inner = one['6']?.['3']?.['5']
  if (inner !== undefined) {
    if (typeof inner !== 'string') fail('INVALID_MESSAGE')
    const content = json(inner)
    // 图片、卡片及其它正文结构不降级成虚构文本。
    if (!record(content) || ![1, 101].includes(content.contentType) || !record(content.text) || typeof content.text.text !== 'string') fail('INVALID_MESSAGE')
    text = content.text.text
  }
  const message: ChatMessage = {
    sourceId: one['3'], sessionId: url?.searchParams.get('sid') ??
      (typeof one['2'] === 'string' ? one['2'].replace(/@goofish$/, '') : ''),
    senderId: typeof info.senderUserId === 'string' ? info.senderUserId.replace(/@goofish$/, '') :
      typeof one['1'] === 'string' ? one['1'].replace(/@goofish$/, '') : '',
    text: text as string, sentAt: one['5'],
  }
  for (const key of ['itemId', 'peerUserId'] as const) {
    const value = url?.searchParams.get(key)
    if (value !== null && value !== undefined) message[key] = value
  }
  stage('MESSAGE_FIELDS')
  if (!isChatMessage(message)) fail('INVALID_MESSAGE')
  return message
}

/**
 * 解析 legacy syncPushPackage 结构；只用平台字段 1/3 作为 sourceId，不生成替代标识。
 * 限制 UTF-8 帧 256 KiB、嵌套 16 层、结构节点 10000、每批 100 项。
 * 仅支持文本推送；图片/卡片、直接 body.content 消息、MessagePack bin/ext 返回明确失败。
 */
export function parseChatFrame(raw: unknown, diagnostic?: (stage: string) => void): ChatParseResult {
  let stage = 'FRAME'
  try {
    if (typeof raw !== 'string') fail('NOT_STRING')
    if (raw.length > 262144 || encoder.encode(raw).byteLength > 262144) fail('FRAME_TOO_LARGE')
    if (!raw.trim()) fail('EMPTY_INPUT')
    const value = json(raw)
    stage = 'ENVELOPE'
    if (!record(value)) fail('INVALID_MESSAGE')
    if (!record(value.body)) return { kind: 'ignored' }
    if (!Object.hasOwn(value.body, 'syncPushPackage')) {
      if ('content' in value.body || 'extension' in value.body) fail('INVALID_MESSAGE')
      return { kind: 'ignored' }
    }
    stage = 'PUSH_PACKAGE'
    const sync = value.body.syncPushPackage
    if (!record(sync) || !Array.isArray(sync.data)) fail('INVALID_MESSAGE')
    if (sync.data.length > 100) fail('LIMIT_EXCEEDED')
    const messages = new Map<string, ChatMessage>()
    for (const item of sync.data) {
      stage = 'PUSH_ITEM'
      if (!record(item)) fail('INVALID_MESSAGE')
      const data = typeof item.data === 'string' ? decode(item.data) : item.data
      bounded(data)
      const message = normalize(data, value => {
        stage = value
        if (value.startsWith('ROOT_SHAPE_') || value.startsWith('ROOT_KEY_CLASS_')) {
          try { diagnostic?.(value) } catch {}
        }
      }), key = JSON.stringify([message.sessionId, message.sourceId])
      const previous = messages.get(key)
      if (previous && JSON.stringify(previous) !== JSON.stringify(message)) fail('CONFLICTING_MESSAGE')
      messages.set(key, message)
    }
    return messages.size ? { kind: 'messages', messages: [...messages.values()] } : { kind: 'ignored' }
  } catch (code) {
    try { diagnostic?.(stage) } catch {}
    const known: readonly unknown[] = ['NOT_STRING', 'EMPTY_INPUT', 'FRAME_TOO_LARGE', 'INVALID_JSON', 'LIMIT_EXCEEDED',
      'INVALID_ENCODING', 'UNSUPPORTED_ENCODING', 'INVALID_MESSAGE', 'MISSING_SOURCE_ID', 'CONFLICTING_MESSAGE']
    return { kind: 'error', code: known.includes(code) ? code as ChatParseError : 'INVALID_MESSAGE' }
  }
}
