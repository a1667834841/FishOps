# 闲鱼API文档

本文档整理了FishOps项目中所使用的闲鱼平台API接口。

## API分类

### 1. 闲鱼内部API (MTOP协议)
通过阿里巴巴MTOP网关调用闲鱼服务，需要签名认证。

- [用户API](./xianyu-internal-api.md#用户api) - 获取当前登录用户信息
- [商品API](./xianyu-internal-api.md#商品api) - 获取商品详情

### 2. 闲管家开放平台API
闲鱼官方开放平台API，提供店铺和订单管理功能。

- [店铺API](./xiangguanjia-api.md#店铺api) - 查询授权店铺列表
- [订单API](./xiangguanjia-api.md#订单api) - 查询订单列表

### 3. WebSocket接口 (LWP协议)
闲鱼实时消息推送协议，用于聊天功能。

- [会话管理](./websocket-api.md#会话管理) - 获取会话列表
- [消息历史](./websocket-api.md#消息历史) - 获取聊天记录
- [消息发送](./websocket-api.md#消息发送) - 发送聊天消息

### 4. 自动回复系统
FishOps 扩展功能模块

- [自动回复处理器](./auto-reply-api.md) - 关键词回复与AI智能回复

## 认证机制

### MTOP签名
```javascript
sign = md5(token + "&" + t + "&" + appKey + "&" + data)
```
- `token`: 从Cookie `_m_h5_tk` 或 `_m_h` 获取
- `t`: 毫秒级时间戳
- `appKey`: 应用Key (固定值: `34839810`)
- `data`: 请求参数JSON字符串

### 闲管家签名
```javascript
sign = md5(appKey + ',' + bodyMd5 + ',' + timestamp + ',' + appSecret)
```
- `appKey`: 应用Key
- `bodyMd5`: 请求体JSON的MD5值
- `timestamp`: 秒级时间戳
- `appSecret`: 应用密钥

## 数据格式

- 消息编码: UTF-8
- 消息体: JSON
- WebSocket二进制数据: MessagePack

## 相关文件

- `inject/api/user-api.js` - 用户API封装
- `inject/api/goods-api.js` - 商品API封装
- `inject/api/chat-history.js` - 聊天历史API封装
- `inject/api/chat-sender.js` - 消息发送API封装
- `inject/api/chat-sync.js` - 聊天同步模块
- `inject/websocket/websocket-data-source.js` - WebSocket拦截器
- `inject/chat-parser.js` - 消息解析器
- `inject/handlers/auto-reply-processor.js` - 自动回复处理器
- `background/xiangguanjia-service.js` - 闲管家API服务