/**
 * test-message-order.js - 测试消息排序和去重
 * 验证消息按 createAt 时间降序排列（最新的在前）
 */

(function() {
    'use strict';
    
    console.log('========== 消息排序测试 ==========\n');
    
    // 获取前 20 条消息
    chrome.runtime.sendMessage({ 
        type: 'GET_CHAT_MESSAGES',
        limit: 20,
        offset: 0
    }, function(response) {
        if (!response || !response.messages) {
            console.error('❌ 获取消息失败');
            return;
        }
        
        var messages = response.messages;
        console.log('📊 获取到', messages.length, '条消息，总数:', response.total);
        
        if (messages.length === 0) {
            console.log('\n⚠️ 没有消息数据，请先同步消息');
            return;
        }
        
        // 检查排序
        console.log('\n🔍 检查排序（应该按 createAt 降序）：\n');
        var isCorrectOrder = true;
        var prevTime = Infinity;
        
        messages.forEach(function(msg, index) {
            var createAt = msg.createAt || 0;
            var timeStr = createAt ? new Date(createAt).toLocaleString() : '无时间';
            var content = (msg.content || '').substring(0, 30);
            
            console.log('  [' + (index + 1) + ']', timeStr, '-', content);
            
            if (createAt > prevTime) {
                isCorrectOrder = false;
                console.warn('    ⚠️ 排序错误！时间', createAt, '>', prevTime);
            }
            prevTime = createAt;
        });
        
        if (isCorrectOrder) {
            console.log('\n✅ 排序正确！消息按时间降序排列（最新的在前）');
        } else {
            console.error('\n❌ 排序错误！消息未按时间降序排列');
        }
        
        // 检查去重
        console.log('\n🔍 检查去重（按 messageId）：\n');
        var messageIdSet = new Set();
        var duplicates = [];
        
        messages.forEach(function(msg) {
            if (msg.messageId) {
                if (messageIdSet.has(msg.messageId)) {
                    duplicates.push(msg.messageId);
                } else {
                    messageIdSet.add(msg.messageId);
                }
            }
        });
        
        if (duplicates.length > 0) {
            console.error('❌ 发现重复消息 ID:', duplicates);
        } else {
            console.log('✅ 无重复消息，去重正常');
        }
        
        // 显示时间范围
        if (messages.length > 0) {
            var firstMsg = messages[0];
            var lastMsg = messages[messages.length - 1];
            var firstTime = firstMsg.createAt ? new Date(firstMsg.createAt).toLocaleString() : '无时间';
            var lastTime = lastMsg.createAt ? new Date(lastMsg.createAt).toLocaleString() : '无时间';
            
            console.log('\n📅 时间范围：');
            console.log('  最新消息:', firstTime);
            console.log('  最旧消息:', lastTime);
        }
        
        console.log('\n========== 测试完成 ==========');
    });
    
})();
