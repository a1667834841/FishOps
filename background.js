// background.js - Service Worker，负责数据存储和管理
console.log('[闲鱼采集] Service Worker 已启动');

// MD5哈希函数实现
function md5(string) {
  function rotateLeft(value, shift) {
    return (value << shift) | (value >>> (32 - shift));
  }
  function addUnsigned(x, y) {
    const x8 = x & 0x80000000, y8 = y & 0x80000000;
    const x4 = x & 0x40000000, y4 = y & 0x40000000;
    const result = (x & 0x3FFFFFFF) + (y & 0x3FFFFFFF);
    if (x4 & y4) return result ^ 0x80000000 ^ x8 ^ y8;
    if (x4 | y4) {
      if (result & 0x40000000) return result ^ 0xC0000000 ^ x8 ^ y8;
      return result ^ 0x40000000 ^ x8 ^ y8;
    }
    return result ^ x8 ^ y8;
  }
  function F(x, y, z) { return (x & y) | (~x & z); }
  function G(x, y, z) { return (x & z) | (y & ~z); }
  function H(x, y, z) { return x ^ y ^ z; }
  function I(x, y, z) { return y ^ (x | ~z); }
  function FF(a, b, c, d, x, s, ac) { return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, F(b, c, d)), addUnsigned(x, ac)), s), b); }
  function GG(a, b, c, d, x, s, ac) { return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, G(b, c, d)), addUnsigned(x, ac)), s), b); }
  function HH(a, b, c, d, x, s, ac) { return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, H(b, c, d)), addUnsigned(x, ac)), s), b); }
  function II(a, b, c, d, x, s, ac) { return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, I(b, c, d)), addUnsigned(x, ac)), s), b); }
  function convertToWordArray(str) {
    const utf8 = unescape(encodeURIComponent(str));
    const len = utf8.length;
    const words = [];
    for (let i = 0; i < len; i += 4) {
      words.push(
        (utf8.charCodeAt(i) || 0) |
        ((utf8.charCodeAt(i + 1) || 0) << 8) |
        ((utf8.charCodeAt(i + 2) || 0) << 16) |
        ((utf8.charCodeAt(i + 3) || 0) << 24)
      );
    }
    const bitLen = len * 8;
    words[len >> 2] |= 0x80 << ((len % 4) * 8);
    words[(((len + 8) >>> 6) << 4) + 14] = bitLen;
    return words;
  }
  function wordToHex(value) {
    let hex = '';
    for (let i = 0; i < 4; i++) {
      hex += ((value >> (i * 8)) & 0xFF).toString(16).padStart(2, '0');
    }
    return hex;
  }
  const x = convertToWordArray(string);
  let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
  const S = [7,12,17,22, 5,9,14,20, 4,11,16,23, 6,10,15,21];
  const K = [
    0xD76AA478,0xE8C7B756,0x242070DB,0xC1BDCEEE,0xF57C0FAF,0x4787C62A,0xA8304613,0xFD469501,
    0x698098D8,0x8B44F7AF,0xFFFF5BB1,0x895CD7BE,0x6B901122,0xFD987193,0xA679438E,0x49B40821,
    0xF61E2562,0xC040B340,0x265E5A51,0xE9B6C7AA,0xD62F105D,0x02441453,0xD8A1E681,0xE7D3FBC8,
    0x21E1CDE6,0xC33707D6,0xF4D50D87,0x455A14ED,0xA9E3E905,0xFCEFA3F8,0x676F02D9,0x8D2A4C8A,
    0xFFFA3942,0x8771F681,0x6D9D6122,0xFDE5380C,0xA4BEEA44,0x4BDECFA9,0xF6BB4B60,0xBEBFBC70,
    0x289B7EC6,0xEAA127FA,0xD4EF3085,0x04881D05,0xD9D4D039,0xE6DB99E5,0x1FA27CF8,0xC4AC5665,
    0xF4292244,0x432AFF97,0xAB9423A7,0xFC93A039,0x655B59C3,0x8F0CCC92,0xFFEFF47D,0x85845DD1,
    0x6FA87E4F,0xFE2CE6E0,0xA3014314,0x4E0811A1,0xF7537E82,0xBD3AF235,0x2AD7D2BB,0xEB86D391
  ];
  for (let k = 0; k < x.length; k += 16) {
    const AA = a, BB = b, CC = c, DD = d;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = F(b, c, d); g = i; }
      else if (i < 32) { f = G(b, c, d); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = H(b, c, d); g = (3 * i + 5) % 16; }
      else { f = I(b, c, d); g = (7 * i) % 16; }
      const temp = d;
      d = c; c = b;
      b = addUnsigned(b, rotateLeft(addUnsigned(addUnsigned(a, f), addUnsigned(K[i], x[k + g] || 0)), S[(Math.floor(i / 16) * 4) + (i % 4)]));
      a = temp;
    }
    a = addUnsigned(a, AA); b = addUnsigned(b, BB); c = addUnsigned(c, CC); d = addUnsigned(d, DD);
  }
  return wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d);
}

// ==================== 数据结构定义 ====================

/**
 * 商品数据标准结构
 * 所有采集的数据都应该符合这个结构
 */
