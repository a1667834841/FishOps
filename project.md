# FishOps - 闲鱼聊天监听助手项目架构文档

## 📋 项目概述

**FishOps** 是一个基于 Chrome Extension Manifest V3 的闲鱼聊天消息监听与自动回复工具，采用事件驱动架构实现消息的拦截、解析、存储和自动回复。

### 核心能力

1. **WebSocket 消息拦截** - Hook 闲鱼聊天 WebSocket，实时捕获消息
2. **MessagePack 协议解析** - 解码闲鱼私有二进制协议
3. **事件驱动架构** - 基于 EventBus 实现模块化、可扩展的消息处理
4. **自动回复功能** - 根据关键字自动回复聊天消息
5. **消息持久化** - 存储聊天记录到 chrome.storage.local
6. **配置管理** - 可视化的配置页面管理监听和回复规则

---

## 🏗️ 项目结构详解

```
FishOps/
├── manifest.json              # 扩展配置文件（Manifest V3）
├── background/                # Service Worker 后台服务
│   └── index.js              # 消息存储、配置管理、API 转发
├── content/                   # Content Scripts（ISOLATED world）
│   ├── bus-isolated.js       # ISOLATED world 消息总线
│   ├── bus-main.js           # MAIN world 与 ISOLATED world 桥接
│   └── index.js              # Content Script 入口
├── inject/                    # 注入到页面的脚本（MAIN world）
│   ├── core/                 # 核心模块
│   │   ├── event-bus.js      # 事件总线（发布/订阅模式）
│   │   └── message-bridge.js # 跨 World 通信桥接
│   ├── data-sources/         # 数据源层
│   │   └── websocket-data-source.js  # WebSocket 拦截器
│   ├── processors/           # 业务处理器层
│   │   ├── print-processor.js  # 打印处理器（示例）
│   │   └── auto-reply-processor.js # 自动回复处理器
│   ├── api/                  # API 接口层
│   │   ├── chat-sender.js    # 消息发送器
│   │   ├── user-api.js       # 用户 API（获取 userId）
│   │   └── test-*.js         # 测试脚本集合
│   └── chat-parser.js        # 消息解析器（MessagePack/JSON）
├── options/                   # 配置页面
│   ├── options.html          # 配置界面 UI
│   └── options.js            # 配置逻辑
├── popup/                     # 弹出窗口
│   ├── popup.html            # 弹窗界面
│   └── popup.js              # 弹窗逻辑
├── shared/                    # 共享工具
│   ├── config.js             # 全局配置常量
│   └── ui-helpers.js         # UI 辅助函数
└── icons/                     # 扩展图标资源
```

---

## 🎯 核心模块详解

### 1. **manifest.json** - 扩展配置

**作用：** 定义扩展的权限、资源注入、架构模式

**关键配置：**
```json
{
  "manifest_version": 3,        // V3 版本（Service Worker）
  "permissions": ["storage", "activeTab"],
  "host_permissions": ["https://www.goofish.com/*"],
  
  "background": {
    "service_worker": "background/index.js"  // Service Worker
  },
  
  "content_scripts": [
    {
      "js": ["content/bus-isolated.js", "content/index.js"],
      "run_at": "document_start",
      "world": "ISOLATED"      // 隔离世界（可访问 chrome.* API）
    },
    {
      "js": ["inject/core/event-bus.js", ...],
      "run_at": "document_start",
      "world": "MAIN"          // 主世界（可访问页面 DOM）
    }
  ]
}
```

**设计思想：**
- **双 World 架构**：ISOLATED world 负责与 background 通信，MAIN world 负责页面交互
- **早期注入**：`document_start` 确保在页面脚本执行前注入，成功 Hook WebSocket

---

### 2. **background/index.js** - Service Worker

**作用：** 后台服务，负责消息存储、配置管理、API 转发

