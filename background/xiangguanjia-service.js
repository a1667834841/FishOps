/**
 * background/xiangguanjia-service.js - 闲管家开放平台API服务
 * 提供闲管家API的签名和调用功能
 */

// ==================== MD5 签名实现（纯JavaScript） ====================

/**
 * 计算字符串的MD5哈希值
 * 纯JavaScript实现，不依赖Web Crypto API
 * @param {string} string - 要计算哈希的字符串
 * @returns {string} - MD5哈希值（32位小写十六进制）
 */
function md5(string) {
  function md5cycle(x, k) {
    var a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]);
    x[1] = add32(b, x[1]);
    x[2] = add32(c, x[2]);
    x[3] = add32(d, x[3]);
  }

  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }

  function ff(a, b, c, d, x, s, t) {
    return cmn((b & c) | ((~b) & d), a, b, x, s, t);
  }

  function gg(a, b, c, d, x, s, t) {
    return cmn((b & d) | (c & (~d)), a, b, x, s, t);
  }

  function hh(a, b, c, d, x, s, t) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }

  function ii(a, b, c, d, x, s, t) {
    return cmn(c ^ (b | (~d)), a, b, x, s, t);
  }

  function md51(s) {
    var n = s.length,
      state = [1732584193, -271733879, -1732584194, 271733878], i;
    for (i = 64; i <= s.length; i += 64) {
      md5cycle(state, md5blk(s.substring(i - 64, i)));
    }
    s = s.substring(i - 64);
    var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < s.length; i++)
      tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
      md5cycle(state, tail);
      for (i = 0; i < 16; i++) tail[i] = 0;
    }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return state;
  }

  function md5blk(s) {
    var md5blks = [], i;
    for (i = 0; i < 64; i += 4) {
      md5blks[i >> 2] = s.charCodeAt(i) +
        (s.charCodeAt(i + 1) << 8) +
        (s.charCodeAt(i + 2) << 16) +
        (s.charCodeAt(i + 3) << 24);
    }
    return md5blks;
  }

  var hex_chr = '0123456789abcdef'.split('');

  function rhex(n) {
    var s = '', j = 0;
    for (; j < 4; j++)
      s += hex_chr[(n >> (j * 8 + 4)) & 0x0F] + hex_chr[(n >> (j * 8)) & 0x0F];
    return s;
  }

  function hex(x) {
    for (var i = 0; i < x.length; i++)
      x[i] = rhex(x[i]);
    return x.join('');
  }

  function add32(a, b) {
    return (a + b) & 0xFFFFFFFF;
  }

  return hex(md51(string));
}

/**
 * 生成闲管家API签名
 * 签名算法：MD5(appKey + ',' + bodyMd5 + ',' + timestamp + ',' + appSecret)
 * @param {string} appKey - 应用Key
 * @param {string} appSecret - 应用Secret
 * @param {string} bodyJson - 请求体的JSON字符串
 * @param {number} timestamp - 时间戳（秒）
 * @returns {string} - 签名值
 */
function generateXiangguanjiaSign(appKey, appSecret, bodyJson, timestamp) {
  var bodyMd5 = md5(bodyJson);
  var signString = appKey + ',' + bodyMd5 + ',' + timestamp + ',' + appSecret;
  return md5(signString);
}

// ==================== API 调用函数 ====================

/**
 * 查询闲鱼店铺列表
 * @param {Object} config - 配置对象，包含 xgjAppKey 和 xgjAppSecret
 * @returns {Promise<Object>} - API响应结果
 */
