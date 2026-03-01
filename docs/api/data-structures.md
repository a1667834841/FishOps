# 数据结构与类型定义

本文档定义了FishOps项目中使用的数据结构和类型。

## 聊天消息

### ChatMessage 聊天消息

```typescript
interface ChatMessage {
    type: 'chat';
    messageId: string;          // 消息ID
    cid: string;                // 会话ID (含@goofish后缀)
    chatId: string;             // 会话ID (不含后缀)
    senderId: string;           // 发送者ID
    senderName: string;         // 发送者昵称
    receiverId: string;         // 接收者ID
    receiverName: string;       // 接收者昵称
    content: string;            // 消息内容
    contentType: number;        // 消息类型 (101=文本)
    rawData: string | undefined; // 原始数据(base64)
    createAt: number;          // 创建时间戳
    timestamp: string;         // 格式化时间字符串
    readStatus: number;        // 已读状态
    direction: 'in' | 'out';   // 消息方向 (in=接收, out=发送)
    itemId: string;            // 商品ID
    itemTitle: string;          // 商品标题
}
```

### Conversation 会话

```typescript
interface Conversation {
    cid: string;                // 会话ID
    peerUserName: string;       // 对方用户名
    lastMessage: string;        // 最后消息摘要
    lastMessageTime: number;    // 最后消息时间戳
    unreadCount: number;       // 未读数
    sortIndex: number;         // 排序索引
    visible: boolean;           // 是否可见
    itemId: string;            // 商品ID
    extension: object;         // 扩展信息
}
```

### MessageHistoryResult 消息历史结果

```typescript
interface MessageHistoryResult {
    success: boolean;
    chatId: string;
    messages: ChatMessage[];
    nextCursor: number;
    hasMore: boolean;
    raw?: any;
}
```

### ConversationListResult 会话列表结果

```typescript
interface ConversationListResult {
    success: boolean;
    conversations: Conversation[];
    hasMore: boolean;
    nextSortIndex: number;
    raw?: any;
}
```

## 商品

### GoodsDetail 商品详情

```typescript
interface GoodsDetail {
    itemId: string;             // 商品ID
    title: string;             // 标题
    description: string;       // 描述
    price: number | string;    // 当前价格(元)
    originalPrice: number | string; // 原价(元)
    picUrls: string[];         // 图片列表
    mainPic: string;           // 主图
    city: string;              // 城市
    categoryId: string;        // 分类ID
    deprecated: boolean;       // 是否已下架
    updatedAt: number;         // 更新时间
    skuList: SKU[];            // SKU列表
    hasSku: boolean;           // 是否有SKU
    skuCount: number;          // SKU数量
}
```

### SKU SKU规格

```typescript
interface SKU {
    skuId: string;             // SKU ID
    price: string;            // 价格(元)
    priceInCent: number;      // 价格(分)
    quantity: number;         // 库存数量
    properties: object;       // 规格属性 { "款式": "红色" }
    propertyText: string;      // 规格文本
}
```

## 订单 (闲管家)

### Order 订单

```typescript
interface Order {
    orderId: string;           // 订单ID
    itemId: string;           // 商品ID
    itemTitle: string;        // 商品标题
    itemPrice: number;        // 商品价格(分)
    itemNum: number;          // 数量
    totalPrice: number;       // 总价(分)
    buyerNick: string;        // 买家昵称
    status: number;           // 订单状态
    createTime: string;       // 创建时间
    payTime: string | null;   // 支付时间
    shipTime: string | null;  // 发货时间
    receiver: {
        name: string;         // 收货人
        phone: string;        // 联系电话
        address: string;      // 收货地址
    };
}
```

### Shop 店铺

```typescript
interface Shop {
    authorizeId: string;      // 授权ID
    nick: string;             // 店铺昵称
    shopIcon: string;         // 店铺图标
    status: number;           // 店铺状态
}
```

## 用户

### UserInfo 用户信息

```typescript
interface UserInfo {
    userId: string;           // 用户ID
    nick?: string;            // 昵称
    avatar?: string;          // 头像
}
```

## 事件类型

### ChatEventType 聊天事件类型

```typescript
const ChatEventType = {
    MESSAGE: 'chat_message',   // 收到新消息
    ORDER: 'order_message',   // 订单消息
    SYSTEM: 'system_message', // 系统消息
    TYPING: 'typing_status',  // 输入状态
    SYNC: 'sync_message'      // 同步消息
};
```

### EventContext 事件上下文

```typescript
interface EventContext {
    message: ChatMessage | OrderMessage | SystemMessage;
    raw: any;
    timestamp: number;
    source: 'websocket' | 'api';
}
```

## API响应格式

### SuccessResult 成功结果

```typescript
interface SuccessResult<T> {
    success: true;
    data: T;
    // ... 其他字段
}
```

### ErrorResult 错误结果

```typescript
interface ErrorResult {
    success: false;
    error: string;
    code?: number | string;
}
```

### APIResult API通用结果

```typescript
type APIResult<T> = SuccessResult<T> | ErrorResult;
```

## WebSocket消息

### WebSocket请求载荷

```typescript
interface WSRequestPayload {
    lwp: string;               // 路由路径
    headers: {
        mid: string;          // 消息ID
    };
    body: any[];              // 请求参数数组
}
```

### WebSocket响应载荷

```typescript
interface WSResponsePayload {
    code: number;             // 状态码 (200=成功)
    headers: {
        mid: string;          // 消息ID
    };
    body: any;
}
```

### LWP路由常量

```typescript
const LWP_ROUTES = {
    LIST_SESSIONS: '/r/Conversation/listNewestPagination',
    LIST_MESSAGES: '/r/MessageManager/listUserMessages',
    SEND_MESSAGE: '/r/MessageSend/sendByReceiverScope'
};
```

## 工具类型

### SendMessageOptions 发送消息选项

```typescript
interface SendMessageOptions {
    sessionId: string;        // 会话ID
    toUserId: string;         // 接收者ID
    myId: string;             // 发送者ID(自己)
    itemId?: string;          // 商品ID
    content: string;          // 消息内容
    contentType?: number;     // 消息类型 (默认101)
}
```

### SyncStats 同步统计

```typescript
interface SyncStats {
    totalConversations: number;  // 会话总数
    totalMessages: number;        // 消息总数
    syncedConversations: number;  // 同步成功的会话数
    errors: string[];             // 错误列表
    allMessages: ChatMessage[];   // 所有消息
}
```