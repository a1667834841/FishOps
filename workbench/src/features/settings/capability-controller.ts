/**
 * 设置页「后台能力状态」检查控制器。纯 TypeScript，可在 Node 下测试。
 *
 * 只在用户点击「检查」时才向后台发命令；未检查前所有项目都显示「未检测」，
 * 绝不预设为「已连接」。每一项都标明状态来源（实际调用的命令），结果全部来自真实返回。
 *
 * 使用的命令（均为只读）：`PING`、`PLATFORM_PING`、`CHAT_STATUS`、`CHAT_AUTO_REPLY_STATUS`、
 * `TASK_LIST`、`PRODUCT_LIST`、`DATA_SOURCE_LIST`、`PROMPT_RULE_LIST`。
 * 不读取、不展示任何 API Key / AppSecret；AI 是否已配置只显示后台返回的布尔值。
 */
import { CommandTypes, genRequestId } from '@fishops/shared'
import type { BridgeApi } from '../shared/bridge-api'
import { CommandError, toErrorView } from '../shared/error-format'
import { StateStore } from '../shared/state-store'

export type CapabilityId = 'bridge' | 'platform' | 'chat' | 'reply' | 'capture' | 'analysis'
export type CapabilityPhase = 'idle' | 'checking' | 'ok' | 'warn' | 'error'

export interface CapabilityItem {
  id: CapabilityId
  label: string
  /** 状态来源：本项实际调用的命令。 */
  source: string
  phase: CapabilityPhase
  summary: string
  detail: string
  checkedAt: number | null
}

export interface CapabilityState {
  availability: 'unavailable' | 'ready'
  running: boolean
  items: CapabilityItem[]
}

interface CheckOutcome {
  phase: 'ok' | 'warn'
  summary: string
  detail?: string
}

interface CapabilityCheck {
  id: CapabilityId
  label: string
  source: string
  run(api: BridgeApi, now: () => number): Promise<CheckOutcome>
}

const SOCKET_TEXT: Record<string, string> = {
  open: '实时连接已建立',
  connecting: '实时连接中',
  closed: '实时连接已断开',
  error: '实时连接异常',
}

