/**
 * test-chat-sync.js - 测试聊天同步功能
 * 使用方法：在闲鱼聊天页面控制台执行
 */

(function() {
    'use strict';
    
    console.log('========== 聊天同步测试 ==========');
    
    // 1. 检查依赖
    console.log('\n1️⃣ 检查依赖模块：');
    console.log('  ChatHistoryAPI:', typeof window.ChatHistoryAPI !== 'undefined' ? '✅ 已加载' : '❌ 未加载');
    console.log('  ChatSyncAPI:', typeof window.ChatSyncAPI !== 'undefined' ? '✅ 已加载' : '❌ 未加载');
    console.log('  GoodsAPI:', typeof window.GoodsAPI !== 'undefined' ? '✅ 已加载' : '❌ 未加载');
    console.log('  MessageBus:', typeof window.MessageBus !== 'undefined' ? '✅ 已加载' : '❌ 未加载');
    
    if (typeof window.ChatSyncAPI === 'undefined') {
        console.error('\n❌ ChatSyncAPI 未加载！');
        console.log('\n请按以下步骤操作：');
        console.log('1. 打开 chrome://extensions/');
        console.log('2. 找到 "闲鱼聊天监听助手"，点击重新加载按钮');
        console.log('3. 刷新当前页面（F5）');
        console.log('4. 重新运行此测试脚本');
        return;
    }
    
    // 2. 检查 WebSocket 连接
    console.log('\n2️⃣ 检查 WebSocket 连接：');
    var ws = window.XianyuSender ? window.XianyuSender.getTargetWebSocket() : null;
    if (ws) {
        console.log('  WebSocket 状态:', ws.readyState === WebSocket.OPEN ? '✅ 已连接' : '⚠️ 未就绪 (状态: ' + ws.readyState + ')');
    } else {
        console.log('  WebSocket 状态: ❌ 未找到连接');
        console.warn('\n⚠️ 请确保：');
        console.warn('  1. 已打开聊天页面（包含聊天会话）');
        console.warn('  2. 已发送或接收至少一条消息');
        return;
    }
    
    // 3. 测试 getConversationIds
    console.log('\n3️⃣ 测试获取会话 ID 列表（获取 5 个）：');
    window.ChatHistoryAPI.getConversationIds(5)
        .then(function(result) {
            console.log('  结果:', result);
            if (result.success && result.conversationIds && result.conversationIds.length > 0) {
                console.log('  ✅ 成功获取', result.conversationIds.length, '个会话 ID');
                console.log('  会话 ID 列表:', result.conversationIds);
                
                // 4. 测试小规模同步
                console.log('\n4️⃣ 测试同步功能（2个会话，每个5条消息）：');
                return window.ChatSyncAPI.startSync(2, 5);
            } else {
                console.warn('  ⚠️ 未获取到会话 ID');
                return Promise.reject('无会话数据');
            }
        })
        .then(function(result) {
            console.log('\n✅ 同步测试完成！');
            console.log('  统计信息:', result.stats);
            console.log('\n========== 测试完成 ==========');
            console.log('\n💡 现在可以执行完整同步：');
            console.log('  window.ChatSyncAPI.startSync(100, 20)  // 100个会话，每个20条消息');
        })
        .catch(function(error) {
            console.error('\n❌ 测试失败:', error);
        });
    
})();
