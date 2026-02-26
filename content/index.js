// content.js - Content Script 入口
(function () {
  'use strict';

  if (window.MessageBus && window.MessageBus.init) {
    window.MessageBus.init();
  } else {
    console.error('[闲鱼聊天监听] MessageBus 未加载');
  }

  console.log('[闲鱼聊天监听] Content Script 已初始化');

  var requests = {};
  var requestIndex = 0;

  // 监听来自 background 的同步请求
  chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.type === 'SYNC_CHAT_HISTORY_REQUEST') {
      var reqId = 'sync_' + (++requestIndex);
      requests[reqId] = sendResponse;

      // 转发给 MAIN world 的 chat-sync.js
      window.postMessage({
        source: 'XIANYU_UTILS',
        type: 'SYNC_CHAT_HISTORY',
        conversationCount: request.conversationCount || 50,
        messageCount: request.messageCount || 20,
        requestId: reqId
      }, '*');

      return true; // 保持连接以发送异步响应
    }
  });

  // 监听来自 MAIN world 的同步结果
  window.addEventListener('message', function (event) {
    if (event.data && event.data.source === 'CHAT_SYNC_PROCESSOR' && event.data.type === 'SYNC_CHAT_HISTORY_RESPONSE') {
      var reqId = event.data.requestId;
      if (requests[reqId]) {
        requests[reqId](event.data.result);
        delete requests[reqId];
      }
    }
  });
})();
