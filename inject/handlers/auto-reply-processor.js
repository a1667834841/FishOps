/**
 * auto-reply-processor.js - 自动回复处理器 (v3.0 - 规则引擎)
 * 支持：关键词正则匹配回复 + AI 读取聊天记录回复
 * 支持：商品 ID 绑定、优先级、提示词
 */

(function () {
  'use strict';

  var LOG_PREFIX = '[自动回复]';

  // ==================== 运行时状态 ====================

  var runtime = {
    globalConfig: null,
    rules: [],
    lastReplyTime: {},         // { cooldownKey: timestamp }
    processedMessageIds: new Set(),
    recentReplySessions: {},   // { sessionId: timestamp } 防止 AI 回复循环
    configLoaded: false,
    aiPauseState: {
      isPaused: false,
      pausedUntil: 0
    }
  };

  // ==================== 跨 world 通信 ====================

  /**
   * 发送请求到 background (通过 bus-isolated)
   * @param {string} type - 请求类型
   * @param {Object} extra - 额外参数
   * @returns {Promise<Object>} 响应
   */
  function sendRequest(type, extra) {
    return new Promise(function (resolve) {
      var requestId = type + '_' + Date.now() + '_' + Math.random();

      var responseType = type + '_RESPONSE';

      function onResponse(event) {
        if (event.data &&
          event.data.source === 'AUTO_REPLY_PROCESSOR' &&
          event.data.type === responseType &&
          event.data.requestId === requestId) {
          window.removeEventListener('message', onResponse);
          resolve(event.data.detail);
        }
      }

      window.addEventListener('message', onResponse);

      var message = Object.assign({
        source: 'AUTO_REPLY_PROCESSOR',
        type: type,
        requestId: requestId
      }, extra || {});

      window.postMessage(message, '*');

      // 超时保护
      setTimeout(function () {
        window.removeEventListener('message', onResponse);
        resolve({ success: false, error: '请求超时' });
      }, 30000);
    });
  }

  // ==================== 配置加载 ====================

  function loadRulesAndConfig() {
    return sendRequest('GET_AUTO_REPLY_RULES').then(function (response) {
      if (response && response.success) {
        runtime.rules = response.rules || [];
        runtime.globalConfig = response.globalConfig || {};
        runtime.configLoaded = true;
        console.log(LOG_PREFIX, '✅ 已加载', runtime.rules.length, '条规则');
      } else {
        runtime.rules = [];
        runtime.globalConfig = { enabled: false };
        runtime.configLoaded = true;
        console.log(LOG_PREFIX, '⚠️ 使用默认配置');
      }
    });
  }

  // ==================== 正则匹配 ====================

  /**
   * 安全编译正则表达式
   * @param {string} pattern - 正则表达式字符串
   * @returns {RegExp|null}
   */
  function safeCompileRegex(pattern) {
    if (!pattern || typeof pattern !== 'string') return null;
    try {
      return new RegExp(pattern, 'i');
    } catch (e) {
      console.warn(LOG_PREFIX, '⚠️ 正则编译失败:', pattern, e.message);
      return null;
    }
  }

  /**
   * 测试内容是否匹配正则
   * @param {string} content - 消息内容
   * @param {string} pattern - 正则表达式字符串
   * @returns {boolean}
   */
  function testRegexMatch(content, pattern) {
    var regex = safeCompileRegex(pattern);
    if (!regex) return false;
    try {
      return regex.test(content);
    } catch (e) {
      console.warn(LOG_PREFIX, '⚠️ 正则执行异常:', e.message);
      return false;
    }
  }

  // ==================== 规则匹配引擎 ====================

  /**
   * 检查消息是否应该被处理
   */
  function shouldProcess(message) {
    // 1. 检查总开关
    if (!runtime.globalConfig || !runtime.globalConfig.enabled) {
      return false;
    }
  
    // 1.5 检查 AI 暂停状态（核心：检测非 Web 端人工回复）
    if (runtime.aiPauseState.isPaused && Date.now() < runtime.aiPauseState.pausedUntil) {
      var remainingSeconds = Math.ceil((runtime.aiPauseState.pausedUntil - Date.now()) / 1000);
      console.log(LOG_PREFIX, '⏸️ AI 暂停中，跳过处理，剩余:', remainingSeconds, '秒');
      return false;
    } else if (runtime.aiPauseState.isPaused) {
      // 暂停时间已过，自动恢复
      runtime.aiPauseState.isPaused = false;
      runtime.aiPauseState.pausedUntil = 0;
      console.log(LOG_PREFIX, '✅ AI 暂停结束，已恢复');
    }
  
    // 2. 核心：跳过自己发的消息（senderId === myId 说明是自己发的）
    var myId = window.CURRENT_USER_ID || '';
    if (myId && message.senderId === myId) {
      return false;
    }
  
    // 3. direction 检查（双重保险）
    if (message.direction === 'out') {
      return false;
    }
  
    // 3. 黑名单
    var blacklist = runtime.globalConfig.blacklist || [];
    if (blacklist.indexOf(message.senderId) !== -1) {
      console.log(LOG_PREFIX, '⏭️ 用户在黑名单:', message.senderId);
      return false;
    }
  
    // 4. 已处理过的消息
    if (message.messageId && runtime.processedMessageIds.has(message.messageId)) {
      return false;
    }
  
    // 5. 会话级防重：最近刚回复过这个会话（防止 AI 回复循环）
    var sessionId = message.sessionId || '';
    if (sessionId && runtime.recentReplySessions[sessionId]) {
      var elapsed = Date.now() - runtime.recentReplySessions[sessionId];
      var cooldown = runtime.globalConfig.defaultCooldown || 60000;
      if (elapsed < cooldown) {
        console.log(LOG_PREFIX, '⏭️ 会话冷却中，剩余:', Math.ceil((cooldown - elapsed) / 1000), '秒');
        return false;
      }
      delete runtime.recentReplySessions[sessionId];
    }
  
    return true;
  }

  /**
   * 检查规则是否适用于此消息
   */
  function isRuleApplicable(rule, message) {
    // 1. 规则必须启用
    if (!rule.enabled) return false;

    // 2. 检查商品 ID 绑定
    if (rule.itemIds && rule.itemIds.length > 0) {
      if (!message.itemId || rule.itemIds.indexOf(message.itemId) === -1) {
        return false;
      }
    }

    // 3. 检查冷却时间
    var cooldown = rule.cooldown || runtime.globalConfig.defaultCooldown || 60000;
    var now = Date.now();
    var cooldownKey = message.senderId + '_' + rule.id;
    var lastTime = runtime.lastReplyTime[cooldownKey] || 0;
    if (now - lastTime < cooldown) {
      console.log(LOG_PREFIX, '⏭️ 冷却时间内, 规则:', rule.name);
      return false;
    }

    return true;
  }

  /**
   * 按优先级降序排列并逐条匹配规则
   * @param {Object} message - 聊天消息
   * @returns {Object|null} 匹配到的规则
   */
  function findMatchingRule(message) {
    // 按优先级降序
    var sorted = runtime.rules.slice().sort(function (a, b) {
      return (b.priority || 0) - (a.priority || 0);
    });

    for (var i = 0; i < sorted.length; i++) {
      var rule = sorted[i];

      if (!isRuleApplicable(rule, message)) continue;

      if (rule.type === 'keyword') {
        // 关键词正则匹配
        if (testRegexMatch(message.content, rule.pattern)) {
          console.log(LOG_PREFIX, '✅ 命中关键词规则:', rule.name, '|', rule.pattern);
          return rule;
        }
      } else if (rule.type === 'ai') {
        // AI 规则：无需关键词匹配条件，有消息就触发
        console.log(LOG_PREFIX, '✅ 命中 AI 规则:', rule.name);
        return rule;
      }
    }

    return null;
  }

  // ==================== 回复发送 ====================

  /**
   * 标记消息为已处理
   */
  function markProcessed(message, rule) {
    if (message.messageId) {
      runtime.processedMessageIds.add(message.messageId);
    }

    var cooldownKey = message.senderId + '_' + rule.id;
    runtime.lastReplyTime[cooldownKey] = Date.now();

    // 标记会话级冷却（防止 AI 回复循环）
    if (message.sessionId) {
      runtime.recentReplySessions[message.sessionId] = Date.now();
    }

    // 清理旧记录
    if (runtime.processedMessageIds.size > 200) {
      var arr = Array.from(runtime.processedMessageIds);
      arr.slice(0, arr.length - 200).forEach(function (id) {
        runtime.processedMessageIds.delete(id);
      });
    }
  }

  /**
   * 发送回复消息
   */
  function sendReply(message, content) {
    console.log(LOG_PREFIX, '📤 发送回复:', content.substring(0, 50) + (content.length > 50 ? '...' : ''));

    var replyData = {
      sessionId: message.sessionId,
      toUserId: message.senderId,
      myId: message.receiverId,
      itemId: message.itemId,
      content: content,
      contentType: 101
    };

    if (window.XianyuSender && window.XianyuSender.sendTextMessage) {
      window.XianyuSender.sendTextMessage(
        replyData.sessionId,
        replyData.toUserId,
        replyData.content,
        replyData.itemId,
        replyData.myId
      )
        .then(function (result) {
          if (result && result.success) {
            console.log(LOG_PREFIX, '✅ 回复成功');
          } else {
            console.error(LOG_PREFIX, '❌ 回复失败:', result);
          }
        })
        .catch(function (error) {
          console.error(LOG_PREFIX, '❌ 回复异常:', error);
        });
    } else {
      console.error(LOG_PREFIX, '❌ XianyuSender 未加载');
    }
  }

  // ==================== 关键词回复处理 ====================

  function handleKeywordReply(message, rule) {
    var delay = rule.delay || runtime.globalConfig.defaultDelay || 1000;

    markProcessed(message, rule);

    setTimeout(function () {
      sendReply(message, rule.reply);
    }, delay);
  }

  // ==================== AI 回复处理 ====================

  /**
   * 构建用于 AI 请求的 messages 数组
   * 格式参照阿里云 DashScope API: https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
   *
   * @param {Object} params - 参数对象
   * @param {Array} params.historyMessages - 历史消息数组
   * @param {Object} params.currentMessage - 当前消息对象
   * @param {string} params.basePrompt - 基础系统提示词
   * @param {Object} params.goodsDetail - 商品详情（可选）
   * @returns {Array} 构建好的 messages 数组
   */
  function buildMessages(params) {
    var historyMessages = params.historyMessages || [];
    var currentMessage = params.currentMessage;
    var basePrompt = params.basePrompt || '你是一个闲鱼卖家的客服助手，请根据聊天记录和用户的最新消息进行回复。回复要简洁、友好、专业。不要用markdown格式。用中文回答。';
    var goodsDetail = params.goodsDetail;

    // 构建 system prompt（注入商品信息）
    var systemPrompt = basePrompt;

    // 如果有商品详情，注入到 prompt 中
    if (goodsDetail) {
      var goodsInfo = '\n\n【当前咨询商品】\n' +
        '商品名称：' + goodsDetail.title + '\n' +
        '**商品价格**：' + (goodsDetail.skuList && goodsDetail.skuList.length > 0 ? goodsDetail.skuList.map(function(s) { return (s.propertyText || '规格') + ': ' + '价格：'+(s.price + '元' || '未设置'); }).join('、') : (goodsDetail.price + '元'  || '未设置')) + '\n' +
        '商品描述：' + (goodsDetail.description || '无详细描述') + '\n' +
        '商品所在地：' + (goodsDetail.city || '未设置') + '\n' +
        '请根据以上商品信息，严格以商品价格为准，专业地回答用户关于该商品的问题。';

      systemPrompt += goodsInfo;
      console.log(LOG_PREFIX, '📝 已注入商品信息到 prompt');
    }

    // 判断内容是否为图片 URL
    function isImageUrl(str) {
      if (!str || typeof str !== 'string') return false;
      // 检测常见图片扩展名（包括 iPhone 的 .heic 格式）
      if (/^https?:\/\/.+\.(jpg|jpeg|png|gif|webp|bmp|heic|heif)/i.test(str)) return true;
      // 检测阿里云图片 CDN 域名
      if (/^https?:\/\/(img\.alicdn\.com|gw\.alicdn\.com|ossgw\.alicdn\.com)/i.test(str)) return true;
      return false;
    }

    // 从消息对象中提取图片 URL
    function extractImageUrl(msg) {
      // 1. 优先使用已解析的 imageUrl 字段
      if (msg.imageUrl) return msg.imageUrl;
      
      // 2. 尝试从 content 解析 JSON 格式（历史消息可能未解析）
      if (msg.content && typeof msg.content === 'string') {
        try {
          var parsed = JSON.parse(msg.content);
          // 格式: {image: {pics: [{url: "..."}]}}
          if (parsed.image && parsed.image.pics && parsed.image.pics.length > 0) {
            return parsed.image.pics[0].url;
          }
          // 备用格式
          if (parsed.url) return parsed.url;
          if (parsed.imgUrl) return parsed.imgUrl;
          if (parsed.imageUrl) return parsed.imageUrl;
        } catch (e) {
          // 解析失败，检测 content 本身是否为图片 URL
          if (isImageUrl(msg.content)) return msg.content;
        }
      }
      
      // 3. 检测 content 本身是否为图片 URL
      if (isImageUrl(msg.content)) return msg.content;
      
      return null;
    }

    // 转换单条消息为 OpenAI/DashScope 格式
    function convertMessageToOpenAIFormat(msg) {
      if (!msg || (!msg.content && !msg.imageUrl)) return null;

      var role = (msg.direction === 'out') ? 'assistant' : 'user';
      
      // 提取图片 URL
      var imgUrl = extractImageUrl(msg);
      
      // 判断是否为图片消息
      var isImage = (msg.contentType === 2) || !!imgUrl;

      // 图片消息：使用多模态格式（图片在前，文字在后）
      if (isImage && imgUrl) {
        return {
          role: role,
          content: [
            { type: 'image_url', image_url: { url: imgUrl } },
            { type: 'text', text: '结合这张图片，回答问题' }
          ]
        };
      }

      // 普通文本消息
      return {
        role: role,
        content: msg.content
      };
    }

    // 转换当前消息为 OpenAI/DashScope 格式
    function convertCurrentMessageToOpenAIFormat(msg) {
      // 提取图片 URL
      var imgUrl = extractImageUrl(msg);
      
      // 判断是否为图片消息
      var isImage = (msg.contentType === 2) || !!imgUrl;
      
      // 如果当前消息是图片，使用多模态格式
      if (isImage && imgUrl) {
        return [
          { type: 'image_url', image_url: { url: imgUrl } },
          { type: 'text', text: '用户发送了一张图片' }
        ];
      }
      return msg.content;
    }

    // 构建完整的 messages 数组
    var messages = [];

    // 1. 添加 system 消息
    messages.push({
      role: 'system',
      content: systemPrompt
    });

    // 2. 转换并添加历史消息
    var convertedHistory = [];
    historyMessages.forEach(function(msg) {
      var converted = convertMessageToOpenAIFormat(msg);
      if (converted) {
        convertedHistory.push(converted);
      }
    });
    messages = messages.concat(convertedHistory);

    console.log(LOG_PREFIX, '📋 历史消息转换完成，共', convertedHistory.length, '条');

    // 3. 确保当前消息在最后
    var currentMsgContent = convertCurrentMessageToOpenAIFormat(currentMessage);
    var lastMsg = convertedHistory.length > 0 ? convertedHistory[convertedHistory.length - 1] : null;

    console.log(LOG_PREFIX, '📊 历史消息数:', convertedHistory.length);
    console.log(LOG_PREFIX, '🔍 最后一条历史消息:', lastMsg ? (typeof lastMsg.content === 'string' ? lastMsg.content : '[多模态消息]') : '无');

    // 去重：如果最后一条历史消息内容与当前消息相同，则不添加
    var shouldAddCurrentMessage = true;
    if (lastMsg) {
      var lastContent = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
      var currentContent = typeof currentMsgContent === 'string' ? currentMsgContent : JSON.stringify(currentMsgContent);
      if (lastContent === currentContent) {
        shouldAddCurrentMessage = false;
      }
    }

    if (shouldAddCurrentMessage) {
      messages.push({
        role: 'user',
        content: currentMsgContent
      });
    }

    console.log(LOG_PREFIX, '💾 构建完整 messages 数组，共', messages.length, '条消息');

    return messages;
  }

  /**
   * 获取历史聊天记录并调用 AI
   */
  function handleAiReply(message, rule) {
    var maxHistory = rule.maxHistoryMessages || 10;
    var delay = rule.delay || runtime.globalConfig.defaultDelay || 1000;
  
    markProcessed(message, rule);
  
    // 获取 chatId（sessionId 对应 cid）
    var chatId = message.sessionId || '';
    if (!chatId) {
      console.error(LOG_PREFIX, '❌ 无法获取 chatId，跳过 AI 回复');
      return;
    }
  
    console.log(LOG_PREFIX, '🔍 拉取聊天记录，chatId:', chatId, ', maxHistory:', maxHistory);
  
    // 获取商品详情（如果有 itemId）
    var goodsDetailPromise = Promise.resolve(null);
    if (message.itemId && window.GoodsAPI && window.GoodsAPI.fetchGoodsDetail) {
      console.log(LOG_PREFIX, '📦 检测到商品 ID:', message.itemId, ', 正在获取商品详情...');
      goodsDetailPromise = window.GoodsAPI.fetchGoodsDetail(message.itemId)
        .then(function(goodsDetail) {
          console.log(LOG_PREFIX, '✅ 获取商品详情成功:', goodsDetail ? goodsDetail.title : '无');
          return goodsDetail;
        })
        .catch(function(err) {
          console.warn(LOG_PREFIX, '⚠️ 获取商品详情失败:', err);
          return null;
        });
    }
  
    // 并行获取历史记录和商品详情
    var historyPromise;
    if (window.ChatHistoryAPI && window.ChatHistoryAPI.getMessageHistory) {
      historyPromise = window.ChatHistoryAPI.getMessageHistory(chatId, undefined, maxHistory);
    } else {
      console.warn(LOG_PREFIX, '⚠️ ChatHistoryAPI 不可用，仅使用当前消息');
      historyPromise = Promise.resolve({ success: true, messages: [] });
    }
  
    Promise.all([historyPromise, goodsDetailPromise]).then(function(results) {
      var histResult = results[0];
      var goodsDetail = results[1];

      var historyMessages = [];

      if (histResult && histResult.success && histResult.messages) {
        // 按时间正序排列
        var sorted = histResult.messages.slice().sort(function (a, b) {
          return (a.createAt || 0) - (b.createAt || 0);
        });
        historyMessages = sorted;
      }

      // 调用 buildMessages 方法构造消息数组
      var basePrompt = rule.prompt || '你是一个闲鱼卖家的客服助手，请根据聊天记录和用户的最新消息进行回复。回复要简洁、友好、专业。不要用markdown格式。用中文回答。';

      var aiMessages = buildMessages({
        historyMessages: historyMessages,
        currentMessage: message,
        basePrompt: basePrompt,
        goodsDetail: goodsDetail
      });

      console.log(LOG_PREFIX, '🤖 发送 AI 请求，messages 数:', aiMessages.length);
      console.log(LOG_PREFIX, '📨 完整 messages:', JSON.stringify(aiMessages, null, 2));

      // 通过 bus-isolated 转发到 background 调用 AI API
      return sendRequest('AI_CHAT_COMPLETION', {
        messages: aiMessages,
        aiConfig: {
          aiApiKey: rule.aiApiKey || '',
          aiBaseUrl: rule.aiBaseUrl || '',
          aiModel: rule.aiModel || '',
          aiTimeout: rule.aiTimeout || 0
        }
      });
    }).then(function (aiResult) {
      if (!aiResult) {
        console.error(LOG_PREFIX, '❌ AI 请求无响应');
        return;
      }

      if (!aiResult.success) {
        console.error(LOG_PREFIX, '❌ AI 回复失败:', aiResult.error);
        return;
      }

      console.log(LOG_PREFIX, '🤖 AI 回复内容:', aiResult.content.substring(0, 100));

      // 延迟发送
      setTimeout(function () {
        sendReply(message, aiResult.content);
      }, delay);
    }).catch(function (error) {
      console.error(LOG_PREFIX, '❌ AI 处理异常:', error);
    });
  }

  /**
   * 主消息处理器
   */
  function handleChatMessage(context) {
    var message = context.message;

    if (!message || !message.content) return;

    // 未加载配置时跳过
    if (!runtime.configLoaded) return;

    // 检测非 Web 端消息并触发 AI 暂停
    // 核心逻辑：只有当前账号在非 Web 端发送消息时，才触发 AI 暂停
    if (message.platform && message.platform !== 'web' && message.direction === 'out') {
      // 这是当前账号从非 Web 端（如手机 APP）发送的消息
      console.log(LOG_PREFIX, '📱 检测到当前账号在非 Web 端发送消息，平台:', message.platform, ', 准备触发 AI 暂停');
      
      sendRequest('REPORT_NON_WEB_MESSAGE', {}).then(function(response) {
        console.log(LOG_PREFIX, '📨 收到 REPORT_NON_WEB_MESSAGE 响应:', response);
        
        if (response && response.success && response.paused) {
          // 更新本地状态
          runtime.aiPauseState.isPaused = true;
          runtime.aiPauseState.pausedUntil = response.until;
          console.log(LOG_PREFIX, '✅ AI 暂停已设置，直到:', new Date(response.until).toLocaleTimeString(), '| 时长:', Math.ceil((response.until - Date.now()) / 60000), '分钟');
        } else if (response && response.success && !response.paused) {
          console.log(LOG_PREFIX, '⚠️ AI 暂停未触发，原因:', response.reason);
        } else {
          console.warn(LOG_PREFIX, '❌ AI 暂停设置失败:', response);
        }
      }).catch(function(err) {
        console.warn(LOG_PREFIX, '⚠️ 报告非 Web 消息失败:', err);
      });
    }

    // 基础检查
    if (!shouldProcess(message)) return;

    console.log(LOG_PREFIX, '🔍 处理消息:', message.senderName, ':', message.content.substring(0, 30));

    // 查找匹配规则
    var rule = findMatchingRule(message);
    if (!rule) {
      console.log(LOG_PREFIX, '⏭️ 无匹配规则');
      return;
    }

    // 根据规则类型执行
    if (rule.type === 'keyword') {
      handleKeywordReply(message, rule);
    } else if (rule.type === 'ai') {
      handleAiReply(message, rule);
    }
  }

  // ==================== 初始化 ====================
  
  function init() {
    if (!window.EventBus) {
      console.error(LOG_PREFIX, '❌ EventBus 未加载');
      return;
    }
  
    // 加载规则和配置
    loadRulesAndConfig().then(function () {
      // 订阅聊天消息事件
      window.EventBus.on(window.ChatEventType.MESSAGE, handleChatMessage);
      console.log(LOG_PREFIX, '🚀 自动回复处理器已启动 (v3.0 - 规则引擎)');
    });
  
    // 从消息中自动识别当前用户 ID（比 UserAPI 更可靠）
    window.EventBus.on(window.ChatEventType.MESSAGE, function (context) {
      if (window.CURRENT_USER_ID) return; // 已有，无需重复
      var msg = context.message;
      if (!msg) return;
  
      // 方式 1：direction=in 的消息的 receiverId 就是自己
      if (msg.direction === 'in' && msg.receiverId) {
        window.CURRENT_USER_ID = msg.receiverId;
        console.log(LOG_PREFIX, '✅ 用户 ID 已从消息中识别:', msg.receiverId);
        return;
      }
      // 方式 2：direction=out 的消息的 senderId 就是自己
      if (msg.direction === 'out' && msg.senderId) {
        window.CURRENT_USER_ID = msg.senderId;
        console.log(LOG_PREFIX, '✅ 用户 ID 已从消息中识别:', msg.senderId);
        return;
      }
    });
      
    // 监听 AI 暂停状态变化（从 background 推送）
    window.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'AI_PAUSE_STATUS_CHANGED') {
        var detail = event.data.detail;
        if (detail) {
          runtime.aiPauseState.isPaused = detail.isPaused;
          runtime.aiPauseState.pausedUntil = detail.pausedUntil || 0;
            
          if (detail.isPaused) {
            console.log(LOG_PREFIX, '⏸️ 收到 AI 暂停通知，原因:', detail.reason);
          } else {
            console.log(LOG_PREFIX, '✅ 收到 AI 恢复通知');
          }
        }
      }
    });
  }

  // ==================== 导出 API ====================

  window.AutoReplyProcessor = {
    // 重载配置
    reload: function () {
      return loadRulesAndConfig();
    },
    // 获取状态
    getStatus: function () {
      return {
        configLoaded: runtime.configLoaded,
        enabled: runtime.globalConfig ? runtime.globalConfig.enabled : false,
        rulesCount: runtime.rules.length,
        processedCount: runtime.processedMessageIds.size,
        aiPaused: runtime.aiPauseState.isPaused && Date.now() < runtime.aiPauseState.pausedUntil,
        aiPausedUntil: runtime.aiPauseState.pausedUntil
      };
    },
    // 获取规则列表
    getRules: function () {
      return runtime.rules.slice();
    }
  };

  // 监听配置更新（从 options 页面推送）
  window.addEventListener('message', function (event) {
    if (event.data && event.data.source === 'AUTO_REPLY_CONFIG_UPDATED') {
      console.log(LOG_PREFIX, '🔄 收到配置更新通知，重新加载...');
      loadRulesAndConfig();
    }
  });

  // 启动
  init();

  console.log('[AutoReplyProcessor] 自动回复处理器已加载 (v3.0)');
})();
