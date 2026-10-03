/**
 * 权限与初始化顺序安全回归测试（不依赖浏览器，使用 mock 校验，不发真实请求）。
 *
 * 直接加载构建产物 `extension/dist/*.js` 与 `extension/public/manifest.json`，覆盖：
 *   1. isolated page bridge 只放行受限的 CHAT_SOCKET_EVENT，
 *      不得把页面上报的 PLATFORM_CALL / CHAT_GET_MESSAGES / PUBLISH 等转发为扩展权限命令，
 *      且校验 event.source / event.origin / payload；
 *   2. background 普通命令只接受本扩展内页来源（sender.id 匹配且 url/origin 为
 *      `chrome-extension://<本扩展 ID>/...`），content script / 外部页面一律拒绝；
 *      注意：扩展内页在 tab 中打开时也会带 sender.tab，不能用「有无 tab」区分；
 *      CHAT_SOCKET_EVENT 走单独的 goofish content 来源校验；
 *      事件长连接拒绝 content / 非扩展页，防事件泄露；
 *   3. 聊天实时数据在 init 完成前不 ingest，且 init 失败可重试、不吞错误；
 *   4. manifest 不含 newtab 覆盖；content_scripts 注入范围仍仅收窄到 www.goofish.com；
 *      host_permissions 只额外放行飞书开放平台 https://open.feishu.cn/*（供 DATA_SOURCE_* 真实拉取），
 *      不得出现 <all_urls> 或任意域通配。
 *
 * 用法：先 `npm run build`，再 `node scripts/review-security.test.mjs`
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const distDir = resolve(here, '../extension/dist')
const backgroundPath = resolve(distDir, 'background.js')
const isolatedBridgePath = resolve(distDir, 'content/isolated-bridge.js')
const manifestPath = resolve(here, '../extension/public/manifest.json')

for (const path of [backgroundPath, isolatedBridgePath]) {
  if (!existsSync(path)) {
    console.error(`未找到构建产物，请先运行 \`npm run build\`。缺少：${path}`)
    process.exit(1)
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ---- 断言 ----
let passed = 0
let failed = 0
function check(label, condition, extra) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`)
  }
}

// ==================== Part 1：isolated page bridge ====================

const PAGE_BRIDGE_SOURCE = 'fishops-workbench-bridge'

function pageCommand(type, payload, requestId = 'r1') {
  return { kind: 'command', protocol: 1, requestId, type, payload, sentAt: 1 }
}

function wrappedPageMessage(message) {
  return { source: PAGE_BRIDGE_SOURCE, message }
}

let isoSeq = 0

/** 加载 isolated-bridge 构建产物（IIFE），返回注入用的 window 与已转发命令。 */
async function loadIsolatedBridge() {
  const messageHandlers = []
  const sent = []
  const fakeWindow = {
    location: { origin: 'https://www.goofish.com', href: 'https://www.goofish.com/im' },
    addEventListener(type, handler) {
      if (type === 'message') messageHandlers.push(handler)
    },
    postMessage() {},
  }
  globalThis.window = fakeWindow
  globalThis.chrome = {
    runtime: {
      sendMessage(command) {
        sent.push(command)
        return Promise.resolve({
          kind: 'response',
          protocol: 1,
          requestId: command.requestId,
          type: command.type,
          ok: true,
          result: { accepted: true },
          respondedAt: Date.now(),
        })
      },
    },
  }
  await import(`${pathToFileURL(isolatedBridgePath).href}?iso=${++isoSeq}`)
  return {
    fakeWindow,
    sent,
    dispatch(event) {
      for (const handler of messageHandlers) handler(event)
    },
  }
}

