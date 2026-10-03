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
  /** 侧栏短标签 */
  label: string
  /** 顶部栏标题 */
  title: string
  /** 顶部栏副标题 */
  description: string
  /** 图标位文字：不引入图标库，用单字符号保持无障碍与一致性 */
  glyph: string
  /** 研发阶段标记，仅用于侧栏提示 */
  phase?: string
}

/** 首页默认页面：刷新后始终回到概览。 */
export const DEFAULT_PAGE: PageId = 'overview'

/** 主导航（侧栏上半部分）。 */
export const primaryNav: readonly NavItem[] = [
  {
    id: 'overview',
    label: '概览',
    title: '概览',
    description: '今日运营摘要、任务状态与快捷入口',
    glyph: '览',
  },
  {
    id: 'collect',
    label: '数据采集',
    title: '数据采集',
    description: '创建采集任务，把商品数据汇入商品库',
    glyph: '采',
    phase: 'P4',
  },
  {
    id: 'chat',
    label: '聊天中心',
    title: '聊天中心',
    description: '查看买家会话，生成回复建议并手动发送',
    glyph: '聊',
    phase: 'P5/P6',
  },
  {
    id: 'products',
    label: '商品库',
    title: '商品库',
    description: '查看、筛选并导出已采集的商品',
    glyph: '库',
    phase: 'P4',
  },
  {
    id: 'publish',
    label: '发布中心',
    title: '发布中心',
    description: '从草稿到上架回执的发布流程',
    glyph: '发',
  },
  {
    id: 'analytics',
    label: '数据分析',
    title: '数据分析',
    description: '选择数据源与提示词规则，生成结构化分析',
    glyph: '析',
    phase: 'P7',
  },
]

/** 设置入口固定在侧栏底部。 */
export const settingsNav: NavItem = {
  id: 'settings',
  label: '设置',
  title: '设置',
  description: '外观、后台能力状态与待接入的安全配置',
  glyph: '设',
}

const allNav: readonly NavItem[] = [...primaryNav, settingsNav]

export function findNavItem(id: PageId): NavItem {
  return allNav.find((item) => item.id === id) ?? primaryNav[0]
}
