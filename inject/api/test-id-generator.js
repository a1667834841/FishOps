/**
 * test-id-generator.js - 测试 MID 和 UUID 生成算法
 * 在闲鱼页面控制台执行
 */

(function() {
  'use strict';
  
  console.log('\n========== ID 生成算法测试 ==========\n');
  
  // 检查是否已加载
  if (!window.XianyuSender) {
    console.error('❌ XianyuSender 未加载');
    return;
  }
  
  console.log('📋 测试 generateMid...');
  for (var i = 0; i < 5; i++) {
    var mid = window.XianyuSender.generateMid();
    console.log('  MID #' + (i + 1) + ':', mid);
    
    // 验证格式：{数字}{时间戳} 0
    var midPattern = /^\d+ 0$/;
    if (!midPattern.test(mid)) {
      console.error('  ❌ MID 格式错误:', mid);
    } else {
      console.log('  ✅ MID 格式正确');
    }
  }
  
  console.log('\n📋 测试 generateUuid...');
  for (var j = 0; j < 5; j++) {
    var uuid = window.XianyuSender.generateUuid();
    console.log('  UUID #' + (j + 1) + ':', uuid);
    
    // 验证格式：8-4-4-4-12
    var uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!uuidPattern.test(uuid)) {
      console.error('  ❌ UUID 格式错误:', uuid);
    } else {
      console.log('  ✅ UUID 格式正确');
    }
  }
  
  console.log('\n📊 统计信息:');
  console.log('  - MID 长度范围:', '约 17-20 字符');
  console.log('  - UUID 长度:', 36, '字符');
  console.log('  - UUID 版本：自定义随机版');
  
  console.log('\n========== 测试完成 ==========\n');
})();
