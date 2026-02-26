/**
 * background/index.js - Service Worker
 * 接收聊天消息，去重后存储到 chrome.storage.local
 * 管理自动回复规则 CRUD，代理 AI API 调用
 */

// 加载配置和 AI 服务
try {
  importScripts('../shared/config.js');
  importScripts('ai-service.js');
  importScripts('goods-list-service.js');
} catch (e) {
  console.error('[Background] 模块加载失败:', e);
}

var chatConfig = (typeof CHAT_CONFIG !== 'undefined') ? CHAT_CONFIG : { maxStoredMessages: 1000 };
var globalConfigDefaults = (typeof DEFAULT_GLOBAL_CONFIG !== 'undefined') ? DEFAULT_GLOBAL_CONFIG : {
  enabled: false,
  defaultCooldown: 60000,
  defaultDelay: 1000,
  blacklist: [],
  aiApiKey: '',
  aiBaseUrl: 'https://api.openai.com/v1',
  aiModel: 'gpt-4o-mini',
  aiTimeout: 30000
};

// 存储 key 常量
var RULES_KEY = (typeof AUTO_REPLY_RULES_KEY !== 'undefined') ? AUTO_REPLY_RULES_KEY : 'autoReplyRules';
var GLOBAL_CONFIG_KEY = (typeof AUTO_REPLY_GLOBAL_CONFIG_KEY !== 'undefined') ? AUTO_REPLY_GLOBAL_CONFIG_KEY : 'autoReplyGlobalConfig';
var AI_PAUSE_CONFIG_KEY = 'aiPauseConfig';

// AI 暂停状态管理
var aiPauseState = {
  isPaused: false,
  pausedUntil: 0,  // 时间戳，毫秒
  pauseReason: null,  // 'manual_reply' | 'config'
  lastManualMessageTime: 0
};

// ==================== 辅助函数 ====================

/**
 * 生成规则 ID
 */
function generateRuleId() {
  return 'rule_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
}

/**
 * 读取全局配置
 */
async function getGlobalConfig() {
  var storageKey = {};
  storageKey[GLOBAL_CONFIG_KEY] = globalConfigDefaults;
  var result = await chrome.storage.local.get(storageKey);
  return Object.assign({}, globalConfigDefaults, result[GLOBAL_CONFIG_KEY]);
}

/**
 * 保存全局配置
 */
async function saveGlobalConfig(config) {
  var data = {};
  data[GLOBAL_CONFIG_KEY] = config;
  await chrome.storage.local.set(data);
}

/**
 * 获取 AI 暂停配置
 */
async function getAiPauseConfig() {
  var storageKey = {};
  storageKey[AI_PAUSE_CONFIG_KEY] = {
    enabled: true,  // 默认启用
    pauseDuration: 300000  // 默认 5 分钟
  };
  var result = await chrome.storage.local.get(storageKey);
  return Object.assign({}, {
    enabled: true,
    pauseDuration: 300000
  }, result[AI_PAUSE_CONFIG_KEY]);
}

/**
 * 保存 AI 暂停配置
 */
async function saveAiPauseConfig(config) {
  var data = {};
  data[AI_PAUSE_CONFIG_KEY] = config;
  await chrome.storage.local.set(data);
}

/**
 * 检查 AI 是否处于暂停状态
 */
function isAiPaused() {
  if (!aiPauseState.isPaused) return false;

  var now = Date.now();
  if (now >= aiPauseState.pausedUntil) {
    // 暂停时间已过，自动恢复
    aiPauseState.isPaused = false;
    aiPauseState.pausedUntil = 0;
    aiPauseState.pauseReason = null;
    console.log('[Background] ✅ AI 暂停结束，已自动恢复');
    return false;
  }

  var remainingSeconds = Math.ceil((aiPauseState.pausedUntil - now) / 1000);
  console.log('[Background] ⏸️ AI 暂停中，剩余', remainingSeconds, '秒');
  return true;
}

/**
 * 设置 AI 暂停
 */
