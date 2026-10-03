# 闲管家开放平台API

闲管家是闲鱼官方提供的开放平台，提供店铺管理和订单管理功能。

## 基础配置

| 参数 | 说明 |
|------|------|
| 基础URL | `https://open.goofish.pro` |
| 协议 | HTTPS |
| 认证方式 | MD5签名 |

## 认证机制

### 签名算法

```
sign = md5(appKey + ',' + bodyMd5 + ',' + timestamp + ',' + appSecret)
```

**参数说明**:
- `appKey`: 应用Key (在闲管家开放平台申请)
- `appSecret`: 应用密钥 (在闲管家开放平台申请)
- `bodyMd5`: 请求体JSON的MD5值 (32位小写十六进制)
- `timestamp`: 秒级时间戳 (Math.floor(Date.now() / 1000))

### 请求头

```javascript
headers: {
    'Content-Type': 'application/json'
}
```

### URL参数

| 参数 | 必填 | 说明 |
|------|------|------|
| appid | 是 | 应用ID |
| timestamp | 是 | 秒级时间戳 |
| sign | 是 | 签名值 |

### 请求体

请求体为JSON格式，包含业务参数。

## 店铺API

### 查询授权店铺列表

**接口**: `/api/open/user/authorize/list`

**请求示例**:
```javascript
var appId = 'your_app_id';
var appKey = 'your_app_key';
var appSecret = 'your_app_secret';
var timestamp = Math.floor(Date.now() / 1000);

var bodyParams = {
    appid: appId,
    timestamp: timestamp
};
var bodyJson = JSON.stringify(bodyParams);

// 生成签名
var bodyMd5 = md5(bodyJson);
var sign = md5(appKey + ',' + bodyMd5 + ',' + timestamp + ',' + appSecret);

// 构建URL
var url = 'https://open.goofish.pro/api/open/user/authorize/list?' +
    'appid=' + appId +
    '&timestamp=' + timestamp +
    '&sign=' + sign;

// 发送请求
fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bodyJson
}).then(response => response.json())
  .then(result => {
      if (result.code === 0) {
          var shops = result.data.list;
          shops.forEach(shop => {
              console.log('店铺ID:', shop.authorizeId);
              console.log('店铺名称:', shop.nick);
          });
      }
  });
```

**请求参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| appid | string | 是 | 应用ID |
| timestamp | number | 是 | 秒级时间戳 |

**响应格式**:
```json
{
    "code": 0,
    "msg": "success",
    "data": {
        "list": [
            {
                "authorizeId": "123456",
                "nick": "店铺昵称",
                "shopIcon": "https://xxx.jpg",
                "status": 1
            }
        ]
    }
}
```

**返回字段说明**:
| 字段 | 类型 | 说明 |
|------|------|------|
| authorizeId | string | 授权店铺ID |
| nick | string | 店铺昵称 |
| shopIcon | string | 店铺图标 |
| status | number | 店铺状态(1=正常) |

## 订单API

### 查询订单列表

**接口**: `/api/open/order/list`

**请求示例**:
```javascript
var authorizeId = '123456';  // 店铺授权ID
var orderStatus = 22;        // 订单状态
var pageNo = 1;
var pageSize = 50;

var bodyParams = {
    authorize_id: Number(authorizeId),
    order_status: orderStatus,
    page_no: pageNo,
    page_size: pageSize
};
var bodyJson = JSON.stringify(bodyParams);

// 生成签名
var bodyMd5 = md5(bodyJson);
var sign = md5(appKey + ',' + bodyMd5 + ',' + timestamp + ',' + appSecret);

// 构建URL
var url = 'https://open.goofish.pro/api/open/order/list?' +
    'appid=' + appId +
    '&timestamp=' + timestamp +
    '&sign=' + sign;

// 发送请求
fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bodyJson
}).then(response => response.json())
  .then(result => {
      if (result.code === 0) {
          var orders = result.data.list;
          console.log('订单数:', result.data.count);
      }
  });
```

**请求参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| authorize_id | number | 是 | 店铺授权ID |
| order_status | number | 否 | 订单状态(默认0=全部) |
| refund_status | number | 否 | 退款状态(默认-1=全部) |
| page_no | number | 否 | 页码(默认1) |
| page_size | number | 否 | 每页数量(默认50,最大100) |

**订单状态说明**:
| 状态码 | 说明 |
|--------|------|
| 0 | 全部 |
| 11 | 待付款 |
| 12 | 待发货 |
| 21 | 已发货 |
| 22 | 已完成 |
| 23 | 已退款 |
| 24 | 已关闭 |

**退款状态说明**:
| 状态码 | 说明 |
|--------|------|
| -1 | 全部 |
| 0 | 未申请 |
| 1 | 待商家处理 |
| 2 | 待买家退货 |
| 3 | 待商家收货 |
| 4 | 退款关闭 |
| 5 | 退款成功 |
| 6 | 已拒绝 |
| 8 | 待确认退货地址 |

**响应格式**:
```json
{
    "code": 0,
    "msg": "success",
    "data": {
        "list": [
            {
                "orderId": "123456789",
                "itemId": "商品ID",
                "itemTitle": "商品标题",
                "itemPrice": 10000,
                "itemNum": 1,
                "totalPrice": 10000,
                "buyerNick": "买家昵称",
                "status": 12,
                "createTime": "2024-01-01 12:00:00",
                "payTime": "2024-01-01 12:05:00",
                "shipTime": null,
                "receiver": {
                    "name": "收货人",
                    "phone": "138****8888",
                    "address": "浙江省杭州市xxx"
                }
            }
        ],
        "count": 100
    }
}
```

## 错误码

| 错误码 | 说明 |
|--------|------|
| 0 | 成功 |
| 1001 | 参数错误 |
| 1002 | 签名错误 |
| 1003 | 应用不存在 |
| 1004 | 应用已禁用 |
| 1005 | 授权已过期 |
| 1006 | 权限不足 |

## 使用限制

- 请求超时: 30秒
- 建议请求间隔: 300ms以上
- 每页最大数量: 100条

## 相关代码

- `background/xiangguanjia-service.js` - 闲管家API服务封装
  - `queryXiangyuShops()` - 查询店铺列表
  - `queryPendingShipmentOrders()` - 查询待发货订单
  - `queryOrderList()` - 查询订单列表(支持状态筛选)
  - `generateXiangguanjiaSign()` - 生成签名