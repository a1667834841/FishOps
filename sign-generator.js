/**
 * MTOP 签名生成器
 * 用于在控制台测试闲鱼 API 签名
 * 
 * 使用方法：
 * 1. 在闲鱼页面打开控制台
 * 2. 复制粘贴此文件内容并执行
 * 3. 调用 SignGenerator.generate(data) 生成签名
 */

window.SignGenerator = (function() {
  'use strict';

  // ==================== MD5 算法实现 ====================
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
    console.warn('[SignGenerator] 未找到 _m_h5_tk cookie');
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
   * @param {string} options.appKey - 应用 key（默认 12574478）
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

    // console.log('[SignGenerator] ========== 签名生成结果 ==========');
    // console.log('[SignGenerator] Token:', token);
    // console.log('[SignGenerator] Timestamp:', timestamp);
    // console.log('[SignGenerator] AppKey:', appKey);
    // console.log('[SignGenerator] Data:', dataStr);
    // console.log('[SignGenerator] 签名原文:', signStr);
    // console.log('[SignGenerator] Sign:', sign);
    // console.log('[SignGenerator] =================================');

    return result;
  }

  /**
   * 构造下一页请求参数
   * @param {string} formDataStr - 原始 form data 字符串 (如 "data=%7B%22pageNumber%22%3A1...")
   * @returns {Object} 包含下一页请求所需的所有参数
   */
  function buildNextPage(formDataStr) {
    // 解析 form data
    const params = new URLSearchParams(formDataStr);
    const dataValue = params.get('data');
    
    if (!dataValue) {
      console.error('[SignGenerator] 无法从 form data 中解析 data 参数');
      return null;
    }

    // 解析 JSON 数据
    let data;
    try {
      data = JSON.parse(decodeURIComponent(dataValue));
    } catch (e) {
      console.error('[SignGenerator] JSON 解析失败:', e);
      return null;
    }

    const currentPage = data.pageNumber;
    const nextPage = currentPage + 1;

    console.log('[SignGenerator] 当前页码:', currentPage);
    console.log('[SignGenerator] 下一页码:', nextPage);

    // 修改页码
    data.pageNumber = nextPage;

    // 生成新签名
    const signResult = generate(data);

    // 构造新的 form data
    const newFormData = 'data=' + encodeURIComponent(JSON.stringify(data));

    return {
      ...signResult,
      pageNumber: nextPage,
      formData: newFormData,
      dataObject: data
    };
  }

  /**
   * 验证签名是否与给定值匹配
   * @param {string} expectedSign - 预期的签名值
   * @param {Object|string} data - 请求数据
   * @param {Object} options - 签名参数
   * @returns {boolean} 是否匹配
   */
  function verify(expectedSign, data, options = {}) {
    const result = generate(data, options);
    const isMatch = result.sign === expectedSign;
    
    console.log('[SignGenerator] 验证结果:', isMatch ? '✅ 匹配' : '❌ 不匹配');
    console.log('[SignGenerator] 预期签名:', expectedSign);
    console.log('[SignGenerator] 计算签名:', result.sign);
    
    return isMatch;
  }

  /**
   * 打印当前 cookie 中的 token 信息
   */
  function showTokenInfo() {
    console.log('[SignGenerator] ========== Token 信息 ==========');
    console.log('[SignGenerator] 完整 Cookie _m_h5_tk:', getFullToken());
    console.log('[SignGenerator] 提取的 Token:', getToken());
    console.log('[SignGenerator] ================================');
  }

  /**
   * 发送闲鱼搜索请求
   * @param {number} pageNumber - 页码
   * @param {string} keyword - 搜索关键词
   * @param {Object} options - 可选参数
   * @returns {Promise} 返回请求结果
   */
  async function fetchSearchData(pageNumber, keyword, options = {}) {
    // 构造请求数据
    const data = {
      pageNumber: pageNumber,
      keyword: keyword,
      fromFilter: false,
      rowsPerPage: 30,
      sortValue: "",
      sortField: "",
      customDistance: "",
      gps: "",
      propValueStr: {},
      customGps: "",
      searchReqFromPage: "pcSearch",
      extraFilterValue: "{}",
      userPositionJson: "{}"
    };

    // 生成签名（从实际请求中看到 appKey 是 34839810）
    const signResult = generate(data, {
      appKey: options.appKey || '34839810'
    });

    // 构造完整 URL
    const baseUrl = 'https://h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search/1.0/';
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
      api: 'mtop.taobao.idlemtopsearch.pc.search',
      sessionOption: 'AutoLoginOnly',
      spm_cnt: 'a21ybx.search.0.0',
      spm_pre: 'a21ybx.search.searchInput.0'
    });

    const fullUrl = baseUrl + '?' + urlParams.toString();

    // 构造请求体
    const requestBody = 'data=' + encodeURIComponent(JSON.stringify(data));

    // console.log('[闲鱼API] ========== 发送请求 ==========');
    // console.log('[闲鱼API] 页码:', pageNumber);
    // console.log('[闲鱼API] 关键词:', keyword);
    // console.log('[闲鱼API] 完整URL:', fullUrl);
    // console.log('[闲鱼API] 请求体:', requestBody);
    // console.log('[闲鱼API] 签名:', signResult.sign);
    // console.log('[闲鱼API] ===================================');

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

    //   console.log('[闲鱼API] ✅ 请求成功');
    //   console.log('[闲鱼API] 返回数据:', result);
    //   console.log('[闲鱼API] 商品数量:', result.data?.resultList?.length || 0);

      return result;
    } catch (error) {
      console.error('[闲鱼API] ❌ 请求失败:', error);
      throw error;
    }
  }

  // ==================== 导出接口 ====================
  return {
    md5: md5,
    getToken: getToken,
    getFullToken: getFullToken,
    generate: generate,
    buildNextPage: buildNextPage,
    verify: verify,
    showTokenInfo: showTokenInfo,
    fetchSearchData: fetchSearchData
  };

})();

// console.log('[SignGenerator] MTOP 签名生成器已加载');
// console.log('[SignGenerator] 使用方法:');
// console.log('  SignGenerator.showTokenInfo()  - 查看当前 token');
// console.log('  SignGenerator.generate({pageNumber: 1, keyword: "test"})  - 生成签名');
// console.log('  SignGenerator.buildNextPage("data=...")  - 构造下一页请求');
// console.log('  SignGenerator.verify("expected_sign", data, options)  - 验证签名');
// console.log('  SignGenerator.fetchSearchData(1, "雨伞")  - 发送搜索请求');
