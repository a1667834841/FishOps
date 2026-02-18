/**
 * test-fix.js - 测试自动回复修复
 * 在闲鱼页面控制台执行此代码
 */

(function() {
  'use strict';
  
  console.log('\n========== 自动回复修复测试 ==========\n');
  
  // Step 1: 检查组件是否存在
  console.log('📋 检查组件...');
  console.log('  - XianyuSender:', !!window.XianyuSender);
  console.log('  - AutoReplyProcessor:', !!window.AutoReplyProcessor);
  console.log('  - EventBus:', !!window.EventBus);
  
  // Step 2: 检查 AutoReplyProcessor 状态
  if (window.AutoReplyProcessor) {
    console.log('\n📊 处理器状态:', window.AutoReplyProcessor.getStatus());
    
    // 尝试启用/禁用
    console.log('\n🔧 测试 API...');
    try {
      window.AutoReplyProcessor.disable();
      setTimeout(() => {
        window.AutoReplyProcessor.enable();
        console.log('✅ API 调用成功');
      }, 500);
    } catch (e) {
      console.error('❌ API 调用失败:', e);
    }
  }
  
  // Step 3: 测试配置加载
  console.log('\n⏳ 等待配置加载...');
  setTimeout(() => {
    if (window.AutoReplyProcessor) {
      var status = window.AutoReplyProcessor.getStatus();
      console.log('📝 当前配置:');
      console.log('  - 已启用:', status.enabled);
      console.log('  - 关键字数量:', status.keywordsCount);
      console.log('  - 已处理消息数:', status.processedCount);
    }
  }, 1000);
  
  // Step 4: 测试发送功能（可选）
  console.log('\n🚀 测试发送功能...');
  if (window.XianyuSender) {
    window.XianyuSender.sendTextMessage(
      '58263399670',
      '3004743608',
      '自动回复测试',
      '1020269847479'
    )
    .then(result => {
      console.log('\n✅ 发送测试结果:', result.success ? '成功' : '失败');
      if (result.data) {
        console.log('📊 响应数据:', result.data);
      }
    })
    .catch(error => {
      console.error('\n❌ 发送测试失败:', error);
    });
  } else {
    console.log('⏭️ 跳过发送测试（XianyuSender 未加载）');
  }
  
  console.log('\n========== 测试完成 ==========\n');
})();