export const CAPABILITY_CHECKS: readonly CapabilityCheck[] = [
  {
    id: 'bridge',
    label: 'Bridge（工作台与扩展）',
    source: 'PING',
    async run(api, now) {
      const started = now()
      const result = await api.call(CommandTypes.PING, { clientTime: started, nonce: genRequestId() })
      if (!result.pong) throw new CommandError('INVALID_MESSAGE', '扩展没有返回 PONG')
      return { phase: 'ok', summary: `已连通，往返 ${Math.max(0, now() - started)} ms`, detail: `累计 PING ${result.pingCount} 次` }
    },
  },
  {
    id: 'platform',
    label: '闲鱼平台页面',
    source: 'PLATFORM_PING',
    async run(api) {
      const result = await api.call(CommandTypes.PLATFORM_PING, {})
      if (!result.pong) throw new CommandError('INVALID_MESSAGE', '平台 host 没有返回 PONG')
      return { phase: 'ok', summary: '已检测到已打开的闲鱼页面，平台 host 就绪', detail: '这只说明页面可调用，不代表账号已登录' }
    },
  },
  {
    id: 'chat',
    label: '聊天（只读缓存）',
    source: 'CHAT_STATUS',
    async run(api) {
      const result = await api.call(CommandTypes.CHAT_STATUS, {})
      const socket = SOCKET_TEXT[result.socketStatus] ?? '连接状态未知'
      return {
        phase: result.socketStatus === 'open' ? 'ok' : 'warn',
        summary: socket,
        detail: `本地缓存 ${result.sessionCount} 个会话，${result.messageCount} 条消息`,
      }
    },
  },
  {
    id: 'reply',
    label: '回复与 AI',
    source: 'CHAT_AUTO_REPLY_STATUS',
    async run(api) {
      const status = await api.call(CommandTypes.CHAT_AUTO_REPLY_STATUS, {})
      const modeText = status.mode === 'auto' ? '自动回复' : status.mode === 'suggest' ? '建议' : '人工'
      const detail = `回复引擎${status.enabled ? '已启用' : '未启用'}，模式：${modeText}，规则 ${status.rulesCount} 条`
      if (!status.configLoaded) return { phase: 'warn', summary: '回复配置尚未加载', detail }
      return {
        phase: status.aiConfigured ? 'ok' : 'warn',
        summary: status.aiConfigured ? 'AI 凭据已在扩展侧配置' : 'AI 凭据未配置，AI 建议不可用',
        detail,
      }
    },
  },
  {
    id: 'capture',
    label: '数据采集与商品库',
    source: 'TASK_LIST + PRODUCT_LIST',
    async run(api) {
      const [tasks, products] = await Promise.all([
        api.call(CommandTypes.TASK_LIST, { type: 'capture' }),
        api.call(CommandTypes.PRODUCT_LIST, { limit: 1 }),
      ])
      const running = tasks.tasks.filter((task) => task.status === 'running').length
      return {
        phase: 'ok',
        summary: `商品库 ${products.total} 件商品`,
        detail: `采集任务 ${tasks.tasks.length} 个，其中进行中 ${running} 个`,
      }
    },
  },
  {
    id: 'analysis',
    label: '数据分析',
    source: 'DATA_SOURCE_LIST + PROMPT_RULE_LIST',
    async run(api) {
      const [sources, rules] = await Promise.all([
        api.call(CommandTypes.DATA_SOURCE_LIST, {}),
        api.call(CommandTypes.PROMPT_RULE_LIST, {}),
      ])
      const names = sources.dataSources.map((source) => source.name).join('、') || '无'
      const hasFeishu = sources.dataSources.some((source) => source.type === 'feishu')
      return {
        phase: sources.dataSources.length > 0 ? (hasFeishu ? 'ok' : 'warn') : 'warn',
        summary: `已注册数据源：${names}`,
        detail: `${hasFeishu ? '' : '飞书数据源未注册。'}提示词规则 ${rules.rules.length} 条`,
      }
    },
  },
]

export function createInitialCapabilityState(availability: CapabilityState['availability']): CapabilityState {
  return {
    availability,
    running: false,
    items: CAPABILITY_CHECKS.map((check) => ({
      id: check.id,
      label: check.label,
      source: check.source,
      phase: 'idle',
      summary: '未检测',
      detail: '',
      checkedAt: null,
    })),
  }
}

export class CapabilityController extends StateStore<CapabilityState> {
  private readonly api: BridgeApi | null
  private readonly now: () => number
  private runSeq = 0

  constructor(options: { api: BridgeApi | null; now?: () => number }) {
    super(createInitialCapabilityState(options.api ? 'ready' : 'unavailable'))
    this.api = options.api
    this.now = options.now ?? (() => Date.now())
  }

  /** 页面挂载时不自动检查；保留与其他控制器一致的生命周期方法。 */
  start(): void {}

  resubscribe(): void {}

  /** 依次发起全部检查。检查进行中重复调用被忽略。 */
  async runAll(): Promise<void> {
    const api = this.api
    if (this.disposed || !api || this.state.running) return
    const token = ++this.runSeq
    this.patch({
      running: true,
      items: this.state.items.map((item) => ({ ...item, phase: 'checking', summary: '检测中', detail: '' })),
    })
    await Promise.all(
      CAPABILITY_CHECKS.map(async (check) => {
        let update: Partial<CapabilityItem>
        try {
          const outcome = await check.run(api, this.now)
          update = { phase: outcome.phase, summary: outcome.summary, detail: outcome.detail ?? '' }
        } catch (error) {
          const view = toErrorView(error)
          update = { phase: 'error', summary: view.title, detail: view.hint ? `${view.hint}` : view.detail }
        }
        if (this.disposed || token !== this.runSeq) return
        this.patch({
          items: this.state.items.map((item) => (item.id === check.id ? { ...item, ...update, checkedAt: this.now() } : item)),
        })
      }),
    )
    if (this.disposed || token !== this.runSeq) return
    this.patch({ running: false })
  }
}
