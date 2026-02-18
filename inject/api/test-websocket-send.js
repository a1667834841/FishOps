/**
 * test-websocket-send.js - 测试 WebSocket 发送消息
 * 在闲鱼聊天页面控制台执行
 */

(function() {
  'use strict';
  
  console.log('\n========== WebSocket 发送测试 ==========\n');
  
  // Step 1: 检查必要对象
  console.log('📋 检查组件...');
  console.log('  - window.XianyuSender:', !!window.XianyuSender);
  console.log('  - window.XianyuSenderSetup:', !!window.XianyuSenderSetup);
  console.log('  - window.WebSocket:', !!window.WebSocket);
  
  // Step 2: 检查 WebSocket 状态
  if (window.XianyuSenderSetup) {
    console.log('\n🔍 检查 WebSocket 连接...');
    // 尝试获取 WebSocket（内部方法）
    var testWs = null;
    try {
      // 通过 XianyuSender 的内部方法获取
      if (window.XianyuSender && window.XianyuSender.__getWebSocket) {
        testWs = window.XianyuSender.__getWebSocket();
      }
      console.log('  - WebSocket 状态:', testWs ? (testWs.readyState === WebSocket.OPEN ? '✅ 已连接' : '⚠️ 未就绪') : '❌ 未找到');
      if (testWs) {
        console.log('  - URL:', testWs.url);
      }
    } catch (e) {
      console.log('  - 无法检查 WebSocket:', e.message);
    }
  }
  
  // Step 3: 测试发送
  console.log('\n🚀 开始测试发送...');
  if (window.XianyuSender) {
    window.XianyuSender.sendTextMessage(
      '58263399670',      // sessionId
      '3004743608',       // receiverId
      'WebSocket 测试消息', // content
      '1020269847479'     // itemId
    )
    .then(result => {
      console.log('\n✅ 发送成功!');
      console.log('响应数据:', result.data);
      console.log('消息 ID:', result.messageId);
    })
    .catch(error => {
      console.error('\n❌ 发送失败:', error);
      console.error('错误详情:', error.error || error.message);
      
      if (error.error && error.error.includes('WebSocket')) {
        console.log('\n💡 提示：请确保已打开聊天页面，WebSocket 连接已建立');
      }
    });
    
    console.log('⏳ 等待发送结果...');
  } else {
    console.error('❌ XianyuSender 未加载');
  }
  
  console.log('\n========== 测试完成 ==========\n');
})();