async function setAiPause(duration, reason) {
  var now = Date.now();
  aiPauseState.isPaused = true;
  aiPauseState.pausedUntil = now + duration;
  aiPauseState.pauseReason = reason;
  aiPauseState.lastManualMessageTime = now;

  var minutes = Math.ceil(duration / 60000);
  console.log('[Background] ⏸️ AI 已暂停，时长:', minutes, '分钟，原因:', reason);

  // 同步到所有 content script
  var tabs = await chrome.tabs.query({ url: 'https://www.goofish.com/*' });
  tabs.forEach(function (tab) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'AI_PAUSE_STATUS_CHANGED',
      detail: {
        isPaused: true,
        pausedUntil: aiPauseState.pausedUntil,
        reason: reason
      }
    }).catch(() => { }); // 忽略错误
  });
}

/**
 * 获取 AI 暂停状态
 */
function getAiPauseStatus() {
  return {
    isPaused: isAiPaused(),
    pausedUntil: aiPauseState.pausedUntil,
    reason: aiPauseState.pauseReason,
    remainingSeconds: aiPauseState.isPaused ? Math.ceil((aiPauseState.pausedUntil - Date.now()) / 1000) : 0
  };
}

/**
 * 读取规则列表
 */
async function getRules() {
  var storageKey = {};
  storageKey[RULES_KEY] = [];
  var result = await chrome.storage.local.get(storageKey);
  return result[RULES_KEY] || [];
}

/**
 * 保存规则列表
 */
async function saveRules(rules) {
  var data = {};
  data[RULES_KEY] = rules;
  await chrome.storage.local.set(data);
}

