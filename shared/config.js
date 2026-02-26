/**
 * shared/config.js - 统一配置常量
 */

// 聊天监听配置
var CHAT_CONFIG = {
  maxStoredMessages: 1000
};

// ==================== 自动回复相关常量 ====================

var AUTO_REPLY_RULES_KEY = 'autoReplyRules';
var AUTO_REPLY_GLOBAL_CONFIG_KEY = 'autoReplyGlobalConfig';

// AI 默认配置
var AI_DEFAULT_MODEL = 'gpt-4o-mini';
var AI_DEFAULT_TIMEOUT = 30000;
var AI_DEFAULT_MAX_HISTORY = 10;

// 正则编译超时保护
var REGEX_COMPILE_TIMEOUT = 100;

// 默认全局配置
var DEFAULT_GLOBAL_CONFIG = {
  enabled: false,
  defaultCooldown: 60000,
  defaultDelay: 1000,
  blacklist: [],
  // AI 连接配置
  aiApiKey: '',
  aiBaseUrl: 'https://api.openai.com/v1',
  aiModel: AI_DEFAULT_MODEL,
  aiTimeout: AI_DEFAULT_TIMEOUT,
  // 闲管家 API 配置
  xgjAppId: '',
  xgjAppKey: '',
  xgjAppSecret: ''
};
