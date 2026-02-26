/**
 * test-deduplication-stats.js - 分析消息去重统计
 * 使用方法：同步后在控制台执行，查看去重详情
 */

(function() {
    'use strict';
    
    console.log('========== 消息去重统计分析 ==========\n');
    
    // 从 storage 获取消息
    chrome.storage.local.get({ chatMessages: [] }, function(result) {
        var messages = result.chatMessages || [];
        
        console.log('📊 存储的消息总数:', messages.length);
        
        // 统计 messageId
        var messageIdMap = {};
        var duplicateIds = [];
        var noIdCount = 0;
        
        messages.forEach(function(msg) {
            if (msg.messageId) {
                if (messageIdMap[msg.messageId]) {
                    messageIdMap[msg.messageId]++;
                    if (messageIdMap[msg.messageId] === 2) {
                        duplicateIds.push(msg.messageId);
                    }
                } else {
                    messageIdMap[msg.messageId] = 1;
                }
            } else {
                noIdCount++;
            }
        });
        
        console.log('✅ 唯一消息数:', Object.keys(messageIdMap).length);
        console.log('⚠️ 无 messageId 的消息:', noIdCount);
        console.log('❌ 重复的 messageId 数:', duplicateIds.length);
        
        if (duplicateIds.length > 0) {
            console.log('\n重复的 messageId 示例（前 5 个）:');
            duplicateIds.slice(0, 5).forEach(function(id) {
                var count = messageIdMap[id];
                var samples = messages.filter(function(m) { return m.messageId === id; });
                console.log('  ID:', id, '出现次数:', count);
                if (samples.length > 0) {
                    console.log('    内容:', (samples[0].content || '').substring(0, 30) + '...');
                }
            });
        }
        
        // 统计会话分布
        var conversationMap = {};
        messages.forEach(function(msg) {
            var cid = msg.chatId || msg.cid || '未知';
            conversationMap[cid] = (conversationMap[cid] || 0) + 1;
        });
        
        console.log('\n📋 会话分布（前 10 个）:');
        var sortedConvs = Object.keys(conversationMap).map(function(cid) {
            return { cid: cid, count: conversationMap[cid] };
        }).sort(function(a, b) {
            return b.count - a.count;
        });
        
        sortedConvs.slice(0, 10).forEach(function(item, i) {
            console.log('  [' + (i + 1) + '] 会话 ' + item.cid + ': ' + item.count + ' 条消息');
        });
        
        console.log('\n========== 分析完成 ==========');
    });
    
})();
