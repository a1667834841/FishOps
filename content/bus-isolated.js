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
        }, function (response) {
          if (chrome.runtime.lastError) {
            console.error(LOG_PREFIX, '转发失败:', chrome.runtime.lastError.message);
          }
        });
      }

      // ==================== 自动回复规则请求 ====================

      // 处理自动回复配置请求（兼容旧版）
      if (event.data && event.data.source === 'AUTO_REPLY_PROCESSOR' && event.data.type === 'GET_AUTO_REPLY_CONFIG') {
        var requestId = event.data.requestId;
        console.log(LOG_PREFIX, '📨 收到配置请求，requestId:', requestId);

        chrome.runtime.sendMessage({
          type: 'GET_AUTO_REPLY_CONFIG'
        }, function (response) {
          console.log(LOG_PREFIX, '📥 收到 background 响应:', response);
          window.postMessage({
            source: 'AUTO_REPLY_CONFIG_RESPONSE',
            type: 'AUTO_REPLY_CONFIG_RESPONSE',
            requestId: requestId,
            detail: response
          }, '*');
        });
      }

      // 处理自动回复配置更新请求（兼容旧版）
      if (event.data && event.data.source === 'AUTO_REPLY_PROCESSOR' && event.data.type === 'UPDATE_AUTO_REPLY_CONFIG') {
        var requestId = event.data.requestId;
        var config = event.data.config;

        chrome.runtime.sendMessage({
          type: 'UPDATE_AUTO_REPLY_CONFIG',
          config: config
        }, function (response) {
          window.postMessage({
            source: 'AUTO_REPLY_CONFIG_UPDATED',
            type: 'AUTO_REPLY_CONFIG_UPDATED',
            requestId: requestId,
            config: config
          }, '*');
        });
      }

      // 获取规则列表 + 全局配置
      if (event.data && event.data.source === 'AUTO_REPLY_PROCESSOR' && event.data.type === 'GET_AUTO_REPLY_RULES') {
        var requestId = event.data.requestId;
        console.log(LOG_PREFIX, '📨 收到规则列表请求');

        chrome.runtime.sendMessage({
          type: 'GET_AUTO_REPLY_RULES'
        }, function (response) {
          window.postMessage({
            source: 'AUTO_REPLY_PROCESSOR',
            type: 'GET_AUTO_REPLY_RULES_RESPONSE',
            requestId: requestId,
            detail: response
          }, '*');
        });
      }

      // AI 聊天补全请求
      if (event.data && event.data.source === 'AUTO_REPLY_PROCESSOR' && event.data.type === 'AI_CHAT_COMPLETION') {
        var requestId = event.data.requestId;
        console.log(LOG_PREFIX, '📨 收到 AI 补全请求');

        chrome.runtime.sendMessage({
          type: 'AI_CHAT_COMPLETION',
          messages: event.data.messages,
          aiConfig: event.data.aiConfig
        }, function (response) {
          window.postMessage({
            source: 'AUTO_REPLY_PROCESSOR',
            type: 'AI_CHAT_COMPLETION_RESPONSE',
            requestId: requestId,
            detail: response
          }, '*');
        });
      }
      
      // AI 暂停配置请求
      if (event.data && event.data.source === 'AUTO_REPLY_PROCESSOR' && event.data.type === 'GET_AI_PAUSE_CONFIG') {
        var requestId = event.data.requestId;
        chrome.runtime.sendMessage({
          type: 'GET_AI_PAUSE_CONFIG'
        }, function (response) {
          window.postMessage({
            source: 'AUTO_REPLY_PROCESSOR',
            type: 'GET_AI_PAUSE_CONFIG_RESPONSE',
            requestId: requestId,
            detail: response
          }, '*');
        });
      }
      
      // AI 暂停状态查询请求
      if (event.data && event.data.source === 'AUTO_REPLY_PROCESSOR' && event.data.type === 'GET_AI_PAUSE_STATUS') {
        var requestId = event.data.requestId;
        chrome.runtime.sendMessage({
          type: 'GET_AI_PAUSE_STATUS'
        }, function (response) {
          window.postMessage({
            source: 'AUTO_REPLY_PROCESSOR',
            type: 'GET_AI_PAUSE_STATUS_RESPONSE',
            requestId: requestId,
            detail: response
          }, '*');
        });
      }
      
      // 报告非 Web 端消息（触发 AI 暂停）
      if (event.data && event.data.source === 'AUTO_REPLY_PROCESSOR' && event.data.type === 'REPORT_NON_WEB_MESSAGE') {
        var requestId = event.data.requestId;
        console.log(LOG_PREFIX, '📨 收到非 Web 消息报告，requestId:', requestId);
        
        chrome.runtime.sendMessage({
          type: 'REPORT_NON_WEB_MESSAGE',
          platform: event.data.platform || 'unknown'
        }, function (response) {
          console.log(LOG_PREFIX, '📥 收到 Background 响应:', response);
          window.postMessage({
            source: 'AUTO_REPLY_PROCESSOR',
            type: 'REPORT_NON_WEB_MESSAGE_RESPONSE',
            requestId: requestId,
            detail: response
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
