/**
 * find-my-id.js - 查找当前用户真实 ID
 * 在闲鱼聊天页面控制台执行
 */

(function() {
  'use strict';
  
  console.log('\n========== 查找当前用户 ID ==========\n');
  
  var possibleIds = {};
  
  // 1. 从 URL 参数查找
  console.log('📋 检查 URL 参数...');
  var urlParams = new URLSearchParams(window.location.search);
  possibleIds.url_myId = urlParams.get('myId');
  possibleIds.url_userId = urlParams.get('userId');
  possibleIds.url_peerUserId = urlParams.get('peerUserId');
  console.log('   myId:', possibleIds.url_myId);
  console.log('   userId:', possibleIds.url_userId);
  console.log('   peerUserId:', possibleIds.url_peerUserId);
  
  // 2. 从 DOM 元素查找
  console.log('\n📋 检查 DOM 元素...');
  var selectors = [
    '[data-userid]',
    '[data-user-id]',
    '.avatar[data-id]',
    '.user-info[data-id]',
    '[class*="user"] [data-id]'
  ];
  
  selectors.forEach(function(selector) {
    try {
      var el = document.querySelector(selector);
      if (el && el.dataset.id) {
        console.log('   ✅', selector, '→', el.dataset.id);
        possibleIds.dom_selector = el.dataset.id;
      }
    } catch (e) {}
  });
  
  // 3. 从已存储的消息中推断
  console.log('\n📋 检查消息历史...');
  if (window.EventBus) {
    window.EventBus.on(window.ChatEventType.MESSAGE, function(context) {
      var msg = context.message;
      
      console.log('\n✅ 收到新消息:');
      console.log('   senderId:', msg.senderId);
      console.log('   receiverId:', msg.receiverId);
      console.log('   sessionId:', msg.sessionId);
      
      // 关键：receiverId 和 sessionId 不同，说明 receiverId 可能是真实用户 ID
      if (msg.receiverId !== msg.sessionId) {
        console.log('   💡 receiverId ≠ sessionId，receiverId 可能是真实用户 ID!');
        possibleIds.from_message_receiver = msg.receiverId;
      } else {
        console.log('   ⚠️ receiverId === sessionId，需要其他方式获取');
      }
      
      // 尝试从原始数据中提取
      if (context.raw && context.raw.body) {
        var raw = context.raw;
        if (raw.body.extension && raw.body.extension.peerUserId) {
          console.log('   📊 peerUserId from extension:', raw.body.extension.peerUserId);
          possibleIds.extension_peer = raw.body.extension.peerUserId;
        }
      }
      
      // 打印所有找到的可能 ID
      console.log('\n📊 所有可能的 ID:');
      Object.keys(possibleIds).forEach(function(key) {
        if (possibleIds[key]) {
          console.log('   -', key + ':', possibleIds[key]);
        }
      });
      
      // 找出出现频率最高的
      var idCounts = {};
      Object.values(possibleIds).forEach(function(id) {
        if (id) {
          idCounts[id] = (idCounts[id] || 0) + 1;
        }
      });
      
      var maxCount = 0;
      var mostLikelyId = null;
      Object.keys(idCounts).forEach(function(id) {
        if (idCounts[id] > maxCount) {
          maxCount = idCounts[id];
          mostLikelyId = id;
        }
      });
      
      if (mostLikelyId) {
        console.log('\n✅ 最可能的当前用户 ID:', mostLikelyId);
        console.log('   出现次数:', maxCount);
        
        // 保存到全局变量
        window.CURRENT_USER_ID = mostLikelyId;
        console.log('   💾 已保存到 window.CURRENT_USER_ID');
      }
    });
    
    console.log('⏳ 等待接收消息...（用另一个账号发一条消息）');
  }
  
  // 4. 从 localStorage 查找
  console.log('\n📋 检查 localStorage...');
  try {
    Object.keys(localStorage).forEach(function(key) {
      if (key.toLowerCase().includes('user') || key.toLowerCase().includes('id')) {
        try {
          var value = localStorage.getItem(key);
          if (value && /^\d+$/.test(value)) {
            console.log('   -', key + ':', value);
            possibleIds.localStorage = value;
          }
        } catch (e) {}
      }
    });
  } catch (e) {
    console.log('   ❌ 无法访问 localStorage');
  }
  
  console.log('\n================================\n');
})();