async function testIsolatedBridge() {
  console.log('Part 1：isolated page bridge 权限边界')
  const iso = await loadIsolatedBridge()
  const sameSource = () => iso.fakeWindow

  // 页面上报的高权限命令：一律不得转发。
  const forbidden = [
    pageCommand('PLATFORM_CALL', { method: 'platform.currentUserId', params: {} }),
    pageCommand('PLATFORM_PING', {}),
    pageCommand('CHAT_GET_MESSAGES', { sessionId: 's1' }),
    pageCommand('CHAT_LIST_CONVERSATIONS', {}),
    pageCommand('CHAT_SYNC_HISTORY', { sessionId: 's1' }),
    pageCommand('PUBLISH', { event: 'DEMO_TICK', payload: {} }),
    pageCommand('PING', { clientTime: 1, nonce: 'n' }),
  ]
  for (const command of forbidden) {
    iso.dispatch({ source: sameSource(), origin: 'https://www.goofish.com', data: wrappedPageMessage(command) })
  }
  await sleep(10)
  check('页面 postMessage 的 PLATFORM_CALL/CHAT_*/PUBLISH/PING 一律不转发', iso.sent.length === 0, iso.sent)

  // 合法的可放行事件。
  iso.dispatch({
    source: sameSource(),
    origin: 'https://www.goofish.com',
    data: wrappedPageMessage(pageCommand('CHAT_SOCKET_EVENT', { event: 'open', at: 1 })),
  })
  await sleep(10)
  check(
    '合法 CHAT_SOCKET_EVENT 被放行到 background',
    iso.sent.length === 1 && iso.sent[0].type === 'CHAT_SOCKET_EVENT',
    iso.sent,
  )

  // 非法 payload：不放行。
  iso.dispatch({
    source: sameSource(),
    origin: 'https://www.goofish.com',
    data: wrappedPageMessage(pageCommand('CHAT_SOCKET_EVENT', { event: 'nope', at: 1 })),
  })
  await sleep(10)
  check('非法 socket payload 不被放行', iso.sent.length === 1)

  // 异源 origin：不放行。
  iso.dispatch({
    source: sameSource(),
    origin: 'https://evil.com',
    data: wrappedPageMessage(pageCommand('CHAT_SOCKET_EVENT', { event: 'open', at: 1 })),
  })
  await sleep(10)
  check('非本源 origin 不被放行', iso.sent.length === 1)

  // 非 window 来源：不放行。
  iso.dispatch({
    source: { not: 'window' },
    origin: 'https://www.goofish.com',
    data: wrappedPageMessage(pageCommand('CHAT_SOCKET_EVENT', { event: 'open', at: 1 })),
  })
  await sleep(10)
  check('event.source 非 window 不被放行', iso.sent.length === 1)
}

// ==================== Part 2：background 来源与初始化 ====================

const EVENTS_PORT = 'fishops-workbench-events'
const EXT_ID = 'fishops-review-test'
const EXT_PAGE_SENDER = {
  id: EXT_ID,
  origin: `chrome-extension://${EXT_ID}`,
  tab: { id: 1, url: `chrome-extension://${EXT_ID}/workbench.html` },
  url: `chrome-extension://${EXT_ID}/workbench.html`,
}
const CONTENT_SENDER = { id: EXT_ID, tab: { id: 7 }, url: 'https://www.goofish.com/im' }
const EVIL_CONTENT_SENDER = { id: EXT_ID, tab: { id: 8 }, url: 'https://evil.com/' }
const OUTSIDE_SENDER = { id: 'other-extension', url: 'https://evil.com/' }

const b64 = (text) => Buffer.from(text, 'utf-8').toString('base64')
const VALID_RAW = JSON.stringify({
  code: 200,
  body: {
    content: { custom: { contentType: 1, data: b64(JSON.stringify({ contentType: 1, text: { text: 'hi' } })) } },
    extension: { senderUserId: '999', reminderUrl: 'https://x?sid=123&peerUserId=999' },
    createAt: 1,
    messageId: 'm1',
  },
})

function createEventTarget() {
  const listeners = []
  return {
    listeners,
    addListener(fn) {
      listeners.push(fn)
    },
    removeListener(fn) {
      const index = listeners.indexOf(fn)
      if (index >= 0) listeners.splice(index, 1)
    },
    last() {
      return listeners[listeners.length - 1]
    },
  }
}

let bgSeq = 0

/**
 * 启动一个新的 background 实例（独立 mock chrome），返回调用辅助。
 * `sessionGet(key)` 可自定义 storage.session.get 行为（用于制造 init 延迟 / 失败）。
 */
