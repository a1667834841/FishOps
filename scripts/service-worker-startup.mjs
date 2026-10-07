/**
 * MV3 background Service Worker 启动回归测试（不依赖浏览器）。
 *
 * 目标：在接近真实 Chrome 的最小 mock 下启动构建产物 `extension/dist/background.js`，
 * 断言「Service Worker 能正常启动、监听器已注册、PING 能拿到响应」，并锁定一个曾在
 * 真实 Chrome 中导致 Bridge 端口关闭的回归：
 *
 *   真实 Chrome 中，扩展内页（`chrome-extension://<id>/workbench.html`）在 tab 内打开时，
 *   `sender.tab` 会被填充（`tab.url` 同为扩展页 URL）。若来源校验用「有无 tab」来区分
 *   扩展内页与 content script，就会把扩展内页误拒，`chrome.runtime.sendMessage` 收不到
 *   响应并抛出 `The message port closed before a response was received.`。
 *
 * 因此本测试刻意还原「带 tab 的扩展内页 sender」，覆盖：
 *   1. 脚本能被 import（无顶层抛错），onMessage / onConnect / action 监听已注册；
 *   2. 带 tab 的扩展内页 PING 返回 PONG；
 *   3. 带 tab 的扩展内页长连接未被断开且收到补发的 WORKER_STARTED；
 *   4. content script 来源仍被拒绝（安全不回退）；
 *   5. 通用调度唤醒器同步注册、创建 1 分钟 alarm，调度命令仍只接受扩展内页；
 *   6. 启动过程不产生 unhandledRejection。
 *
 * 用法：先 `npm run build`（或 `npm run build:extension`），再 `node scripts/service-worker-startup.mjs`
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const backgroundPath = resolve(here, '../extension/dist/background.js')
const EXTENSION_ID = 'fishops-sw-startup-test'
const EVENTS_PORT = 'fishops-workbench-events'

if (!existsSync(backgroundPath)) {
  console.error(`未找到构建产物，请先运行 \`npm run build\`。期望路径：${backgroundPath}`)
  process.exit(1)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ---- 断言 ---- //
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

/** 捕获启动期间的 unhandledRejection，作为 SW 启动失败信号。 */
const unhandled = []
process.on('unhandledRejection', (reason) => unhandled.push(reason))

// ---- 最小 chrome.* mock（贴近真实扩展环境）---- //
const sessionStore = new Map()
const localStore = new Map()
const alarmStore = new Map()

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
    hasListeners() {
      return listeners.length > 0
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
      throw new Error('service-worker-startup test 未实现 chrome.runtime.connect')
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
    local: {
      async get(key) {
        const result = {}
        if (typeof key === 'string' && localStore.has(key)) result[key] = localStore.get(key)
        return result
      },
      async set(items) {
        for (const [key, value] of Object.entries(items)) localStore.set(key, value)
      },
    },
  },
  alarms: {
    onAlarm: createEventTarget(),
    async get(name) {
      return alarmStore.get(name)
    },
    async create(name, info) {
      alarmStore.set(name, { name, scheduledTime: Date.now(), ...info })
    },
    async clear(name) {
      return alarmStore.delete(name)
    },
  },
  action: { onClicked: createEventTarget() },
  // 提供接近真实的 scripting / tabs，验证平台层懒组装不会被顶层触发。
  scripting: { executeScript() {} },
  tabs: { create() {}, query() {}, get() {} },
}

/**
 * 扩展内页 sender：刻意带上 tab 与 origin，还原真实 Chrome 的结构。
 * 这是本回归测试的核心。
 */
const EXTENSION_PAGE_SENDER = {
  id: EXTENSION_ID,
  origin: `chrome-extension://${EXTENSION_ID}`,
  tab: { id: 1, url: `chrome-extension://${EXTENSION_ID}/workbench.html` },
  url: `chrome-extension://${EXTENSION_ID}/workbench.html`,
}
/** goofish content script 来源：仅用于验证仍被拒绝。 */
const CONTENT_SENDER = { id: EXTENSION_ID, origin: 'https://www.goofish.com', tab: { id: 7, url: 'https://www.goofish.com/im' }, url: 'https://www.goofish.com/im' }

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

