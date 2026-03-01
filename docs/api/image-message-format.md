# 闲鱼WebSocket图片消息格式调研

## 概述

本文档调研闲鱼聊天WebSocket消息中图片信息的传输格式和数据结构。

## 消息类型定义 (contentType)

| contentType | 说明 | 数据格式 |
|-------------|------|----------|
| 1 | 文本消息 | JSON (text.text) |
| 2 | 图片消息 | 图片URL或base64 |
| 3 | 语音消息 | 音频URL或base64 |
| 4 | 商品卡片 | dxCard结构 |
| 5 | 订单消息 | order结构 |

## 图片消息数据结构

### 响应中的消息格式 (来自 WebSocket)

```javascript
{
    "message": {
        "messageId": "msg_xxx",
        "cid": "123456789@goofish",
        "content": {
            "contentType": 2,  // 图片消息
            "custom": {
                "type": 2,
                "summary": "[图片]",
                "data": "base64编码的图片数据或图片URL"
            }
        },
        "extension": {
            "senderUserId": "123456",
            "reminderTitle": "发送者昵称"
        },
        "createAt": 1704067200000
    }
}
```

### 解析后的数据结构

解析后的ChatMessage对象：

```javascript
{
    type: 'chat',
    messageId: 'msg_xxx',
    cid: '123456789@goofish',
    chatId: '123456789',
    senderId: '123456',
    senderName: '发送者昵称',
    content: '[图片]',           // 图片消息的summary
    contentType: 2,              // 2 = 图片消息
    rawData: '图片URL或base64数据',  // 原始图片数据
    createAt: 1704067200000,
    itemId: '',
    direction: 'in'
}
```

## 图片数据提取方法

### 方法1: 从 custom.data 提取 (推荐)

```javascript
function extractImageData(message) {
    var custom = message.content && message.content.custom;

    if (!custom || custom.contentType !== 2) {
        return null;
    }

    var rawData = custom.data;

    if (!rawData) {
        return null;
    }

    // 检查是否是base64编码的图片数据
    if (rawData.startsWith('data:image')) {
        // 完整base64图片数据
        return {
            type: 'base64',
            data: rawData
        };
    }

    // 检查是否是图片URL
    if (rawData.startsWith('http')) {
        return {
            type: 'url',
            url: rawData
        };
    }

    // 尝试base64解码
    try {
        var decoded = decodeURIComponent(escape(atob(rawData)));

        // 可能是JSON格式的图片信息
        var parsed = JSON.parse(decoded);
        if (parsed.imgUrl || parsed.imageUrl || parsed.url) {
            return {
                type: 'url',
                url: parsed.imgUrl || parsed.imageUrl || parsed.url
            };
        }

        // 尝试直接作为图片数据处理
        if (decoded.startsWith('data:image') || decoded.startsWith('http')) {
            return {
                type: decoded.startsWith('data:image') ? 'base64' : 'url',
                data: decoded
            };
        }
    } catch (e) {
        console.warn('图片数据解析失败:', e);
    }

    return null;
}
```

### 方法2: 从 messageData 提取 (WebSocket实时消息)

```javascript
function extractImageFromMessageData(chatData) {
    var messageData = chatData["6"] || {};

    // 图片数据在 messageData["3"]["5"] 中
    if (messageData["3"] && messageData["3"]["5"]) {
        var imageData = messageData["3"]["5"];

        try {
            // 尝试解析JSON
            var parsed = JSON.parse(imageData);

            // 检查是否是图片格式
            if (parsed.contentType === 2 || parsed.type === 2) {
                // 可能包含图片URL
                return {
                    contentType: 2,
                    url: parsed.url || parsed.imgUrl || parsed.imageUrl || '',
                    data: parsed
                };
            }
        } catch (e) {
            // 可能是直接返回的图片URL
            if (imageData.startsWith('http') || imageData.startsWith('data:image')) {
                return {
                    contentType: 2,
                    data: imageData
                };
            }
        }
    }

    return null;
}
```

### 方法3: 处理商品图片卡片中的图片

```javascript
function extractImageFromDxCard(rawData) {
    if (!rawData) return null;

    try {
        var decoded = decodeURIComponent(escape(atob(rawData)));
        var cardData = JSON.parse(decoded);

        // 检查是否是商品卡片
        if (cardData.dxCard && cardData.dxCard.item && cardData.dxCard.item.main) {
            var main = cardData.dxCard.item.main;

            // 商品图片
            if (main.picInfo && main.picInfo.picUrl) {
                return {
                    type: 'goods_image',
                    url: main.picInfo.picUrl
                };
            }
        }
    } catch (e) {
        // 不是商品卡片格式
    }

    return null;
}
```