**核心职责：**
```javascript
// 1. 消息去重存储
chrome.runtime.onMessage.addListener((request) => {
  if (request.type === 'CHAT_MESSAGE') {
    // messageId 去重
    if (seenMessageIds.has(request.data.messageId)) return;
    
    // 存储到 chrome.storage.local
    chrome.storage.local.set({ chatMessages: messages });
  }
});

// 2. 配置管理
if (request.type === 'GET_AUTO_REPLY_CONFIG') {
  const config = await chrome.storage.local.get('autoReplyConfig');
  sendResponse({ success: true, config: config });
}

// 3. API 转发
if (request.type === 'SEND_CHAT_MESSAGE') {
  chrome.tabs.sendMessage(sender.tab.id, request.data);
}
```

**关键特性：**
- ✅ 无状态设计（Stateless）
- ✅ 内存去重（`seenMessageIds` Set）
- ✅ 异步消息处理（async/await）
- ✅ 支持多种消息类型路由

---

### 3. **inject/core/event-bus.js** - 事件总线

**作用：** 实现发布/订阅模式，解耦消息源与业务处理器

**API 设计：**
```javascript
// 标准事件类型
window.ChatEventType = {
  MESSAGE: 'chat:message',     // 单条聊天消息
  SYNC: 'chat:sync',           // 批量历史消息
  ORDER: 'chat:order',         // 订单消息
  TYPING: 'chat:typing',       // 正在输入
  SYSTEM: 'chat:system',       // 系统通知
  UNKNOWN: 'chat:unknown'      // 未知类型
};

// 订阅事件
EventBus.on('chat:message', function(context) {
  console.log('收到消息:', context.message);
});

// 触发事件
EventBus.emit('chat:message', {
  message: {...},      // 标准化消息对象
  raw: {...},          // 原始消息数据
  timestamp: 1234567890,
  source: 'websocket'
});

// 取消订阅
var unsubscribe = EventBus.on('chat:message', handler);
unsubscribe();

// 清空所有监听
EventBus.clear();
```

**架构优势：**
- 🎯 **完全解耦**：消息源不关心谁消费消息
- 🔌 **即插即用**：新增处理器无需修改现有代码
- 📦 **单一职责**：每个处理器只关注一种业务逻辑

---

### 4. **inject/data-sources/websocket-data-source.js** - WebSocket 拦截器

**作用：** Hook 闲鱼 WebSocket，捕获聊天消息并触发事件

**核心技术：**
```javascript
// 1. 覆盖原生 WebSocket 构造函数
window.WebSocket = function(url, protocols) {
  var ws = new originalWebSocket(url, protocols);
  
  // 2. 识别目标 WebSocket（包含 goofish.com）
  if (self.isTargetWebSocket(url)) {
    // 3. Hook onmessage 事件
    Object.defineProperty(ws, 'onmessage', {
      set: function(handler) {
        var wrappedHandler = function(event) {
          handler.call(this, event);
          
          // 4. 解析消息并触发 EventBus
          if (typeof event.data === 'string') {
            self._handleWebSocketMessage(event.data);
          }
        };
        // 设置包装后的处理器
      }
    });
    
    // 5. 保存 WebSocket 引用供发送使用
    window.XianyuSenderSetup.setTargetWebSocket(ws);
  }
  
  return ws;
};
```

**关键流程：**
```
WebSocket 连接建立
    ↓
识别是否为闲鱼聊天 WebSocket
    ↓
Hook onmessage / addEventListener
    ↓
收到消息 → 调用 _handleWebSocketMessage
    ↓
传递给 XianyuAPI.handleWebSocketMessage
    ↓
chat-parser.js 解析（MessagePack/JSON）
    ↓
EventBus.emit('chat:message', context)
```

---

### 5. **inject/chat-parser.js** - 消息解析器

**作用：** 解析闲鱼私有协议（MessagePack / JSON），提取标准化消息对象

**核心能力：**