// ==================== 消息监听 ====================

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  var handleMessage = async function () {
    try {
      // ==================== 自动回复规则 CRUD ====================

      // 获取全局配置（含 AI 连接信息）
      if (request.type === 'GET_AUTO_REPLY_GLOBAL_CONFIG') {
        var config = await getGlobalConfig();
        sendResponse({ success: true, config: config });
        return;
      }

      // 更新全局配置
      if (request.type === 'UPDATE_AUTO_REPLY_GLOBAL_CONFIG') {
        var currentConfig = await getGlobalConfig();
        var newConfig = Object.assign({}, currentConfig, request.config);
        await saveGlobalConfig(newConfig);
        sendResponse({ success: true, config: newConfig });
        return;
      }

      // 获取规则列表
      if (request.type === 'GET_AUTO_REPLY_RULES') {
        var rules = await getRules();
        var config = await getGlobalConfig();
        sendResponse({ success: true, rules: rules, globalConfig: config });
        return;
      }

      // 保存（新增/编辑）规则
      if (request.type === 'SAVE_AUTO_REPLY_RULE') {
        var rules = await getRules();
        var rule = request.rule;

        if (!rule) {
          sendResponse({ success: false, error: '规则数据不能为空' });
          return;
        }

        // 检查是否是编辑（有 id）还是新增
        if (rule.id) {
          // 编辑：查找并替换
          var found = false;
          for (var i = 0; i < rules.length; i++) {
            if (rules[i].id === rule.id) {
              rules[i] = rule;
              found = true;
              break;
            }
          }
          if (!found) {
            sendResponse({ success: false, error: '未找到该规则' });
            return;
          }
        } else {
          // 新增：生成 ID
          rule.id = generateRuleId();
          rules.push(rule);
        }

        await saveRules(rules);
        sendResponse({ success: true, rule: rule, rules: rules });
        return;
      }

      // 删除规则
      if (request.type === 'DELETE_AUTO_REPLY_RULE') {
        var rules = await getRules();
        var ruleId = request.ruleId;

        var newRules = rules.filter(function (r) { return r.id !== ruleId; });

        if (newRules.length === rules.length) {
          sendResponse({ success: false, error: '未找到该规则' });
          return;
        }

        await saveRules(newRules);
        sendResponse({ success: true, rules: newRules });
        return;
      }

      // 更新规则排序
      if (request.type === 'UPDATE_RULE_ORDER') {
        var ruleIds = request.ruleIds;
        if (!Array.isArray(ruleIds)) {
          sendResponse({ success: false, error: '无效的排序数据' });
          return;
        }

        var rules = await getRules();
        var rulesMap = {};
        rules.forEach(function (r) { rulesMap[r.id] = r; });

        var sorted = [];
        ruleIds.forEach(function (id) {
          if (rulesMap[id]) {
            sorted.push(rulesMap[id]);
          }
        });

        // 补上不在 ruleIds 中的规则
        rules.forEach(function (r) {
          if (ruleIds.indexOf(r.id) === -1) {
            sorted.push(r);
          }
        });

        await saveRules(sorted);
        sendResponse({ success: true, rules: sorted });
        return;
      }

      // ==================== AI 暂停管理 ====================

      // 获取 AI 暂停配置
      if (request.type === 'GET_AI_PAUSE_CONFIG') {
        var config = await getAiPauseConfig();
        sendResponse({ success: true, config: config });
        return;
      }

      // 更新 AI 暂停配置
      if (request.type === 'UPDATE_AI_PAUSE_CONFIG') {
        var currentConfig = await getAiPauseConfig();
        var newConfig = Object.assign({}, currentConfig, request.config);
        await saveAiPauseConfig(newConfig);
        sendResponse({ success: true, config: newConfig });
        return;
      }

      // 获取 AI 暂停状态
      if (request.type === 'GET_AI_PAUSE_STATUS') {
        sendResponse({ success: true, status: getAiPauseStatus() });
        return;
      }

      // 手动控制 AI 暂停/恢复
      if (request.type === 'SET_AI_PAUSE') {
        if (request.enabled) {
          var duration = request.duration || 300000;
          await setAiPause(duration, request.reason || 'manual');
        } else {
          aiPauseState.isPaused = false;
          aiPauseState.pausedUntil = 0;
          aiPauseState.pauseReason = null;
          console.log('[Background] ✅ AI 已手动恢复');

          // 通知所有 content script
          var tabs = await chrome.tabs.query({ url: 'https://www.goofish.com/*' });
          tabs.forEach(function (tab) {
            chrome.tabs.sendMessage(tab.id, {
              type: 'AI_PAUSE_STATUS_CHANGED',
              detail: { isPaused: false }
            }).catch(() => { });
          });
        }
        sendResponse({ success: true, status: getAiPauseStatus() });
        return;
      }

      // 检测非 Web 端消息（用于自动触发 AI 暂停）
      if (request.type === 'REPORT_NON_WEB_MESSAGE') {
        var pauseConfig = await getAiPauseConfig();

        if (!pauseConfig.enabled) {
          sendResponse({ success: true, paused: false, reason: 'feature_disabled' });
          return;
        }

        // 检测到非 Web 端消息，触发 AI 暂停
        await setAiPause(pauseConfig.pauseDuration, 'manual_reply');

        sendResponse({ success: true, paused: true, until: aiPauseState.pausedUntil });
        return;
      }

      // ==================== AI 聊天补全代理 ====================

      // 获取商品列表
      if (request.type === 'FETCH_GOODS_LIST') {
        console.log('[Background] 📥 收到商品列表请求');
        var pageNumber = request.pageNumber || 1;
        var pageSize = request.pageSize || 20;

        if (typeof fetchGoodsList === 'function') {
          var result = await fetchGoodsList(pageNumber, pageSize);
          sendResponse(result);
        } else {
          sendResponse({ success: false, error: '商品列表服务未加载', goodsList: [], hasMore: false });
        }
        return;
      }

      if (request.type === 'AI_CHAT_COMPLETION') {
        console.log('[Background] 📤 收到 AI 补全请求');

        var globalConfig = await getGlobalConfig();

        // 合并规则级别的 AI 配置（如果有）
        var aiConfig = {
          apiKey: (request.aiConfig && request.aiConfig.aiApiKey) || globalConfig.aiApiKey,
          baseUrl: (request.aiConfig && request.aiConfig.aiBaseUrl) || globalConfig.aiBaseUrl,
          model: (request.aiConfig && request.aiConfig.aiModel) || globalConfig.aiModel,
          timeout: (request.aiConfig && request.aiConfig.aiTimeout) || globalConfig.aiTimeout
        };

        if (!aiConfig.apiKey) {
          sendResponse({ success: false, error: 'AI API Key 未配置，请在设置中配置' });
          return;
        }

        // 调用 AI 服务（由 ai-service.js 提供）
        if (typeof callChatCompletion === 'function') {
          var result = await callChatCompletion(aiConfig, request.messages);
          sendResponse(result);
        } else {
          sendResponse({ success: false, error: 'AI 服务模块未加载' });
        }
        return;
      }

      // ==================== 向后兼容：旧版自动回复配置 ====================

      // 获取自动回复配置（兼容旧版）
      if (request.type === 'GET_AUTO_REPLY_CONFIG') {
        console.log('[Background] 📥 收到配置请求（兼容模式）');
        var config = await getGlobalConfig();
        var rules = await getRules();
        // 将新数据格式映射回旧格式
        var legacyConfig = {
          enabled: config.enabled,
          cooldown: config.defaultCooldown,
          delay: config.defaultDelay,
          keywords: rules.filter(function (r) { return r.type === 'keyword'; }).map(function (r) {
            return { trigger: r.pattern, reply: r.reply };
          })
        };
        sendResponse({ success: true, config: legacyConfig });
        return;
      }

      // 更新自动回复配置（兼容旧版）
      if (request.type === 'UPDATE_AUTO_REPLY_CONFIG') {
        var currentConfig = await getGlobalConfig();
        if (request.config.enabled !== undefined) currentConfig.enabled = request.config.enabled;
        if (request.config.cooldown !== undefined) currentConfig.defaultCooldown = request.config.cooldown;
        if (request.config.delay !== undefined) currentConfig.defaultDelay = request.config.delay;
        await saveGlobalConfig(currentConfig);
        sendResponse({ success: true });
        return;
      }

      // 添加关键字规则（兼容旧版）
      if (request.type === 'ADD_AUTO_REPLY_KEYWORD') {
        var rules = await getRules();
        var keyword = request.keyword;

        // 检查是否已存在
        for (var i = 0; i < rules.length; i++) {
          if (rules[i].type === 'keyword' && rules[i].pattern === keyword.trigger) {
            sendResponse({ success: false, error: '该关键字已存在' });
            return;
          }
        }

        var newRule = {
          id: generateRuleId(),
          name: '关键词: ' + keyword.trigger,
          type: 'keyword',
          priority: 10,
          enabled: true,
          pattern: keyword.trigger,
          reply: keyword.reply,
          itemIds: [],
          cooldown: 0,
          delay: 0
        };
        rules.push(newRule);
        await saveRules(rules);
        sendResponse({ success: true });
        return;
      }

      // 删除关键字规则（兼容旧版）
      if (request.type === 'DELETE_AUTO_REPLY_KEYWORD') {
        var rules = await getRules();
        var keywordRules = rules.filter(function (r) { return r.type === 'keyword'; });

        if (request.index >= 0 && request.index < keywordRules.length) {
          var targetId = keywordRules[request.index].id;
          var newRules = rules.filter(function (r) { return r.id !== targetId; });
          await saveRules(newRules);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: '索引超出范围' });
        }
        return;
      }

      // ==================== 发送聊天消息 ====================

      if (request.type === 'SEND_CHAT_MESSAGE') {
        console.log('[Background] 📤 收到发送请求:', request.data);

        if (sender.tab && sender.tab.id) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'SEND_MESSAGE_REQUEST',
            data: request.data
          }, function (response) {
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

      // ==================== 同步聊天记录（从 options 触发） ====================

      if (request.type === 'SYNC_CHAT_HISTORY') {
        var conversationCount = request.conversationCount || 50;
        var messageCount = request.messageCount || 20;
        console.log('[Background] 🔄 收到同步请求, 会话数:', conversationCount, '消息数:', messageCount);

        // 查找闲鱼聊天页 tab
        var tabs = await chrome.tabs.query({ url: 'https://www.goofish.com/*' });
        if (!tabs || tabs.length === 0) {
          sendResponse({ success: false, error: '未找到闲鱼页面，请先打开闲鱼聊天页' });
          return;
        }

        // 向第一个闲鱼 tab 发送同步请求
        try {
          var response = await chrome.tabs.sendMessage(tabs[0].id, {
            type: 'SYNC_CHAT_HISTORY_REQUEST',
            conversationCount: conversationCount,
            messageCount: messageCount
          });
          sendResponse(response || { success: false, error: '未收到响应' });
        } catch (err) {
          sendResponse({ success: false, error: '通信失败: ' + err.message });
        }
        return;
      }

      // ==================== 聊天消息存储 ====================
      // 消息存储功能已移除，导出时直接实时获取

      if (request.type === 'GET_CHAT_CONFIG') {
        var result = await chrome.storage.local.get({ chatConfig: chatConfig });
        sendResponse({ success: true, config: result.chatConfig });
        return;
      }

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

console.log('[Background] 聊天消息存储服务已就绪 (v3.0 - 规则引擎)');
