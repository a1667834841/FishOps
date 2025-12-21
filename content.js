// content.js - Content Script，负责与background通信
(function() {
  'use strict';

  console.log('[闲鱼采集-INFO] content.js 已加载，等待inject.js启动...');

  // 监听来自inject.js的自定义事件
  document.addEventListener('XIANYU_API_DATA', function(event) {
    const apiData = event.detail;
    
    console.log('[闲鱼采集] ========== Content Script收到数据 ==========');

    // 转发给background script
    console.log('[闲鱼采集] 正在发送消息到background...');
    chrome.runtime.sendMessage({
      type: 'API_DATA_CAPTURED',
      data: apiData
    }, response => {
      if (chrome.runtime.lastError) {
        console.error('[闲鱼采集] 发送消息到background失败:', chrome.runtime.lastError.message);
      } else {
        console.log('[闲鱼采集] 数据已发送到background script, 响应:', response);
      }
    });
  });

  console.log('[闲鱼采集] Content Script初始化完成，等待API请求...');

  // 监听爬取完成/停止事件
  document.addEventListener('XIANYU_CRAWL_COMPLETED', function() {
    console.log('[闲鱼采集] 爬取已完成，通知 popup');
    chrome.runtime.sendMessage({ type: 'CRAWL_COMPLETED' });
  });
  
  document.addEventListener('XIANYU_CRAWL_STOPPED', function() {
    console.log('[闲鱼采集] 爬取已停止，通知 popup');
    chrome.runtime.sendMessage({ type: 'CRAWL_STOPPED' });
  });

  // 监听来自popup的扩展消息
  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    console.log('[闲鱼采集] Content收到消息:', request.type);

    if (request.type === 'START_AUTO_CRAWL') {
      console.log('[闲鱼采集] 收到自动爬取指令:', request);
      
      // 转发到页面上下文（通过DOM事件）
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
})();
