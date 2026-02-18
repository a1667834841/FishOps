/**
 * MessageBus - ISOLATED world 消息总线
 * 接收 MAIN world 的 postMessage，转发到 background service worker
 */

(function () {
  'use strict';

  var LOG_PREFIX = '[MessageBus:Isolated]';

  function initMessageForward() {
    window.addEventListener('message', function (event) {
      // 转发聊天消息到 background
      if (event.data && event.data.source === 'XIANYU_CHAT' && event.data.eventName === 'CHAT_MESSAGE') {
        var detail = event.data.detail;
        if (!detail) return;

        chrome.runtime.sendMessage({
          type: 'CHAT_MESSAGE',
          data: detail
        }, function(response) {
          if (chrome.runtime.lastError) {
            console.error(LOG_PREFIX, '转发失败:', chrome.runtime.lastError.message);
          }
        });
      }
      
      // 处理自动回复配置请求
      if (event.data && event.data.source === 'AUTO_REPLY_PROCESSOR' && event.data.type === 'GET_AUTO_REPLY_CONFIG') {
        var requestId = event.data.requestId;
        console.log('[MessageBus:Isolated] 📨 收到配置请求，requestId:', requestId);
                    
        chrome.runtime.sendMessage({
          type: 'GET_AUTO_REPLY_CONFIG'
        }, function(response) {
          console.log('[MessageBus:Isolated] 📥 收到 background 响应:', response);
          // 将响应发送回 MAIN world
          window.postMessage({
            source: 'AUTO_REPLY_CONFIG_RESPONSE',
            type: 'AUTO_REPLY_CONFIG_RESPONSE',
            requestId: requestId,
            detail: response
          }, '*');
          console.log('[MessageBus:Isolated] 📤 配置响应已发送到 MAIN world');
        });
      }
            
      // 处理自动回复配置更新请求
      if (event.data && event.data.source === 'AUTO_REPLY_PROCESSOR' && event.data.type === 'UPDATE_AUTO_REPLY_CONFIG') {
        var requestId = event.data.requestId;
        var config = event.data.config;
              
        chrome.runtime.sendMessage({
          type: 'UPDATE_AUTO_REPLY_CONFIG',
          config: config
        }, function(response) {
          // 通知 MAIN world 配置已更新
          window.postMessage({
            source: 'AUTO_REPLY_CONFIG_UPDATED',
            type: 'AUTO_REPLY_CONFIG_UPDATED',
            requestId: requestId,
            config: config
          }, '*');
        });
      }
    });

    console.log(LOG_PREFIX, '消息转发已初始化');
  }

  window.MessageBus = {
    init: initMessageForward
  };
})();