#### **MessagePack 解码**
```javascript
class MessagePackDecoder {
  decode() {
    const byte = this.view.getUint8(this.offset++);
    
    // 根据首字节判断数据类型
    if (byte <= 0x7f) return byte;           // 正整数
    if (byte >= 0x80 && byte <= 0x8f) return this.parseMap();  // Map
    if (byte >= 0x90 && byte <= 0x9f) return this.parseArray(); // 数组
    if (byte >= 0xa0 && byte <= 0xbf) return this.parseString(); // 字符串
    if (byte === 0xc0) return null;          // null
    // ... 更多类型
  }
}
```

#### **消息标准化**
```javascript
function buildChatMessage(data) {
  return {
    senderId: data['1']?.['1']?.split('@')[0],     // 发送人 ID
    senderName: data['1']?.['3'],                   // 发送人昵称
    receiverId: data['1']?.['2']?.split('@')[0],   // 接收人 ID
    sessionId: data['1']?.['2']?.split('@')[0],    // 会话 ID
    itemId: data['1']?.['4'],                       // 商品 ID
    content: decodedData.text?.text || '',         // 消息内容
    contentType: decodedData.contentType || 1,     // 内容类型
    direction: 'in',                                // 消息方向
    timestamp: Date.now(),                          // 时间戳
    messageId: uuid                                 // 消息唯一 ID
  };
}
```

**协议逆向成果：**
- ✅ 支持 MessagePack 二进制格式
- ✅ 支持 JSON 格式
- ✅ 自动检测消息类型（心跳/聊天/订单）
- ✅ 提取完整上下文（senderId、receiverId、sessionId、itemId）

---

### 6. **inject/api/chat-sender.js** - 消息发送器

**作用：** 通过 WebSocket 发送聊天消息到闲鱼服务器

**核心实现：**

#### **协议字段生成**
```javascript
// MID 生成（Message ID）
function generateMid() {
  var randomPart = Math.floor(Math.random() * 1000);
  var timestamp = Date.now();
  return randomPart + '' + timestamp + ' 0';
  // 示例：5371771432421836 0
}

// UUID 生成（消息唯一标识）
function generateUuid() {
  var timestamp = Date.now();
  var randomPart = Math.floor(Math.random() * 10000);
  return '-' + timestamp + randomPart;
  // 示例：-17714324218364151
}
```

#### **WebSocket 发送**
```javascript
function sendViaWebSocket(options) {
  return new Promise((resolve, reject) => {
    // 1. 生成 ID
    var uuid = generateUuid();
    var mid = generateMid();
    
    // 2. 构建消息体（UTF-8 Base64 编码）
    var messageContent = {
      contentType: 1,
      text: { text: options.content }
    };
    var messageDataBase = btoa(unescape(encodeURIComponent(
      JSON.stringify(messageContent)
    )));
    
    // 3. 构建完整 Payload
    var payload = {
      lwp: '/r/MessageSend/sendByReceiverScope',
      headers: { mid: mid },
      body: [
        {
          uuid: uuid,
          cid: options.sessionId + '@goofish',
          conversationType: 1,
          content: {
            contentType: 101,
            custom: { type: 1, data: messageDataBase }
          },
          actualReceivers: [
            options.toUserId + '@goofish',    // 对方
            options.myId + '@goofish'         // 自己（多端同步）
          ]
        }
      ]
    };
    
    // 4. 通过 WebSocket 发送
    var ws = getTargetWebSocket();
    ws.send(JSON.stringify(payload));
    
    // 5. 监听响应
    ws.addEventListener('message', function(event) {
      var response = JSON.parse(event.data);
      if (response.headers.mid === mid) {
        resolve({ success: true, data: response });
      }
    });
  });
}
```

**关键技术点：**
- ✅ 复用已有 WebSocket 连接（非新建）
- ✅ 符合闲鱼官方协议格式
- ✅ `actualReceivers` 包含双方 ID（实现多端同步）
- ✅ UTF-8 Base64 编码（支持中文）
- ✅ 异步 Promise 封装

---

### 7. **inject/api/user-api.js** - 用户 API

