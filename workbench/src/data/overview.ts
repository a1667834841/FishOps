import type { PageId } from './navigation'

/**
 * 概览页的示例数据。
 * 这里的数字、进度和活动都是演示用静态内容，界面上必须标注「示例 / 演示」，
 * 接入真实数据源后应整体替换，而不是在此基础上修改。
 */

export interface DemoMetric {
  id: string
  label: string
  value: number
  unit: string
  hint: string
  target: PageId
}

export type TaskStatus = 'running' | 'waiting' | 'queued' | 'idle' | 'done'

export interface DemoTask {
  id: string
  name: string
  detail: string
  status: TaskStatus
  /** 0 到 100 */
  progress: number
}

export interface DemoActivity {
  id: string
  time: string
  module: string
  text: string
}

export interface QuickAction {
  id: string
  label: string
  description: string
  target: PageId
  primary?: boolean
}

/** 流程各环节的真实研发状态（非演示数据）。 */
export interface FlowStage {
  id: string
  label: string
  note: string
  tone: 'ok' | 'accent' | 'neutral'
  status: string
}

export const demoMetrics: readonly DemoMetric[] = [
  { id: 'queue', label: '待采集链接', value: 12, unit: '条', hint: '等待加入采集队列', target: 'collect' },
  { id: 'unread', label: '未读会话', value: 5, unit: '个', hint: '来自买家的新消息', target: 'chat' },
  { id: 'drafts', label: '待发布草稿', value: 3, unit: '件', hint: '已编辑但未上架', target: 'publish' },
  { id: 'reports', label: '本周分析报告', value: 1, unit: '份', hint: '价格与咨询复盘', target: 'analytics' },
]

export const demoTasks: readonly DemoTask[] = [
  { id: 'collect', name: '商品抓取', detail: '批量采集任务队列', status: 'running', progress: 62 },
  { id: 'chat-sync', name: '聊天同步', detail: '会话与消息的只读同步', status: 'waiting', progress: 0 },
  { id: 'analysis', name: '数据分析', detail: '周度价格与咨询汇总', status: 'done', progress: 100 },
  { id: 'publish', name: '商品发布', detail: '草稿校验与上架', status: 'idle', progress: 0 },
]

export const demoActivities: readonly DemoActivity[] = [
  { id: 'a1', time: '10:42', module: '采集', text: '完成一批商品详情的抓取，等待写入商品库' },
  { id: 'a2', time: '10:15', module: '聊天', text: '收到 2 条新的买家咨询，尚未回复' },
  { id: 'a3', time: '09:30', module: '分析', text: '生成上周价格分布汇总' },
  { id: 'a4', time: '昨天', module: '发布', text: '一件草稿未通过校验，缺少商品图片' },
]

export const quickActions: readonly QuickAction[] = [
  { id: 'collect', label: '开始采集', description: '创建商品采集任务', target: 'collect', primary: true },
  { id: 'chat', label: '打开聊天', description: '查看买家会话', target: 'chat' },
  { id: 'products', label: '查看商品库', description: '浏览与整理商品', target: 'products' },
  { id: 'analytics', label: '运行分析', description: '生成价格与咨询报告', target: 'analytics' },
]

export const flowStages: readonly FlowStage[] = [
  { id: 'collect', label: '采集', note: '商品数据入库', tone: 'accent', status: 'P4 已接入' },
  { id: 'chat', label: '对话', note: '买家会话跟进', tone: 'accent', status: 'P5/P6 已接入' },
  { id: 'publish', label: '发布', note: '草稿到上架', tone: 'neutral', status: '规划中' },
  { id: 'analytics', label: '分析', note: '数据复盘', tone: 'accent', status: 'P7 已接入' },
]

export const taskStatusMeta: Record<TaskStatus, { label: string; tone: 'accent' | 'info' | 'neutral' | 'ok' }> = {
  running: { label: '运行中', tone: 'accent' },
  waiting: { label: '待接线', tone: 'info' },
  queued: { label: '排队中', tone: 'neutral' },
  idle: { label: '未开始', tone: 'neutral' },
  done: { label: '已完成', tone: 'ok' },
}
