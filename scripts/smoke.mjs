/**
 * P1 Bridge 冒烟测试（不依赖浏览器）。
 *
 * 直接加载构建产物 `extension/dist/background.js`，用最小 mock 模拟 chrome.* API，
 * 验证：
 *   1. PING → PONG（请求/响应链路与 requestId 关联）
 *   2. 命令路由与负载校验（未知命令 / 非法负载 / 来源拒绝）
 *   3. 来源区分：普通命令只接受扩展内页，content script / 外部页面一律拒绝，长连接同理
 *   4. 长连接 Port 的事件订阅与广播
 *   5. service worker “被回收后重启”时计数仍从 chrome.storage.session 恢复（状态未放内存）
 *
 * 用法：先 `npm run build`，再 `node scripts/smoke.mjs`
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const backgroundPath = resolve(here, '../extension/dist/background.js')
const EVENTS_PORT = 'fishops-workbench-events'
const EXTENSION_ID = 'fishops-smoke-test'
/**
 * 扩展内页（Workbench）来源：普通命令与订阅长连接只接受它。
 *
 * 真实 Chrome 中扩展内页位于 tab 内，`sender.tab` 会被填充（tab.url 即扩展页 URL），
 * 并带 `origin`；这里刻意还原该结构，防止「把带 tab 的扩展内页误判为 content script」的回归。
 */
const EXTENSION_PAGE_SENDER = {
  id: EXTENSION_ID,
  origin: `chrome-extension://${EXTENSION_ID}`,
  tab: { id: 1, url: `chrome-extension://${EXTENSION_ID}/workbench.html` },
  url: `chrome-extension://${EXTENSION_ID}/workbench.html`,
}
/** goofish content script 来源：仅用于验证普通命令 / 长连接被拒绝。 */
const CONTENT_SENDER = { id: EXTENSION_ID, tab: { id: 7 }, url: 'https://www.goofish.com/im' }

