/** 集中维护真实回归用例；只加入已有数据读取与明确的接口探测。 */
export const regressionCases = {
  pages: [
    { id: 'overview', tab: '概览', title: '概览', selector: '.overview-view' },
    { id: 'collect', tab: '采集', title: '数据采集', selector: '.seline-collect-page' },
    { id: 'chat', tab: '聊天', title: '聊天中心', selector: '.chat' },
    { id: 'products', tab: '商品库', title: '商品库', selector: '.products-view' },
    { id: 'publish', tab: '发布', title: '发布中心', selector: '.publish-page' },
    { id: 'analytics', tab: '分析', title: '数据分析', selector: '.analytics-page' },
    { id: 'settings', tab: '设置', title: '设置', selector: '.settings' },
  ],
  commands: [
    { id: 'bridge', type: 'PING', payload: { clientTime: 0, nonce: 'regression' }, resultKey: 'pong' },
    { id: 'tasks', type: 'TASK_LIST', payload: { limit: 5 }, resultKey: 'tasks' },
    { id: 'chat-cache', type: 'CHAT_LIST_CONVERSATIONS', payload: {}, resultKey: 'conversations' },
    { id: 'publish-history', type: 'PUBLISH_LIST', payload: { limit: 5 }, resultKey: 'tasks' },
  ],
  connections: [
    { id: 'ai', section: 'AI 配置', button: '测试 AI 接口', input: '#ai-model', success: 'AI 接口测试成功' },
    { id: 'feishu', section: '飞书配置', button: '测试飞书连接 (Schema)', input: '#feishu-app-id', success: '连接成功' },
  ],
}
