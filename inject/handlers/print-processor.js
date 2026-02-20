/**
 * print-processor.js - 打印消息业务处理器
 * 订阅聊天消息事件，格式化输出到控制台
 */

(function() {
  'use strict';

  var LOG_PREFIX = '[消息打印]';

  /**
   * 格式化并打印单条聊天消息
   * @param {object} context - 事件上下文
   */
  function printChatMessage(context) {
    var message = context.message;
    
    if (!message || !message.content) {
      return;
    }

    // 修复内容编码，防止乱码
    var content = message.content;
    if (typeof content === 'string') {
      try {
        // 尝试修复 UTF-8 编码问题
        var hasMojibake =
          /[\u00C0-\u00FF]{2,}/.test(content) ||
          /[\u00C2-\u00DF][\u0080-\u00BF]/.test(content) ||
          /[\u00E0-\u00EF][\u0080-\u00BF]{2}/.test(content);

        if (hasMojibake) {
          var bytes = [];
          for (let i = 0; i < content.length; i++) {
            bytes.push(content.charCodeAt(i) & 0xff);
          }
          content = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
        }
      } catch (error) {
        console.warn(LOG_PREFIX, '内容编码修复失败:', error);
        content = message.content;
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log(LOG_PREFIX + ' 📩 收到新消息');
    console.log('='.repeat(60));
    console.log(LOG_PREFIX + ' 👤 发送人:', message.senderName || '未知');
    console.log(LOG_PREFIX + ' 🆔 发送人 ID:', message.senderId);
    console.log(LOG_PREFIX + ' 💬 消息内容:', content);
    console.log(LOG_PREFIX + ' 🕐 发送时间:', message.timestamp);
    console.log(LOG_PREFIX + ' 🏷️  消息类型:', message.contentType);
    console.log(LOG_PREFIX + ' 🔗 会话 ID:', message.sessionId);
    console.log(LOG_PREFIX + ' 🛒 商品 ID:', message.itemId);
    console.log(LOG_PREFIX + ' 📱 平台:', message.platform);
    console.log(LOG_PREFIX + ' 🌐 IP:', message.clientIp);
    console.log('='.repeat(60) + '\n');
  }

  /**
   * 格式化并打印同步消息（批量）
   * @param {object} context - 事件上下文
   */
  function printSyncMessages(context) {
    var messages = context.messages;
    
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }

    // console.log('\n' + '='.repeat(60));
    // console.log(LOG_PREFIX + ' 📦 收到历史消息同步，共', messages.length, '条');
    // console.log('='.repeat(60));
    
    // messages.forEach(function(msg, index) {
    //   if (msg.type === 'chat') {
    //     console.log('\n[' + (index + 1) + '/' + messages.length + ']');
    //     console.log(LOG_PREFIX + ' 👤 发送人:', msg.senderName || '未知');
    //     console.log(LOG_PREFIX + ' 💬 内容:', msg.content);
    //     console.log(LOG_PREFIX + ' 🕐 时间:', msg.timestamp);
    //   }
    // });
    
    // console.log('\n' + '='.repeat(60) + '\n');
  }

  /**
   * 打印订单消息
   * @param {object} context - 事件上下文
   */
  function printOrderMessage(context) {
    var message = context.message;
    
    console.log(LOG_PREFIX + ' 🧾 订单消息：状态=' + message.orderStatus + ', 用户=' + message.userId);
  }

  /**
   * 打印正在输入状态
   * @param {object} context - 事件上下文
   */
  function printTypingStatus(context) {
    console.log(LOG_PREFIX + ' ⌨️  对方正在输入...');
  }

  /**
   * 打印系统消息
   * @param {object} context - 事件上下文
   */
  function printSystemMessage(context) {
    var message = context.message;
    console.log(LOG_PREFIX + ' 🔔 系统通知:', message.data);
  }

  /**
   * 初始化处理器，订阅所有相关事件
   */
  function initPrintProcessor() {
    if (!window.EventBus) {
      console.error(LOG_PREFIX, 'EventBus 未加载，无法初始化打印处理器');
      return;
    }

    // 订阅单条聊天消息
    window.EventBus.on(window.ChatEventType.MESSAGE, printChatMessage);
    console.log(LOG_PREFIX, '✅ 已订阅 MESSAGE 事件');

    // 订阅同步消息
    window.EventBus.on(window.ChatEventType.SYNC, printSyncMessages);
    console.log(LOG_PREFIX, '✅ 已订阅 SYNC 事件');

    // 订阅订单消息
    window.EventBus.on(window.ChatEventType.ORDER, printOrderMessage);
    console.log(LOG_PREFIX, '✅ 已订阅 ORDER 事件');

    // 订阅正在输入
    window.EventBus.on(window.ChatEventType.TYPING, printTypingStatus);
    console.log(LOG_PREFIX, '✅ 已订阅 TYPING 事件');

    // 订阅系统消息
    window.EventBus.on(window.ChatEventType.SYSTEM, printSystemMessage);
    console.log(LOG_PREFIX, '✅ 已订阅 SYSTEM 事件');

    console.log(LOG_PREFIX, '🚀 打印处理器已就绪');
  }

  // 自动初始化
  initPrintProcessor();
})();

console.log('[PrintProcessor] 打印消息处理器已加载');