async function bootBackground(options = {}) {
  const store = new Map()
  const sessionGet = options.sessionGet ?? (async (key) => store.get(key))

  const chromeMock = {
    runtime: {
      id: EXT_ID,
      lastError: undefined,
      onConnect: createEventTarget(),
      onMessage: createEventTarget(),
      getURL: (path) => `chrome-extension://${EXT_ID}/${path}`,
      sendMessage() {},
      connect() {
        throw new Error('review-security test 未实现 chrome.runtime.connect')
      },
    },
    storage: {
      session: {
        async get(key) {
          const value = await sessionGet(key)
          return value === undefined ? {} : { [key]: value }
        },
        async set(items) {
          for (const [key, value] of Object.entries(items)) store.set(key, value)
        },
      },
    },
    action: { onClicked: createEventTarget() },
    tabs: { create() {} },
  }
  globalThis.chrome = chromeMock
  await import(`${pathToFileURL(backgroundPath).href}?bg=${++bgSeq}`)
  await sleep(30) // 等待 bootstrap 读写 storage

  function invoke(sender, type, payload) {
    const listener = chromeMock.runtime.onMessage.last()
    return new Promise((resolveResult) => {
      let done = false
      let ret
      const finish = (response) => {
        if (done) return
        done = true
        resolveResult({ ret, response })
      }
      ret = listener(
        { kind: 'command', protocol: 1, requestId: `req_${Math.random().toString(36).slice(2)}`, type, payload, sentAt: Date.now() },
        sender,
        finish,
      )
      setTimeout(() => finish('__no_response__'), 200)
    })
  }

  function connectPort(sender) {
    const onMessage = createEventTarget()
    const onDisconnect = createEventTarget()
    const received = []
    const port = {
      name: EVENTS_PORT,
      sender,
      onMessage,
      onDisconnect,
      received,
      disconnected: false,
      postMessage(message) {
        received.push(message)
      },
      disconnect() {
        this.disconnected = true
        for (const listener of onDisconnect.listeners) listener()
      },
    }
    chromeMock.runtime.onConnect.last()(port)
    return port
  }

  return { chromeMock, invoke, connectPort }
}

async function testBackgroundSources() {
  console.log('Part 2：background 命令 / 长连接来源策略')
  const bg = await bootBackground()

  const extPing = await bg.invoke(EXT_PAGE_SENDER, 'PING', { clientTime: 1, nonce: 'n1' })
  check('扩展内页 PING 成功', extPing.response?.ok === true && extPing.response?.result?.pong === true, extPing.response)
  check('扩展内页命令 listener 返回 true（异步等候）', extPing.ret === true)

  const contentPing = await bg.invoke(CONTENT_SENDER, 'PING', { clientTime: 1, nonce: 'n2' })
  check('content script 发普通命令被拒绝（listener 返回 false）', contentPing.ret === false)
  check('content script 普通命令无响应', contentPing.response === '__no_response__')

  const outsidePing = await bg.invoke(OUTSIDE_SENDER, 'PING', { clientTime: 1, nonce: 'n3' })
  check('外部扩展命令被拒绝', outsidePing.ret === false && outsidePing.response === '__no_response__')

  // 回归：真实 Chrome 中扩展内页（chrome-extension://<id>/...）位于 tab 内，
  // sender.tab 会被填充、tab.url 同为扩展页 URL；带 tab 不得被误判为 content script。
  const extWithTab = await bg.invoke(
    {
      id: EXT_ID,
      origin: `chrome-extension://${EXT_ID}`,
      tab: { id: 1, url: `chrome-extension://${EXT_ID}/workbench.html` },
      url: `chrome-extension://${EXT_ID}/workbench.html`,
    },
    'PING',
    { clientTime: 1, nonce: 'n4' },
  )
  check('扩展内页带 tab 仍被接受（防误判回归）', extWithTab.ret === true && extWithTab.response?.ok === true, extWithTab.response)

  // content script 无法伪装扩展来源：sender.url / sender.origin 由浏览器填写为宿主页面 URL。
  const hostUrlSender = await bg.invoke(
    {
      id: EXT_ID,
      origin: 'https://www.goofish.com',
      tab: { id: 2, url: 'https://www.goofish.com/im' },
      url: 'https://www.goofish.com/im',
    },
    'PING',
    { clientTime: 1, nonce: 'n5' },
  )
  check(
    '宿主页面 URL 来源被拒绝（content script 无法伪装扩展页）',
    hostUrlSender.ret === false && hostUrlSender.response === '__no_response__',
  )

  // 高权限命令同样只接受扩展内页。
  const contentPlatform = await bg.invoke(CONTENT_SENDER, 'PLATFORM_CALL', { method: 'platform.currentUserId', params: {} })
  check('content script 发 PLATFORM_CALL 被拒绝', contentPlatform.ret === false)
  const contentChatGet = await bg.invoke(CONTENT_SENDER, 'CHAT_GET_MESSAGES', { sessionId: 's1' })
  check('content script 发 CHAT_GET_MESSAGES 被拒绝', contentChatGet.ret === false)
  const contentPublish = await bg.invoke(CONTENT_SENDER, 'PUBLISH', { event: 'DEMO_TICK', payload: {} })
  check('content script 发 PUBLISH 被拒绝', contentPublish.ret === false)

  // 回归：CHAT_SYNC_CONVERSATIONS 在原缺陷中返回空响应（客户端报 INVALID_MESSAGE）。
  // 本 mock 环境无 chrome.scripting、且 tabs 缺 query/get/onUpdated → 无 goofish tab；
  // 必须返回结构合法的 ResponseEnvelope（业务失败体现在 result.ok=false + 可展示错误），
  // 绝不能 no_response / undefined。
  const chatSync = await bg.invoke(EXT_PAGE_SENDER, 'CHAT_SYNC_CONVERSATIONS', {})
  const chatSyncResponse = chatSync.response
  check('CHAT_SYNC_CONVERSATIONS 返回合法 ResponseEnvelope（非空响应）',
    chatSyncResponse !== '__no_response__' &&
      chatSyncResponse?.kind === 'response' &&
      chatSyncResponse?.type === 'CHAT_SYNC_CONVERSATIONS' &&
      typeof chatSyncResponse?.requestId === 'string' &&
      typeof chatSyncResponse?.ok === 'boolean',
    chatSyncResponse)
  check('CHAT_SYNC_CONVERSATIONS 在无 tab 时带可展示错误（业务失败不误判为非法消息）',
    chatSyncResponse?.result?.ok === false && typeof chatSyncResponse?.result?.error?.message === 'string',
    chatSyncResponse
  )
  check('CHAT_SYNC_CONVERSATIONS 回包不泄露 token / 凭据',
    !JSON.stringify(chatSyncResponse ?? '').match(/token|cookie|authorization/i),
  )
  check('CHAT_SYNC_CONVERSATIONS listener 返回 true（异步等候）', chatSync.ret === true)
}

