/**
 * message-bridge.js - 消息桥接器
 * 将 EventBus 的消息转发到 MessageBus（跨 world 通信）
 */

(function() {
  'use strict';

  var LOG_PREFIX = '[消息桥接]';

  function initMessageBridge() {
    if (!window.EventBus) {
      console.error(LOG_PREFIX, 'EventBus 未加载');
      return;
    }

    // 监听聊天消息事件，转发到 MessageBus
    window.EventBus.on(window.ChatEventType.MESSAGE, function(context) {
      if (window.MessageBus && window.MessageBus.send) {
        window.MessageBus.send('CHAT_MESSAGE', context.message);
      }
    });

    // 监听同步消息，批量转发到 MessageBus
    window.EventBus.on(window.ChatEventType.SYNC, function(context) {
      if (!window.MessageBus || !window.MessageBus.send) {
        return;
      }
      
      var messages = context.messages || [];
      messages.forEach(function(msg) {
        if (msg && msg.type === 'chat') {
          window.MessageBus.send('CHAT_MESSAGE', msg);
        }
      });
    });

    console.log(LOG_PREFIX, '✅ 消息桥接已初始化');
  }

  initMessageBridge();
})();

console.log('[MessageBridge] 消息桥接器已加载');
