/**
 * MessageBus - MAIN world 消息总线
 * 通过 postMessage 将聊天消息发送到 ISOLATED world
 */

(function () {
  'use strict';

  function sendToBackground(eventName, data) {
    window.postMessage({
      source: 'XIANYU_CHAT',
      eventName: eventName,
      detail: data
    }, '*');
  }

  window.MessageBus = {
    send: sendToBackground
  };

  console.log('[MessageBus-MAIN] 已初始化');
})();