**作用：** 获取当前登录用户的真实 ID（用于消息发送）

**协议分析：**
```javascript
// API 端点
https://h5api.m.goofish.com/h5/mtop.taobao.idlemessage.pc.loginuser.get/1.0/

// 签名算法
sign = md5(token + "&" + t + "&" + appKey + "&" + data)

// 参数说明
- token: 从 Cookie 获取 (_m_h 字段)
- t: 时间戳（毫秒）
- appKey: "34839810"（固定）
- data: 所有查询参数的拼接字符串
```

**实现流程：**
```javascript
async function getCurrentUserId(token) {
  // 1. 生成时间戳
  var timestamp = Date.now().toString();
  
  // 2. 构造查询参数
  var queryParams = {
    jsv: '2.7.2',
    appKey: '34839810',
    t: timestamp,
    api: 'mtop.taobao.idlemessage.pc.loginuser.get',
    // ... 其他参数
  };
  
  // 3. 生成签名
  var signData = Object.keys(queryParams).map(k => k + '=' + queryParams[k]).join('&');
  var sign = await md5(token + '&' + timestamp + '&' + appKey + '&' + signData);
  queryParams.sign = sign;
  
  // 4. 发送请求
  var url = baseUrl + '?' + new URLSearchParams(queryParams);
  var response = await fetch(url, { credentials: 'include' });
  var data = await response.json();
  
  // 5. 提取 userId
  if (data.ret[0].includes('SUCCESS')) {
    var userId = data.data.userId;
    
    // 6. 缓存到全局
    window.CURRENT_USER_ID = userId;
    localStorage.setItem('idle_current_user_id', userId);
    
    return { success: true, userId: userId };
  }
}
```

**为什么需要这个 API？**
- 发送消息时需要 `myId` 参数
- `myId` 必须是当前用户的真实 ID（不是 sessionId）
- 从收到的消息中无法直接获取（`receiverId` 被 sessionId 覆盖）
- 需要通过官方 API 获取

---

### 8. **inject/processors/auto-reply-processor.js** - 自动回复处理器

**作用：** 监听聊天消息，根据关键字自动回复

**架构设计：**

#### **配置结构**
```javascript
var defaultConfig = {
  enabled: false,           // 启用开关
  keywords: [               // 关键字规则
    { trigger: '123', reply: '456' },
    { trigger: '你好', reply: '您好！有什么可以帮您？' }
  ],
  delay: 1000,              // 延迟发送（毫秒）
  cooldown: 60000,          // 冷却时间（毫秒）
  blacklist: []             // 黑名单用户
};
```

#### **核心流程**
```javascript
// 1. 订阅聊天消息事件
EventBus.on(ChatEventType.MESSAGE, handleChatMessage);

// 2. 处理消息
function handleChatMessage(context) {
  var message = context.message;
  
  // 3. 检查是否应该回复
  if (!shouldReply(message)) return;
  
  // 4. 查找匹配的关键字
  var matched = findMatchingKeyword(message.content);
  if (!matched) return;
  
  // 5. 延迟发送回复
  setTimeout(() => {
    sendReply(message, matched.reply);
  }, config.delay);
}

// 6. 发送回复
function sendReply(message, replyContent) {
  var replyData = {
    sessionId: message.sessionId,
    toUserId: message.senderId,     // 回复给对方
    myId: message.receiverId,       // 当前用户自己
    itemId: message.itemId,
    content: replyContent
  };
  
  window.XianyuSender.sendTextMessage(
    replyData.sessionId,
    replyData.toUserId,
    replyData.content,
    replyData.itemId,
    replyData.myId
  );
}
```

**防重复机制：**
- ✅ 检查消息方向（跳过自己发送的）
- ✅ 检查黑名单用户
- ✅ 检查消息 ID（避免重复处理）
- ✅ 检查冷却时间（防止频繁骚扰）

---

### 9. **content/bus-isolated.js** - ISOLATED World 消息总线

**作用：** 桥接 MAIN world 和 background Service Worker

