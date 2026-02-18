/**
 * test-send-message.js - 测试消息发送功能
 * 在闲鱼聊天页面控制台直接运行此代码测试发送功能
 */

(function() {
  'use strict';

  console.log('\n========== 消息发送测试 ==========\n');

  // 测试数据（请根据实际情况修改）
  var testData = {
    sessionId: '58263399670',      // 会话 ID
    receiverId: '3004743608',      // 接收者 ID
    itemId: '1020269847479',       // 商品 ID
    content: '这是一条测试消息 🚀'   // 测试内容
  };

  console.log('📝 测试数据:', testData);
  console.log('\n');

  // 检查 XianyuSender 是否可用
  if (!window.XianyuSender) {
    console.error('❌ XianyuSender 未加载，请确保扩展已正确注入');
    console.log('💡 解决方法：刷新页面或检查 manifest.json 配置');
    return;
  }

  console.log('✅ XianyuSender 已加载');
  console.log('📤 开始发送测试消息...\n');

  // 发送测试消息
  window.XianyuSender.sendTextMessage(
    testData.sessionId,
    testData.receiverId,
    testData.content,
    testData.itemId
  )
  .then(function(result) {
    console.log('\n========== 发送结果 ==========\n');
    if (result && result.success) {
      console.log('✅ 发送成功！');
      console.log('📝 消息 ID:', result.messageId);
      console.log('📊 完整响应:', result.data);
    } else {
      console.error('❌ 发送失败');
      console.error('错误信息:', result ? result.error : '未知错误');
    }
    console.log('\n================================\n');
  })
  .catch(function(error) {
    console.error('\n========== 发送异常 ==========\n');
    console.error('❌ 发生异常:', error);
    console.error('错误详情:', error.message || error);
    console.log('\n================================\n');
  });

  console.log('⏳ 等待发送结果...\n');
})();
