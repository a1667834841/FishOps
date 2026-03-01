# 自动回复处理器 (补充文档)

本文档补充自动回复处理器的接口和配置格式。

## 概述

自动回复处理器 (AutoReplyProcessor) 是 FishOps 的核心模块，支持两种自动回复模式：
1. **关键词回复** - 基于正则表达式匹配
2. **AI 回复** - 基于大语言模型的智能回复

## 核心接口

### 加载规则和配置

```javascript
function loadRulesAndConfig()
```

从 background 脚本加载自动回复规则和全局配置。

**返回值**: Promise

### 消息处理

```javascript
function handleChatMessage(context)
```

处理收到的聊天消息，匹配规则并触发自动回复。

**参数**:
```javascript
context: {
    message: ChatMessage,   // 聊天消息对象
    raw: any,                // 原始数据
    timestamp: number,       // 时间戳
    source: 'websocket' | 'api'  // 消息来源
}
```

## 规则配置格式

### 关键词规则

```javascript
{
    id: 'rule_001',
    type: 'keyword',
    name: '价格咨询',
    enabled: true,
    priority: 10,
    pattern: '价格|多少钱|怎么卖',
    reply: '亲，这款商品目前售价 xxx 元，包邮哦~',
    itemIds: ['123456', '789012'],  // 可选，绑定商品ID
    cooldown: 60000,                // 冷却时间(毫秒)
    delay: 1000                      // 发送延迟(毫秒)
}
```

### AI 规则

```javascript
{
    id: 'rule_ai_001',
    type: 'ai',
    name: '智能客服',
    enabled: true,
    priority: 5,
    prompt: '你是一个闲鱼卖家的客服助手，请根据聊天记录和用户的最新消息进行回复。回复要简洁、友好、专业。',
    aiApiKey: 'sk-xxx',              // AI API Key
    aiBaseUrl: 'https://api.openai.com/v1',
    aiModel: 'gpt-3.5-turbo',
    aiTimeout: 30000,
    maxHistoryMessages: 10,          // 历史消息条数
    itemIds: [],                     // 可选，绑定商品ID
    cooldown: 60000,
    delay: 1000
}
```

### 全局配置

```javascript
{
    enabled: true,
    defaultCooldown: 60000,      // 默认冷却时间
    defaultDelay: 1000,           // 默认发送延迟
    blacklist: ['user_id_1', 'user_id_2']  // 黑名单用户ID
}
```

## 跨 World 通信

自动回复处理器运行在 ISOLATED world，需要通过 `postMessage` 与 background 通信。

### 消息类型

| 消息类型 | 说明 | 请求参数 |
|----------|------|----------|
| GET_AUTO_REPLY_RULES | 获取自动回复规则 | - |
| AI_CHAT_COMPLETION | 调用 AI 对话 | messages, aiConfig |
| REPORT_NON_WEB_MESSAGE | 报告非Web端消息 | - |

### 响应类型

| 响应类型 | 说明 | 返回数据 |
|----------|------|----------|
| GET_AUTO_REPLY_RULES_RESPONSE | 规则加载结果 | rules, globalConfig |
| AI_CHAT_COMPLETION_RESPONSE | AI 回复结果 | success, content, error |
| REPORT_NON_WEB_MESSAGE_RESPONSE | 非Web消息报告结果 | success, paused, until, reason |

## 消息处理流程

```
收到消息
    ↓
shouldProcess() 检查
    ├─ 总开关是否启用
    ├─ AI 是否暂停
    ├─ 消息是否为自己发送
    ├─ 用户是否在黑名单
    ├─ 消息是否已处理
    └─ 会话是否在冷却期
    ↓
findMatchingRule() 匹配规则
    ├─ 规则是否启用
    ├─ 商品ID是否匹配
    └─ 冷却时间是否满足
    ↓
执行规则
    ├─ 关键词规则 → handleKeywordReply()
    └─ AI规则 → handleAiReply()
        ├─ 获取聊天历史
        ├─ 获取商品详情
        ├─ 构建prompt
        └─ 调用AI API
```

## API 方法

### 导出接口

```javascript
window.AutoReplyProcessor = {
    // 重载配置
    reload: function() { ... },

    // 获取状态
    getStatus: function() {
        return {
            configLoaded: boolean,
            enabled: boolean,
            rulesCount: number,
            processedCount: number,
            aiPaused: boolean,
            aiPausedUntil: number
        };
    },

    // 获取规则列表
    getRules: function() { ... }
};
```

### 事件监听

```javascript
// 监听聊天消息
window.EventBus.on(window.ChatEventType.MESSAGE, function(context) {
    // 处理消息
});

// 监听配置更新
window.addEventListener('message', function(event) {
    if (event.data && event.data.source === 'AUTO_REPLY_CONFIG_UPDATED') {
        // 重新加载配置
    }
});

// 监听 AI 暂停状态变化
window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'AI_PAUSE_STATUS_CHANGED') {
        // AI 暂停状态变化
    }
});
```

## AI 暂停机制

当检测到用户在非 Web 端（如手机 APP）发送消息时，自动回复处理器会暂停 AI 回复，防止冲突。

### 检测逻辑

```javascript
// 核心：只有当前账号在非 Web 端发送消息时才触发
if (message.platform && message.platform !== 'web' && message.direction === 'out') {
    // 触发 AI 暂停
}
```

### 暂停时长

默认暂停时长为 10 分钟（600秒），可通过 background 脚本配置。

## 消息防重复

- **消息级防重**: 使用 `processedMessageIds` Set 记录已处理的消息ID
- **会话级防重**: 使用 `recentReplySessions` 记录每个会话的最后回复时间
- **冷却时间**: 每个规则可单独配置冷却时间

## 注意事项

1. 消息必须包含 `content` 字段才会被处理
2. 自己发送的消息（`senderId === myId`）会被忽略
3. AI 回复需要配置有效的 API Key 和 Base URL
4. 正则表达式匹配使用 `i` 标志（不区分大小写）
5. 默认冷却时间为 60 秒，默认发送延迟为 1 秒