// content.js - Content Script，消息中转
(function() {
  'use strict';

  console.log('[闲鱼采集] content.js 已加载');

  // 初始化消息总线（自动处理所有配置的通道）
  if (window.MessageBus && window.MessageBus.init) {
    window.MessageBus.init();
  } else {
    console.error('[闲鱼采集] ❌ MessageBus 未加载');
  }

  // ==================== 其他 content 功能 ====================

  // 监听爬取完成/停止事件（不需要转发给 background，只用于通知 popup）
  document.addEventListener('XIANYU_CRAWL_COMPLETED', function() {
    console.log('[闲鱼采集] 爬取已完成，通知 popup');
    chrome.runtime.sendMessage({ type: 'CRAWL_COMPLETED' });
  });

  document.addEventListener('XIANYU_CRAWL_STOPPED', function() {
    console.log('[闲鱼采集] 爬取已停止，通知 popup');
    chrome.runtime.sendMessage({ type: 'CRAWL_STOPPED' });
  });

  // 监听来自 popup 的扩展消息
  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    console.log('[闲鱼采集] Content收到消息:', request.type);

    if (request.type === 'START_AUTO_CRAWL') {
      console.log('[闲鱼采集] 收到自动爬取指令:', request);

      // 转发到页面上下文（通过 DOM 事件）
      document.dispatchEvent(new CustomEvent('XIANYU_START_AUTO_CRAWL', {
        detail: {
          keyword: request.keyword,
          startPage: request.startPage,
          pageCount: request.pageCount,
          delay: request.delay || 1500
        }
      }));

      console.log('[闲鱼采集] 已派发DOM事件 XIANYU_START_AUTO_CRAWL');
      sendResponse({ started: true });
      return true;
    }

    if (request.type === 'STOP_AUTO_CRAWL') {
      console.log('[闲鱼采集] 收到停止爬取指令');

      // 转发到页面上下文
      document.dispatchEvent(new CustomEvent('XIANYU_STOP_AUTO_CRAWL'));

      console.log('[闲鱼采集] 已派发DOM事件 XIANYU_STOP_AUTO_CRAWL');
      sendResponse({ stopped: true });
      return true;
    }

    return true;
  });

  console.log('[闲鱼采集] Content Script初始化完成');
})();
