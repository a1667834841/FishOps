/**
 * config.js - 聊天监听配置
 */

var CHAT_CONFIG = {
  maxStoredMessages: 1000
};

if (typeof window !== 'undefined') {
  window.CHAT_CONFIG = CHAT_CONFIG;
}

if (typeof self !== 'undefined') {
  self.CHAT_CONFIG = CHAT_CONFIG;
}
