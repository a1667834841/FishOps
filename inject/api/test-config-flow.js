/**
 * test-config-flow.js - 测试配置数据流
 * 在闲鱼页面控制台执行
 */

(function() {
  'use strict';
  
  console.log('\n========== 配置数据流测试 ==========\n');
  
  // Step 1: 检查必要对象
  console.log('📋 检查组件...');
  console.log('  - window.AutoReplyProcessor:', !!window.AutoReplyProcessor);
  console.log('  - window.EventBus:', !!window.EventBus);
  
  // Step 2: 手动触发配置加载并查看日志
  console.log('\n⏳ 等待配置加载完成...\n');
  
  // 监听 postMessage
  window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'AUTO_REPLY_CONFIG_RESPONSE') {
      console.log('📨 [TEST] 捕获到配置响应:');
      console.log('   source:', event.data.source);
      console.log('   type:', event.data.type);
      console.log('   requestId:', event.data.requestId);
      console.log('   detail:', event.data.detail);
      
      // 检查返回的配置
      if (event.data.detail && event.data.detail.config) {
        var config = event.data.detail.config;
        console.log('\n✅ 配置内容:');
        console.log('   enabled:', config.enabled);
        console.log('   keywords:', config.keywords);
        console.log('   delay:', config.delay);
        console.log('   cooldown:', config.cooldown);
      } else {
        console.log('⚠️ 配置为空或格式不正确');
      }
    }
  });
  
  // Step 3: 检查 AutoReplyProcessor 状态
  setTimeout(() => {
    if (window.AutoReplyProcessor) {
      var status = window.AutoReplyProcessor.getStatus();
      console.log('\n📊 AutoReplyProcessor 状态:');
      console.log('  enabled:', status.enabled);
      console.log('  keywordsCount:', status.keywordsCount);
      console.log('  processedCount:', status.processedCount);
      
      // 测试启用
      console.log('\n🔧 测试启用自动回复...');
      window.AutoReplyProcessor.enable();
      
      setTimeout(() => {
        var newStatus = window.AutoReplyProcessor.getStatus();
        console.log('  启用后 enabled:', newStatus.enabled);
      }, 500);
    }
  }, 1000);
  
  // Step 4: 测试配置保存
  setTimeout(() => {
    console.log('\n💾 测试添加关键字并保存...');
    if (window.AutoReplyProcessor) {
      window.AutoReplyProcessor.addKeyword('test', 'reply');
      
      setTimeout(() => {
        var finalStatus = window.AutoReplyProcessor.getStatus();
        console.log('  最终 keywordsCount:', finalStatus.keywordsCount);
      }, 500);
    }
  }, 2000);
  
  console.log('\n========== 请查看详细日志 ==========\n');
})();
