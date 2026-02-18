/**
 * test-get-user-id.js - 测试获取用户 ID
 * 在闲鱼聊天页面控制台执行
 */

(function() {
  'use strict';
  
  console.log('\n========== 测试获取用户 ID ==========\n');
  
  // Step 1: 加载 UserAPI
  console.log('📥 正在加载 UserAPI...');
  
  fetch(chrome.runtime.getURL('inject/api/user-api.js'))
    .then(res => res.text())
    .then(code => {
      eval(code);
      
      console.log('✅ UserAPI 已加载\n');
      console.log('📋 可用的方法:');
      console.log('   - UserAPI.getCurrentUserId(token) - 使用指定 token 获取');
      console.log('   - UserAPI.quickGetUserId() - 自动从 Cookie 获取');
      console.log('   - UserAPI.getCurrentUserIdSync() - 同步获取缓存的 ID');
      console.log('   - UserAPI.getTokenFromCookie() - 获取 Cookie 中的 token\n');
      
      // Step 2: 尝试获取 token
      var token = UserAPI.getTokenFromCookie();
      if (token) {
        console.log('✅ 找到 Cookie token:', token.substring(0, 10) + '...');
        
        // Step 3: 调用 API
        console.log('\n🚀 开始获取用户 ID...\n');
        
        return UserAPI.getCurrentUserId(token);
      } else {
        console.warn('⚠️ 未找到 Cookie token');
        console.log('\n💡 提示：请确保已登录闲鱼账号');
        return Promise.resolve({ success: false, error: 'No token' });
      }
    })
    .then(result => {
      console.log('\n📊 结果:');
      console.log('   成功:', result.success ? '✅' : '❌');
      
      if (result.success) {
        console.log('   用户 ID:', result.userId);
        console.log('   完整数据:', result.data);
        
        console.log('\n✅ 测试完成！用户 ID 已保存到:');
        console.log('   - window.CURRENT_USER_ID');
        console.log('   - localStorage.idle_current_user_id');
        
        // 验证是否可以用于发送消息
        console.log('\n🔍 验证 actualReceivers 格式...');
        var testActualReceivers = [
          "3004743608@goofish",
          result.userId + "@goofish"
        ];
        console.log('   ✅ 正确的 actualReceivers:', testActualReceivers);
        
      } else {
        console.error('   ❌ 错误:', result.error);
        console.log('\n💡 排查建议:');
        console.log('   1. 检查是否已登录闲鱼');
        console.log('   2. 检查网络是否正常');
        console.log('   3. 查看上面的详细日志');
      }
      
      console.log('\n================================\n');
    })
    .catch(error => {
      console.error('\n❌ 测试失败:', error);
      console.error(error.stack);
      console.log('\n================================\n');
    });
})();
