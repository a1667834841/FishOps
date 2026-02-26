/**
 * goods-list-api.js - 闲鱼商品列表 API
 * 提供获取用户商品列表的功能，包含签名生成和缓存机制
 */

(function () {
    'use strict';

    var LOG_PREFIX = '[GoodsListAPI]';

    // 固定配置
    var APP_KEY = '34839810';
    var API_VERSION = '1.0';
    var API_NAME = 'mtop.idle.web.xyh.item.list';

    // 缓存配置
    var CACHE_PREFIX = 'fishops_goods_list_cache_';
    var CACHE_EXPIRE_TIME = 10 * 60 * 1000; // 10分钟 (毫秒)

    // ==================== 纯 JS MD5 实现 ====================
    // Chrome 的 crypto.subtle 不支持 MD5，必须使用纯 JS 实现

    function md5(string) {
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

        // UTF-8 encode
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

    /**
     * 生成签名（同步）
     * 公式：sign = md5(token + "&" + t + "&" + appKey + "&" + data)
     */
    function generateSign(t, token, data) {
        var msg = token + '&' + t + '&' + APP_KEY + '&' + data;
        return md5(msg);
    }

    /**
     * 从 Cookie 获取 token
     * 优先使用 _m_h5_tk（标准 mtop 协议），格式为 token_timestamp，取下划线前的部分
     * 备选 _m_h
     */
    function getTokenFromCookie() {
        // 方式 1: _m_h5_tk (标准 mtop，格式: token_timestamp)
        var match = document.cookie.match(/_m_h5_tk=([^;]+)/);
        if (match && match[1]) {
            // 取下划线前面的部分作为 token
            var parts = match[1].split('_');
            if (parts.length >= 1 && parts[0]) {
                console.log(LOG_PREFIX, '🔑 从 _m_h5_tk 获取 Token');
                return parts[0];
            }
        }

        // 方式 2: _m_h (旧版或特定环境)
        match = document.cookie.match(/_m_h=([^;]+)/);
        if (match && match[1]) {
            console.log(LOG_PREFIX, '🔑 从 _m_h 获取 Token');
            return match[1];
        }

        return null;
    }

    // ==================== 缓存管理 ====================

    /**
     * 获取缓存的商品列表
     */
    function getCachedGoods(pageNumber) {
        try {
            var cacheKey = CACHE_PREFIX + pageNumber;
            var cachedStr = localStorage.getItem(cacheKey);

            if (!cachedStr) return null;

            var cachedData = JSON.parse(cachedStr);
            var now = Date.now();

            // 检查过期
            if (now - cachedData.timestamp > CACHE_EXPIRE_TIME) {
                console.log(LOG_PREFIX, '⚠️ 缓存已过期:', cacheKey);
                localStorage.removeItem(cacheKey);
                return null;
            }

            console.log(LOG_PREFIX, '✅ 使用本地缓存:', cacheKey);
            return cachedData.data;
        } catch (e) {
            console.warn(LOG_PREFIX, '⚠️ 读取缓存失败:', e);
            return null;
        }
    }

    /**
     * 保存商品列表到缓存
     */
    function setCachedGoods(pageNumber, data) {
        try {
            var cacheKey = CACHE_PREFIX + pageNumber;
            var cacheData = {
                timestamp: Date.now(),
                data: data
            };
            localStorage.setItem(cacheKey, JSON.stringify(cacheData));
        } catch (e) {
            console.warn(LOG_PREFIX, '⚠️ 写入缓存失败 (可能空间不足):', e);
        }
    }

    // ==================== 核心 API ====================

    /**
     * 解析商品列表响应
     * 从 data.cardList[].cardData 提取商品信息
     */
    function parseGoodsListResponse(data) {
        var goodsList = [];

        if (!data || !data.cardList || !Array.isArray(data.cardList)) {
            console.warn(LOG_PREFIX, '⚠️ 响应数据格式不正确');
            return goodsList;
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

            // 提取价格
            if (cardData.priceInfo && cardData.priceInfo.price) {
                goods.price = cardData.priceInfo.price;
            }

            // 提取图片
            if (cardData.picInfo && cardData.picInfo.picUrl) {
                goods.picUrl = cardData.picInfo.picUrl;
            }

            if (goods.itemId) {
                goodsList.push(goods);
            }
        });

        return goodsList;
    }

    /**
     * 获取商品列表
     * @param {number} pageNumber - 页码（从1开始）
     * @param {number} pageSize - 每页数量
     * @param {boolean} forceRefresh - 是否强制刷新（忽略缓存）
     * @returns {Promise<Object>} { goodsList: [], currentPage: number, hasMore: boolean }
     */
    function fetchGoodsList(pageNumber, pageSize, forceRefresh) {
        pageNumber = pageNumber || 1;
        pageSize = pageSize || 20;
        forceRefresh = forceRefresh || false;

        return new Promise(function (resolve, reject) {
            // 1. 检查缓存
            if (!forceRefresh) {
                var cached = getCachedGoods(pageNumber);
                if (cached) {
                    resolve(cached);
                    return;
                }
            }

            var token = getTokenFromCookie();
            if (!token) {
                console.error(LOG_PREFIX, '❌ 无法获取 Token');
                reject('Token not found');
                return;
            }

            // 构造请求参数
            var timestamp = Date.now().toString();
            var dataObj = {
                pageNumber: pageNumber,
                pageSize: pageSize
            };
            var dataStr = JSON.stringify(dataObj);

            // 生成签名（同步）
            var sign = generateSign(timestamp, token, dataStr);

            var queryParams = {
                jsv: '2.7.2',
                appKey: APP_KEY,
                t: timestamp,
                sign: sign,
                v: API_VERSION,
                type: 'originaljson',
                accountSite: 'xianyu',
                dataType: 'json',
                timeout: '20000',
                api: API_NAME,
                data: dataStr
            };

            console.log(LOG_PREFIX, '📝 准备获取商品列表: 第', pageNumber, '页');

            // 构建完整 URL
            var queryString = Object.keys(queryParams).map(function (key) {
                return encodeURIComponent(key) + '=' + encodeURIComponent(queryParams[key]);
            }).join('&');

            var url = 'https://h5api.m.goofish.com/h5/' + API_NAME + '/' + API_VERSION + '/?' + queryString;

            console.log(LOG_PREFIX, '🌐 开始请求 API...', API_NAME);

            fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                credentials: 'include'
            })
                .then(function (response) { return response.json(); })
                .then(function (data) {
                    if (data.ret && data.ret[0].includes('SUCCESS')) {
                        var goodsList = parseGoodsListResponse(data.data || {});
                        var result = {
                            goodsList: goodsList,
                            currentPage: pageNumber,
                            hasMore: goodsList.length >= pageSize
                        };

                        console.log(LOG_PREFIX, '✅ 获取商品列表成功:', goodsList.length, '条');

                        // 写入缓存
                        if (goodsList.length > 0) {
                            setCachedGoods(pageNumber, result);
                        }

                        resolve(result);
                    } else {
                        console.warn(LOG_PREFIX, '❌ API 返回错误:', data.ret);
                        resolve({ goodsList: [], currentPage: pageNumber, hasMore: false });
                    }
                })
                .catch(function (err) {
                    console.error(LOG_PREFIX, '❌ 网络请求异常:', err);
                    reject(err);
                });
        });
    }

    // 导出到全局
    window.GoodsListAPI = {
        fetchGoodsList: fetchGoodsList,
        getCachedGoods: getCachedGoods,
        clearCache: function () {
            var removedCount = 0;
            for (var i = localStorage.length - 1; i >= 0; i--) {
                var key = localStorage.key(i);
                if (key && key.startsWith(CACHE_PREFIX)) {
                    localStorage.removeItem(key);
                    removedCount++;
                }
            }
            console.log(LOG_PREFIX, '🗑️ 缓存已清空, 共移除', removedCount, '条');
        }
    };

    console.log(LOG_PREFIX, '✅ GoodsListAPI 已加载');
})();
