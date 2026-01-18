/**
 * 闲鱼 API 模块
 * 提供签名生成和API请求功能
 */

window.XianyuAPI = (function () {
  'use strict';

  // ==================== MessagePack 解析工具 ====================

  /**
   * MessagePack 解码器
   * 用于解析阿里系聊天 WebSocket 的 Base64 数据
   */
  class MessagePackDecoder {
    constructor(buffer) {
      this.view = new DataView(buffer);
      this.offset = 0;
    }

    decode() {
      return this.parse();
    }

    parse() {
      const byte = this.view.getUint8(this.offset++);

      // positive fixint
      if (byte <= 0x7f) return byte;

      // fixmap
      if (byte >= 0x80 && byte <= 0x8f) {
        return this.parseMap(byte - 0x80);
      }

      // fixarray
      if (byte >= 0x90 && byte <= 0x9f) {
        return this.parseArray(byte - 0x90);
      }

      // fixstr
      if (byte >= 0xa0 && byte <= 0xbf) {
        return this.parseString(byte - 0xa0);
      }

      // nil
      if (byte === 0xc0) return null;

      // false
      if (byte === 0xc2) return false;

      // true
      if (byte === 0xc3) return true;

      // bin 8
      if (byte === 0xc4) {
        const len = this.view.getUint8(this.offset++);
        return this.parseBytes(len);
      }

      // bin 16
      if (byte === 0xc5) {
        const len = this.view.getUint16(this.offset);
        this.offset += 2;
        return this.parseBytes(len);
      }

      // bin 32
      if (byte === 0xc6) {
        const len = this.view.getUint32(this.offset);
        this.offset += 4;
        return this.parseBytes(len);
      }

      // float 32
      if (byte === 0xca) {
        const val = this.view.getFloat32(this.offset);
        this.offset += 4;
        return val;
      }

      // float 64
      if (byte === 0xcb) {
        const val = this.view.getFloat64(this.offset);
        this.offset += 8;
        return val;
      }

      // uint 8
      if (byte === 0xcc) {
        return this.view.getUint8(this.offset++);
      }

      // uint 16
      if (byte === 0xcd) {
        const val = this.view.getUint16(this.offset);
        this.offset += 2;
        return val;
      }

      // uint 32
      if (byte === 0xce) {
        const val = this.view.getUint32(this.offset);
        this.offset += 4;
        return val;
      }

      // uint 64
      if (byte === 0xcf) {
        const val = this.view.getBigUint64(this.offset);
        this.offset += 8;
        return Number(val);
      }

      // int 8
      if (byte === 0xd0) {
        return this.view.getInt8(this.offset++);
      }

      // int 16
      if (byte === 0xd1) {
        const val = this.view.getInt16(this.offset);
        this.offset += 2;
        return val;
      }

      // int 32
      if (byte === 0xd2) {
        const val = this.view.getInt32(this.offset);
        this.offset += 4;
        return val;
      }

      // int 64
      if (byte === 0xd3) {
        const val = this.view.getBigInt64(this.offset);
        this.offset += 8;
        return Number(val);
      }

      // str 8
      if (byte === 0xd9) {
        const len = this.view.getUint8(this.offset++);
        return this.parseString(len);
      }

      // str 16
      if (byte === 0xda) {
        const len = this.view.getUint16(this.offset);
        this.offset += 2;
        return this.parseString(len);
      }

      // str 32
      if (byte === 0xdb) {
        const len = this.view.getUint32(this.offset);
        this.offset += 4;
        return this.parseString(len);
      }

      // array 16
      if (byte === 0xdc) {
        const len = this.view.getUint16(this.offset);
        this.offset += 2;
        return this.parseArray(len);
      }

      // array 32
      if (byte === 0xdd) {
        const len = this.view.getUint32(this.offset);
        this.offset += 4;
        return this.parseArray(len);
      }

      // map 16
      if (byte === 0xde) {
        const len = this.view.getUint16(this.offset);
        this.offset += 2;
        return this.parseMap(len);
      }

      // map 32
      if (byte === 0xdf) {
        const len = this.view.getUint32(this.offset);
        this.offset += 4;
        return this.parseMap(len);
      }

      // negative fixint
      if (byte >= 0xe0) return byte - 256;

      throw new Error(`Unknown byte: 0x${byte.toString(16)} at offset ${this.offset - 1}`);
    }

    parseString(length) {
      const bytes = new Uint8Array(this.view.buffer, this.offset, length);
      this.offset += length;
      return new TextDecoder('utf-8').decode(bytes);
    }

    parseBytes(length) {
      const bytes = new Uint8Array(this.view.buffer, this.offset, length);
      this.offset += length;
      return bytes;
    }

    parseArray(length) {
      const arr = [];
      for (let i = 0; i < length; i++) {
        arr.push(this.parse());
      }
      return arr;
    }

    parseMap(length) {
      const obj = {};
      for (let i = 0; i < length; i++) {
        const key = this.parse();
        const value = this.parse();
        obj[key] = value;
      }
      return obj;
    }
  }

  /**
   * Base64 字符串转 ArrayBuffer
   */
  function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * 解析阿里系聊天 MessagePack 数据
   * @param {string} base64Data - Base64 编码的 MessagePack 数据
   * @returns {Object|null} 解析后的对象，失败返回 null
   */
  function parseMessagePackData(base64Data) {
    try {
      const buffer = base64ToArrayBuffer(base64Data);
      const decoder = new MessagePackDecoder(buffer);
      const result = decoder.decode();
      return result;
    } catch (error) {
      console.warn('[XianyuAPI] MessagePack 解析失败:', error.message);
      return null;
    }
  }

  /**
   * 检查字符串是否为有效的 JSON
   */
  function isValidJSON(str) {
    try {
      JSON.parse(str);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 解码并解析 Base64 编码的聊天数据
   * 支持 MessagePack 和 JSON 两种格式
   * @param {string} base64Data - Base64 编码的数据
   * @returns {Object|null} 解析后的数据对象
   */
  function decodeChatData(base64Data) {
    if (!base64Data || typeof base64Data !== 'string') {
      console.warn('[XianyuAPI] 无效的 Base64 数据');
      return null;
    }

    const cleanedData = base64Data.trim();

    // 优先尝试 MessagePack 解析（阿里系聊天数据）
    const msgPackData = parseMessagePackData(cleanedData);
    if (msgPackData) {
      console.log('[XianyuAPI] ✅ MessagePack 解析成功');
      return msgPackData;
    }

    // MessagePack 解析失败，尝试传统 Base64 解析
    let decodedText;
    try {
      decodedText = atob(cleanedData);
    } catch (decodeError) {
      console.warn('[XianyuAPI] ⚠️ Base64 解码失败:', decodeError.message);
      return null;
    }

    // 判断是否属于 JSON
    if (!isValidJSON(decodedText)) {
      console.log('[XianyuAPI] 📝 解码后的内容（非JSON）:', decodedText);
      return null;
    }

    // 如果是 JSON，则解析
    try {
      const jsonData = JSON.parse(decodedText);
      console.log('[XianyuAPI] ✅ JSON 解析成功');
      return jsonData;
    } catch (parseError) {
      console.warn('[XianyuAPI] ⚠️ JSON 解析失败:', parseError.message);
      return null;
    }
  }

  /**
   * 从 reminderUrl 中提取接收人ID
   * URL格式: fleamarket://message_chat?itemId=xxx&peerUserId=xxx&sid=xxx
   */
  function extractReceiverId(reminderUrl) {
    if (!reminderUrl) return null;
    const match = reminderUrl.match(/peerUserId=([^&]+)/);
    return match ? match[1] : null;
  }

  /**
   * 从 reminderUrl 中提取会话ID (sid)
   */
  function extractSessionId(reminderUrl) {
    if (!reminderUrl) return null;
    const match = reminderUrl.match(/sid=([^&]+)/);
    return match ? match[1] : null;
  }

  /**
   * 从 reminderUrl 中提取商品ID (itemId)
   */
  function extractItemId(reminderUrl) {
    if (!reminderUrl) return null;
    const match = reminderUrl.match(/itemId=([^&]+)/);
    return match ? match[1] : null;
  }

  // ==================== MD5 算法（使用公共模块） ====================
  // 优先使用公共模块的 MD5 函数，如果不可用则使用备用实现
  function md5(string) {
    // 尝试使用公共模块
    if (typeof window !== 'undefined' && window.FishOpsUtils && window.FishOpsUtils.md5) {
      return window.FishOpsUtils.md5(string);
    }
    // 备用：使用内置简化 MD5（确保在 utils.js 加载前也能工作）
    console.warn('[XianyuAPI] FishOpsUtils 未加载，使用备用 MD5');
    return _fallbackMd5(string);
  }

  // 备用 MD5 实现（仅在公共模块不可用时使用）
  function _fallbackMd5(string) {
    function rotateLeft(value, shift) { return (value << shift) | (value >>> (32 - shift)); }
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
    function convertToWordArray(str) {
      const utf8 = unescape(encodeURIComponent(str));
      const len = utf8.length;
      const words = [];
      for (let i = 0; i < len; i += 4) {
        words.push((utf8.charCodeAt(i) || 0) | ((utf8.charCodeAt(i + 1) || 0) << 8) | ((utf8.charCodeAt(i + 2) || 0) << 16) | ((utf8.charCodeAt(i + 3) || 0) << 24));
      }
      words[len >> 2] |= 0x80 << ((len % 4) * 8);
      words[(((len + 8) >>> 6) << 4) + 14] = len * 8;
      return words;
    }
    function wordToHex(value) {
      let hex = '';
      for (let i = 0; i < 4; i++) hex += ((value >> (i * 8)) & 0xFF).toString(16).padStart(2, '0');
      return hex;
    }
    const x = convertToWordArray(string);
    let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
    const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const K = [0xD76AA478, 0xE8C7B756, 0x242070DB, 0xC1BDCEEE, 0xF57C0FAF, 0x4787C62A, 0xA8304613, 0xFD469501, 0x698098D8, 0x8B44F7AF, 0xFFFF5BB1, 0x895CD7BE, 0x6B901122, 0xFD987193, 0xA679438E, 0x49B40821, 0xF61E2562, 0xC040B340, 0x265E5A51, 0xE9B6C7AA, 0xD62F105D, 0x02441453, 0xD8A1E681, 0xE7D3FBC8, 0x21E1CDE6, 0xC33707D6, 0xF4D50D87, 0x455A14ED, 0xA9E3E905, 0xFCEFA3F8, 0x676F02D9, 0x8D2A4C8A, 0xFFFA3942, 0x8771F681, 0x6D9D6122, 0xFDE5380C, 0xA4BEEA44, 0x4BDECFA9, 0xF6BB4B60, 0xBEBFBC70, 0x289B7EC6, 0xEAA127FA, 0xD4EF3085, 0x04881D05, 0xD9D4D039, 0xE6DB99E5, 0x1FA27CF8, 0xC4AC5665, 0xF4292244, 0x432AFF97, 0xAB9423A7, 0xFC93A039, 0x655B59C3, 0x8F0CCC92, 0xFFEFF47D, 0x85845DD1, 0x6FA87E4F, 0xFE2CE6E0, 0xA3014314, 0x4E0811A1, 0xF7537E82, 0xBD3AF235, 0x2AD7D2BB, 0xEB86D391];
    for (let k = 0; k < x.length; k += 16) {
      const AA = a, BB = b, CC = c, DD = d;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = F(b, c, d); g = i; }
        else if (i < 32) { f = G(b, c, d); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = H(b, c, d); g = (3 * i + 5) % 16; }
        else { f = I(b, c, d); g = (7 * i) % 16; }
        const temp = d; d = c; c = b;
        b = addUnsigned(b, rotateLeft(addUnsigned(addUnsigned(a, f), addUnsigned(K[i], x[k + g] || 0)), S[(Math.floor(i / 16) * 4) + (i % 4)]));
        a = temp;
      }
      a = addUnsigned(a, AA); b = addUnsigned(b, BB); c = addUnsigned(c, CC); d = addUnsigned(d, DD);
    }
    return wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d);
  }


  // ==================== Token 获取 ====================

  /**
   * 从 cookie 中获取 MTOP token
   * Cookie 名: _m_h5_tk
   * 格式: token_timestamp
   */
  function getToken() {
    const match = document.cookie.match(/_m_h5_tk=([^;]+)/);
    if (match) {
      const fullToken = match[1];
      // Token 格式通常是 "xxx_timestamp"，取下划线前的部分
      return fullToken.split('_')[0];
    }
    console.warn('[XianyuAPI] 未找到 _m_h5_tk cookie');
    return '';
  }

  /**
   * 获取完整的 token cookie 值
   */
  function getFullToken() {
    const match = document.cookie.match(/_m_h5_tk=([^;]+)/);
    return match ? match[1] : '';
  }

  // ==================== 签名生成 ====================

  /**
   * 生成 MTOP 签名
   * @param {Object|string} data - 请求数据对象或 JSON 字符串
   * @param {Object} options - 可选参数
   * @param {string} options.token - 自定义 token（默认从 cookie 获取）
   * @param {string} options.timestamp - 自定义时间戳（默认当前时间）
   * @param {string} options.appKey - 应用 key（默认 34839810）
   * @returns {Object} 包含签名和相关参数的对象
   */
  function generate(data, options = {}) {
    // 处理 data 参数
    let dataStr = typeof data === 'string' ? data : JSON.stringify(data);

    // 获取参数
    const token = options.token || getToken();
    const timestamp = options.timestamp || Date.now().toString();
    const appKey = options.appKey || '34839810'; // 闲鱼默认 appKey

    // 生成签名字符串
    const signStr = `${token}&${timestamp}&${appKey}&${dataStr}`;
    const sign = md5(signStr);

    const result = {
      sign: sign,
      t: timestamp,
      appKey: appKey,
      token: token,
      data: dataStr,
      signString: signStr
    };

    return result;
  }

  // ==================== API 配置 ====================

  const API_CONFIG = {
    // 搜索 API
    search: {
      baseUrl: 'https://h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search/1.0/',
      api: 'mtop.taobao.idlemtopsearch.pc.search',
      appKey: '34839810'
    },
    // 详情 API
    detail: {
      baseUrl: 'https://h5api.m.goofish.com/h5/mtop.taobao.idle.pc.detail/1.0/',
      api: 'mtop.taobao.idle.pc.detail',
      appKey: '34839810'
    },
    // 流量词（搜索建议）API
    suggest: {
      baseUrl: 'https://h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search.suggest/1.0/',
      api: 'mtop.taobao.idlemtopsearch.pc.search.suggest',
      appKey: '34839810'
    }
  };

  // ==================== 通用请求方法 ====================

  /**
   * 发送 MTOP API 请求
   * @param {string} apiType - API 类型 ('search' | 'detail')
   * @param {Object} data - 请求数据
   * @param {Object} options - 可选参数
   * @returns {Promise} 返回请求结果
   */
  async function request(apiType, data, options = {}) {
    const config = API_CONFIG[apiType];
    if (!config) {
      throw new Error(`[XianyuAPI] 未知的 API 类型: ${apiType}`);
    }

    // 生成签名
    const signResult = generate(data, {
      appKey: options.appKey || config.appKey
    });

    // 构造 URL 参数
    const urlParams = new URLSearchParams({
      jsv: '2.7.2',
      appKey: signResult.appKey,
      t: signResult.t,
      sign: signResult.sign,
      v: '1.0',
      type: 'originaljson',
      accountSite: 'xianyu',
      dataType: 'json',
      timeout: '20000',
      api: config.api,
      sessionOption: 'AutoLoginOnly'
    });

    const fullUrl = config.baseUrl + '?' + urlParams.toString();

    // 构造请求体
    const requestBody = 'data=' + encodeURIComponent(JSON.stringify(data));

    try {
      const response = await fetch(fullUrl, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'origin': 'https://www.goofish.com',
          'referer': 'https://www.goofish.com/'
        },
        body: requestBody,
        credentials: 'include' // 携带 cookie
      });

      const result = await response.json();

      // 注意：不再主动通过 MessageBus 发送数据
      // inject.js 的 fetch 拦截器已经会自动捕获并发送，这里再发送会导致重复计数
      // console.log(`[XianyuAPI] ${apiType === 'detail' ? '详情' : '搜索'}API请求完成`);

      return result;
    } catch (error) {
      console.error('[XianyuAPI] 请求失败:', error);
      throw error;
    }
  }

  // ==================== 搜索 API ====================

  /**
   * 发送闲鱼商品搜索请求
   * @param {number} pageNumber - 页码
   * @param {string} keyword - 搜索关键词
   * @param {Object} options - 可选参数
   * @returns {Promise} 返回请求结果
   */
  async function fetchSearchData(pageNumber, keyword, options = {}) {
    const data = {
      pageNumber: pageNumber,
      keyword: keyword,
      fromFilter: false,
      rowsPerPage: 30,
      sortValue: "",
      sortField: "",
      customDistance: "",
      gps: "",
      propValueStr: { "searchFilter": "publishDays:14;" },
      customGps: "",
      searchReqFromPage: "pcSearch",
      extraFilterValue: "{}",
      userPositionJson: "{}"
    };

    return request('search', data, options);
  }

  // ==================== 详情 API ====================

  /**
   * 发送闲鱼商品详情请求
   * @param {string} itemId - 商品ID
   * @param {Object} options - 可选参数
   * @returns {Promise} 返回请求结果
   */
  async function fetchItemDetail(itemId, options = {}) {
    const data = {
      itemId: itemId
    };

    return request('detail', data, options);
  }

  // ==================== 流量词（搜索建议）API ====================

  /**
   * 获取闲鱼流量词（搜索建议）列表
   * @param {string} inputWords - 输入词
   * @param {Object} options - 可选参数
   * @param {string} options.searchReqFromPage - 搜索来源页面（默认 xyPcHome）
   * @param {number} options.bucketId - 桶ID（默认 30）
   * @param {number} options.type - 类型（默认 0）
   * @returns {Promise<string[]>} 返回流量词列表
   */
  async function fetchSuggestWords(inputWords, options = {}) {
    const data = {
      inputWords: inputWords,
      searchReqFromPage: options.searchReqFromPage || 'xyPcHome',
      bucketId: options.bucketId || 30,
      type: options.type || 0
    };

    const result = await request('suggest', data, options);

    // 提取流量词列表
    const items = result && result.data && Array.isArray(result.data.items)
      ? result.data.items
      : [];

    return items
      .map(item => item.suggest)
      .filter(text => !!text);
  }

  // ==================== 闲鱼业务消息处理 ====================

  /**
   * 修复 UTF-8 乱码问题
   * 将被错误解码为 ISO-8859-1 的 UTF-8 字符串还原
   */
  function fixUTF8Encoding(str) {
    if (typeof str !== 'string') return str;

    try {
      // 更准确的乱码检测模式（针对中文优化）
      const hasMojibake =
        // 模式1: 检测连续的 Latin-1 补充字符（典型乱码特征）
        /[\u00C0-\u00FF]{2,}/.test(str) ||
        // 模式2: 检测 UTF-8 双字节序列被错误解码的情况
        /[\u00C2-\u00DF][\u0080-\u00BF]/.test(str) ||
        // 模式3: 检测 UTF-8 三字节序列被错误解码的情况（中文常见）
        /[\u00E0-\u00EF][\u0080-\u00BF]{2}/.test(str);

      if (!hasMojibake) {
        return str; // 没有乱码，直接返回
      }

      // 将字符串转换为字节数组（按 ISO-8859-1 编码）
      const bytes = [];
      for (let i = 0; i < str.length; i++) {
        bytes.push(str.charCodeAt(i) & 0xff);
      }

      // 使用 TextDecoder 将字节数组按 UTF-8 解码
      const decoder = new TextDecoder('utf-8');
      return decoder.decode(new Uint8Array(bytes));
    } catch (error) {
      console.warn('[XianyuAPI] 编码修复失败:', error);
      return str;
    }
  }

  /**
   * 递归修复对象中所有字符串的编码问题
   */
  function fixEncodingInObject(obj) {
    if (typeof obj === 'string') {
      return fixUTF8Encoding(obj);
    }

    if (Array.isArray(obj)) {
      return obj.map(item => fixEncodingInObject(item));
    }

    if (typeof obj === 'object' && obj !== null) {
      const fixed = {};
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          fixed[key] = fixEncodingInObject(obj[key]);
        }
      }
      return fixed;
    }

    return obj;
  }

  /**
   * 判断是否为订单消息
   */
  function isOrderMessage(data) {
    return data && data['3'] && data['3']['redReminder'];
  }

  /**
   * 判断是否为正在输入状态
   * 检查消息['1']数组中是否包含@goofish字符串
   */
  function isTypingStatus(data) {
    try {
      return (
        typeof data === 'object' &&
        data !== null &&
        '1' in data &&
        Array.isArray(data['1']) &&
        data['1'].length > 0 &&
        typeof data['1'][0] === 'object' &&
        data['1'][0] !== null &&
        '1' in data['1'][0] &&
        typeof data['1'][0]['1'] === 'string' &&
        data['1'][0]['1'].includes('@goofish')
      );
    } catch (e) {
      return false;
    }
  }

  /**
   * 判断是否为系统消息
   */
  function isSystemMessage(data) {
    return data && data['3'] && data['3']['systemNotice'];
  }

  /**
   * 判断是否为用户聊天消息
   */
  function isChatMessage(data) {
    return data && data['1'] && data['1']['10'] && data['1']['10']['reminderContent'];
  }

  /**
   * 获取消息类型
   */
  function getMessageType(data) {
    if (!data) return '未知';
    if (isOrderMessage(data)) return '订单消息';
    if (isTypingStatus(data)) return '正在输入';
    if (isSystemMessage(data)) return '系统消息';
    if (isChatMessage(data)) return '用户聊天消息';
    return '未知类型';
  }

  /**
   * 安全的 JSON 解析函数，自动进行编码修复
   */
  function safeJSONParse(str) {
    try {
      const parsed = JSON.parse(str);
      return fixEncodingInObject(parsed);
    } catch (e) {
      console.warn('[XianyuAPI] JSON解析失败:', e);
      return null;
    }
  }

  /**
   * 构造统一的聊天消息对象
   * @param {Object} options - 配置选项
   * @returns {Object} 聊天消息对象
   */
  function buildChatMessage(options) {
    const {
      senderId,
      senderName,
      senderUserType,
      clientIp,
      receiverId,
      sessionId,
      itemId,
      content,
      contentType,
      timestamp,
      createAt,
      messageId,
      platform,
      appVersion,
      direction // 'in' = 接收的消息, 'out' = 发送的消息
    } = options;

    return {
      type: 'chat',
      // 发送人信息
      senderId: senderId || '未知',
      senderName: senderName || '未知',
      senderUserType: senderUserType || '0',
      clientIp: clientIp || '未知',
      // 接收人信息
      receiverId: receiverId || '未知',
      sessionId: sessionId || '未知',
      // 商品信息
      itemId: itemId || '未知',
      // 消息内容
      content: content || '',
      contentType: contentType || 101,
      // 时间信息
      timestamp: timestamp || new Date().toLocaleString(),
      createAt: createAt || Date.now(),
      // 其他信息
      messageId: messageId || '未知',
      platform: platform || '未知',
      appVersion: appVersion || '未知',
      // 消息方向：in=接收, out=发送
      direction: direction || 'in'
    };
  }

  /**
   * 处理闲鱼聊天数据项（对象格式）
   * @param {Object} dataItem - 包含 data 字段的数据对象
   * @param {number} index - 数据索引
   * @returns {Object|null} 解析后的聊天信息
   */
  function handleObjectDataItem(dataItem, index) {
    console.log(`[XianyuAPI] 📦 消息包 [${index + 1}]:`, {
      bizType: dataItem.bizType,
      objectType: dataItem.objectType,
      streamId: dataItem.streamId
    });

    // 解码 data 字段
    try {
      let decodedData = safeJSONParse(atob(dataItem.data));
      if (!decodedData) {
        console.log('[XianyuAPI] ⚠️ 数据解码失败，跳过');
        return null;
      }

      console.log(`[XianyuAPI] 📦 解码后的数据 [${index + 1}]:`, decodedData);

      // 消息分类
      const msgType = getMessageType(decodedData);
      console.log(`[XianyuAPI] 🔍 消息类型: ${msgType}`);

      // 根据消息类型进行处理
      if (isOrderMessage(decodedData)) {
        const orderStatus = decodedData['3']['redReminder'];
        const userId = decodedData['1'] ? decodedData['1'].split('@')[0] : '未知';
        console.log(`[XianyuAPI] 📦 订单状态: ${orderStatus}, 用户ID: ${userId}`);
        return { type: 'order', orderStatus, userId, data: decodedData };
      } else if (isTypingStatus(decodedData)) {
        console.log('[XianyuAPI] ⌨️ 用户正在输入...');
        return { type: 'typing', data: decodedData };
      } else if (isSystemMessage(decodedData)) {
        console.log('[XianyuAPI] 🔔 系统消息（不需要推送）');
        return { type: 'system', data: decodedData };
      } else if (isChatMessage(decodedData)) {
        // 提取聊天消息详细信息
        const chatInfo = decodedData['1']['10'];
        const chatData = buildChatMessage({
          senderId: chatInfo.senderUserId || '未知',
          senderName: chatInfo.reminderTitle || '未知',
          senderUserType: chatInfo.senderUserType || '0',
          clientIp: chatInfo.clientIp || '未知',
          receiverId: decodedData['1']?.['2']?.split('@')[0] || '未知',
          sessionId: chatInfo.reminderUrl ? extractSessionId(chatInfo.reminderUrl) : decodedData['1']?.['2'] || '未知',
          itemId: chatInfo.reminderUrl ? extractItemId(chatInfo.reminderUrl) : '未知',
          content: chatInfo.reminderContent || '',
          contentType: 101,
          timestamp: decodedData['1']['5'] ? new Date(decodedData['1']['5']).toLocaleString() : '未知',
          createAt: decodedData['1']['5'] || Date.now(),
          messageId: decodedData['1']['3'] || '未知',
          platform: chatInfo._platform || '未知',
          appVersion: chatInfo._appVersion || '未知',
          direction: 'in' // 接收的消息
        });
        console.log('[XianyuAPI] 💬 用户聊天消息:', chatData);
        return chatData;
      }

      // 提取会话信息
      if (decodedData.sessionInfo) {
        const sessionInfo = decodedData.sessionInfo;
        const ext = sessionInfo.extensions || {};
        console.log('[XianyuAPI] 📋 会话信息:', {
          sessionId: sessionInfo.sessionId,
          itemTitle: ext.itemTitle || '未知',
          sellerId: ext.itemSellerId || ext.ownerUserId || '未知',
          buyerId: ext.extUserId || '未知',
          itemId: ext.itemId || '未知'
        });
      }

      return { type: 'unknown', data: decodedData };
    } catch (decodeError) {
      console.log('[XianyuAPI] ⚠️ 无法解码 data 字段:', decodeError.message);
      return null;
    }
  }

  /**
   * 处理闲鱼聊天数据项（字符串格式，MessagePack/JSON）
   * @param {string} base64Data - Base64 编码的数据
   * @param {number} index - 数据索引
   * @returns {Object|null} 解析后的聊天信息
   */
  function handleStringDataItem(base64Data, index) {
    // 调用统一解析函数
    const decodedData = decodeChatData(base64Data);

    if (!decodedData) {
      console.log('[XianyuAPI] ⚠️ 数据解析失败，跳过');
      return null;
    }

    console.log(`[XianyuAPI] 📦 同步数据 [${index + 1}] 解析成功:`, decodedData);

    // 消息分类
    const msgType = getMessageType(decodedData);
    console.log(`[XianyuAPI] 🔍 消息类型: ${msgType}`);

    // 判断是否为用户聊天消息
    if (decodedData["1"] && decodedData["1"]["10"] && decodedData["1"]["10"]["reminderContent"]) {
      const chatData = decodedData["1"];
      const contentData = chatData["10"];
      const messageData = chatData["6"] || {};

      // 解析消息内容（从 messageData["3"]["5"] 或 contentData.reminderContent）
      let messageText = '';
      let messageContentType = 101;

      if (messageData["3"] && messageData["3"]["5"]) {
        try {
          const contentJson = JSON.parse(messageData["3"]["5"]);
          if (contentJson.text && contentJson.text.text) {
            messageText = contentJson.text.text;
          }
          messageContentType = contentJson.contentType || 101;
        } catch (e) {
          messageText = messageData["3"]["5"] || contentData.reminderContent || '';
        }
      } else {
        messageText = contentData.reminderContent || '';
      }

      // 从 reminderUrl 提取信息
      const sessionId = extractSessionId(contentData.reminderUrl);
      const itemId = extractItemId(contentData.reminderUrl);
      const peerUserId = extractReceiverId(contentData.reminderUrl);

      // 判断消息方向：根据接收人ID是否等于当前会话的发送方
      // 这里简单判断：如果接收人ID存在且在peerUserId中，则可能是接收的消息
      const direction = 'in'; // 默认为接收的消息，后续可根据业务逻辑调整

      const chatInfo = buildChatMessage({
        senderId: contentData.senderUserId || chatData["1"]?.["1"]?.split('@')[0] || peerUserId || '未知',
        senderName: contentData.reminderTitle || '未知',
        senderUserType: contentData.senderUserType || '0',
        clientIp: contentData.clientIp || '未知',
        receiverId: chatData["2"]?.split('@')[0] || '未知',
        sessionId: sessionId || chatData["2"] || '未知',
        itemId: itemId || '未知',
        content: messageText,
        contentType: messageContentType,
        timestamp: chatData["5"] ? new Date(chatData["5"]).toLocaleString() : new Date().toLocaleString(),
        createAt: chatData["5"] || Date.now(),
        messageId: chatData["3"] || '未知',
        platform: contentData._platform || '未知',
        appVersion: contentData._appVersion || '未知',
        direction: direction
      });

      console.log('[XianyuAPI] 💬 聊天消息:', {
        方向: direction === 'in' ? '接收' : '发送',
        发送人: `${chatInfo.senderName}(${chatInfo.senderId})`,
        发送人IP: chatInfo.clientIp,
        接收人ID: chatInfo.receiverId,
        会话ID: chatInfo.sessionId,
        商品ID: chatInfo.itemId,
        内容: chatInfo.content,
        类型: chatInfo.contentType,
        时间: chatInfo.timestamp
      });

      return chatInfo;
    }

    return { type: 'unknown', data: decodedData };
  }

  /**
   * 处理闲鱼 WebSocket 同步数据
   * @param {Array} syncData - 同步数据数组
   * @returns {Array} 处理后的消息列表
   */
  function handleSyncData(syncData) {
    if (!Array.isArray(syncData)) {
      console.log('[XianyuAPI] syncData 不是数组，类型:', typeof syncData);
      return [];
    }

    console.log('[XianyuAPI] syncData 是数组，长度:', syncData.length);

    const results = [];

    syncData.forEach((dataItem, index) => {
      try {
        // 检查是否为对象（闲鱼格式）
        if (typeof dataItem.data === 'object' && dataItem.data) {
          const result = handleObjectDataItem(dataItem, index);
          if (result) {
            results.push(result);
          }
        }
        // 旧格式：直接是 base64 字符串
        else if (typeof dataItem.data === 'string') {
          const result = handleStringDataItem(dataItem.data, index);
          if (result) {
            results.push(result);
          }
        }
      } catch (decodeError) {
        console.log('[XianyuAPI] ⚠️ 处理消息失败:', decodeError.message);
        console.log('[XianyuAPI] 原始数据:', dataItem);
      }
    });

    return results;
  }

  /**
   * 处理闲鱼 WebSocket 消息
   * @param {string} eventData - WebSocket 接收到的原始数据
   * @returns {Object} 处理结果
   */
  function handleWebSocketMessage(eventData) {
    try {
      const parsed = JSON.parse(eventData);

      // 解析钉钉长轮询协议消息
      if (parsed.body && parsed.body.syncPushPackage && parsed.body.syncPushPackage.data) {
        console.log('[XianyuAPI] 🔄 收到同步包消息');

        const syncData = parsed.body.syncPushPackage.data;
        const messages = handleSyncData(syncData);

        return {
          type: 'sync',
          messages: messages,
          raw: parsed
        };
      }

      // 解析普通消息体
      else if (parsed.body) {
        const body = parsed.body;
        if (body.content || body.extension) {
          // 解析扩展信息（包含发送人、接收人信息）
          const ext = body.extension || {};
          const content = body.content || {};

          // 解析消息内容（custom.data 是 Base64 编码的 JSON）
          let messageText = '';
          if (content.custom && content.custom.data) {
            try {
              const decodedData = atob(content.custom.data);
              const contentJson = JSON.parse(decodedData);
              if (contentJson.text && contentJson.text.text) {
                messageText = contentJson.text.text;
              }
            } catch (e) {
              console.warn('[XianyuAPI] 解析消息内容失败:', e);
              messageText = content.custom.summary || '';
            }
          }

          // 判断消息方向：这是从WebSocket接收到的，默认为接收的消息
          const direction = 'in';

          const chatMessage = buildChatMessage({
            senderId: ext.senderUserId || '未知',
            senderName: ext.reminderTitle || '未知',
            senderUserType: ext.senderUserType || '0',
            clientIp: ext.clientIp || '未知',
            receiverId: extractReceiverId(ext.reminderUrl) || '未知',
            sessionId: extractSessionId(ext.reminderUrl) || '未知',
            itemId: extractItemId(ext.reminderUrl) || '未知',
            content: messageText || content.custom?.summary || '',
            contentType: content.contentType || 101,
            timestamp: body.createAt ? new Date(body.createAt).toLocaleString() : new Date().toLocaleString(),
            createAt: body.createAt || Date.now(),
            messageId: body.messageId || '未知',
            platform: ext._platform || '未知',
            appVersion: ext._appVersion || '未知',
            direction: direction
          });

          console.log('[XianyuAPI] 💬 聊天消息:', {
            方向: direction === 'in' ? '接收' : '发送',
            发送人: `${chatMessage.senderName}(${chatMessage.senderId})`,
            接收人: `ID:${chatMessage.receiverId}`,
            会话ID: chatMessage.sessionId,
            内容: chatMessage.content,
            未读数: body.unreadCount || 0,
            时间: chatMessage.timestamp
          });

          return {
            type: 'message',
            message: chatMessage,
            raw: parsed
          };
        }
      }

      // 记录协议路径
      if (parsed.lwp) {
        console.log('[XianyuAPI] 🔄 LWP协议路径:', parsed.lwp);
      }

      return {
        type: 'unknown',
        raw: parsed
      };

    } catch (e) {
      console.log('[XianyuAPI] ⚠️ 无法解析为JSON:', e.message);
      return {
        type: 'error',
        error: e.message
      };
    }
  }

  // ==================== 导出接口 ====================
  return {
    // MD5
    md5: md5,

    // Token
    getToken: getToken,
    getFullToken: getFullToken,

    // 签名
    generate: generate,

    // 通用请求
    request: request,

    // 搜索 API
    fetchSearchData: fetchSearchData,

    // 详情 API
    fetchItemDetail: fetchItemDetail,

    // 流量词 API
    fetchSuggestWords: fetchSuggestWords,

    // WebSocket 数据解析
    decodeChatData: decodeChatData,
    parseMessagePackData: parseMessagePackData,
    MessagePackDecoder: MessagePackDecoder,

    // URL 参数提取
    extractReceiverId: extractReceiverId,
    extractSessionId: extractSessionId,
    extractItemId: extractItemId,

    // 闲鱼业务消息处理
    buildChatMessage: buildChatMessage,
    handleWebSocketMessage: handleWebSocketMessage,
    handleSyncData: handleSyncData,
    handleObjectDataItem: handleObjectDataItem,
    handleStringDataItem: handleStringDataItem,
    getMessageType: getMessageType,
    isOrderMessage: isOrderMessage,
    isTypingStatus: isTypingStatus,
    isSystemMessage: isSystemMessage,
    isChatMessage: isChatMessage,
    fixUTF8Encoding: fixUTF8Encoding,
    fixEncodingInObject: fixEncodingInObject,
    safeJSONParse: safeJSONParse,

    // 配置
    API_CONFIG: API_CONFIG
  };

})();

console.log('[XianyuAPI] 闲鱼 API 模块已加载');