async function queryXiangyuShops(config) {
  var appId = config.xgjAppId;
  var appKey = config.xgjAppKey;
  var appSecret = config.xgjAppSecret;

  // 参数校验
  if (!appKey || !appSecret) {
    return {
      success: false,
      error: '请先配置 App Key 和 App Secret'
    };
  }

  // 注意：timestamp 使用秒级时间戳
  var timestamp = Math.floor(Date.now() / 1000);

  // 构建body参数（不含sign），用于签名计算
  var bodyParams = {
    appid: appId,
    timestamp: timestamp
  };
  var bodyJson = JSON.stringify(bodyParams);

  // 生成签名（使用body的MD5）
  var sign = generateXiangguanjiaSign(appKey, appSecret, bodyJson, timestamp);

  // 创建超时控制
  var timeout = 30000; // 30秒超时
  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, timeout);

  try {
    // 构建URL参数
    var queryParams = new URLSearchParams();
    if (appId) queryParams.append('appid', appId);
    queryParams.append('timestamp', timestamp.toString());
    queryParams.append('sign', sign);

    var url = 'https://open.goofish.pro/api/open/user/authorize/list?' + queryParams.toString();

    console.log('[Xiangguanjia] ========== 请求参数 ==========');
    console.log('[Xiangguanjia] URL:', url);
    console.log('[Xiangguanjia] appid:', appId);
    console.log('[Xiangguanjia] timestamp:', timestamp);
    console.log('[Xiangguanjia] sign:', sign);
    console.log('[Xiangguanjia] body:', bodyJson);
    console.log('[Xiangguanjia] ================================');

    var response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: bodyJson,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log('[Xiangguanjia] ========== HTTP错误 ==========');
      console.log('[Xiangguanjia] Status:', response.status, response.statusText);
      return {
        success: false,
        error: 'HTTP错误: ' + response.status + ' ' + response.statusText
      };
    }

    var result = await response.json();
    console.log('[Xiangguanjia] ========== 响应结果 ==========');
    console.log('[Xiangguanjia] Response:', result);
    console.log('[Xiangguanjia] ===============================');

    // 检查API返回状态
    if (result.code !== 0 && result.code !== '0') {
      return {
        success: false,
        error: result.msg || result.message || 'API返回错误',
        code: result.code
      };
    }

    // 获取店铺列表（实际数据在 data.list 中）
    var shopList = result.data?.list || result.data || result.result || [];

    return {
      success: true,
      data: result.data || result.result || result,
      shops: shopList
    };
  } catch (e) {
    clearTimeout(timeoutId);

    if (e.name === 'AbortError') {
      return {
        success: false,
        error: '请求超时，请检查网络连接'
      };
    }

    console.error('[Xiangguanjia] 请求失败:', e);
    return {
      success: false,
      error: '请求失败: ' + e.message
    };
  }
}

/**
 * 查询待发货订单列表
 * @param {Object} config - 配置对象，包含 xgjAppId, xgjAppKey, xgjAppSecret
 * @param {Object} options - 查询选项
 * @param {string|number} options.authorizeId - 店铺授权 ID
 * @param {number} options.pageNo - 页码，默认 1
 * @param {number} options.pageSize - 每页数量，默认 100（最大 100）
 * @returns {Promise<Object>} - API 响应结果
 */
