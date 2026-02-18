/**
 * test-actual-receivers.js - 测试 actualReceivers 参数
 * 在闲鱼聊天页面控制台执行
 */

(function() {
  'use strict';
  
  console.log('\n========== actualReceivers 参数测试 ==========\n');
  
  // Step 1: 监听一条消息，查看 receiverId 是否有值
  console.log('📋 等待接收消息...');
  console.log('💡 提示：请用另一个账号发送一条消息到此会话\n');
  
  if (window.EventBus) {
    window.EventBus.on(window.ChatEventType.MESSAGE, function(context) {
      var message = context.message;
      
      console.log('✅ 收到新消息！完整上下文:');
      console.log('   senderId (对方):', message.senderId);
      console.log('   senderName:', message.senderName);
      console.log('   receiverId (自己):', message.receiverId || '❌ 未找到');
      console.log('   sessionId:', message.sessionId);
      console.log('   itemId:', message.itemId);
      console.log('   content:', message.content);
      
      if (!message.receiverId) {
        console.error('\n❌ receiverId 为空！无法确定当前用户 ID');
        console.log('\n🔍 尝试从其他地方获取...');
        
        // 尝试从 URL 或其他地方获取
        var urlParams = new URLSearchParams(window.location.search);
        console.log('   URL peerUserId:', urlParams.get('peerUserId'));
        console.log('   URL userId:', urlParams.get('userId'));
      } else {
        console.log('\n✅ receiverId 有值，可以用于 myId');
      }
      
      // Step 2: 测试发送（如果有 receiverId）
      if (message.receiverId && window.XianyuSender) {
        console.log('\n🚀 开始测试发送（带 actualReceivers）...\n');
        
        window.XianyuSender.sendTextMessage(
          message.sessionId,
          message.senderId,       // toUserId: 回复给对方
          '测试 actualReceivers',  // content
          message.itemId,         // itemId
          message.receiverId      // myId: 当前用户自己
        )
        .then(result => {
          console.log('\n✅ 发送结果:', result.success ? '成功' : '失败');
          console.log('📊 响应数据:', result.data);
          
          if (result.success) {
            console.log('\n💡 如果对方收到消息，说明 actualReceivers 配置正确！');
          }
        })
        .catch(error => {
          console.error('\n❌ 发送失败:', error);
        });
      } else if (!window.XianyuSender) {
        console.error('\n❌ XianyuSender 未加载');
      }
      
      console.log('\n================================\n');
    });
    
    console.log('⏳ 已设置监听器，等待消息...\n');
  } else {
    console.error('❌ EventBus 未加载');
  }
})();