async function testChatSocketEventSource() {
  console.log('Part 3：CHAT_SOCKET_EVENT 单独来源校验')
  const bg = await bootBackground()

  const contentSocket = await bg.invoke(CONTENT_SENDER, 'CHAT_SOCKET_EVENT', { event: 'open', at: 1 })
  check('goofish content script 的 socket 事件被接受', contentSocket.response?.result?.accepted === true, contentSocket.response)
  check('socket 事件 listener 返回 true（异步等候）', contentSocket.ret === true)

  const extSocket = await bg.invoke(EXT_PAGE_SENDER, 'CHAT_SOCKET_EVENT', { event: 'open', at: 1 })
  check('扩展内页发 socket 事件被拒绝（url 非 goofish）', extSocket.response?.result?.accepted === false)

  const evilSocket = await bg.invoke(EVIL_CONTENT_SENDER, 'CHAT_SOCKET_EVENT', { event: 'open', at: 1 })
  check('非 goofish content 发 socket 事件被拒绝', evilSocket.response?.result?.accepted === false)

  const badPayload = await bg.invoke(CONTENT_SENDER, 'CHAT_SOCKET_EVENT', { event: 'nope', at: 1 })
  check('非法 socket payload 被拒绝', badPayload.response?.result?.accepted === false)

  const outsideSocket = await bg.invoke(OUTSIDE_SENDER, 'CHAT_SOCKET_EVENT', { event: 'open', at: 1 })
  check('外部扩展发 socket 事件被忽略（不响应）', outsideSocket.ret === false && outsideSocket.response === '__no_response__')
}

async function testPortSourcePolicy() {
  console.log('Part 4：事件长连接来源策略')
  const bg = await bootBackground()

  const extPort = bg.connectPort(EXT_PAGE_SENDER)
  check('扩展内页 Port 收到 WORKER_STARTED', extPort.received.some((e) => e.type === 'WORKER_STARTED'))

  const contentPort = bg.connectPort(CONTENT_SENDER)
  check('content script Port 被断开', contentPort.disconnected === true)
  check('content script Port 未收到任何事件', !contentPort.received.some((e) => e.type === 'WORKER_STARTED'))

  const outsidePort = bg.connectPort(OUTSIDE_SENDER)
  check('外部扩展 Port 被断开', outsidePort.disconnected === true)
  check('外部扩展 Port 未收到任何事件', outsidePort.received.length === 0)
}

