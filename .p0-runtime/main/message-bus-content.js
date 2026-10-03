/**
 * MessageBus - 消息总线（ISOLATED world / Content Script 版本）
 * 监听 DOM 事件并转发给 background
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
   * 初始化消息转发
   * 自动为所有配置的通道设置监听和转发
   */
  function initMessageForward() {
    MESSAGE_CHANNELS.forEach(channel => {
      // 监听 DOM 事件
      document.addEventListener(channel.eventName, function(event) {
        const apiData = event.detail;

        if (!apiData) {
          console.error(channel.logPrefix, '❌ event.detail 为空，无法转发');
          return;
        }

        // 转发给 background
        chrome.runtime.sendMessage({
          type: channel.messageType,
          data: apiData
        }, response => {
          if (chrome.runtime.lastError) {
            console.error(channel.logPrefix, '❌ 发送background失败:', chrome.runtime.lastError.message);
          }
        });
      });
    });
  }

  // 导出给 content.js 使用
  window.MessageBus = {
    init: initMessageForward
  };

})();