if (!existsSync(backgroundPath)) {
  console.error(`未找到构建产物，请先运行 \`npm run build\`。期望路径：${backgroundPath}`)
  process.exit(1)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ---- 最小 chrome.* mock ----
/** 模拟 chrome.storage.session：跨 service worker 重启保留，用于验证持久化。 */
const sessionStore = new Map()

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

globalThis.chrome = {
  runtime: {
    id: EXTENSION_ID,
    lastError: undefined,
    onConnect: createEventTarget(),
    onMessage: createEventTarget(),
    getURL: (path) => `chrome-extension://${EXTENSION_ID}/${path}`,
    sendMessage() {},
    connect() {
      throw new Error('smoke test 未实现 chrome.runtime.connect')
    },
  },
  storage: {
    session: {
      async get(key) {
        const result = {}
        if (typeof key === 'string' && sessionStore.has(key)) result[key] = sessionStore.get(key)
        return result
      },
      async set(items) {
        for (const [key, value] of Object.entries(items)) sessionStore.set(key, value)
      },
    },
  },
  action: { onClicked: createEventTarget() },
  tabs: { create() {} },
}

// ---- 加载 background（每次带不同 query，模拟新实例）----
let loadSeq = 0
async function loadBackground() {
  const url = `${pathToFileURL(backgroundPath).href}?instance=${++loadSeq}`
  await import(url)
  await sleep(30) // 等待顶层 bootstrap() 读取 storage 并广播
}

function makeCommand(type, payload) {
  return {
    kind: 'command',
    protocol: 1,
    requestId: `req_${Math.random().toString(36).slice(2)}`,
    type,
    payload,
    sentAt: Date.now(),
  }
}

/** 以扩展内页来源发送命令，返回 Promise<ResponseEnvelope>。 */
function send(type, payload) {
  const listener = chrome.runtime.onMessage.last()
  return new Promise((resolveResponse) => {
    listener(makeCommand(type, payload), EXTENSION_PAGE_SENDER, resolveResponse)
  })
}

/** 用指定来源发送命令，返回 { ret, response }；ret 为 listener 的同步返回值。 */
function sendFrom(sender, type, payload) {
  const listener = chrome.runtime.onMessage.last()
  return new Promise((resolveResult) => {
    const ret = listener(makeCommand(type, payload), sender, (response) => resolveResult({ ret, response }))
    // 被拒绝时不回响应，30ms 后返回哨兵值。
    setTimeout(() => resolveResult({ ret, response: '__no_response__' }), 30)
  })
}

function createPort(sender) {
  const onMessage = createEventTarget()
  const onDisconnect = createEventTarget()
  const received = []
  return {
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
}

function connectPort(sender = EXTENSION_PAGE_SENDER) {
  const port = createPort(sender)
  chrome.runtime.onConnect.last()(port)
  return port
}

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

async function run() {
  console.log('加载 background 实例 #1 ...')
  await loadBackground()

  const port = connectPort()
  check('onConnect 后收到补发的 WORKER_STARTED', port.received.some((e) => e.type === 'WORKER_STARTED'))
  check('扩展内页 Port 未被断开（sender.tab 存在也不影响）', port.disconnected === false)
  port.onMessage.last()({ kind: 'subscribe', events: ['PING_RECEIVED'] })

  const r1 = await send('PING', { clientTime: Date.now(), nonce: 'n1' })
  check('PING 返回 response 信封', r1?.kind === 'response')
  check('PONG 成功且 pong=true', r1?.ok === true && r1?.result?.pong === true)
  check('nonce 回显正确', r1?.result?.nonce === 'n1')
  check('带 tab 的扩展内页 sender 仍被接受（真实 Chrome 行为）', r1?.ok === true)

  const r2 = await send('PING', { clientTime: Date.now(), nonce: 'n2' })
  check('pingCount 递增到 2', r2?.result?.pingCount === 2, r2?.result)

  check(
    '订阅者收到 PING_RECEIVED 事件',
    port.received.some((e) => e.type === 'PING_RECEIVED' && e.payload?.nonce === 'n2'),
  )

  const rUnknown = await send('NOPE', {})
  check('未知命令返回 UNKNOWN_COMMAND', rUnknown?.ok === false && rUnknown?.error?.code === 'UNKNOWN_COMMAND')

  const rBad = await send('PING', { clientTime: 'oops' })
  check('非法 PING 负载返回 INVALID_PAYLOAD', rBad?.ok === false && rBad?.error?.code === 'INVALID_PAYLOAD')

  const rSub = await send('SUBSCRIBE', { events: ['DEMO_TICK'] })
  check('SUBSCRIBE 回显订阅列表', rSub?.ok === true && Array.isArray(rSub?.result?.subscribed))

  const outsideRet = await new Promise((resolveResponse) => {
    const listener = chrome.runtime.onMessage.last()
    const ret = listener(makeCommand('PING', { clientTime: Date.now(), nonce: 'x' }), { id: 'evil-other-id', url: 'https://evil.com/' }, resolveResponse)
    check('外部来源命令被拒绝（listener 返回 false）', ret === false)
    setTimeout(() => resolveResponse('__no_response__'), 30)
  })
  check('外部来源未收到响应', outsideRet === '__no_response__')

  // content script 的 sender.id 同样等于本扩展，但不得调用普通命令。
  const contentResult = await sendFrom(CONTENT_SENDER, 'PING', { clientTime: Date.now(), nonce: 'c' })
  check('content script 来源的普通命令被拒绝', contentResult.ret === false)
  check('content script 未收到普通命令响应', contentResult.response === '__no_response__')

  // 非扩展页建立的事件长连接应被拒绝，防止事件泄露。
  const rejectedPort = connectPort(CONTENT_SENDER)
  check('content script Port 被断开', rejectedPort.disconnected === true)
  check('content script Port 未收到 WORKER_STARTED', !rejectedPort.received.some((e) => e.type === 'WORKER_STARTED'))

  console.log('模拟 service worker 被回收后重启 ...')
  port.disconnect()
  await loadBackground()
  const port2 = connectPort()
  const workerStarted = port2.received.find((e) => e.type === 'WORKER_STARTED')
  check('重启后仍补发 WORKER_STARTED', Boolean(workerStarted))
  check('重启后 firstStart=false（会话内非首启）', workerStarted?.payload?.firstStart === false, workerStarted?.payload)

  const r3 = await send('PING', { clientTime: Date.now(), nonce: 'n3' })
  check('重启后 pingCount 继续累加（=3，证明 persist 在 storage.session）', r3?.result?.pingCount === 3, r3?.result)

  // 只带 origin、无 url 的扩展内页 sender 也应被接受（origin 回退判断）。
  // 放在计数断言之后，避免额外 PING 影响 pingCount。
  const originOnly = await new Promise((resolveResponse) => {
    const listener = chrome.runtime.onMessage.last()
    listener(
      makeCommand('PING', { clientTime: Date.now(), nonce: 'o' }),
      { id: EXTENSION_ID, origin: `chrome-extension://${EXTENSION_ID}` },
      resolveResponse,
    )
  })
  check('仅带 origin 的扩展内页 sender 被接受', originOnly?.ok === true, originOnly)

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
