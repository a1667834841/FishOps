/**
 * MessageBus - 消息总线（MAIN world 版本）
 * 用于在页面上下文（inject.js）中发送数据到 DOM 事件
 */

(function() {
  'use strict';

  // ==================== 配置区 ====================
  const MESSAGE_CHANNELS = [
    {
      eventName: 'XIANYU_API_DATA',
      messageType: 'API_DATA_CAPTURED',
      logPrefix: '[闲鱼采集-搜索]'
    },
    {
      eventName: 'XIANYU_DETAIL_DATA',
      messageType: 'DETAIL_DATA_CAPTURED',
      logPrefix: '[闲鱼采集-详情]'
    }
  ];

  /**
   * 发送数据到 background（通过 DOM 事件）
   * @param {string} eventName - 事件名称
   * @param {Object} data - 要发送的数据
   */
  function sendToBackground(eventName, data) {
    const channel = MESSAGE_CHANNELS.find(ch => ch.eventName === eventName);
    if (!channel) {
      console.error('[MessageBus-MAIN] 未知的通道名称:', eventName);
      return;
    }

    // 通过 DOM 事件发送
    const event = new CustomEvent(eventName, {
      detail: data
    });
    document.dispatchEvent(event);
  }

  // 导出给 inject.js 使用
  window.MessageBus = {
    send: sendToBackground
  };

})();
