/**
 * goods-list-service.js - 商品列表服务
 * 在 Service Worker 中运行，使用 chrome.cookies API 获取 Token
 */

var GOODS_LIST_LOG_PREFIX = '[GoodsListService]';

// 固定配置
var GOODS_LIST_APP_KEY = '34839810';
var GOODS_LIST_API_VERSION = '1.0';
var GOODS_LIST_API_NAME = 'mtop.idle.web.xyh.item.list';

// 缓存
var goodsListCacheData = {};
var GOODS_LIST_CACHE_EXPIRE = 10 * 60 * 1000; // 10分钟

// ==================== MD5 实现 ====================

function goodsListMd5(string) {
  function md5cycle(x, k) {
    var a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]); x[1] = add32(b, x[1]);
    x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
  }

  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }

  function md5blk(s) {
    var md5blks = [], i;
    for (i = 0; i < 64; i += 4) {
      md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) +
        (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    }
    return md5blks;
  }

  function add32(a, b) {
    return (a + b) & 0xFFFFFFFF;
  }

  function rhex(n) {
    var s = '', j;
    for (j = 0; j < 4; j++) {
      s += '0123456789abcdef'.charAt((n >> (j * 8 + 4)) & 0x0F) +
        '0123456789abcdef'.charAt((n >> (j * 8)) & 0x0F);
    }
    return s;
  }

  function hex(x) {
    for (var i = 0; i < x.length; i++) {
      x[i] = rhex(x[i]);
    }
    return x.join('');
  }

  var s = unescape(encodeURIComponent(string));
  var n = s.length;
  var state = [1732584193, -271733879, -1732584194, 271733878], i;

  for (i = 64; i <= n; i += 64) {
    md5cycle(state, md5blk(s.substring(i - 64, i)));
  }

  s = s.substring(i - 64);
  var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (i = 0; i < s.length; i++) {
    tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
  }
  tail[i >> 2] |= 0x80 << ((i % 4) << 3);
  if (i > 55) {
    md5cycle(state, tail);
    for (i = 0; i < 16; i++) tail[i] = 0;
  }
  tail[14] = n * 8;
  md5cycle(state, tail);

  return hex(state);
}

// ==================== 辅助函数 ====================

function generateGoodsListSign(t, token, data) {
  var msg = token + '&' + t + '&' + GOODS_LIST_APP_KEY + '&' + data;
  return goodsListMd5(msg);
}

/**
 * 获取闲鱼 Token 和 用户ID
 */
async function getGoofishAuthInfo() {
  try {
    // 获取 _m_h5_tk (token_timestamp 格式)
    var tokenCookie = await chrome.cookies.get({
      url: 'https://www.goofish.com',
      name: '_m_h5_tk'
    });

    var token = null;
    if (tokenCookie && tokenCookie.value) {
      var parts = tokenCookie.value.split('_');
      if (parts.length >= 1 && parts[0]) {
        token = parts[0];
        console.log(GOODS_LIST_LOG_PREFIX, '🔑 从 _m_h5_tk 获取 Token');
      }
    }

    // 备选: _m_h
    if (!token) {
      tokenCookie = await chrome.cookies.get({
        url: 'https://www.goofish.com',
        name: '_m_h'
      });
      if (tokenCookie && tokenCookie.value) {
        token = tokenCookie.value;
        console.log(GOODS_LIST_LOG_PREFIX, '🔑 从 _m_h 获取 Token');
      }
    }

    // 获取用户 ID (unb cookie)
    var userCookie = await chrome.cookies.get({
      url: 'https://www.goofish.com',
      name: 'unb'
    });

    var userId = null;
    if (userCookie && userCookie.value) {
      userId = userCookie.value;
      console.log(GOODS_LIST_LOG_PREFIX, '👤 从 unb 获取用户ID:', userId);
    }

    return { token: token, userId: userId };
  } catch (e) {
    console.error(GOODS_LIST_LOG_PREFIX, '获取认证信息失败:', e);
    return { token: null, userId: null };
  }
}

function parseGoodsListResponseData(data) {
  var goodsList = [];

  if (!data || !data.cardList || !Array.isArray(data.cardList)) {
    return { goodsList: [], hasMore: false };
  }

  data.cardList.forEach(function (card) {
    var cardData = card.cardData;
    if (!cardData) return;

    var goods = {
      itemId: cardData.id || '',
      title: cardData.title || '',
      price: '',
      picUrl: ''
    };

    if (cardData.priceInfo && cardData.priceInfo.price) {
      goods.price = cardData.priceInfo.price;
    }

    if (cardData.picInfo && cardData.picInfo.picUrl) {
      goods.picUrl = cardData.picInfo.picUrl;
    }

    if (goods.itemId) {
      goodsList.push(goods);
    }
  });

  // 使用响应中的 nextPage 字段判断是否有更多数据
  var hasMore = data.nextPage === true;

  return { goodsList: goodsList, hasMore: hasMore };
}

