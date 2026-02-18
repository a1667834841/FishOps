// content.js - Content Script 入口
(function() {
  'use strict';

  if (window.MessageBus && window.MessageBus.init) {
    window.MessageBus.init();
  } else {
    console.error('[闲鱼聊天监听] MessageBus 未加载');
  }

  console.log('[闲鱼聊天监听] Content Script 已初始化');
})();
