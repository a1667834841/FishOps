# 闲鱼WebSocket API (LWP协议)

闲鱼聊天功能使用WebSocket进行实时消息推送，采用LWP(LightWeight Protocol)协议。

## 连接信息

| 项目 | 值 |
|------|-----|
| WebSocket URL | `wss://wss-goofish.dingtalk.com/` |
| 协议 | WSS (WebSocket Secure) |
| 消息格式 | JSON |

## LWP协议格式

### 请求消息

```json
{
    "lwp": "/r/Conversation/listNewestPagination",
    "headers": {
        "mid": "1234567890123 0"
    },
    "body": [参数数组]
}
```

**字段说明**:
| 字段 | 类型 | 说明 |
|------|------|------|
| lwp | string | 路由路径 |
| headers.mid | string | 消息ID (格式: `{随机数}{时间戳} 0`) |
| body | array | 请求参数数组 |

### 响应消息

```json
{
    "code": 200,
    "headers": {
        "mid": "1234567890123 0"
    },
    "body": { ... }
}
```

**响应码说明**:
| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 0 | 成功 |
| 其他 | 失败 |

## 会话管理

### 获取会话列表

**路由**: `/r/Conversation/listNewestPagination`

**请求参数**:
```javascript
// [maxSortIndex, pageSize]
// maxSortIndex: 分页游标，首次请求使用 JavaScript 安全最大整数 (9007199254740991)
// pageSize: 每页数量，默认20
var body = [9007199254740991, 20];

// 构建请求
var payload = {
    lwp: '/r/Conversation/listNewestPagination',
    headers: { mid: generateMid() },
    body: body
};

ws.send(JSON.stringify(payload));
```

**响应解析**:
```javascript
// 响应结构
{
    "code": 200,
    "body": {
        "userConvs": [
            {
                "singleChatUserConversation": {
                    "cid": "123456789@goofish",
                    "redPoint": 0,
                    "modifyTime": 1704067200000,
                    "joinTime": 1704067200000,
                    "lastMessage": {
                        "message": {
                            "cid": "123456789@goofish",
                            "createAt": 1704067200000,
                            "content": {
                                "custom": {
                                    "summary": "最后消息内容"
                                }
                            },
                            "extension": {
                                "reminderTitle": "对方用户名",
                                "reminderUrl": "https://2...itemId=xxx&peerUserId=xxx"
                            }
                        }
                    }
                },
                "singleChatConversation": {
                    "extension": {}
                }
            }
        ],
        "hasMore": true
    }
}
```

**返回字段说明**:
| 字段 | 类型 | 说明 |
|------|------|------|
| cid | string | 会话ID |
| redPoint | number | 未读数 |
| modifyTime | number | 修改时间戳 |
| lastMessage.message.content.custom.summary | string | 最后消息摘要 |
| lastMessage.message.extension.reminderTitle | string | 对方用户名 |
| lastMessage.message.extension.reminderUrl | string | 扩展信息URL(含itemId等) |

### 会话分页

- 使用 `hasMore` 字段判断是否还有更多
- 下一页使用最后一个会话的 `sortIndex` 作为 `maxSortIndex`
- 建议请求间隔: 300ms

## 消息历史

### 获取消息历史

**路由**: `/r/MessageManager/listUserMessages`

**请求参数**:
```javascript
// [cid, isReverse, anchor, count, includeInfo]
// cid: 会话ID (格式: "123456789@goofish")
// isReverse: 是否反向获取 (false)
// anchor: 翻页锚点，首次请求使用最大整数
// count: 获取条数，默认20
// includeInfo: 是否包含信息 (false)
var cid = "123456789@goofish";
var body = [cid, false, 9007199254740991, 20, false];

var payload = {
    lwp: '/r/MessageManager/listUserMessages',
    headers: { mid: generateMid() },
    body: body
};
```

**响应解析**:
```javascript
{
    "code": 200,
    "body": {
        "userMessageModels": [
            {
                "readStatus": 0,
                "message": {
                    "messageId": "msg_123",
                    "cid": "123456789@goofish",
                    "createAt": 1704067200000,
                    "content": {
                        "contentType": 101,
                        "custom": {
                            "type": 1,
                            "data": "base64编码的消息内容"
                        }
                    },
                    "extension": {
                        "senderUserId": "987654321",
                        "reminderTitle": "发送者昵称",
                        "itemId": "123456"
                    }
                }
            }
        ],
        "nextCursor": 1704067100000
    }
}
```