function invoke(sender, type, payload) {
  const listener = chrome.runtime.onMessage.last()
  return new Promise((resolveResult) => {
    let done = false
    let ret
    const finish = (response) => {
      if (done) return
      done = true
      resolveResult({ ret, response })
    }
    ret = listener(makeCommand(type, payload), sender, finish)
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
  chrome.runtime.onConnect.last()(port)
  return port
}

async function run() {
  console.log('启动 background Service Worker（最小 chrome mock）...')
  const url = `${pathToFileURL(backgroundPath).href}?sw=${Date.now()}`
  await import(url)
  await sleep(50) // 等待顶层 bootstrap 读写 storage

  console.log('Part 1：Service Worker 启动与监听器注册')
  check('background.js 可加载（无顶层抛错）', true)
  check('chrome.runtime.onMessage 已注册监听', chrome.runtime.onMessage.hasListeners())
  check('chrome.runtime.onConnect 已注册监听', chrome.runtime.onConnect.hasListeners())
  check('chrome.action.onClicked 已注册监听', chrome.action.onClicked.hasListeners())

  console.log('Part 2：扩展内页（带 tab）PING 必须能拿到响应')
  const ping = await invoke(EXTENSION_PAGE_SENDER, 'PING', { clientTime: Date.now(), nonce: 'sw1' })
  check('listener 返回 true（保持端口异步响应）', ping.ret === true)
  check('PING 返回 response 信封', ping.response?.kind === 'response', ping.response)
  check('PONG 成功且 pong=true', ping.response?.ok === true && ping.response?.result?.pong === true, ping.response)
  check('nonce 回显正确', ping.response?.result?.nonce === 'sw1', ping.response?.result)

  console.log('Part 3：扩展内页（带 tab）长连接不被断开')
  const port = connectPort(EXTENSION_PAGE_SENDER)
  check('扩展内页 Port 未被断开', port.disconnected === false)
  check('扩展内页 Port 收到补发 WORKER_STARTED', port.received.some((e) => e.type === 'WORKER_STARTED'))

  console.log('Part 4：安全不回退（content script 仍被拒绝）')
  const contentPing = await invoke(CONTENT_SENDER, 'PING', { clientTime: Date.now(), nonce: 'c1' })
  check('content script 普通命令被拒绝（listener 返回 false）', contentPing.ret === false)
  check('content script 普通命令无响应', contentPing.response === '__no_response__')
  const contentPort = connectPort(CONTENT_SENDER)
  check('content script Port 被断开', contentPort.disconnected === true)

  console.log('Part 5：通用调度唤醒器启动与命令来源')
  check('调度 alarm 监听已同步注册', chrome.alarms.onAlarm.hasListeners())
  const schedulerAlarm = alarmStore.get('fishops.scheduler.tick')
  check('启动时创建了 1 分钟固定间隔的调度 alarm', schedulerAlarm?.periodInMinutes === 1, schedulerAlarm)
  const executors = await invoke(EXTENSION_PAGE_SENDER, 'SCHEDULE_EXECUTOR_LIST', {})
  check('本期无业务执行器：执行器列表为空数组', executors.response?.ok === true && Array.isArray(executors.response?.result) && executors.response.result.length === 0, executors.response)
  const schedules = await invoke(EXTENSION_PAGE_SENDER, 'SCHEDULE_LIST', {})
  check('扩展内页可读取调度计划（初始为空数组）', schedules.response?.ok === true && Array.isArray(schedules.response?.result), schedules.response)
  const contentSchedule = await invoke(CONTENT_SENDER, 'SCHEDULE_SAVE', { id: 'p', name: 'p', taskType: 'none', config: {}, intervalMinutes: 1, enabled: true })
  check('content script 发调度命令被拒绝（listener 返回 false）', contentSchedule.ret === false)
  check('content script 调度命令无响应', contentSchedule.response === '__no_response__')

  console.log('Part 6：启动无未处理异常')
  // 手动触发一次 alarm；本期无执行器，tick 应空跑而不产生未处理拒绝。
  const alarmListener = chrome.alarms.onAlarm.last()
  alarmListener({ name: 'fishops.other.event' })
  alarmListener({ name: 'fishops.scheduler.tick' })
  await sleep(50)
  check('启动期间无 unhandledRejection', unhandled.length === 0, unhandled.map(String))

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
