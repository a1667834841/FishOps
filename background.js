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

// 存储采集到的数据
let capturedData = [];
let capturedItemIds = new Set(); // 用于采集时去重的商品ID集合
let requestLogs = []; // 存储每次请求的URL、参数和返回值
let itemDetailData = []; // 存储商品详情数据
let statistics = {
  pageCount: 0,        // 采集页数
  itemCount: 0,        // 商品总数
  detailCount: 0,      // 商品详情数
  lastCaptureTime: null
};

// 配置选项
let config = {
  autoFetchDetail: false,  // 是否自动调用详情API
  detailFetchDelay: 1000   // 详情API请求间隔(ms)
};

// 监听来自content script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[闲鱼采集] Background收到消息:', request.type);

  if (request.type === 'API_DATA_CAPTURED') {
    const apiData = request.data;
    const resultList = apiData.response?.data?.resultList || [];

    // 记录请求信息
    try {
      // 处理协议相对URL（如 //h5api.m.goofish.com/...)
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

    // 过滤已采集的商品（根据itemId去重）
    const newItems = resultList.filter(item => {
      const mainData = item.data?.item?.main;
      if (!mainData) return false;
      const exContent = mainData.exContent || {};
      const clickParam = mainData.clickParam?.args || {};
      const itemId = clickParam.item_id || exContent.itemId || '';
      
      if (!itemId) return false;
      if (capturedItemIds.has(itemId)) return false;
      
      capturedItemIds.add(itemId);
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

  // 处理商品详情数据
  if (request.type === 'DETAIL_DATA_CAPTURED') {
    const apiData = request.data;
    const detailData = apiData.response.data;

    if (!detailData) {
      console.error('[闲鱼采集] 详情数据格式错误');
      sendResponse({ success: false, error: '详情数据格式错误' });
      return true;
    }

    const itemDO = detailData.itemDO || {};
    const sellerDO = detailData.sellerDO || {};
    const itemId = itemDO.itemId;

    console.log('[闲鱼采集] ========== 收到商品详情 ==========');
    console.log('[闲鱼采集] 商品ID:', itemId);
    console.log('[闲鱼采集] 标题:', itemDO.title);
    console.log('[闲鱼采集] 价格:', itemDO.soldPrice);
    console.log('[闲鱼采集] 想要数:', itemDO.wantCnt);
    console.log('[闲鱼采集] 浏览数:', itemDO.browseCnt);

    // 解析请求体获取itemId
    let requestedItemId = '';
    try {
      if (typeof apiData.requestBody === 'string') {
        const urlParams = new URLSearchParams(apiData.requestBody);
        const dataValue = urlParams.get('data');
        if (dataValue) {
          const parsedData = JSON.parse(decodeURIComponent(dataValue));
          requestedItemId = parsedData.itemId;
        }
      }
    } catch (e) {
      console.error('[闲鱼采集] 解析请求体失败:', e);
    }

    // 提取详情数据
    const detailRecord = {
      itemId: itemId,
      requestedItemId: requestedItemId,
      title: itemDO.title || '',
      price: itemDO.soldPrice || '',
      originalPrice: itemDO.originalPrice || '',
      wantCnt: itemDO.wantCnt || 0,
      browseCnt: itemDO.browseCnt || 0,
      collectCnt: itemDO.collectCnt || 0,
      desc: (itemDO.desc || '').replace(/\n/g, ' '),
      gmtCreate: itemDO.GMT_CREATE_DATE_KEY || '',
      publishTime: itemDO.gmtCreate ? new Date(itemDO.gmtCreate).toLocaleString('zh-CN') : '',
      itemStatus: itemDO.itemStatusStr || '',
      quantity: itemDO.quantity || 0,
      transportFee: itemDO.transportFee || '',
      freeShip: itemDO.priceRelativeTags?.some(t => t.text === '包邮') ? '是' : '否',

      // 卖家信息
      sellerId: sellerDO.sellerId || '',
      sellerNick: sellerDO.nick || '',
      sellerCity: sellerDO.city || '',
      sellerAvatar: sellerDO.portraitUrl || '',
      sellerRegDay: sellerDO.userRegDay || 0,
      hasSoldNum: sellerDO.hasSoldNumInteger || 0,
      sellerSignature: (sellerDO.signature || '').replace(/\n/g, ' '),
      replyRatio24h: sellerDO.replyRatio24h || '',
      replyInterval: sellerDO.replyInterval || '',

      // 图片URL
      images: (itemDO.imageInfos || []).map(img => img.url).join(';'),

      // 详情URL
      detailUrl: `https://www.goofish.com/item?id=${itemId}`,

      // 原始数据
      rawData: detailData,

      // 采集时间
      timestamp: apiData.timestamp,
      captureTime: new Date(apiData.timestamp).toLocaleString()
    };

    // 检查是否已存在该商品的详情（根据itemId去重）
    const existingIndex = itemDetailData.findIndex(d => d.itemId === itemId);
    if (existingIndex >= 0) {
      // 更新现有记录
      itemDetailData[existingIndex] = detailRecord;
      console.log('[闲鱼采集] 更新商品详情:', itemId);
    } else {
      // 添加新记录
      itemDetailData.push(detailRecord);
      statistics.detailCount++;
      console.log('[闲鱼采集] 新增商品详情:', itemId);
    }

    // 保存到 storage
    chrome.storage.local.set({
      itemDetailData: itemDetailData,
      statistics: statistics
    }, () => {
      console.log('[闲鱼采集] 详情数据已保存 - 详情数:', statistics.detailCount);
    });

    sendResponse({
      success: true,
      itemId: itemId,
      detailCount: statistics.detailCount
    });
  }

  // 获取统计信息
  if (request.type === 'GET_STATS') {
    sendResponse({
      pageCount: statistics.pageCount,
      itemCount: statistics.itemCount,
      detailCount: statistics.detailCount || 0,
      lastCaptureTime: statistics.lastCaptureTime || '无'
    });
  }

  // 清空数据
  if (request.type === 'CLEAR_DATA') {
    console.log('[闲鱼采集] 开始清空数据...');
    capturedData = [];
    capturedItemIds = new Set(); // 清空去重ID集合
    requestLogs = []; // 清空请求记录
    itemDetailData = []; // 清空详情数据
    statistics = {
      pageCount: 0,
      itemCount: 0,
      detailCount: 0,
      lastCaptureTime: null
    };

    chrome.storage.local.clear(() => {
      if (chrome.runtime.lastError) {
        console.error('[闲鱼采集] 清空storage失败:', chrome.runtime.lastError);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true });
      }
    });
    return true; // 保持消息通道开启以支持异步响应
  }

  // 导出CSV数据
  if (request.type === 'EXPORT_CSV') {
    console.log('[闲鱼采集] ========== 导出CSV ==========');
    console.log('[闲鱼采集] capturedData长度:', capturedData.length);
    console.log('[闲鱼采集] capturedItemIds数量:', capturedItemIds.size);
    console.log('[闲鱼采集] statistics:', statistics);
    console.log('[闲鱼采集] requestLogs长度:', requestLogs.length);

    // 打印前几条数据结构用于调试
    if (capturedData.length > 0) {
      console.log('[闲鱼采集] 第1页 capturedData:', {
        url: capturedData[0].url,
        itemsCount: capturedData[0].items?.length,
        hasItems: !!capturedData[0].items,
        itemsType: typeof capturedData[0].items,
        firstItem: capturedData[0].items?.[0]
      });
    }

    // 打印 requestLogs 第一条用于对比
    if (requestLogs.length > 0) {
      console.log('[闲鱼采集] 第1条 requestLogs:', {
        url: requestLogs[0].url,
        itemCount: requestLogs[0].itemCount,
        hasResponse: !!requestLogs[0].response,
        responseKeys: Object.keys(requestLogs[0].response || {})
      });
    }

    try {
      const csvData = generateCSV(capturedData);
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

  // 导出详情CSV数据
  if (request.type === 'EXPORT_DETAIL_CSV') {
    try {
      const csvData = generateDetailCSV(itemDetailData);
      sendResponse({ success: true, csvData: csvData });
    } catch (error) {
      console.error('[闲鱼采集] 详情CSV生成失败:', error);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  return true; // 保持消息通道开启，用于异步响应
});

// 从 storage 恢复数据
chrome.storage.local.get(['capturedData', 'capturedItemIds', 'requestLogs', 'statistics', 'itemDetailData'], (result) => {
  if (result.capturedData) {
    capturedData = result.capturedData;
    console.log('[闲鱼采集] 从 storage恢复数据，数量:', capturedData.length);
  }
  if (result.capturedItemIds) {
    capturedItemIds = new Set(result.capturedItemIds); // 数组转Set
    console.log('[闲鱼采集] 恢复已采集商品ID数:', capturedItemIds.size);
  }
  if (result.requestLogs) {
    requestLogs = result.requestLogs;
    console.log('[闲鱼采集] 恢复请求记录数:', requestLogs.length);
  }
  if (result.itemDetailData) {
    itemDetailData = result.itemDetailData;
    console.log('[闲鱼采集] 恢复详情数据数:', itemDetailData.length);
  }
  if (result.statistics) {
    statistics = result.statistics;
    console.log('[闲鱼采集] 恢复统计 - 页数:', statistics.pageCount, '商品数:', statistics.itemCount, '详情数:', statistics.detailCount || 0);
  }
});

// 生成CSV数据
function generateCSV(data) {
  if (!data || data.length === 0) {
    throw new Error('没有数据可导出');
  }

  // CSV表头
  const headers = [
    '记录ID', '标题', '价格', '原价', '卖家昵称', 
    '想要人数', '浏览量', '发布时间', '地区',
    '包邮', '商品标签', '图片URL', '详情URL'
  ];

  let csvContent = headers.join(',') + '\n';
  
  // 用于去重的recordId集合
  const seenRecordIds = new Set();

  // 遍历所有页面的数据
  data.forEach(pageData => {
    const items = pageData.items || [];
    
    items.forEach(item => {
      try {
        const mainData = item.data?.item?.main;
        if (!mainData) return;

        const exContent = mainData.exContent || {};
        const clickParam = mainData.clickParam?.args || {};
        
        // 提取数据
        const itemId = clickParam.item_id || exContent.itemId || '';
        const title = (exContent.title || '').replace(/,/g, '，').replace(/\n/g, ' ');
        const priceArray = exContent.price || [];
        const price = priceArray.map(p => p.text || '').join('');
        const oriPrice = exContent.oriPrice || '';
        const seller = exContent.userNickName || '';
        const viewNum = '';
        const publishTime = clickParam.publishTime ? new Date(parseInt(clickParam.publishTime)).toLocaleString('zh-CN') : '';
        const area = exContent.area || '';
        const freeShip = clickParam.tag?.includes('freeship') || clickParam.tagname?.includes('包邮') ? '是' : '否';
        
        // 提取商品标签 - 从fishTags的各个区域(r1,r2,r3等)的tagList中提取data.content
        const fishTags = exContent.fishTags || {};
        const tagContents = [];
        Object.values(fishTags).forEach(region => {
          const tagList = region?.tagList || [];
          tagList.forEach(tag => {
            const content = tag?.data?.content;
            if (content) {
              tagContents.push(content);
            }
          });
        });
        
        // 从标签中提取"人想要"数据作为想要人数
        const wantTagMatch = tagContents.find(c => c.endsWith('人想要'));
        const wantNum = wantTagMatch ? wantTagMatch.replace('人想要', '') : '';
        
        // 标签名称替换映射
        const tagNameMap = {
          'nfrIcon': '描述不符包邮退',
          'freeShippingIcon': '包邮'
        };
        
        // 过滤掉"人想要"标签，并替换特定标签名称
        const processedTags = tagContents
          .filter(c => !c.endsWith('人想要'))
          .map(c => tagNameMap[c] || c);
        
        // 去重后用、分隔
        const fishTagsStr = [...new Set(processedTags)].join('、');
        
        const picUrl = exContent.picUrl || '';
        const detailUrl = `https://www.goofish.com/item?id=${itemId}`;
        
        // 生成记录ID - 对关键字段做MD5哈希防止重复
        const recordData = `${title}|${price}|${seller}|${itemId}`;
        const recordId = md5(recordData);
        
        // 根据recordId去重
        if (seenRecordIds.has(recordId)) {
          return; // 跳过重复记录
        }
        seenRecordIds.add(recordId);

        // 构建CSV行
        const row = [
          recordId,
          `"${title}"`,
          price,
          oriPrice,
          seller,
          wantNum,
          viewNum,
          publishTime,
          area,
          freeShip,
          `"${fishTagsStr}"`,
          picUrl,
          detailUrl
        ];

        csvContent += row.join(',') + '\n';
      } catch (error) {
        console.error('[闲鱼采集] 处理商品数据出错:', error);
      }
    });
  });

  return csvContent;
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

// 生成详情CSV数据
function generateDetailCSV(details) {
  if (!details || details.length === 0) {
    throw new Error('没有详情数据可导出');
  }

  // CSV表头
  const headers = [
    '商品ID', '标题', '价格', '原价', '想要人数', '浏览量', '收藏数',
    '发布时间', '商品状态', '库存', '运费', '包邮',
    '卖家ID', '卖家昵称', '卖家城市', '卖家头像', '注册天数', '已售件数',
    '回复率', '回复时长', '卖家签名', '图片', '详情URL', '描述', '采集时间'
  ];

  let csvContent = headers.join(',') + '\n';

  // 遍历所有详情数据
  details.forEach(detail => {
    try {
      // 构建CSV行
      const row = [
        detail.itemId,
        `"${(detail.title || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`,
        detail.price,
        detail.originalPrice,
        detail.wantCnt,
        detail.browseCnt,
        detail.collectCnt,
        detail.publishTime,
        `"${detail.itemStatus}"`,
        detail.quantity,
        detail.transportFee,
        `"${detail.freeShip}"`,
        detail.sellerId,
        `"${(detail.sellerNick || '').replace(/"/g, '""')}"`,
        `"${detail.sellerCity}"`,
        detail.sellerAvatar,
        detail.sellerRegDay,
        detail.hasSoldNum,
        `"${detail.replyRatio24h}"`,
        `"${detail.replyInterval}"`,
        `"${(detail.sellerSignature || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`,
        `"${detail.images}"`,
        detail.detailUrl,
        `"${(detail.desc || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`,
        detail.captureTime
      ];

      csvContent += row.join(',') + '\n';
    } catch (error) {
      console.error('[闲鱼采集] 处理详情数据出错:', error);
    }
  });

  return csvContent;
}

console.log('[闲鱼采集] Background初始化完成，等待数据...');
