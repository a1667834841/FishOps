/**
 * test-conversation-loading.js - 测试会话加载机制
 * 用于调试闲鱼懒加载导致的会话数量不一致问题
 * 
 * 使用方法：直接在控制台粘贴执行（不需要 fetch）
 */

(function() {
    'use strict';
    
    console.log('========== 会话加载测试 ==========\n');
    
    // 检查 API
    if (typeof window.ChatHistoryAPI === 'undefined') {
        console.error('❌ ChatHistoryAPI 未加载');
        console.log('\n请按以下步骤操作：');
        console.log('1. 确认当前页面是闲鱼聊天页面');
        console.log('2. 刷新页面（F5）');
        console.log('3. 重新运行此脚本');
        return;
    }
    
    console.log('✅ ChatHistoryAPI 已加载');
    console.log('\n📋 测试步骤：');
    console.log('1. 手动滚动聊天列表到底部，确保所有会话都加载');
    console.log('2. 等待 3 秒后自动开始测试...\n');
    
    setTimeout(function() {
        console.log('🚀 开始测试获取会话列表...\n');
        
        // 测试 1: 获取第一页（20 个）
        console.log('📄 测试 1: 获取第一页会话（pageSize=20）');
        window.ChatHistoryAPI.getConversationList(undefined, 20)
            .then(function(result) {
                console.log('\n📊 第一页结果：');
                console.log('  会话数量:', result.conversations.length);
                console.log('  hasMore:', result.hasMore);
                console.log('  nextSortIndex:', result.nextSortIndex);
                console.log('  原始响应字段:', Object.keys(result.raw || {}));
                console.log('  原始响应（部分）:', JSON.stringify(result.raw).substring(0, 300) + '...');
                
                if (result.hasMore && result.nextSortIndex) {
                    console.log('\n📄 测试 2: 获取第二页会话');
                    return window.ChatHistoryAPI.getConversationList(result.nextSortIndex, 20);
                } else {
                    console.log('\n⚠️ hasMore=false，没有更多会话');
                    console.log('\n🔍 分析：');
                    if (result.conversations.length < 20) {
                        console.log('  ⚠️ 只获取到', result.conversations.length, '个会话（少于请求的 20 个）');
                        console.log('  ⚠️ 这可能是闲鱼懒加载机制导致的');
                        console.log('  💡 建议：手动滚动聊天列表到底部，触发更多会话加载');
                    }
                    return null;
                }
            })
            .then(function(result) {
                if (result) {
                    console.log('\n📊 第二页结果：');
                    console.log('  会话数量:', result.conversations.length);
                    console.log('  hasMore:', result.hasMore);
                    console.log('  nextSortIndex:', result.nextSortIndex);
                }
                
                console.log('\n========== 测试完成 ==========');
                console.log('\n💡 解决方案：');
                console.log('1. 如果返回少于 20 个会话但 hasMore=false：');
                console.log('   → 手动滚动聊天列表到底部，触发懒加载');
                console.log('   → 或使用强制分页模式（忽略 hasMore）');
                console.log('2. 如果 hasMore=true：');
                console.log('   → 说明可以正常分页，继续获取下一页');
            })
            .catch(function(error) {
                console.error('\n❌ 测试失败:', error);
            });
    }, 3000);
    
    console.log('⏳ 倒计时 3 秒...（请在此期间滚动会话列表）');
    
})();