// ==================== 主函数 ====================

async function fetchGoodsList(pageNumber, pageSize) {
  pageNumber = pageNumber || 1;
  pageSize = pageSize || 20;

  // 检查缓存
  var cacheKey = 'page_' + pageNumber;
  if (goodsListCacheData[cacheKey]) {
    var cached = goodsListCacheData[cacheKey];
    if (Date.now() - cached.timestamp < GOODS_LIST_CACHE_EXPIRE) {
      console.log(GOODS_LIST_LOG_PREFIX, '✅ 使用缓存:', cacheKey);
      return cached.data;
    }
  }

  // 获取认证信息
  var authInfo = await getGoofishAuthInfo();
  if (!authInfo.token) {
    console.error(GOODS_LIST_LOG_PREFIX, '❌ 无法获取 Token');
    return { success: false, error: 'Token not found', goodsList: [], hasMore: false };
  }
  if (!authInfo.userId) {
    console.error(GOODS_LIST_LOG_PREFIX, '❌ 无法获取用户ID');
    return { success: false, error: 'User ID not found', goodsList: [], hasMore: false };
  }

  var timestamp = Date.now().toString();

  // 构造请求体数据（参照 curl 示例）
  var dataObj = {
    needGroupInfo: false,
    pageNumber: pageNumber,
    userId: authInfo.userId,
    pageSize: pageSize,
    groupName: '在售',
    groupId: 70746814,
    defaultGroup: true
  };
  var dataStr = JSON.stringify(dataObj);

  // 生成签名
  var sign = generateGoodsListSign(timestamp, authInfo.token, dataStr);

  // 构造 URL query 参数（不包含 data）
  var queryParams = {
    jsv: '2.7.2',
    appKey: GOODS_LIST_APP_KEY,
    t: timestamp,
    sign: sign,
    v: GOODS_LIST_API_VERSION,
    type: 'originaljson',
    accountSite: 'xianyu',
    dataType: 'json',
    timeout: '20000',
    api: GOODS_LIST_API_NAME,
    sessionOption: 'AutoLoginOnly',
    spm_cnt: 'a21ybx.personal.0.0',
    spm_pre: 'a21ybx.home.nav.1'
  };

  var queryString = Object.keys(queryParams).map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(queryParams[key]);
  }).join('&');

  var url = 'https://h5api.m.goofish.com/h5/' + GOODS_LIST_API_NAME + '/' + GOODS_LIST_API_VERSION + '/?' + queryString;

  // 构造 POST body (application/x-www-form-urlencoded)
  var postBody = 'data=' + encodeURIComponent(dataStr);

  console.log(GOODS_LIST_LOG_PREFIX, '🌐 请求商品列表: 第', pageNumber, '页, userId:', authInfo.userId);

  try {
    var response = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://www.goofish.com',
        'Referer': 'https://www.goofish.com/'
      },
      body: postBody,
      credentials: 'include'
    });

    var respData = await response.json();

    if (respData.ret && respData.ret[0].includes('SUCCESS')) {
      var parsed = parseGoodsListResponseData(respData.data || {});
      var result = {
        success: true,
        goodsList: parsed.goodsList,
        currentPage: pageNumber,
        hasMore: parsed.hasMore
      };

      // 写入缓存
      goodsListCacheData[cacheKey] = {
        timestamp: Date.now(),
        data: result
      };

      console.log(GOODS_LIST_LOG_PREFIX, '✅ 获取商品列表成功:', parsed.goodsList.length, '条, hasMore:', parsed.hasMore);
      return result;
    } else {
      console.warn(GOODS_LIST_LOG_PREFIX, '❌ API 返回错误:', respData.ret);
      return { success: false, error: respData.ret ? respData.ret[0] : 'API error', goodsList: [], hasMore: false };
    }
  } catch (err) {
    console.error(GOODS_LIST_LOG_PREFIX, '❌ 网络请求异常:', err);
    return { success: false, error: err.message, goodsList: [], hasMore: false };
  }
}

console.log(GOODS_LIST_LOG_PREFIX, '✅ 商品列表服务已加载');
