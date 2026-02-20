/**
 * websocket-data-source.js - WebSocket 拦截数据源
 * 拦截闲鱼聊天 WebSocket 连接，捕获并转发聊天消息
 */

(function() {
  'use strict';

  var LOG_PREFIX = '[WS监听]';

  var WebSocketDataSource = {
    initialized: false,
    originalWebSocket: null,

    isTargetWebSocket: function(url) {
      return url && url.includes('wss-goofish.dingtalk.com');
    },

    sendChatMessage: function(chatResult) {
      // 已废弃，改为通过 EventBus 分发
      console.warn(LOG_PREFIX, 'sendChatMessage 已废弃，请使用 EventBus');
    },

    initialize: function() {
      if (this.initialized) return;
      this._hookWebSocket();
      this.initialized = true;
      console.log(LOG_PREFIX, 'WebSocket 数据源已初始化');
    },

    _hookWebSocket: function() {
      var self = this;
      var originalWebSocket = window.WebSocket;
      self.originalWebSocket = originalWebSocket;

      window.WebSocket = function(url, protocols) {
        var ws = new originalWebSocket(url, protocols);

        if (self.isTargetWebSocket(url)) {
          console.log(LOG_PREFIX, '检测到闲鱼聊天 WebSocket 连接');
          
          // 保存 WebSocket 引用供 chat-sender 使用
          if (window.XianyuSenderSetup && window.XianyuSenderSetup.setTargetWebSocket) {
            window.XianyuSenderSetup.setTargetWebSocket(ws);
          }

          var actualOnMessageHandler = null;
          Object.defineProperty(ws, 'onmessage', {
            get: function() { return actualOnMessageHandler; },
            set: function(handler) {
              actualOnMessageHandler = handler;
              var wrappedHandler = function(event) {
                var result = handler ? handler.call(this, event) : undefined;
                try {
                  if (typeof event.data === 'string') {
                    self._handleWebSocketMessage(event.data);
                  }
                } catch (error) {
                  console.error(LOG_PREFIX, '处理消息失败:', error);
                }
                return result;
              };
              Object.getOwnPropertyDescriptor(originalWebSocket.prototype, 'onmessage')
                .set.call(ws, wrappedHandler);
            },
            configurable: true
          });

          var originalAddEventListener = ws.addEventListener.bind(ws);
          originalAddEventListener('open', function() {
            console.log(LOG_PREFIX, 'WebSocket 连接已建立');
          });
          originalAddEventListener('close', function(event) {
            console.log(LOG_PREFIX, 'WebSocket 连接已关闭:', event.code);
          });
        }

        return ws;
      };

      window.WebSocket.prototype = originalWebSocket.prototype;
      window.WebSocket.CONNECTING = originalWebSocket.CONNECTING;
      window.WebSocket.OPEN = originalWebSocket.OPEN;
      window.WebSocket.CLOSING = originalWebSocket.CLOSING;
      window.WebSocket.CLOSED = originalWebSocket.CLOSED;
    },

    _handleWebSocketMessage: function(data) {
      // 过滤心跳消息和简单确认消息
      try {
        const parsed = JSON.parse(data);
        if (parsed.code === 200 && !parsed.body) {
          return;
        }
      } catch (e) {
        // 不是 JSON 格式，继续处理
      }
      
      if (!window.XianyuAPI || typeof window.XianyuAPI.handleWebSocketMessage !== 'function') {
        console.error(LOG_PREFIX, 'XianyuAPI 未加载');
        return;
      }

      // 调用 parser 解析，EventBus 会自动分发事件给业务处理器
      window.XianyuAPI.handleWebSocketMessage(data);
    }
  };

  window.WebSocketDataSource = WebSocketDataSource;

  // 自动初始化（必须在任何 WebSocket 创建之前）
  WebSocketDataSource.initialize();
})();
