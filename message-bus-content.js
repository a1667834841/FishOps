/**
 * MessageBus - 消息总线（ISOLATED world / Content Script 版本）
 * 监听 DOM 事件并转发给 background
 */

(function () {
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
    },
    {
      eventName: 'XIANYU_CRAWL_COMPLETED',
      messageType: 'FLUSH_PENDING_ITEMS',
      logPrefix: '[闲鱼采集-生命周期]'
    },
    {
      eventName: 'XIANYU_CRAWL_STOPPED',
      messageType: 'FLUSH_PENDING_ITEMS',
      logPrefix: '[闲鱼采集-生命周期]'
    }
  ];

  /**
   * 初始化消息转发
   * 自动为所有配置的通道设置监听和转发
   */
  function initMessageForward() {
    // 1. 监听 DOM 事件 (保持兼容)
    MESSAGE_CHANNELS.forEach(channel => {
      document.addEventListener(channel.eventName, function (event) {
        if (event.detail) {
          forwardToBackground(channel, event.detail, 'DOM事件');
        }
      });
    });

    // 2. 监听 window.postMessage (更可靠)
    window.addEventListener('message', function (event) {
      // 检查消息来源
      if (event.data && event.data.source === 'XIANYU_COLLECT_MAIN') {
        const { eventName, detail } = event.data;
        const channel = MESSAGE_CHANNELS.find(ch => ch.eventName === eventName);

        if (channel && detail) {
          forwardToBackground(channel, detail, 'postMessage');
        }
      }
    });
  }

  /**
   * 实际转发逻辑
   */
  function forwardToBackground(channel, data, source) {
    console.log(channel.logPrefix, `收到 ${source}: ${channel.eventName}`, data ? '详情有效' : '❌ 详情为空');

    if (!data) return;

    chrome.runtime.sendMessage({
      type: channel.messageType,
      data: data
    }, response => {
      if (chrome.runtime.lastError) {
        console.error(channel.logPrefix, '❌ 发送background失败:', chrome.runtime.lastError.message);
      } else {
        console.log(channel.logPrefix, `✅ 已转发到 background (${source}): ${channel.messageType}`, response);
      }
    });
  }

  // 导出给 content.js 使用
  window.MessageBus = {
    init: initMessageForward
  };

})();