**为什么需要桥接？**
```
┌─────────────────┐
│  MAIN world     │  ← 可以访问页面 DOM、Window
│  (event-bus)    │     但无法访问 chrome.* API
└────────┬────────┘
         │ postMessage
         ▼
┌─────────────────┐
│ ISOLATED world  │  ← 可以访问 chrome.* API
│ (bus-isolated)  │     但无法访问页面 DOM
└────────┬────────┘
         │ chrome.runtime.sendMessage
         ▼
┌─────────────────┐
│  Background     │  ← Service Worker，持久存储
└─────────────────┘
```

**核心实现：**
```javascript
// 1. 监听 MAIN world 的消息
window.addEventListener('message', function(event) {
  // 2. 转发聊天消息到 background
  if (event.data.source === 'XIANYU_CHAT') {
    chrome.runtime.sendMessage({
      type: 'CHAT_MESSAGE',
      data: event.data.detail
    });
  }
  
  // 3. 处理自动回复配置请求
  if (event.data.type === 'GET_AUTO_REPLY_CONFIG') {
    chrome.runtime.sendMessage({
      type: 'GET_AUTO_REPLY_CONFIG'
    }, function(response) {
      // 4. 将响应发回 MAIN world
      window.postMessage({
        type: 'AUTO_REPLY_CONFIG_RESPONSE',
        detail: response
      }, '*');
    });
  }
});
```

---

### 10. **options/options.html & options.js** - 配置页面

**作用：** 提供可视化界面管理监听配置和自动回复规则

**界面结构：**
```
配置中心
├── 消息列表          # 查看已存储的聊天消息
│   ├── 刷新
│   ├── 导出 CSV
│   └── 清空全部
├── 自动回复          # 配置自动回复规则
│   ├── 启用开关
│   ├── 冷却时间设置
│   ├── 延迟发送设置
│   └── 关键字规则管理
│       ├── 添加规则
│       └── 删除规则
└── 监听设置          # 基础监听配置
    └── 最大存储消息数
```

**核心功能：**
```javascript
// 加载配置
function loadAutoReplyConfig() {
  chrome.runtime.sendMessage({ 
    type: 'GET_AUTO_REPLY_CONFIG' 
  }, function(response) {
    autoReplyEnabledCheckbox.checked = response.config.enabled;
    cooldownInput.value = response.config.cooldown;
    renderKeywordTable(response.config.keywords);
  });
}

// 添加关键字规则
function addKeyword() {
  var trigger = prompt('触发关键字');
  var reply = prompt('回复内容');
  
  chrome.runtime.sendMessage({
    type: 'ADD_AUTO_REPLY_KEYWORD',
    keyword: { trigger, reply }
  });
}

// 实时保存配置
autoReplyEnabledCheckbox.addEventListener('change', saveAutoReplyConfig);
cooldownInput.addEventListener('change', saveAutoReplyConfig);
```

---

## 🔄 完整数据流

### **场景 1：收到新消息**

```
1. 用户在闲鱼收到聊天消息
   ↓
2. 闲鱼 WebSocket 收到消息
   ↓
3. websocket-data-source.js 拦截
   ↓
4. chat-parser.js 解析（MessagePack/JSON）
   ↓
5. EventBus.emit('chat:message', context)
   ↓
   ├─→ print-processor.js → 打印日志
   ├─→ auto-reply-processor.js → 检查关键字 → 发送回复
   └─→ message-bridge.js → postMessage → bus-isolated.js
                                              ↓
                                    chrome.runtime.sendMessage
                                              ↓
                                         background
                                              ↓
                                   chrome.storage.local 存储
```

### **场景 2：发送自动回复**

```
1. auto-reply-processor 匹配到关键字
   ↓
2. 调用 XianyuSender.sendTextMessage()
   ↓
3. chat-sender.js 构建协议数据
   ├── 生成 MID 和 UUID
   ├── 构建消息体（UTF-8 Base64 编码）
   └── 设置 actualReceivers（双方 ID）
   ↓
4. 通过 WebSocket 发送
   ↓
5. 闲鱼服务器响应
   ↓
6. 更新 UI 显示已发送
```

