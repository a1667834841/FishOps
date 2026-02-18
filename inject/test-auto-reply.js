/**
 * test-auto-reply.js - 自动回复测试脚本
 * 在闲鱼聊天页面控制台执行此脚本进行测试
 */

(function() {
  'use strict';

  console.log('\n=== 🧪 自动回复功能诊断 ===\n');

  // 1. 检查 EventBus
  if (!window.EventBus) {
    console.error('❌ EventBus 未加载');
  } else {
    console.log('✅ EventBus 已加载');
  }

  // 2. 检查 ChatEventType
  if (!window.ChatEventType) {
    console.error('❌ ChatEventType 未定义');
  } else {
    console.log('✅ ChatEventType 已定义');
    console.log('   事件类型:', window.ChatEventType);
  }

  // 3. 检查 AutoReplyProcessor
  if (!window.AutoReplyProcessor) {
    console.error('❌ AutoReplyProcessor 未导出');
  } else {
    console.log('✅ AutoReplyProcessor 已导出');
    
    // 获取状态
    var status = window.AutoReplyProcessor.getStatus();
    console.log('   状态:', status);
    
    // 尝试获取配置
    chrome.runtime.sendMessage({
      type: 'GET_AUTO_REPLY_CONFIG'
    }, function(response) {
      if (response && response.config) {
        console.log('   ✅ 配置已加载');
        console.log('   配置详情:', JSON.stringify(response.config, null, 2));
        
        if (response.config.enabled) {
          console.log('   ✅ 自动回复已启用');
        } else {
          console.warn('   ⚠️ 自动回复未启用，请在设置页面开启');
        }
        
        if (response.config.keywords && response.config.keywords.length > 0) {
          console.log('   ✅ 关键字规则数量:', response.config.keywords.length);
          console.log('   关键字列表:', response.config.keywords);
        } else {
          console.warn('   ⚠️ 暂无关键字规则');
        }
      } else {
        console.error('   ❌ 配置加载失败');
      }
    });
  }

  // 4. 检查 XianyuSender
  if (!window.XianyuSender) {
    console.error('❌ XianyuSender 未加载');
  } else {
    console.log('✅ XianyuSender 已加载');
    
    // 检查 WebSocket
    var ws = window.XianyuSender.getWebSocketInstance();
    if (ws) {
      console.log('✅ WebSocket 实例可用，状态:', ws.readyState);
    } else {
      console.warn('⚠️ WebSocket 实例不可用');
    }
  }

  // 5. 手动触发测试
  console.log('\n=== 📝 测试命令 ===');
  console.log('1. 启用自动回复：window.AutoReplyProcessor.enable()');
  console.log('2. 添加测试规则：window.AutoReplyProcessor.addKeyword("test", "reply")');
  console.log('3. 查看完整状态：console.log(window.AutoReplyProcessor.getStatus())');
  console.log('4. 手动发送测试消息：window.XianyuSender.sendTextMessage("sessionId", "receiverId", "test")');
  console.log('\n');

})();