const PRODUCT_SCHEMA = {
  itemId: { type: 'string', label: '商品ID', csvOrder: 1, feishuType: 1 },
  title: { type: 'string', label: '商品标题', csvOrder: 2, feishuType: 1 },
  price: { type: 'string', label: '价格', csvOrder: 3, feishuType: 1 },
  priceNumber: { type: 'number', label: '价格数值', csvOrder: 0, feishuType: 2, feishuField: '价格' }, // 不导出到CSV，仅用于飞书
  originalPrice: { type: 'string', label: '原价', csvOrder: 4, feishuType: 1 },
  originalPriceNumber: { type: 'number', label: '原价数值', csvOrder: 0, feishuType: 2, feishuField: '原价' }, // 不导出到CSV，仅用于飞书
  wantCnt: { type: 'number', label: '想要人数', csvOrder: 5, feishuType: 2 },
  publishTime: { type: 'string', label: '发布时间', csvOrder: 6, feishuType: 1 },
  publishTimeMs: { type: 'number', label: '发布时间戳', csvOrder: 0, feishuType: 5, feishuField: '发布时间' }, // 不导出到CSV，仅用于飞书
  captureTime: { type: 'string', label: '采集时间', csvOrder: 0, feishuType: 1 }, // 不导出到CSV
  captureTimeMs: { type: 'number', label: '采集时间戳', csvOrder: 0, feishuType: 5, feishuField: '采集时间' }, // 不导出到CSV，仅用于飞书
  sellerNick: { type: 'string', label: '卖家昵称', csvOrder: 7, feishuType: 1 },
  sellerCity: { type: 'string', label: '地区', csvOrder: 8, feishuType: 1 },
  freeShip: { type: 'string', label: '包邮', csvOrder: 9, feishuType: 1 },
  tags: { type: 'string', label: '商品标签', csvOrder: 10, feishuType: 1 },
  coverUrl: { type: 'string', label: '封面URL', csvOrder: 11, feishuType: 15 },
  detailUrl: { type: 'string', label: '商品详情URL', csvOrder: 12, feishuType: 15 }
};

// 从 SCHEMA 生成 CSV 表头（按 csvOrder 排序，跳过 csvOrder 为 0 的字段）
function getCSVHeaders() {
  return Object.entries(PRODUCT_SCHEMA)
    .filter(([key, config]) => config.csvOrder > 0)
    .sort((a, b) => a[1].csvOrder - b[1].csvOrder)
    .map(([key, config]) => config.label);
}

// 从 SCHEMA 生成飞书字段配置
function getFeishuFieldConfigs() {
  const configs = [];
  const addedFields = new Set();
  
  Object.entries(PRODUCT_SCHEMA).forEach(([key, config]) => {
    // 使用 feishuField 或 label 作为字段名
    const fieldName = config.feishuField || config.label;
    
    // 避免重复添加（比如价格和价格数值共用一个飞书字段）
    if (!addedFields.has(fieldName)) {
      configs.push({
        name: fieldName,
        type: config.feishuType
      });
      addedFields.add(fieldName);
    }
  });
  
  // 添加关键字字段（不在 schema 中，但飞书需要）
  configs.unshift({ name: '关键字', type: 1 });
  
  return configs;
}

// 存储采集到的数据
let capturedData = [];
let capturedItemIds = new Set(); // 用于采集时去重的商品组合键集合（商品ID+想要数+价格）
let requestLogs = []; // 存储每次请求的URL、参数和返回值
let currentKeyword = ''; // 当前搜索关键词
let statistics = {
  pageCount: 0,        // 采集页数
  itemCount: 0,        // 商品总数
  lastCaptureTime: null
};

// 过滤条件配置
let filterConfig = {
  minWantCnt: 0,      // 最小想要人数
  minPrice: 0,        // 最小价格
  maxPrice: 0,        // 最大价格（0表示不限）
  onlyFreeShip: false // 只看包邮
};

// 配置选项
let config = {
  autoFetchDetail: false,  // 是否自动调用详情API
  detailFetchDelay: 1000   // 详情API请求间隔(ms)
};