async function queryPendingShipmentOrders(config, options) {
  var appId = config.xgjAppId;
  var appKey = config.xgjAppKey;
  var appSecret = config.xgjAppSecret;

  // 参数校验
  if (!appKey || !appSecret) {
    return {
      success: false,
      error: '请先配置 App Key 和 App Secret'
    };
  }

  if (!options || !options.authorizeId) {
    return {
      success: false,
      error: '请指定店铺授权 ID'
    };
  }

  var pageNo = options.pageNo || 1;
  var pageSize = Math.min(options.pageSize || 100, 100); // 最大 100

  // 注意：timestamp 使用秒级时间戳
  var timestamp = Math.floor(Date.now() / 1000);

  // 构建 body 参数（不含 sign），用于签名计算
  var bodyParams = {
    authorize_id: Number(options.authorizeId),
    order_status: 22,  // 22=待发货状态
    page_no: pageNo,
    page_size: pageSize
  };
  var bodyJson = JSON.stringify(bodyParams);

  // 生成签名（使用 body 的 MD5）
  var sign = generateXiangguanjiaSign(appKey, appSecret, bodyJson, timestamp);

  // 创建超时控制
  var timeout = 30000; // 30 秒超时
  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, timeout);

  try {
    // 构建 URL 参数
    var queryParams = new URLSearchParams();
    if (appId) queryParams.append('appid', appId);
    queryParams.append('timestamp', timestamp.toString());
    queryParams.append('sign', sign);

    var url = 'https://open.goofish.pro/api/open/order/list?' + queryParams.toString();

    console.log('[Xiangguanjia] ========== 查询待发货订单请求 ==========');
    console.log('[Xiangguanjia] URL:', url);
    console.log('[Xiangguanjia] authorize_id:', options.authorizeId);
    console.log('[Xiangguanjia] order_status: 22 (待发货)');
    console.log('[Xiangguanjia] page_no:', pageNo);
    console.log('[Xiangguanjia] page_size:', pageSize);
    console.log('[Xiangguanjia] timestamp:', timestamp);
    console.log('[Xiangguanjia] sign:', sign);
    console.log('[Xiangguanjia] body:', bodyJson);
    console.log('[Xiangguanjia] ========================================');

    var response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: bodyJson,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log('[Xiangguanjia] ========== HTTP 错误 ==========');
      console.log('[Xiangguanjia] Status:', response.status, response.statusText);
      return {
        success: false,
        error: 'HTTP 错误：' + response.status + ' ' + response.statusText
      };
    }

    var result = await response.json();
    console.log('[Xiangguanjia] ========== 响应结果 ==========');
    console.log('[Xiangguanjia] Response:', result);
    console.log('[Xiangguanjia] ===============================');

    // 检查 API 返回状态
    if (result.code !== 0 && result.code !== '0') {
      return {
        success: false,
        error: result.msg || result.message || 'API 返回错误',
        code: result.code
      };
    }

    // 获取订单列表（实际数据在 data.list 中）
    var orderList = result.data?.list || [];
    var totalCount = result.data?.count || 0;

    console.log('[Xiangguanjia] 查询成功，本页' + orderList.length + '条，总计' + totalCount + '条');

    return {
      success: true,
      data: result.data || result.result || result,
      orders: orderList,
      count: totalCount,
      pageNo: pageNo,
      pageSize: pageSize
    };
  } catch (e) {
    clearTimeout(timeoutId);

    if (e.name === 'AbortError') {
      return {
        success: false,
        error: '请求超时，请检查网络连接'
      };
    }

    console.error('[Xiangguanjia] 请求失败:', e);
    return {
      success: false,
      error: '请求失败：' + e.message
    };
  }
}

/**
 * 测试闲管家 API 连接
 * @param {Object} config - 配置对象
 * @returns {Promise<Object>} - 测试结果
 */
async function testXiangguanjiaConnection(config) {
  var result = await queryXiangyuShops(config);

  if (result.success) {
    var shopCount = (result.shops && result.shops.length) || 0;
    return {
      success: true,
      message: '连接成功，共 ' + shopCount + ' 个授权店铺'
    };
  }

  return result;
}

/**
 * 查询订单列表（支持状态筛选）
 * @param {Object} config - 配置对象，包含 xgjAppId, xgjAppKey, xgjAppSecret
 * @param {Object} options - 查询选项
 * @param {string|number} options.authorizeId - 店铺授权 ID
 * @param {number} options.orderStatus - 订单状态（11=待付款，12=待发货，21=已发货，22=已完成，23=已退款，24=已关闭，0=全部）
 * @param {number} options.refundStatus - 退款状态（0=未申请，1=待商家处理，2=待买家退货，3=待商家收货，4=退款关闭，5=退款成功，6=已拒绝，8=待确认退货地址，-1=全部）
 * @param {number} options.pageNo - 页码，默认 1
 * @param {number} options.pageSize - 每页数量，默认 50（最大 100）
 * @returns {Promise<Object>} - API 响应结果
 */
