/**
 * event-bus.js - 事件总线核心模块
 * 提供事件订阅、发布功能，实现消息源与业务处理器的解耦
 */

(function() {
  'use strict';

  var EventBus = {
    _listeners: {},
    
    /**
     * 订阅事件
     * @param {string} eventType - 事件类型 (如：chat:message, chat:sync)
     * @param {function} handler - 事件处理函数，接收 context 参数
     * @returns {function} 取消订阅的函数
     */
    on: function(eventType, handler) {
      if (!this._listeners[eventType]) {
        this._listeners[eventType] = [];
      }
      this._listeners[eventType].push(handler);
      
      // 返回取消订阅函数
      var self = this;
      return function unsubscribe() {
        var index = self._listeners[eventType].indexOf(handler);
        if (index > -1) {
          self._listeners[eventType].splice(index, 1);
        }
      };
    },
    
    /**
     * 触发事件
     * @param {string} eventType - 事件类型
     * @param {object} context - 事件上下文（包含完整的消息信息）
     */
    emit: function(eventType, context) {
      if (!this._listeners[eventType]) {
        return;
      }
      
      var handlers = this._listeners[eventType];
      for (var i = 0; i < handlers.length; i++) {
        try {
          handlers[i](context);
        } catch (error) {
          console.error('[EventBus] 事件处理异常:', eventType, error);
        }
      }
    },
    
    /**
     * 移除事件监听器
     * @param {string} eventType - 事件类型
     */
    off: function(eventType) {
      delete this._listeners[eventType];
    },
    
    /**
     * 清空所有监听器
     */
    clear: function() {
      this._listeners = {};
    }
  };

  // 定义标准事件类型常量
  var ChatEventType = {
    MESSAGE: 'chat:message',     // 单条聊天消息
    SYNC: 'chat:sync',           // 消息同步（批量）
    ORDER: 'chat:order',         // 订单消息
    TYPING: 'chat:typing',       // 正在输入
    SYSTEM: 'chat:system',       // 系统通知
    UNKNOWN: 'chat:unknown'      // 未知类型
  };

  // 导出到全局
  window.EventBus = EventBus;
  window.ChatEventType = ChatEventType;
  
  console.log('[EventBus] 事件总线已初始化');
})();
