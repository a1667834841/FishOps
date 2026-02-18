/**
 * auto-reply-processor.js - 自动回复处理器
 * 监听聊天消息，根据关键字自动回复
 */

(function() {
  'use strict';

  var LOG_PREFIX = '[自动回复]';

  // 默认配置
  var defaultConfig = {
    enabled: false, // 默认关闭
    keywords: [
      { trigger: '123', reply: '456' },
      { trigger: '你好', reply: '您好！有什么可以帮您？' },
      { trigger: '在吗', reply: '您好，请问有什么事吗？' }
    ],
    delay: 1000, // 回复延迟（毫秒）
    blacklist: [], // 黑名单用户 ID
    cooldown: 60000 // 同一用户冷却时间（毫秒）
  };

  // 运行时状态
  var runtime = {
    config: null,
    lastReplyTime: {}, // 记录每个用户的最后回复时间
    processedMessageIds: new Set() // 已处理的消息 ID
  };

  // 加载配置
  function loadConfig(callback) {
    // 在 MAIN world 中，通过 postMessage 发送到 ISOLATED world
    var requestId = 'config_' + Date.now();
    
    console.log(LOG_PREFIX, '📥 开始加载配置，requestId:', requestId);
    
    // 监听响应
    function onResponse(event) {
      if (event.data && event.data.type === 'AUTO_REPLY_CONFIG_RESPONSE' && 
          event.data.requestId === requestId) {
        window.removeEventListener('message', onResponse);
        
        var response = event.data.detail;
        console.log(LOG_PREFIX, '📨 收到配置响应:', response);
        
        if (response && response.success && response.config) {
          runtime.config = Object.assign({}, defaultConfig, response.config);
          console.log(LOG_PREFIX, '✅ 配置加载成功:', runtime.config);
        } else {
          runtime.config = defaultConfig;
          console.log(LOG_PREFIX, '⚠️ 使用默认配置:', runtime.config);
        }
        callback && callback(runtime.config);
      }
    }
    
    window.addEventListener('message', onResponse);
    
    // 发送请求到 ISOLATED world
    window.postMessage({
      source: 'AUTO_REPLY_PROCESSOR',
      type: 'GET_AUTO_REPLY_CONFIG',
      requestId: requestId
    }, '*');
    
    console.log(LOG_PREFIX, '📤 配置请求已发送');
  }

  // 检查是否应该回复
  function shouldReply(message) {
    // 1. 检查是否启用
    // if (!runtime.config.enabled) {
    //   console.log(LOG_PREFIX, '⏸️ 自动回复未启用');
    //   return false;
    // }

    // 2. 检查是否是自己的消息（避免循环回复）
    if (message.direction === 'out') {
      console.log(LOG_PREFIX, '⏭️ 跳过自己发送的消息');
      return false;
    }

    // 3. 检查是否在黑名单
    if (runtime.config.blacklist.includes(message.senderId)) {
      console.log(LOG_PREFIX, '⏭️ 用户在黑名单中:', message.senderId);
      return false;
    }

    // 4. 检查是否已处理过该消息
    if (runtime.processedMessageIds.has(message.messageId)) {
      console.log(LOG_PREFIX, '⏭️ 消息已处理过:', message.messageId);
      return false;
    }

    // 5. 检查冷却时间
    var now = Date.now();
    var lastTime = runtime.lastReplyTime[message.senderId] || 0;
    if (now - lastTime < runtime.config.cooldown) {
      console.log(LOG_PREFIX, '⏭️ 冷却时间内，跳过');
      return false;
    }

    return true;
  }

  // 查找匹配的关键字
  function findMatchingKeyword(content) {
    if (!content || typeof content !== 'string') {
      return null;
    }

    for (var i = 0; i < runtime.config.keywords.length; i++) {
      var keyword = runtime.config.keywords[i];
      if (content.includes(keyword.trigger)) {
        return keyword;
      }
    }

    return null;
  }

  // 发送回复消息
  function sendReply(message, replyContent) {
    console.log(LOG_PREFIX, '📤 准备发送回复:', replyContent);

    // 标记为已处理
    runtime.processedMessageIds.add(message.messageId);

    // 更新最后回复时间
    runtime.lastReplyTime[message.senderId] = Date.now();

    // 清理旧的已处理消息 ID（保留最近 100 条）
    if (runtime.processedMessageIds.size > 100) {
      var arr = Array.from(runtime.processedMessageIds);
      arr.slice(0, arr.length - 100).forEach(id => {
        runtime.processedMessageIds.delete(id);
      });
    }

    // 构建回复消息数据
    var replyData = {
      sessionId: message.sessionId,
      toUserId: message.senderId,     // 回复给发送者（对方）
      myId: message.receiverId,       // 当前用户 ID（自己）
      itemId: message.itemId,
      content: replyContent,
      contentType: 101 // 文本消息
    };

    console.log(LOG_PREFIX, '📝 回复数据:', replyData);

    // 使用 XianyuSender 发送消息
    if (window.XianyuSender && window.XianyuSender.sendTextMessage) {
      window.XianyuSender.sendTextMessage(
        replyData.sessionId,
        replyData.toUserId,
        replyData.content,
        replyData.itemId,
        replyData.myId
      )
      .then(function(result) {
        if (result && result.success) {
          console.log(LOG_PREFIX, '✅ 回复成功');
        } else {
          console.error(LOG_PREFIX, '❌ 回复失败:', result);
        }
      })
      .catch(function(error) {
        console.error(LOG_PREFIX, '❌ 回复异常:', error);
      });
    } else {
      console.error(LOG_PREFIX, '❌ XianyuSender 未加载');
      
      // 降级方案：通过 background 转发
      chrome.runtime.sendMessage({
        type: 'SEND_CHAT_MESSAGE',
        data: replyData
      }, function(response) {
        if (response && response.success) {
          console.log(LOG_PREFIX, '✅ 回复成功（通过 background）');
        } else {
          console.error(LOG_PREFIX, '❌ 回复失败:', response);
        }
      });
    }
  }

  // 处理聊天消息事件
  function handleChatMessage(context) {
    var message = context.message;

    console.log(LOG_PREFIX, '🔍 收到消息，检查是否需要回复...');
    console.log(LOG_PREFIX, '发送人:', message.senderName, '(' + message.senderId + ')');
    console.log(LOG_PREFIX, '内容:', message.content);

    // 检查是否应该回复
    if (!shouldReply(message)) {
      return;
    }

    // 查找匹配的关键字
    var matched = findMatchingKeyword(message.content);
    if (!matched) {
      console.log(LOG_PREFIX, '⏭️ 无匹配关键字');
      return;
    }

    console.log(LOG_PREFIX, '✅ 匹配到关键字:', matched.trigger, '->', matched.reply);

    // 延迟发送回复
    setTimeout(function() {
      sendReply(message, matched.reply);
    }, runtime.config.delay);
  }

  // 初始化
  function init() {
    if (!window.EventBus) {
      console.error(LOG_PREFIX, '❌ EventBus 未加载');
      return;
    }

    // 加载 UserAPI（如果可用）
    if (window.UserAPI) {
      window.UserAPI.init().then(function(result) {
        if (result.success) {
          console.log(LOG_PREFIX, '✅ 用户 ID 已缓存:', result.userId);
        }
      });
    }

    // 加载配置
    loadConfig(function(config) {
      console.log(LOG_PREFIX, '✅ 已加载配置:', config);

      // 订阅聊天消息事件
      window.EventBus.on(window.ChatEventType.MESSAGE, handleChatMessage);

      console.log(LOG_PREFIX, '🚀 自动回复处理器已启动');
    });
  }

  // 导出 API（供外部调用）
  window.AutoReplyProcessor = {
    enable: function() {
      runtime.config.enabled = true;
      console.log(LOG_PREFIX, '✅ 自动回复已启用');
      saveConfig();
    },
    disable: function() {
      runtime.config.enabled = false;
      console.log(LOG_PREFIX, '⏸️ 自动回复已禁用');
      saveConfig();
    },
    addKeyword: function(trigger, reply) {
      if (!runtime.config.keywords) {
        runtime.config.keywords = [];
      }
      runtime.config.keywords.push({ trigger: trigger, reply: reply });
      console.log(LOG_PREFIX, '➕ 添加关键字:', trigger, '->', reply);
      saveConfig();
    },
    removeKeyword: function(trigger) {
      if (!runtime.config.keywords) return;
      runtime.config.keywords = runtime.config.keywords.filter(k => k.trigger !== trigger);
      console.log(LOG_PREFIX, '➖ 移除关键字:', trigger);
      saveConfig();
    },
    addBlacklist: function(userId) {
      if (!runtime.config.blacklist) {
        runtime.config.blacklist = [];
      }
      runtime.config.blacklist.push(userId);
      console.log(LOG_PREFIX, '➕ 加入黑名单:', userId);
      saveConfig();
    },
    getStatus: function() {
      return {
        enabled: runtime.config ? runtime.config.enabled : false,
        keywordsCount: runtime.config ? runtime.config.keywords.length : 0,
        processedCount: runtime.processedMessageIds.size
      };
    }
  };

  // 保存配置到 storage
  function saveConfig() {
    var requestId = 'save_' + Date.now();
    
    window.postMessage({
      source: 'AUTO_REPLY_PROCESSOR',
      type: 'UPDATE_AUTO_REPLY_CONFIG',
      requestId: requestId,
      config: runtime.config
    }, '*');
    
    console.log(LOG_PREFIX, '💾 配置已保存');
  }
  
  // 监听配置更新
  window.addEventListener('message', function(event) {
    if (event.data && event.data.source === 'AUTO_REPLY_CONFIG_UPDATED') {
      runtime.config = Object.assign({}, defaultConfig, event.data.config);
      console.log(LOG_PREFIX, '🔄 配置已更新');
    }
  });

  // 启动
  init();

  console.log('[AutoReplyProcessor] 自动回复处理器已加载');
})();
