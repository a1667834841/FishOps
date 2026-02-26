/**
 * 测试脚本 - 手动加载 ChatHistoryAPI.getConversationIds
 * 在闲鱼聊天页面控制台粘贴运行此脚本
 */

(function() {
    'use strict';

    var LOG_PREFIX = '[测试]';

    // 检查 ChatHistoryAPI 是否存在
    if (window.ChatHistoryAPI) {
        console.log(LOG_PREFIX, 'ChatHistoryAPI 已存在');
        console.log(LOG_PREFIX, 'getConversationIds:', typeof ChatHistoryAPI.getConversationIds);
        return;
    }

    console.log(LOG_PREFIX, 'ChatHistoryAPI 不存在，可能加载失败');

    // 尝试单独定义 getConversationIds 函数
    window.getConversationIds = function(count) {
        count = count || 50;
        console.log(LOG_PREFIX, '开始获取', count, '个会话ID...');

        // 使用现有的 getConversationList API
        return ChatHistoryAPI.getConversationList().then(function(result) {
            var ids = [];
            if (result.conversations) {
                result.conversations.forEach(function(conv) {
                    if (conv.cid) ids.push(conv.cid);
                });
            }
            return {
                success: true,
                conversationIds: ids.slice(0, count)
            };
        });
    };

    console.log(LOG_PREFIX, '已将 getConversationIds 挂载到 window');
})();