**消息内容解析**:
```javascript
// content.custom.data 是 base64 编码的内容，需要解码
var rawData = message.content.custom.data;
var decoded = decodeURIComponent(escape(atob(rawData)));
var messageData = JSON.parse(decoded);

// messageData 结构
{
    "contentType": 1,
    "text": {
        "text": "消息内容"
    }
}
```

### 分页获取

- 使用 `nextCursor` 作为下一页的 `anchor`
- 当 `messages.length < count` 或 `nextCursor === 0` 时，表示已获取全部

## 消息发送

### 发送聊天消息

**路由**: `/r/MessageSend/sendByReceiverScope`

**请求参数**:
```javascript
var uuid = generateUuid();  // 格式: "-{时间戳}{随机数}"
var mid = generateMid();    // 格式: "{随机数}{时间戳} 0"

var payload = {
    lwp: '/r/MessageSend/sendByReceiverScope',
    headers: { mid: mid },
    body: [
        {
            uuid: uuid,
            cid: sessionId + '@goofish',
            conversationType: 1,
            content: {
                contentType: 101,
                custom: {
                    type: 1,
                    data: base64编码的消息内容
                }
            },
            redPointPolicy: 0,
            extension: { extJson: '{}' },
            ctx: {
                appVersion: '1.0',
                platform: 'web'
            },
            mtags: {},
            msgReadStatusSetting: 1
        },
        {
            // 实际接收者数组
            actualReceivers: [
                receiverId + '@goofish',  // 对方ID
                myId + '@goofish'         // 自己ID
            ]
        }
    ]
};
```

**消息内容编码**:
```javascript
// 消息内容需要 JSON 序列化后再 base64 编码
var messageContent = {
    contentType: 1,
    text: {
        text: "消息内容"
    }
};
var dataBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(messageContent))));
```

**ID生成函数**:
```javascript
// 生成MID
function generateMid() {
    var randomPart = Math.floor(Math.random() * 1000);
    var timestamp = Date.now();
    return randomPart + '' + timestamp + ' 0';
}

// 生成UUID
function generateUuid() {
    var timestamp = Date.now();
    var randomPart = Math.floor(Math.random() * 10000);
    return '-' + timestamp + randomPart;
}
```

## 消息类型

| contentType | 说明 |
|-------------|------|
| 1 | 文本消息 |
| 2 | 图片消息 |
| 3 | 语音消息 |
| 4 | 商品卡片 |
| 5 | 订单消息 |

## 实时消息推送

### 消息推送格式

WebSocket会推送以下类型消息：

```javascript
// 普通消息
{
    "code": 200,
    "body": {
        "content": { ... },
        "extension": {
            "senderUserId": "123456",
            "reminderTitle": "发送者昵称",
            "reminderUrl": "https://...itemId=xxx"
        },
        "createAt": 1704067200000,
        "messageId": "msg_xxx"
    }
}

// 同步推送
{
    "code": 200,
    "body": {
        "syncPushPackage": {
            "data": [
                {
                    "data": "base64编码的数据"
                }
            ]
        }
    }
}
```

### 消息类型判断

```javascript
// 判断消息类型
function getMessageType(data) {
    if (data['3'] && data['3']['redReminder']) return 'order';       // 订单消息
    if (data['1'] && data['1']['10'] && data['1']['10']['reminderContent']) return 'chat';  // 聊天消息
    if (data['3'] && data['3']['systemNotice']) return 'system';     // 系统消息
    return 'unknown';
}
```

## 相关代码

- `inject/websocket/websocket-data-source.js` - WebSocket拦截器
- `inject/chat-parser.js` - 消息解析器
- `inject/api/chat-history.js` - 聊天历史API
- `inject/api/chat-sender.js` - 消息发送API
- `inject/api/chat-sync.js` - 聊天同步模块

## 使用限制

- 建议请求间隔: 300ms
- 消息超时: 10秒
- WebSocket连接需要保持活跃