// 监听来自content script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[闲鱼采集] Background收到消息:', request.type);

  // 设置当前关键词
  if (request.type === 'SET_KEYWORD') {
    currentKeyword = request.keyword || '';
    console.log('[闲鱼采集] 设置关键词:', currentKeyword);
    chrome.storage.local.set({ currentKeyword: currentKeyword });
    sendResponse({ success: true });
    return true;
  }

  // 获取当前关键词
  if (request.type === 'GET_KEYWORD') {
    sendResponse({ keyword: currentKeyword });
    return true;
  }

  if (request.type === 'API_DATA_CAPTURED') {
    const apiData = request.data;
    const resultList = apiData.response?.data?.resultList || [];
  
    // 记录请求信息
    try {
      // 处理协议相对URL（如 //h5api.m.goofish.com/...）
      let fullUrl = apiData.url;
      if (fullUrl.startsWith('//')) {
        fullUrl = 'https:' + fullUrl;
      }
      const urlObj = new URL(fullUrl);
      const requestParams = {};
      urlObj.searchParams.forEach((value, key) => {
        requestParams[key] = value;
      });
  
      // 尝试解析请求体
      let parsedRequestBody = apiData.requestBody;
      if (typeof apiData.requestBody === 'string') {
        try {
          parsedRequestBody = JSON.parse(apiData.requestBody);
        } catch (e) {
          // 如果不是JSON，保持原样
        }
      }
  
      requestLogs.push({
        timestamp: apiData.timestamp,
        captureTime: new Date(apiData.timestamp).toLocaleString(),
        url: apiData.url,
        method: apiData.method || 'GET',
        baseUrl: urlObj.origin + urlObj.pathname,
        urlParams: requestParams,
        requestBody: parsedRequestBody,
        response: apiData.response,
        itemCount: resultList.length
      });
  
    } catch (error) {
      console.error('[闲鱼采集] 记录请求信息失败:', error);
    }
  
    // 打印当前过滤条件（首次采集时）
    if (requestLogs.length === 1) {
      console.log('[闲鱼采集] 当前过滤条件:', {
        '最小想要人数': filterConfig.minWantCnt > 0 ? `>=${filterConfig.minWantCnt}人` : '不限制',
        '最小价格': filterConfig.minPrice > 0 ? `>=${filterConfig.minPrice}元` : '不限制',
        '最大价格': filterConfig.maxPrice > 0 ? `<=${filterConfig.maxPrice}元` : '不限制',
        '只看包邮': filterConfig.onlyFreeShip ? '是' : '否'
      });
    }

    // 过滤已采集的商品（根据商品ID+想要数+价格组合键去重）并应用过滤条件
    const newItems = resultList.filter(item => {
      const mainData = item.data?.item?.main;
      if (!mainData) return false;
      const exContent = mainData.exContent || {};
      const clickParam = mainData.clickParam?.args || {};
      const itemId = clickParam.item_id || exContent.itemId || '';
      
      if (!itemId) return false;
      
      // 提取想要人数
      const fishTags = exContent.fishTags || {};
      let wantCnt = 0;
      Object.values(fishTags).forEach(region => {
        const tagList = region?.tagList || [];
        tagList.forEach(tag => {
          const content = tag?.data?.content;
          if (content && content.endsWith('人想要')) {
            wantCnt = parseInt(content.replace('人想要', '')) || 0;
          }
        });
      });
      
      // 提取价格
      const priceStr = (exContent.price || []).map(p => p.text || '').join('');
      const priceNumber = parseFloat(priceStr.replace(/[^\d.]/g, '')) || 0;
      
      // 判断包邮
      const isFreeShip = clickParam.tag?.includes('freeship') ||
                        clickParam.tagname?.includes('包邮') ||
                        fishTags?.r1?.tagList?.some(t => t.data?.content === '包邮');
      
      // 应用过滤条件
      // 1. 最小想要人数过滤
      if (filterConfig.minWantCnt > 0 && wantCnt < filterConfig.minWantCnt) {
        console.log(`[闲鱼采集] 过滤: 商品 ${itemId} 想要人数 ${wantCnt} < ${filterConfig.minWantCnt}`);
        return false;
      }
      
      // 2. 最小价格过滤
      if (filterConfig.minPrice > 0 && priceNumber < filterConfig.minPrice) {
        console.log(`[闲鱼采集] 过滤: 商品 ${itemId} 价格 ${priceNumber} < ${filterConfig.minPrice}`);
        return false;
      }
      
      // 3. 最大价格过滤
      if (filterConfig.maxPrice > 0 && priceNumber > filterConfig.maxPrice) {
        console.log(`[闲鱼采集] 过滤: 商品 ${itemId} 价格 ${priceNumber} > ${filterConfig.maxPrice}`);
        return false;
      }
      
      // 4. 只看包邮过滤
      if (filterConfig.onlyFreeShip && !isFreeShip) {
        console.log(`[闲鱼采集] 过滤: 商品 ${itemId} 不包邮`);
        return false;
      }
      
      // 构建组合键：商品ID + 想要数 + 价格
      const compositeKey = `${itemId}_${wantCnt}_${priceStr}`;
      
      // 去重检查
      if (capturedItemIds.has(compositeKey)) return false;
      
      capturedItemIds.add(compositeKey);
      return true;
    });

    const newItemCount = newItems.length;
    console.log('[闲鱼采集] 新增商品数:', newItemCount, '(去重后)');

    // 只有新商品时才保存商品数据
    if (newItemCount > 0) {
      const pageRecord = {
        url: apiData.url,
        response: apiData.response,
        items: newItems, // 只保存新商品
        timestamp: apiData.timestamp,
        captureTime: new Date(apiData.timestamp).toLocaleString()
      };
      capturedData.push(pageRecord);
      console.log('[闲鱼采集] 📦 已添加到 capturedData，当前页数:', capturedData.length, '本页商品数:', newItems.length);
      console.log('[闲鱼采集] 📦 第一个商品数据:', JSON.stringify(newItems[0]).substring(0, 200));

      // 更新统计信息
      statistics.pageCount = capturedData.length;
      statistics.itemCount += newItemCount;
      statistics.lastCaptureTime = new Date(apiData.timestamp).toLocaleString();
    } else {
      console.log('[闲鱼采集] 本页无新商品');
    }

    // 无论是否有新商品，都要保存 requestLogs
    chrome.storage.local.set({
      capturedData: capturedData,
      capturedItemIds: Array.from(capturedItemIds),
      requestLogs: requestLogs,
      statistics: statistics
    });

    sendResponse({
      success: true,
      pageCount: statistics.pageCount,
      itemCount: statistics.itemCount,
      newItems: newItemCount
    });
  }



  // 获取统计信息
  if (request.type === 'GET_STATS') {
    sendResponse({
      pageCount: statistics.pageCount,
      itemCount: statistics.itemCount,
      lastCaptureTime: statistics.lastCaptureTime || '无'
    });
  }

  // 清空数据
  if (request.type === 'CLEAR_DATA') {
    console.log('[闲鱼采集] 开始清空数据...');
    capturedData = [];
    capturedItemIds = new Set(); // 清空去重组合键集合
    requestLogs = []; // 清空请求记录

    // 重置统计信息
    statistics = {
      pageCount: 0,
      itemCount: 0,
      lastCaptureTime: null
    };

    // 只删除采集数据和统计信息，保留配置和关键词
    const keysToRemove = ['capturedData', 'capturedItemIds', 'requestLogs', 'statistics'];
    chrome.storage.local.remove(keysToRemove, () => {
      if (chrome.runtime.lastError) {
        console.error('[闲鱼采集] 清空storage失败:', chrome.runtime.lastError);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true });
      }
    });
    return true; // 保持消息通道开启以支持异步响应
  }

  // 导出CSV数据（使用列表数据）
  if (request.type === 'EXPORT_CSV') {
    console.log('[闲鱼采集] ========== 导出CSV ==========');
    console.log('[闲鱼采集] capturedData长度:', capturedData.length);
    console.log('[闲鱼采集] capturedItemIds数量:', capturedItemIds.size);

    try {
      // 使用统一的数据处理逻辑（与飞书发送相同）
      const processedData = processListData(capturedData);
      console.log('[闲鱼采集] 处理后数据量:', processedData.length);
      
      const csvData = generateProductCSV(processedData);
      sendResponse({ success: true, csvData: csvData });
    } catch (error) {
      console.error('[闲鱼采集] CSV生成失败:', error);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  // 导出请求记录
  if (request.type === 'EXPORT_REQUESTS') {
    try {
      const csvData = generateRequestsCSV(requestLogs);
      sendResponse({ success: true, csvData: csvData });
    } catch (error) {
      console.error('[闲鱼采集] 请求记录CSV生成失败:', error);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }



  // 导出商品和商家CSV（使用列表数据）
  if (request.type === 'EXPORT_PRODUCT_SELLER_CSV') {
    try {
      // 使用统一的数据处理逻辑（与CSV导出和飞书发送相同）
      const processedData = processListData(capturedData);
      console.log('[闲鱼采集] 处理后数据量:', processedData.length);

      const productCsvData = generateProductCSV(processedData);
      const sellerCsvData = generateSellerCSV(processedData);
      sendResponse({
        success: true,
        productCsvData: productCsvData,
        sellerCsvData: sellerCsvData
      });
    } catch (error) {
      console.error('[闲鱼采集] 商品/商家CSV生成失败:', error);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  // 设置配置
  if (request.type === 'SET_CONFIG') {
    if (request.config) {
      config = { ...config, ...request.config };
      chrome.storage.local.set({ config: config });
      sendResponse({ success: true, config: config });
    } else {
      sendResponse({ success: false, error: '无效的配置' });
    }
    return true;
  }

  // 获取配置
  if (request.type === 'GET_CONFIG') {
    sendResponse({ success: true, config: config });
    return true;
  }

  // ========== 飞书相关消息处理 ==========

  // 测试飞书连接
  if (request.type === 'TEST_FEISHU_CONNECTION') {
    testFeishuConnection(request.config).then(sendResponse);
    return true;
  }

  // 发送数据到飞书（使用列表数据）
  if (request.type === 'SEND_TO_FEISHU') {
    // 使用统一的数据处理逻辑（与CSV导出相同）
    const processedData = processListData(capturedData);
    sendToFeishu(processedData).then(sendResponse);
    return true;
  }

  // 更新飞书配置
  if (request.type === 'UPDATE_FEISHU_CONFIG') {
    if (request.config) {
      feishuConfig = { ...feishuConfig, ...request.config };
      chrome.storage.local.set(feishuConfig);
      sendResponse({ success: true, config: feishuConfig });
    } else {
      sendResponse({ success: false, error: '无效的配置' });
    }
    return true;
  }

  // 获取飞书配置
  if (request.type === 'GET_FEISHU_CONFIG') {
    sendResponse({ success: true, config: feishuConfig });
    return true;
  }

  return true; // 保持消息通道开启，用于异步响应
});
// 从 storage 恢复数据
chrome.storage.local.get(['capturedData', 'capturedItemIds', 'requestLogs', 'statistics', 'config', 'currentKeyword', 'minWantCnt', 'minPrice', 'maxPrice', 'onlyFreeShip'], (result) => {
  if (result.capturedData) {
    capturedData = result.capturedData;
    console.log('[闲鱼采集] 从 storage恢复数据，数量:', capturedData.length);
  }
  if (result.capturedItemIds) {
    capturedItemIds = new Set(result.capturedItemIds); // 数组转Set
    console.log('[闲鱼采集] 恢复已采集商品组合键数:', capturedItemIds.size);
  }
  if (result.requestLogs) {
    requestLogs = result.requestLogs;
    console.log('[闲鱼采集] 恢复请求记录数:', requestLogs.length);
  }
  if (result.statistics) {
    statistics = result.statistics;
    console.log('[闲鱼采集] 恢复统计 - 页数:', statistics.pageCount, '商品数:', statistics.itemCount);
  }
  if (result.config) {
    config = { ...config, ...result.config };
    console.log('[闲鱼采集] 恢复配置:', config);
  }
  if (result.currentKeyword) {
    currentKeyword = result.currentKeyword;
    console.log('[闲鱼采集] 恢复关键词:', currentKeyword);
  }
  // 恢复过滤条件配置
  if (result.minWantCnt !== undefined) filterConfig.minWantCnt = result.minWantCnt;
  if (result.minPrice !== undefined) filterConfig.minPrice = result.minPrice;
  if (result.maxPrice !== undefined) filterConfig.maxPrice = result.maxPrice;
  if (result.onlyFreeShip !== undefined) filterConfig.onlyFreeShip = result.onlyFreeShip;
  console.log('[闲鱼采集] 恢复过滤条件:', filterConfig);
});

// ==================== 统一的数据处理逻辑 ====================
// 说明：所有导出方式（CSV单文件、CSV双文件、飞书）都使用此函数处理列表数据

// 处理列表数据，返回符合 PRODUCT_SCHEMA 的标准数据结构
function processListData(capturedData) {
  const processedMap = new Map();
  const currentTime = Date.now();
  const currentTimeStr = new Date(currentTime).toLocaleString('zh-CN');

  // 处理列表数据
  capturedData.forEach(pageData => {
    const items = pageData.items || [];
    items.forEach(item => {
      try {
        const mainData = item.data?.item?.main;
        if (!mainData) return;

        const exContent = mainData.exContent || {};
        const clickParam = mainData.clickParam?.args || {};

        const itemId = clickParam.item_id || exContent.itemId || '';
        if (!itemId) return;

        // 从 fishTags提取想要人数
        const fishTags = exContent.fishTags || {};
        let wantCnt = 0;
        Object.values(fishTags).forEach(region => {
          const tagList = region?.tagList || [];
          tagList.forEach(tag => {
            const content = tag?.data?.content;
            if (content && content.endsWith('人想要')) {
              wantCnt = parseInt(content.replace('人想要', '')) || 0;
            }
          });
        });

        // 提取商品标签
        const tagContents = [];
        Object.values(fishTags).forEach(region => {
          const tagList = region?.tagList || [];
          tagList.forEach(tag => {
            const content = tag?.data?.content;
            if (content && !content.endsWith('人想要')) {
              // 标签里如果包含freeShippingIcon，替换成包邮
            if (content && content.includes('freeShippingIcon')) {
              tagContents.push('包邮');
            } else {
              tagContents.push(content);
            }
            }
            
          });
        });
        const tagsStr = [...new Set(tagContents)].join('、');

        // 判断包邮
        const isFreeShip = clickParam.tag?.includes('freeship') ||
                          clickParam.tagname?.includes('包邮') ||
                          exContent.fishTags?.r1?.tagList?.some(t => t.data?.content === '包邮');

        // 获取封面图
        const picUrl = exContent.picUrl || '';
        
        // 提取价格（字符串和数值）
        const priceStr = (exContent.price || []).map(p => p.text || '').join('');
        const priceNumber = parseFloat(priceStr.replace(/[^\d.]/g, '')) || 0;
        
        // 提取原价（字符串和数值）
        const originalPriceStr = exContent.oriPrice || '';
        const originalPriceNumber = parseFloat(originalPriceStr.replace(/[^\d.]/g, '')) || 0;
        
        // 提取发布时间
        const publishTimeMs = clickParam.publishTime ? parseInt(clickParam.publishTime) : 0;
        const publishTimeStr = publishTimeMs ? new Date(publishTimeMs).toLocaleString('zh-CN') : '';

        // 构建组合键：商品ID + 想要数 + 价格
        const compositeKey = `${itemId}_${wantCnt}_${priceStr}`;

        // 构建符合 PRODUCT_SCHEMA 的标准数据结构
        processedMap.set(compositeKey, {
          // 基本信息
          itemId: itemId,
          title: exContent.title || '',
          
          // 价格相关（字符串和数值两种形式）
          price: priceStr,
          priceNumber: priceNumber,
          originalPrice: originalPriceStr,
          originalPriceNumber: originalPriceNumber,
          
          // 其他字段
          wantCnt: wantCnt,
          
          // 时间相关（字符串和时间戳两种形式）
          publishTime: publishTimeStr,
          publishTimeMs: publishTimeMs,
          captureTime: currentTimeStr,
          captureTimeMs: currentTime,
          
          // 卖家信息
          sellerNick: exContent.userNickName || '',
          sellerCity: exContent.area || '',
          
          // 其他属性
          freeShip: isFreeShip ? '是' : '否',
          tags: tagsStr,
          
          // URL
          coverUrl: normalizeUrl(picUrl),
          detailUrl: normalizeUrl(`https://www.goofish.com/item?id=${itemId}`)
        });
      } catch (error) {
        console.error('[闲鱼采集] 处理列表数据出错:', error);
      }
    });
  });

  return Array.from(processedMap.values());
}

// URL 规范化函数：处理 // 开头的协议相对地址
function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return '';

  let trimmed = url.trim();

  // 如果是 // 开头，补上 https:
  if (trimmed.startsWith('//')) {
    trimmed = 'https:' + trimmed;
  }

  return trimmed;
}



// 生成请求记录CSV数据
function generateRequestsCSV(logs) {
  if (!logs || logs.length === 0) {
    throw new Error('没有请求记录可导出');
  }

  // CSV表头
  const headers = [
    '序号', '请求时间', '请求方法', '请求URL', '基础URL', 'URL参数', '请求体(FormData)', '返回商品数', '返回数据'
  ];

  let csvContent = headers.join(',') + '\n';

  // 遍历所有请求记录
  logs.forEach((log, index) => {
    try {
      // 将URL参数转为JSON字符串
      const urlParamsStr = JSON.stringify(log.urlParams || {}).replace(/"/g, '""');
      
      // 将请求体转为JSON字符串
      const requestBodyStr = JSON.stringify(log.requestBody || '').replace(/"/g, '""');
      
      // 将返回数据转为JSON字符串
      const responseStr = JSON.stringify(log.response || {}).replace(/"/g, '""');
      
      // 构建CSV行
      const row = [
        index + 1,
        log.captureTime || '',
        log.method || 'GET',
        `"${(log.url || '').replace(/"/g, '""')}"`,
        `"${(log.baseUrl || '').replace(/"/g, '""')}"`,
        `"${urlParamsStr}"`,
        `"${requestBodyStr}"`,
        log.itemCount || 0,
        `"${responseStr}"`
      ];

      csvContent += row.join(',') + '\n';
    } catch (error) {
      console.error('[闲鱼采集] 处理请求记录出错:', error);
    }
  });

  return csvContent;
}



// ==================== CSV生成函数 ====================

// 生成商品CSV数据（使用 PRODUCT_SCHEMA 自动生成）
function generateProductCSV(processedData) {
  if (!processedData || processedData.length === 0) {
    throw new Error('没有商品数据可导出');
  }

  // 使用 SCHEMA 生成 CSV 表头
  const headers = getCSVHeaders();
  let csvContent = headers.join(',') + '\n';

  // 获取需要导出的字段（按 csvOrder 排序）
  const fields = Object.entries(PRODUCT_SCHEMA)
    .filter(([key, config]) => config.csvOrder > 0)
    .sort((a, b) => a[1].csvOrder - b[1].csvOrder)
    .map(([key, config]) => key);

  // 遍历所有数据
  processedData.forEach(item => {
    try {
      const row = fields.map(fieldKey => {
        const value = item[fieldKey];
        const config = PRODUCT_SCHEMA[fieldKey];
        
        // 根据类型处理值
        if (value === null || value === undefined) {
          return '';
        } else if (config.type === 'number') {
          return value;
        } else {
          // 字符串类型，需要转义引号
          return `"${String(value).replace(/"/g, '""')}"`;
        }
      });

      csvContent += row.join(',') + '\n';
    } catch (error) {
      console.error('[闲鱼采集] 处理商品数据出错:', error, item);
    }
  });

  return csvContent;
}

// 生成商家CSV数据
function generateSellerCSV(processedData) {
  if (!processedData || processedData.length === 0) {
    throw new Error('没有商家数据可导出');
  }

  // CSV表头（移除详情相关字段）
  const headers = [
    '商家名称', '地点'
  ];

  let csvContent = headers.join(',') + '\n';

  // 用于去重的商家名称集合
  const seenSellerNicks = new Set();

  // 遍历所有数据，提取唯一商家
  processedData.forEach(item => {
    try {
      const sellerNick = item.sellerNick;
      // 如果没有商家名称，跳过
      if (!sellerNick || seenSellerNicks.has(sellerNick)) {
        return; // 跳过重复商家
      }
      seenSellerNicks.add(sellerNick);

      // 构建CSV行
      const row = [
        `"${(item.sellerNick || '').replace(/"/g, '""')}"`,
        `"${item.sellerCity || ''}"`
      ];

      csvContent += row.join(',') + '\n';
    } catch (error) {
      console.error('[闲鱼采集] 处理商家数据出错:', error, item);
    }
  });

  return csvContent;
}

console.log('[闲鱼采集] Background初始化完成，等待数据...');

// ==================== 飞书 API 模块 ====================

// 飞书 API 基础配置
const FEISHU_API_BASE = 'https://open.feishu.cn';

// 飞书配置缓存
let feishuConfig = {
  appId: '',
  appSecret: '',
  spreadsheetToken: '',
  productTableId: '',
  sellerTableId: '',
  enabled: false
};

// 租户访问令牌缓存
let tenantAccessToken = null;
let tokenExpireTime = 0;

// 从 storage 加载飞书配置
chrome.storage.local.get(['appId', 'appSecret', 'spreadsheetToken', 'productTableId', 'sellerTableId', 'enabled'], (result) => {
  feishuConfig = {
    appId: result.appId || '',
    appSecret: result.appSecret || '',
    spreadsheetToken: result.spreadsheetToken || '',
    productTableId: result.productTableId || '',
    sellerTableId: result.sellerTableId || '',
    enabled: result.enabled || false
  };
  console.log('[闲鱾采集-飞书] 配置已加载:', feishuConfig);
  console.log('[闲鱾采集-飞书] Storage 原始数据:', result);
});

// 监听 storage 变化，实时更新配置
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    // 检查飞书配置是否变化
    const feishuKeys = ['appId', 'appSecret', 'spreadsheetToken', 'productTableId', 'sellerTableId', 'enabled'];
    let hasFeishuChange = false;
    
    feishuKeys.forEach(key => {
      if (changes[key]) {
        feishuConfig[key] = changes[key].newValue || '';
        hasFeishuChange = true;
      }
    });
    
    if (hasFeishuChange) {
      console.log('[闲鱾采集-飞书] 配置已更新:', feishuConfig);
    }
  }
});

// 获取租户访问令牌
async function getTenantAccessToken() {
  // 如果令牌未过期,直接返回
  if (tenantAccessToken && Date.now() < tokenExpireTime) {
    return tenantAccessToken;
  }

  try {
    const response = await fetch(`${FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        app_id: feishuConfig.appId,
        app_secret: feishuConfig.appSecret
      })
    });

    const data = await response.json();

    if (data.code !== 0) {
      console.error('[闲鱼采集-飞书] 获取访问令牌失败:', data);
      throw new Error(data.msg || '获取访问令牌失败');
    }

    tenantAccessToken = data.tenant_access_token;
    // 提前5分钟过期
    tokenExpireTime = Date.now() + (data.expire - 300) * 1000;

    console.log('[闲鱼采集-飞书] 访问令牌已更新');
    return tenantAccessToken;
  } catch (error) {
    console.error('[闲鱼采集-飞书] 获取访问令牌异常:', error);
    throw error;
  }
}

// 测试飞书连接
async function testFeishuConnection(config) {
  try {
    const testConfig = { ...feishuConfig, ...config };

    const response = await fetch(`${FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        app_id: testConfig.appId,
        app_secret: testConfig.appSecret
      })
    });

    const data = await response.json();

    if (data.code !== 0) {
      return { success: false, error: data.msg || '认证失败' };
    }

    // 如果配置了表格,也测试表格访问
    if (testConfig.spreadsheetToken && testConfig.productTableId) {
      const tableResponse = await fetch(
        `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${testConfig.spreadsheetToken}/tables/${testConfig.productTableId}/records?page_size=1`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${data.tenant_access_token}`
          }
        }
      );

      const tableData = await tableResponse.json();

      if (tableData.code !== 0) {
        return { success: false, error: `表格访问失败: ${tableData.msg}` };
      }
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 商品表字段配置（从 PRODUCT_SCHEMA 自动生成）
const PRODUCT_FIELD_CONFIGS = getFeishuFieldConfigs();

// 定义商家表字段配置（移除详情相关字段）
const SELLER_FIELD_CONFIGS = [
  { name: '商家名称', type: 1 },      // 文本
  { name: '地点', type: 1 }          // 文本
];

// 获取表格字段列表
async function getTableFields(tableId) {
  const token = await getTenantAccessToken();
  
  try {
    const response = await fetch(
      `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${feishuConfig.spreadsheetToken}/tables/${tableId}/fields`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );

    const data = await response.json();
    
    if (data.code !== 0) {
      console.error('[闲鱼采集-飞书] 获取字段列表失败:', data);
      throw new Error(data.msg || '获取字段列表失败');
    }

    return data.data?.items || [];
  } catch (error) {
    console.error('[闲鱼采集-飞书] 获取字段列表异常:', error);
    throw error;
  }
}

// 创建表格字段
async function createTableField(tableId, fieldConfig) {
  const token = await getTenantAccessToken();
  
  try {
    const response = await fetch(
      `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${feishuConfig.spreadsheetToken}/tables/${tableId}/fields`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          field_name: fieldConfig.name,
          type: fieldConfig.type
        })
      }
    );

    const data = await response.json();
    
    if (data.code !== 0) {
      console.error(`[闲鱼采集-飞书] 创建字段失败 [${fieldConfig.name}]:`, data);
      throw new Error(data.msg || `创建字段失败: ${fieldConfig.name}`);
    }

    console.log(`[闲鱼采集-飞书] 成功创建字段: ${fieldConfig.name}`);
    return data.data?.field;
  } catch (error) {
    console.error(`[闲鱼采集-飞书] 创建字段异常 [${fieldConfig.name}]:`, error);
    throw error;
  }
}

// 确保表格字段存在
async function ensureTableFields(tableId, fieldConfigs) {
  console.log(`[闲鱼采集-飞书] 开始检查表格字段...`);
  
  // 获取现有字段
  const existingFields = await getTableFields(tableId);
  const existingFieldNames = new Set(existingFields.map(f => f.field_name));
  
  console.log(`[闲鱼采集-飞书] 现有字段:`, Array.from(existingFieldNames));
  
  // 找出缺失的字段
  const missingFields = fieldConfigs.filter(config => !existingFieldNames.has(config.name));
  
  if (missingFields.length === 0) {
    console.log(`[闲鱼采集-飞书] 所有字段已存在`);
    return;
  }
  
  console.log(`[闲鱼采集-飞书] 需要创建 ${missingFields.length} 个字段:`, missingFields.map(f => f.name));
  
  // 逐个创建缺失的字段
  for (const fieldConfig of missingFields) {
    await createTableField(tableId, fieldConfig);
    // 避免速率限制
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  console.log(`[闲鱼采集-飞书] 字段创建完成`);
}

// 转换商品数据为飞书记录格式（使用 PRODUCT_SCHEMA 自动转换）
function convertProductToFeishuRecord(item) {
  const fields = {
    // 添加关键字字段（不在 schema 中）
    '关键字': String(currentKeyword || '')
  };
  
  // 遍历 PRODUCT_SCHEMA，自动转换所有字段
  Object.entries(PRODUCT_SCHEMA).forEach(([key, config]) => {
    const fieldName = config.feishuField || config.label;
    const value = item[key];
    
    // 根据飞书字段类型转换数据
    if (config.feishuType === 1) {
      // 文本类型
      fields[fieldName] = String(value || '');
    } else if (config.feishuType === 2) {
      // 数字类型
      fields[fieldName] = Number(value) || 0;
    } else if (config.feishuType === 5) {
      // 日期类型（时间戳）
      fields[fieldName] = value || null;
    } else if (config.feishuType === 15) {
      // URL类型
      const url = normalizeUrl(value || '');
      fields[fieldName] = url ? { link: url } : null;
    } else {
      // 默认处理
      fields[fieldName] = value;
    }
  });
  
  return { fields };
}

// 转换商家数据为飞书记录格式（移除详情相关字段）
function convertSellerToFeishuRecord(item) {
  return {
    fields: {
      '商家名称': String(item.sellerNick || ''),
      '地点': String(item.sellerCity || '')
    }
  };
}

// 获取表格中已存在的商品组合键（用于去重）
async function getExistingItemIds(tableId) {
  const token = await getTenantAccessToken();
  const existingKeys = new Set();
  
  try {
    let hasMore = true;
    let pageToken = undefined;
    
    while (hasMore) {
      const url = new URL(`${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${feishuConfig.spreadsheetToken}/tables/${tableId}/records`);
      url.searchParams.append('page_size', '500');
      url.searchParams.append('field_names', '["商品ID", "想要人数", "价格"]');
      if (pageToken) {
        url.searchParams.append('page_token', pageToken);
      }
      
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      const data = await response.json();
      
      if (data.code !== 0) {
        console.error('[闲鱼采集-飞书] 获取已存在商品失败:', data);
        throw new Error(data.msg || '获取已存在商品失败');
      }
      
      // 收集商品组合键（商品ID + 想要数 + 价格）
      (data.data?.items || []).forEach(item => {
        const itemId = item.fields?.['商品ID'];
        const wantCnt = item.fields?.['想要人数'] || 0;
        const price = item.fields?.['价格'] || 0;
        if (itemId) {
          const compositeKey = `${itemId}_${wantCnt}_${price}`;
          existingKeys.add(compositeKey);
        }
      });
      
      hasMore = data.data?.has_more || false;
      pageToken = data.data?.page_token;
      
      // 避免速率限制
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    console.log(`[闲鱼采集-飞书] 已存在的商品组合键数量: ${existingKeys.size}`);
    return existingKeys;
  } catch (error) {
    console.error('[闲鱼采集-飞书] 获取已存在商品异常:', error);
    // 如果获取失败，返回空集合，继续执行（不影响主流程）
    return new Set();
  }
}

// 批量创建记录
async function batchCreateRecords(tableId, records) {
  const token = await getTenantAccessToken();

  // 飞书 API 每次最多创建 500 条记录
  const batchSize = 500;
  const results = [];

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);

    try {
      const url = `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${feishuConfig.spreadsheetToken}/tables/${tableId}/records/batch_create`;
      console.log('[闲鱼采集-飞书] 请求 URL:', url);
      console.log('[闲鱼采集-飞书] 请求数据数量:', batch.length);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          records: batch
        })
      });

      console.log('[闲鱼采集-飞书] HTTP 响应状态:', response.status, response.statusText);

      const data = await response.json();
      console.log('[闲鱼采集-飞书] 响应数据:', data);

      if (data.code !== 0) {
        console.error('[闲鱼采集-飞书] 批量创建记录失败:', data);
        throw new Error(data.msg || '批量创建记录失败');
      }

      results.push(...(data.data?.records || []));
      console.log(`[闲鱼采集-飞书] 成功创建 ${batch.length} 条记录`);

      // 速率限制: 每次请求后等待 200ms
      if (i + batchSize < records.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } catch (error) {
      console.error('[闲鱼采集-飞书] 批量创建记录异常:', error);
      throw error;
    }
  }

  return results;
}

// 发送数据到飞书
async function sendToFeishu(processedData) {
  if (!feishuConfig.enabled) {
    return { success: false, error: '飞书同步未启用' };
  }

  if (!feishuConfig.appId || !feishuConfig.appSecret) {
    return { success: false, error: '请先配置飞书 App ID 和 App Secret' };
  }

  if (!feishuConfig.spreadsheetToken || !feishuConfig.productTableId) {
    return { success: false, error: '请先配置飞书表格 Token 和商品表 ID' };
  }

  try {
    // 自动创建商品表字段
    console.log('[闲鱼采集-飞书] 开始检查并创建商品表字段...');
    await ensureTableFields(feishuConfig.productTableId, PRODUCT_FIELD_CONFIGS);

    console.log('[闲鱼采集-飞书] 当前关键词:', currentKeyword);
    console.log('[闲鱼采集-飞书] 处理后数据量:', processedData.length);
    
    // 打印前3条数据，检查是否有空值
    if (processedData.length > 0) {
      console.log('[闲鱼采集-飞书] 第1条数据:', {
        itemId: processedData[0].itemId,
        title: processedData[0].title?.substring(0, 20),
        price: processedData[0].price,
        hasAllFields: !!(processedData[0].itemId && processedData[0].title)
      });
    }

    const productRecords = processedData
      .filter(item => {
        // 过滤掉关键字段为空的记录
        const hasValidData = item.itemId && item.title;
        if (!hasValidData) {
          console.warn('[闲鱼采集-飞书] 过滤空记录:', item);
        }
        return hasValidData;
      })
      .map(convertProductToFeishuRecord);

    console.log('[闲鱼采集-飞书] 过滤后的记录数:', productRecords.length);

    // 获取已存在的商品组合键，用于去重
    console.log('[闲鱼采集-飞书] 开始获取已存在的商品组合键...');
    const existingItemKeys = await getExistingItemIds(feishuConfig.productTableId);
    
    // 过滤掉已存在的商品（根据组合键）
    const newProductRecords = productRecords.filter(record => {
      const itemId = record.fields['商品ID'];
      const wantCnt = record.fields['想要人数'] || 0;
      const priceNum = record.fields['价格'] || 0;
      // 注意：这里需要使用价格数值构建组合键，但在获取已存在记录时也需要使用数值
      const compositeKey = `${itemId}_${wantCnt}_${priceNum}`;
      const isNew = !existingItemKeys.has(compositeKey);
      if (!isNew) {
        console.log(`[闲鱼采集-飞书] 跳过已存在的商品: ${compositeKey}`);
      }
      return isNew;
    });
    
    console.log(`[闲鱼采集-飞书] 去重后待创建的记录数: ${newProductRecords.length}/${productRecords.length}`);
    
    // 如果没有新记录，直接返回
    if (newProductRecords.length === 0) {
      console.log('[闲鱼采集-飞书] 没有新记录需要创建');
      return {
        success: true,
        productCount: 0,
        sellerCount: 0,
        message: '所有商品已存在，未添加新记录'
      };
    }

    // 创建商品记录
    const productResults = await batchCreateRecords(feishuConfig.productTableId, newProductRecords);

    let sellerResults = [];
    if (feishuConfig.sellerTableId) {
      // 自动创建商家表字段
      console.log('[闲鱼采集-飞书] 开始检查并创建商家表字段...');
      await ensureTableFields(feishuConfig.sellerTableId, SELLER_FIELD_CONFIGS);

      // 去重商家记录
      const sellerMap = new Map();
      processedData.forEach(item => {
        if (item.sellerNick && !sellerMap.has(item.sellerNick)) {
          sellerMap.set(item.sellerNick, item);
        }
      });

      const sellerRecords = Array.from(sellerMap.values()).map(convertSellerToFeishuRecord);
      sellerResults = await batchCreateRecords(feishuConfig.sellerTableId, sellerRecords);
    }

    return {
      success: true,
      productCount: productResults.length,
      sellerCount: sellerResults.length
    };
  } catch (error) {
    console.error('[闲鱼采集-飞书] 发送数据失败:', error);
    return { success: false, error: error.message };
  }
}
