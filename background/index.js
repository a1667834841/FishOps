/**
 * background/index.js - Service Worker
 * 接收聊天消息，去重后存储到 chrome.storage.local
 */

// 加载配置
try {
  importScripts('../shared/config.js');
} catch (e) {
  console.error('[Background] 配置加载失败:', e);
}

var chatConfig = (typeof CHAT_CONFIG !== 'undefined') ? CHAT_CONFIG : { maxStoredMessages: 1000 };

// 内存中的去重 Set（messageId）
var seenMessageIds = new Set();

// 启动时从 storage 恢复已有消息的 messageId
chrome.storage.local.get({ chatMessages: [] }, function(result) {
  var messages = result.chatMessages || [];
  messages.forEach(function(msg) {
    if (msg.messageId) {
      seenMessageIds.add(msg.messageId);
    }
  });
  console.log('[Background] 已恢复', seenMessageIds.size, '条消息ID用于去重');
});

// 监听消息
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  var handleMessage = async function() {
    try {
      // 获取自动回复配置
      if (request.type === 'GET_AUTO_REPLY_CONFIG') {
        console.log('[Background] 📥 收到配置请求');
        var result = await chrome.storage.local.get({ autoReplyConfig: defaultConfig });
        var config = result.autoReplyConfig || defaultConfig;
        console.log('[Background] 📚 读取配置:', config);
        sendResponse({ success: true, config: config });
        return;
      }

      // 更新自动回复配置
      if (request.type === 'UPDATE_AUTO_REPLY_CONFIG') {
        await chrome.storage.local.set({ autoReplyConfig: request.config });
        sendResponse({ success: true });
        return;
      }

      // 发送聊天消息
      if (request.type === 'SEND_CHAT_MESSAGE') {
        console.log('[Background] 📤 收到发送请求:', request.data);
        
        // TODO: 这里需要调用实际的闲鱼 API
        // 由于 Service Worker 无法直接访问页面 DOM，需要通过 tabs.sendMessage
        // 或者将请求转发回 content script 执行
        
        // 方式 1: 通过 tabs.sendMessage 发送到 content script
        if (sender.tab && sender.tab.id) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'SEND_MESSAGE_REQUEST',
            data: request.data
          }, function(response) {
            sendResponse(response);
          });
        } else {
          sendResponse({ 
            success: false, 
            error: '无法连接到 content script' 
          });
        }
        return;
      }

      // 聊天消息存储
      if (request.type === 'CHAT_MESSAGE') {
        var chatMsg = request.data;
        
        if (!chatMsg) {
          sendResponse({ success: false, error: '空消息' });
          return;
        }

        // messageId 去重
        if (chatMsg.messageId && seenMessageIds.has(chatMsg.messageId)) {
          sendResponse({ success: true, duplicate: true });
          return;
        }

        // 读取现有消息
        var result = await chrome.storage.local.get({ chatMessages: [], chatStats: {} });
        var messages = result.chatMessages || [];
        var stats = result.chatStats || { messageCount: 0, lastMessageTime: null };

        // 添加新消息
        messages.push(chatMsg);
        if (chatMsg.messageId) {
          seenMessageIds.add(chatMsg.messageId);
        }

        // 限制数组长度 (FIFO)
        var maxMessages = chatConfig.maxStoredMessages || 1000;
        if (messages.length > maxMessages) {
          var removed = messages.splice(0, messages.length - maxMessages);
          // 清理去重 Set 中被移除的消息 ID
          removed.forEach(function(msg) {
            if (msg.messageId) seenMessageIds.delete(msg.messageId);
          });
        }

        // 更新统计
        stats.messageCount = messages.length;
        stats.lastMessageTime = chatMsg.timestamp || new Date().toLocaleString();

        await chrome.storage.local.set({ chatMessages: messages, chatStats: stats });

        sendResponse({ success: true, messageCount: messages.length });
        return;
      }

      // 获取统计信息
      if (request.type === 'GET_CHAT_STATS') {
        var result = await chrome.storage.local.get({ chatStats: {} });
        sendResponse(result.chatStats || { messageCount: 0, lastMessageTime: null });
        return;
      }

      // 获取消息列表
      if (request.type === 'GET_CHAT_MESSAGES') {
        var result = await chrome.storage.local.get({ chatMessages: [] });
        var messages = result.chatMessages || [];
        var limit = request.limit || 10;
        var offset = request.offset || 0;

        // 返回最新的消息（倒序截取）
        var reversed = messages.slice().reverse();
        var sliced = reversed.slice(offset, offset + limit);

        sendResponse({
          messages: sliced,
          total: messages.length
        });
        return;
      }

      // 清空消息
      if (request.type === 'CLEAR_CHAT_MESSAGES') {
        seenMessageIds.clear();
        await chrome.storage.local.set({
          chatMessages: [],
          chatStats: { messageCount: 0, lastMessageTime: null }
        });
        sendResponse({ success: true });
        return;
      }

      // 获取配置
      if (request.type === 'GET_CHAT_CONFIG') {
        var result = await chrome.storage.local.get({ chatConfig: chatConfig });
        sendResponse({ success: true, config: result.chatConfig });
        return;
      }

      // 更新配置
      if (request.type === 'UPDATE_CHAT_CONFIG') {
        if (request.config) {
          chatConfig = Object.assign({}, chatConfig, request.config);
          await chrome.storage.local.set({ chatConfig: chatConfig });
          sendResponse({ success: true, config: chatConfig });
        } else {
          sendResponse({ success: false, error: '无效配置' });
        }
        return;
      }

      sendResponse({ success: false, error: '未知消息类型: ' + request.type });
    } catch (error) {
      console.error('[Background] 处理异常:', error);
      sendResponse({ success: false, error: error.message });
    }
  };

  handleMessage();
  return true;
});

console.log('[Background] 聊天消息存储服务已就绪');