### **场景 3：配置管理**

```
1. 用户在配置页面修改设置
   ↓
2. options.js 收集数据
   ↓
3. chrome.runtime.sendMessage → background
   ↓
4. background 保存到 chrome.storage.local
   ↓
5. auto-reply-processor 监听到变化
   ↓
6. 下次收到消息时使用新配置
```

---

## 🛠️ 技术亮点

### **1. 双 World 架构设计**
- **MAIN world**：访问页面 DOM、Hook WebSocket、解析消息
- **ISOLATED world**：访问 chrome API、转发消息到 background
- **优势**：既保持页面交互能力，又满足 Chrome 扩展安全要求

### **2. 事件驱动解耦**
- 消息源（WebSocket）不关心消费者
- 业务处理器（打印、回复、存储）独立运行
- 新增功能只需订阅事件，无需修改现有代码

### **3. 协议逆向工程**
- **MessagePack 解码**：完整实现二进制协议解析
- **ID 生成算法**：符合闲鱼官方的 MID/UUID 格式
- **签名破解**：MD5 签名算法 + Token 认证
- **WebSocket 复用**：Hook 已有连接而非新建

### **4. 跨 World 通信**
- **postMessage**：MAIN ↔ ISOLATED
- **chrome.runtime**：ISOLATED ↔ Background
- **消息桥接**：透明转发，保持数据一致性

### **5. 中文编码处理**
```javascript
// 错误的做法
btoa(jsonString)  // 中文会报错

// 正确的做法
btoa(unescape(encodeURIComponent(jsonString)))
// UTF-8 → %XX → Latin1 → Base64
```

---

## 📊 性能优化

### **1. 消息去重**
- 使用 `Set` 存储已处理的 messageId
- 启动时从 storage 恢复历史 ID
- O(1) 时间复杂度检查重复

### **2. 内存管理**
- 限制最大存储消息数（默认 1000 条）
- 超出后 FIFO（先进先出）删除旧消息
- 清理过期 messageId 释放内存

### **3. 异步处理**
- 所有 I/O 操作使用 async/await
- 避免阻塞主线程
- Promise 封装保证错误处理一致性

---

## 🔐 安全考虑

### **1. 权限最小化**
```json
"permissions": [
  "storage",      // 仅存储数据
  "activeTab"     // 仅当前标签页
]
```

### **2. CSP 兼容**
- 不使用 `innerHTML`
- 不使用 `eval()`（除了测试脚本）
- 遵循页面内容安全策略

### **3. 零外部依赖**
- 纯 JavaScript 实现
- 无第三方库
- 无网络请求（除闲鱼 API）

---

## 🧪 测试工具集

项目提供了丰富的测试脚本：

| 测试文件 | 用途 |
|---------|------|
| `test-send-message.js` | 测试消息发送功能 |
| `test-websocket-send.js` | 测试 WebSocket 发送 |
| `test-id-generator.js` | 测试 MID/UUID 生成 |
| `test-actual-receivers.js` | 测试接收者数组 |
| `test-get-user-id.js` | 测试用户 ID 获取 |
| `test-chinese-encoding.js` | 测试中文 Base64 编码 |
| `find-my-id.js` | 查找当前用户 ID |

**使用方法：**
```javascript
// 浏览器控制台执行
fetch(chrome.runtime.getURL('inject/api/test-xxx.js'))
  .then(res => res.text())
  .then(code => eval(code));
```

---

## 📈 扩展性设计

### **新增业务处理器示例**

假设要添加一个「消息通知」处理器：

