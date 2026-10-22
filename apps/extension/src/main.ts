import { installChatWakeup } from './chat-wakeup.ts'
/**
 * 扩展入口（service worker）。
 *
 * 顶层同步注册监听：SW 每次唤醒都会执行本文件，因此顶层连接 native host 即可保活；
 * 安装、浏览器启动与点击图标是一次明确的唤醒动作，会主动补一次连接。
 */
import { ChatOutbox } from './chat-outbox.ts'
import { createChromeChatStorage } from './chat-storage.ts'
import type { NativeBridge } from './connection.ts'
import { createBridge } from './bridge-factory.ts'
import { createChromeScripting } from './chrome-scripting.ts'
import { createChromeEnv } from './env.ts'

const BRIDGE_KEY = '__fishopsNativeBridge__'

type BridgeScope = typeof globalThis & { [BRIDGE_KEY]?: NativeBridge }

function createProductionBridge(): NativeBridge {
  const env = createChromeEnv()
  return createBridge({
    env,
    outbox: new ChatOutbox(createChromeChatStorage()),
    scripting: createChromeScripting(),
  })
}

// 同一 SW 生命周期内重复执行顶层代码时复用实例，避免产生重复 Port。
const scope = globalThis as BridgeScope
const bridge = scope[BRIDGE_KEY] ?? createProductionBridge()
scope[BRIDGE_KEY] = bridge

chrome.runtime.onInstalled.addListener(() => bridge.ensureConnected())
chrome.runtime.onStartup.addListener(() => bridge.ensureConnected())
chrome.action.onClicked.addListener(() => bridge.ensureConnected())

installChatWakeup(bridge, createChromeScripting())
bridge.start()