async function testInitOrdering() {
  console.log('Part 5：init 完成前不 ingest 实时数据')
  let releaseGate
  const gate = new Promise((resolve) => {
    releaseGate = resolve
  })
  const bg = await bootBackground({
    sessionGet: async (key) => {
      if (key === 'fishops.chat.messages' || key === 'fishops.chat.conversations') await gate
      return undefined
    },
  })

  const port = bg.connectPort(EXT_PAGE_SENDER)
  port.onMessage.last()({ kind: 'subscribe', events: ['CHAT_MESSAGE_INGESTED'] })

  const pending = bg.invoke(CONTENT_SENDER, 'CHAT_SOCKET_EVENT', { event: 'message', raw: VALID_RAW, at: 1 })
  await sleep(30)
  check('init 完成前不 ingest（未广播 CHAT_MESSAGE_INGESTED）', !port.received.some((e) => e.type === 'CHAT_MESSAGE_INGESTED'))

  releaseGate()
  const result = await pending
  check('init 完成后 socket 事件被接受', result.response?.result?.accepted === true, result.response)
  await sleep(20)
  check('init 完成后广播 CHAT_MESSAGE_INGESTED（含元数据）', port.received.some((e) => e.type === 'CHAT_MESSAGE_INGESTED'))
}

async function testInitFailureRetry() {
  console.log('Part 6：init 失败可重试且不吞错误')
  let failOnce = true
  const bg = await bootBackground({
    sessionGet: async (key) => {
      if ((key === 'fishops.chat.messages' || key === 'fishops.chat.conversations') && failOnce) {
        failOnce = false
        throw new Error('mock storage unavailable')
      }
      return undefined
    },
  })

  const first = await bg.invoke(CONTENT_SENDER, 'CHAT_SOCKET_EVENT', { event: 'open', at: 1 })
  check('init 失败时 socket 事件 accepted=false（错误被感知，不吞）', first.response?.result?.accepted === false, first.response)

  const second = await bg.invoke(CONTENT_SENDER, 'CHAT_SOCKET_EVENT', { event: 'open', at: 1 })
  check('init 失败后可重建并重试成功', second.response?.result?.accepted === true, second.response)
}

// ==================== Part 7：manifest 范围与权限 ====================

function testManifest() {
  console.log('Part 7：manifest 范围与权限')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  check('manifest 不含 chrome_url_overrides（未替换新标签页）', manifest.chrome_url_overrides === undefined)
  // 仅允许两个精确 origin：goofish 页面注入 + 飞书开放平台 API。
  // 使用精确数组相等而非 includes，防止后续误加 <all_urls> / 任意域通配。
  check(
    'host_permissions 精确为 goofish 与飞书开放平台两项',
    JSON.stringify(manifest.host_permissions) ===
      JSON.stringify(['https://www.goofish.com/*', 'https://open.feishu.cn/*']),
    manifest.host_permissions,
  )
  check(
    'optional_host_permissions 同时声明 http://*/* 与 https://*/*（按需授权，不常驻 all URLs）',
    JSON.stringify(manifest.optional_host_permissions) === JSON.stringify(['http://*/*', 'https://*/*']),
    manifest.optional_host_permissions,
  )
  const allWww = (manifest.content_scripts ?? []).every(
    (script) => JSON.stringify(script.matches) === JSON.stringify(['https://www.goofish.com/*']),
  )
  check('所有 content_scripts 注入范围仍仅 https://www.goofish.com/*', allWww)
  check(
    '保留必要 permissions（storage/scripting/tabs）',
    ['storage', 'scripting', 'tabs'].every((p) => (manifest.permissions ?? []).includes(p)),
    manifest.permissions,
  )
}

async function run() {
  await testIsolatedBridge()
  await testBackgroundSources()
  await testChatSocketEventSource()
  await testPortSourcePolicy()
  await testInitOrdering()
  await testInitFailureRetry()
  testManifest()

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