```javascript
// 1. 创建新文件
// inject/processors/notification-processor.js

(function() {
  'use strict';
  
  function handleNotification(context) {
    var message = context.message;
    
    // 发送浏览器通知
    if (Notification.permission === 'granted') {
      new Notification('新消息', {
        body: message.senderName + ': ' + message.content,
        icon: '/icons/icon48.png'
      });
    }
  }
  
  // 订阅事件
  EventBus.on(ChatEventType.MESSAGE, handleNotification);
})();

// 2. 添加到 manifest.json
"content_scripts": [{
  "js": [
    // ... 其他脚本
    "inject/processors/notification-processor.js"
  ]
}]
```

**无需修改任何现有代码！**

---

## 🎓 学习价值

本项目涵盖了以下技术领域：

1. **Chrome Extension 开发**
   - Manifest V3 架构
   - Service Worker 生命周期
   - Content Script 注入
   - chrome.* API 使用

2. **协议逆向工程**
   - MessagePack 二进制格式
   - WebSocket 协议分析
   - API 签名算法
   - 抓包调试技巧

3. **架构设计模式**
   - 事件驱动架构
   - 发布/订阅模式
   - 分层架构（数据源 → 解析 → 业务）
   - 跨进程通信

4. **JavaScript 高级技巧**
   - Hook 原生对象
   - postMessage 通信
   - ArrayBuffer 处理
   - UTF-8 编码转换

---

## 🚀 快速开始

### **安装步骤**

1. 克隆项目
```bash
git clone <repo>
cd FishOps
```

2. 加载到 Chrome
```
chrome://extensions/ → 开发者模式 → 加载已解压的扩展程序
选择 FishOps 目录
```

3. 打开闲鱼
```
https://www.goofish.com/
```

4. 验证安装
```
F12 打开控制台
应该看到：
[EventBus] 事件总线已初始化
[WS 监听] WebSocket 数据源已初始化
[自动回复] 自动回复处理器已就绪
```

### **配置自动回复**

1. 右键扩展图标 → 选项
2. 点击「自动回复」标签
3. 勾选「启用自动回复」
4. 添加规则：
   - 触发关键字：`你好`
   - 回复内容：`您好！有什么可以帮您？`
5. 设置冷却时间：5000ms
6. 保存配置

### **测试**

用另一个账号发送「你好」，应该看到自动回复！

---

## 📝 常见问题

### **Q1: 为什么收不到消息？**
- 检查是否在闲鱼聊天页面
- 确认 WebSocket 已建立（控制台有日志）
- 检查 EventBus 是否正常初始化

### **Q2: 自动回复不生效？**
- 检查是否启用自动回复
- 查看配置是否正确加载
- 确认不在冷却时间内
- 检查是否是自己的消息（会跳过）

### **Q3: 发送消息失败？**
- 确认 WebSocket 连接正常
- 检查 userId 是否获取成功
- 查看 actualReceivers 是否包含双方 ID
- 验证 Base64 编码是否正确（中文容易出错）

---

## 🎯 未来规划

### **短期目标**
- [ ] 支持图片消息发送
- [ ] 支持语音消息
- [ ] 消息记录云端同步
- [ ] 智能回复建议（AI）

### **长期目标**
- [ ] 多账号管理
- [ ] 消息统计分析
- [ ] 自定义处理器市场
- [ ] 跨平台支持（Firefox、Edge）

---

## 📚 参考资料

- [Chrome Extension Manifest V3](https://developer.chrome.com/docs/extensions/mv3/intro/)
- [MessagePack 规范](https://github.com/msgpack/msgpack/blob/master/spec.md)
- [WebSocket RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455)
- [闲鱼开放平台](https://open.goofish.com/)

---

## 👨‍💻 贡献指南

欢迎提交 Issue 和 Pull Request！

**代码规范：**
- 使用 ES5 语法（兼容性）
- 遵循 JSHint 规范
- 添加详细注释
- 保持日志输出精简

**提交信息：**
```
feat: 添加图片消息支持
fix: 修复中文编码问题
docs: 更新架构文档
refactor: 重构事件总线
```

---

## 📄 许可证

MIT License

---

**最后更新时间：** 2024-02-18
