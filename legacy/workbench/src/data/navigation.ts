/** 工作台页面标识。导航使用 Vue 本地状态，不依赖路由库。 */
export type PageId =
  | 'overview'
  | 'collect'
  | 'chat'
  | 'products'
  | 'publish'
  | 'analytics'
  | 'settings'

export interface NavItem {
  id: PageId
  /** 导航标签（保留原有全称） */
  label: string
  /** 顶部胶囊 Tab 紧凑标签 */
  shortLabel?: string
  /** 页面标题 */
  title: string
  /** 页面副标题与描述 */
  description: string
  /** 图标位文字：单字符号保持无障碍与一致性 */
  glyph: string
}

/** 首页默认页面：刷新后始终回到概览。 */
export const DEFAULT_PAGE: PageId = 'overview'

/** 主业务导航（支持顶部 Tab 栏展示）。 */
export const primaryNav: readonly NavItem[] = [
  {
    id: 'overview',
    label: '概览',
    shortLabel: '概览',
    title: '概览',
    description: '今日运营摘要、任务状态与快捷入口',
    glyph: '览',
  },
  {
    id: 'collect',
    label: '数据采集',
    shortLabel: '采集',
    title: '数据采集',
    description: '创建采集任务，把商品数据汇入商品库',
    glyph: '采',
  },
  {
    id: 'chat',
    label: '聊天中心',
    shortLabel: '聊天',
    title: '聊天中心',
    description: '查看买家会话，生成回复建议并手动发送',
    glyph: '聊',
  },
  {
    id: 'products',
    label: '商品库',
    shortLabel: '商品库',
    title: '商品库',
    description: '查看、筛选并导出已采集的商品',
    glyph: '库',
  },
  {
    id: 'publish',
    label: '发布中心',
    shortLabel: '发布',
    title: '发布中心',
    description: '从草稿到上架回执的发布流程',
    glyph: '发',
  },
  {
    id: 'analytics',
    label: '数据分析',
    shortLabel: '分析',
    title: '数据分析',
    description: '选择数据源与提示词规则，生成结构化分析',
    glyph: '析',
  },
]

/** 系统设置入口（纳入全局导航 Tab 体系）。 */
export const settingsNav: NavItem = {
  id: 'settings',
  label: '设置',
  shortLabel: '设置',
  title: '设置',
  description: '外观、模型、飞书和回复配置',
  glyph: '设',
}

/** 包含所有可访问页面的导航列表 */
export const allNav: readonly NavItem[] = [...primaryNav, settingsNav]

export function findNavItem(id: PageId): NavItem {
  return allNav.find((item) => item.id === id) ?? primaryNav[0]
}