## 修改建议

### 1. 更新 chat-parser.js

在 `handleStringDataItem` 和 `handleObjectDataItem` 函数中添加图片消息处理：

```javascript
// 在消息类型判断后添加
function handleImageMessage(messageData, contentData) {
    var custom = contentData.custom;

    if (!custom || (custom.contentType !== 2 && custom.type !== 2)) {
        return null;
    }

    var rawData = custom.data;

    // 提取图片URL或base64数据
    var imageUrl = '';
    var imageData = '';

    if (rawData) {
        // 情况1: 直接是URL
        if (rawData.startsWith('http')) {
            imageUrl = rawData;
        }
        // 情况2: base64图片数据
        else if (rawData.startsWith('data:image')) {
            imageData = rawData;
        }
        // 情况3: 需要解析
        else {
            try {
                var decoded = decodeURIComponent(escape(atob(rawData)));
                var parsed = JSON.parse(decoded);
                imageUrl = parsed.url || parsed.imgUrl || parsed.imageUrl || '';
                imageData = parsed.data || '';
            } catch (e) {
                console.warn('图片数据解析失败:', e);
            }
        }
    }

    return {
        type: 'image',
        imageUrl: imageUrl,
        imageData: imageData,
        thumbnail: imageUrl ? imageUrl + '_150x150.jpg' : ''  // 缩略图
    };
}
```

### 2. 更新 ChatMessage 数据结构

```typescript
interface ChatMessage {
    // ... 其他字段
    contentType: number;        // 1=文本, 2=图片, 3=语音, 4=商品, 5=订单
    content: string;            // 消息摘要 "[图片]" / "[语音]"
    rawData: string | undefined; // 原始数据(可能包含图片URL)
    // 新增图片相关字段
    imageUrl?: string;          // 图片URL
    thumbnailUrl?: string;      // 缩略图URL
    imageData?: string;        // base64图片数据
}
```

### 3. 添加图片消息事件

```javascript
// 在 chat-parser.js 中添加
function emitImageMessage(imageInfo, context) {
    if (window.EventBus) {
        window.EventBus.emit(window.ChatEventType.IMAGE, {
            message: imageInfo,
            raw: context.raw,
            timestamp: Date.now(),
            source: 'websocket'
        });
    }
}

// 定义新的事件类型
window.ChatEventType = {
    MESSAGE: 'chat_message',
    IMAGE: 'image_message',     // 新增
    ORDER: 'order_message',
    SYSTEM: 'system_message',
    TYPING: 'typing_status',
    SYNC: 'sync_message'
};
```

### 4. 更新 auto-reply-processor.js

添加图片消息的处理逻辑（可选）：

```javascript
// 在 handleChatMessage 中添加
if (message.contentType === 2) {
    console.log(LOG_PREFIX, '🖼️ 收到图片消息:', message.imageUrl || '[图片]');
    // 可以选择跳过AI回复或使用不同的处理逻辑
    return;
}
```

## 验证方法

1. **抓包验证**: 使用Chrome DevTools监听WebSocket消息，发送一条图片消息，观察实际数据结构

2. **调试脚本**:
```javascript
// 在控制台执行
window.EventBus.on(window.ChatEventType.MESSAGE, function(context) {
    var msg = context.message;
    console.log('收到消息:', {
        contentType: msg.contentType,
        content: msg.content,
        rawData: msg.rawData ? (msg.rawData.substring(0, 100) + '...') : null
    });
});
```

## 注意事项

1. 图片URL可能是临时URL，有过期时间
2. 大图片可能是分片传输
3. 部分图片可能需要携带特定的请求头才能访问
4. 图片消息的summary通常是"[图片]"或"[图片]"

## 相关代码位置

| 文件 | 行号 | 说明 |
|------|------|------|
| inject/chat-parser.js | 143-168 | 消息解析逻辑 |
| inject/chat-parser.js | 280-315 | 消息类型判断 |
| inject/api/chat-history.js | 143-166 | RPC消息解析 |
| inject/handlers/auto-reply-processor.js | 280 | 回复发送 |