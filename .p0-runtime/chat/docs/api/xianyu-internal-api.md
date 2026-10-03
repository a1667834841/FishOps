# 闲鱼内部API (MTOP协议)

闲鱼内部API通过阿里巴巴MTOP网关调用，需要使用Cookie中的token进行签名认证。

## 基础配置

| 参数 | 值 |
|------|-----|
| AppKey | `34839810` |
| API版本 | `1.0` |
| 基础URL | `https://h5api.m.goofish.com/h5/` |
| 数据格式 | `originaljson` |
| 账户站点 | `xianyu` |

## 认证机制

### 获取Token

从Cookie中获取认证token：

```javascript
// 方式1: 从 _m_h5_tk 获取 (标准MTOP协议)
var match = document.cookie.match(/_m_h5_tk=([^;]+)/);
if (match && match[1]) {
    var token = match[1].split('_')[0];  // 取下划线前的部分
}

// 方式2: 从 _m_h 获取 (旧版)
var match = document.cookie.match(/_m_h=([^;]+)/);
if (match && match[1]) {
    var token = match[1];
}
```

### 生成签名

```javascript
function generateSign(t, token, data) {
    var msg = token + '&' + t + '&' + appKey + '&' + data;
    return md5(msg);
}

// 参数说明
// t: 毫秒级时间戳 (Date.now().toString())
// token: 从Cookie获取的认证token
// data: 请求参数JSON字符串
```

## 用户API

### 获取当前用户ID

**API**: `mtop.taobao.idlemessage.pc.loginuser.get`

**请求示例**:
```javascript
var timestamp = Date.now().toString();
var queryParams = {
    jsv: '2.7.2',
    appKey: '34839810',
    t: timestamp,
    sign: '',  // 需生成
    v: '1.0',
    type: 'originaljson',
    accountSite: 'xianyu',
    dataType: 'json',
    timeout: '20000',
    api: 'mtop.taobao.idlemessage.pc.loginuser.get',
    sessionOption: 'AutoLoginOnly',
    spm_cnt: 'a21ybx.im.0.0',
    spm_pre: 'a21ybx.home.sidebar.2.4c053da6OBdnko',
    log_id: '4c053da6OBdnko'
};

// 构建签名数据
var signData = Object.keys(queryParams)
    .map(key => key + '=' + queryParams[key])
    .join('&');

// 生成签名
var sign = generateSign(timestamp, token, signData);
queryParams.sign = sign;

// 构建完整URL
var url = 'https://h5api.m.goofish.com/h5/mtop.taobao.idlemessage.pc.loginuser.get/1.0/?' +
    Object.keys(queryParams)
    .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(queryParams[key]))
    .join('&');

// 发送请求
fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'
}).then(response => response.json())
  .then(data => {
      // 成功响应
      // { ret: ["SUCCESS::调用成功"], data: { userId: "123456789" } }
  });
```

**响应格式**:
```json
{
    "ret": ["SUCCESS::调用成功"],
    "data": {
        "userId": "123456789"
    }
}
```

## 商品API

### 获取商品详情

**API**: `mtop.taobao.idle.pc.detail`

**请求示例**:
```javascript
var itemId = "123456789";
var timestamp = Date.now().toString();
var dataObj = { itemId: itemId };
var dataStr = JSON.stringify(dataObj);

var sign = generateSign(timestamp, token, dataStr);

var queryParams = {
    jsv: '2.7.2',
    appKey: '34839810',
    t: timestamp,
    sign: sign,
    v: '1.0',
    type: 'originaljson',
    accountSite: 'xianyu',
    dataType: 'json',
    timeout: '20000',
    api: 'mtop.taobao.idle.pc.detail',
    data: dataStr
};

var url = 'https://h5api.m.goofish.com/h5/mtop.taobao.idle.pc.detail/1.0/?' +
    Object.keys(queryParams)
    .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(queryParams[key]))
    .join('&');
```

**响应格式**:
```json
{
    "ret": ["SUCCESS::调用成功"],
    "data": {
        "itemDO": {
            "id": "123456789",
            "title": "商品标题",
            "desc": "商品描述",
            "soldPrice": 10000,
            "marketPrice": 15000,
            "imageInfos": [
                { "url": "https://xxx.jpg" }
            ],
            "prov": "浙江省",
            "city": "杭州市",
            "categoryId": "123",
            "status": 0,
            "skuList": [
                {
                    "skuId": "sku123",
                    "price": 10000,
                    "quantity": 10,
                    "propertyList": [
                        { "propertyText": "款式", "valueText": "红色" }
                    ]
                }
            ]
        }
    }
}
```

**返回字段说明**:
| 字段 | 类型 | 说明 |
|------|------|------|
| itemDO.id | string | 商品ID |
| itemDO.title | string | 商品标题 |
| itemDO.desc | string | 商品描述 |
| itemDO.soldPrice | number | 售价(分) |
| itemDO.marketPrice | number | 原价(分) |
| itemDO.imageInfos | array | 图片列表 |
| itemDO.prov | string | 省份 |
| itemDO.city | string | 城市 |
| itemDO.categoryId | string | 分类ID |
| itemDO.status | number | 商品状态(0=上架,1=下架) |
| itemDO.skuList | array | SKU列表 |

## 错误码

| 错误码 | 说明 |
|--------|------|
| SUCCESS | 调用成功 |
| FAIL_SYS_TOKEN_EXPIRED | Token过期 |
| FAIL_SYS_USER_VALIDATE | 用户验证失败 |

## 使用限制

- 请求频率: 建议每次间隔300ms以上
- 超时时间: 20秒
- 需要携带Cookie (`credentials: 'include'`)