async function queryOrderList(config, options) {
  var appId = config.xgjAppId;
  var appKey = config.xgjAppKey;
  var appSecret = config.xgjAppSecret;

  // 参数校验
  if (!appKey || !appSecret) {
    return {
      success: false,
      error: '请先配置 App Key 和 App Secret'
    };
  }

  if (!options || !options.authorizeId) {
    return {
      success: false,
      error: '请指定店铺授权 ID'
    };
  }

  var pageNo = options.pageNo || 1;
  var pageSize = Math.min(options.pageSize || 50, 100); // 最大 100
  var orderStatus = options.orderStatus !== undefined ? options.orderStatus : 0; // 默认 0=全部状态
  var refundStatus = options.refundStatus !== undefined ? options.refundStatus : -1; // 默认 -1=不筛选退款状态

  // 注意：timestamp 使用秒级时间戳
  var timestamp = Math.floor(Date.now() / 1000);

  // 构建 body 参数（不含 sign），用于签名计算
  var bodyParams = {
    authorize_id: Number(options.authorizeId),
    order_status: orderStatus,
    page_no: pageNo,
    page_size: pageSize
  };
  
  // 如果指定了退款状态，添加到请求参数
  if (refundStatus >= 0) {
    bodyParams.refund_status = refundStatus;
  }
  
  var bodyJson = JSON.stringify(bodyParams);

  // 生成签名（使用 body 的 MD5）
  var sign = generateXiangguanjiaSign(appKey, appSecret, bodyJson, timestamp);

  // 创建超时控制
  var timeout = 30000; // 30 秒超时
  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, timeout);

  try {
    // 构建 URL 参数
    var queryParams = new URLSearchParams();
    if (appId) queryParams.append('appid', appId);
    queryParams.append('timestamp', timestamp.toString());
    queryParams.append('sign', sign);

    var url = 'https://open.goofish.pro/api/open/order/list?' + queryParams.toString();

    console.log('[Xiangguanjia] ========== 查询订单列表请求 ==========');
    console.log('[Xiangguanjia] URL:', url);
    console.log('[Xiangguanjia] authorize_id:', options.authorizeId);
    console.log('[Xiangguanjia] order_status:', orderStatus);
    if (refundStatus >= 0) {
      console.log('[Xiangguanjia] refund_status:', refundStatus);
    }
    console.log('[Xiangguanjia] page_no:', pageNo);
    console.log('[Xiangguanjia] page_size:', pageSize);
    console.log('[Xiangguanjia] timestamp:', timestamp);
    console.log('[Xiangguanjia] sign:', sign);
    console.log('[Xiangguanjia] body:', bodyJson);
    console.log('[Xiangguanjia] ========================================');

    var response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: bodyJson,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log('[Xiangguanjia] ========== HTTP 错误 ==========');
      console.log('[Xiangguanjia] Status:', response.status, response.statusText);
      return {
        success: false,
        error: 'HTTP 错误：' + response.status + ' ' + response.statusText
      };
    }

    var result = await response.json();
    console.log('[Xiangguanjia] ========== 响应结果 ==========');
    console.log('[Xiangguanjia] Response:', result);
    console.log('[Xiangguanjia] ===============================');

    // 检查 API 返回状态
    if (result.code !== 0 && result.code !== '0') {
      return {
        success: false,
        error: result.msg || result.message || 'API 返回错误',
        code: result.code
      };
    }

    // 获取订单列表（实际数据在 data.list 中）
    var orderList = result.data?.list || [];
    var totalCount = result.data?.count || 0;

    console.log('[Xiangguanjia] 查询成功，本页' + orderList.length + '条，总计' + totalCount + '条');

    return {
      success: true,
      data: result.data || result.result || result,
      orders: orderList,
      count: totalCount,
      pageNo: pageNo,
      pageSize: pageSize
    };
  } catch (e) {
    clearTimeout(timeoutId);

    if (e.name === 'AbortError') {
      return {
        success: false,
        error: '请求超时，请检查网络连接'
      };
    }

    console.error('[Xiangguanjia] 请求失败:', e);
    return {
      success: false,
      error: '请求失败：' + e.message
    };
  }
}

console.log('[Xiangguanjia] 闲管家 API 服务已加载');
