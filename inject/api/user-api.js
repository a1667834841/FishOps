/**
 * user-api.js - 闲鱼用户相关 API
 * 提供获取当前登录用户 ID 等功能
 */

(function() {
  'use strict';
  
  var LOG_PREFIX = '[UserAPI]';
  
  // 固定配置
  var APP_KEY = '34839810';
  var API_VERSION = '1.0';
  var API_NAME = 'mtop.taobao.idlemessage.pc.loginuser.get';
  
  /**
   * 生成 MD5 哈希（使用浏览器 Crypto API）
   * @param {string} message - 要加密的消息
   * @returns {Promise<string>} MD5 哈希值（十六进制）
   */
  function md5(message) {
    return new Promise(function(resolve, reject) {
      try {
        // 使用 SubtleCrypto API（现代浏览器支持）
        var encoder = new TextEncoder();
        var data = encoder.encode(message);
        
        crypto.subtle.digest('MD5', data).then(function(hashBuffer) {
          var hashArray = Array.from(new Uint8Array(hashBuffer));
          var hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
          resolve(hashHex);
        }).catch(function(err) {
          // 如果 MD5 不可用，使用备用方案
          console.warn(LOG_PREFIX, '⚠️ MD5 算法不可用，使用简化方案');
          resolve(simpleHash(message));
        });
      } catch (e) {
        console.error(LOG_PREFIX, '❌ MD5 计算失败:', e);
        resolve(simpleHash(message));
      }
    });
  }
  
  /**
   * 简化哈希函数（当 crypto.subtle 不可用时）
   * 注意：这不是真正的 MD5，仅用于降级兼容
   */
  function simpleHash(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      var char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }
  
  /**
   * 生成签名
   * 公式：sign = md5(token + "&" + t + "&" + appKey + "&" + data)
   * 
   * @param {string} t - 时间戳
   * @param {string} token - 认证 token
   * @param {string} data - 请求数据字符串
   * @returns {Promise<string>} 签名值
   */
  function generateSign(t, token, data) {
    var msg = token + '&' + t + '&' + APP_KEY + '&' + data;
    console.log(LOG_PREFIX, '🔐 生成签名的消息:', msg.replace(token, '***'));
    return md5(msg);
  }
  
  /**
   * 获取当前登录用户的 ID
   * 
   * @param {string} token - 认证 token（从 cookie 或页面中获取）
   * @returns {Promise<Object>} 用户信息对象 {userId: number, success: boolean}
   * 
   * @example
   * // 从页面获取 token
   * var token = document.cookie.match(/_m_h=([^;]+)/)?.[1];
   * 
   * // 调用 API
   * getCurrentUserId(token).then(result => {
   *   if (result.success) {
   *     console.log('当前用户 ID:', result.userId);
   *   }
   * });
   */
  function getCurrentUserId(token) {
    return new Promise(function(resolve, reject) {
      if (!token) {
        console.error(LOG_PREFIX, '❌ Token 不能为空');
        resolve({ success: false, error: 'Token is required' });
        return;
      }
      
      // 构造请求参数
      var timestamp = Date.now().toString();
      var queryParams = {
        jsv: '2.7.2',
        appKey: APP_KEY,
        t: timestamp,
        sign: '', // 稍后生成
        v: API_VERSION,
        type: 'originaljson',
        accountSite: 'xianyu',
        dataType: 'json',
        timeout: '20000',
        api: API_NAME,
        sessionOption: 'AutoLoginOnly',
        spm_cnt: 'a21ybx.im.0.0',
        spm_pre: 'a21ybx.home.sidebar.2.4c053da6OBdnko',
        log_id: '4c053da6OBdnko'
      };
      
      // 生成签名的数据字符串
      var signData = Object.keys(queryParams).map(function(key) {
        return key + '=' + queryParams[key];
      }).join('&');
      
      console.log(LOG_PREFIX, '📝 准备获取用户 ID...');
      console.log(LOG_PREFIX, '   Timestamp:', timestamp);
      console.log(LOG_PREFIX, '   Token:', token.substring(0, 10) + '...');
      
      // 生成签名
      generateSign(timestamp, token, signData).then(function(sign) {
        queryParams.sign = sign;
        
        console.log(LOG_PREFIX, '✅ 签名已生成:', sign);
        
        // 构建完整 URL
        var url = 'https://h5api.m.goofish.com/h5/' + API_NAME + '/' + API_VERSION + '/?' + 
                  Object.keys(queryParams).map(function(key) {
                    return encodeURIComponent(key) + '=' + encodeURIComponent(queryParams[key]);
                  }).join('&');
        
        console.log(LOG_PREFIX, '🌐 开始请求 API...');
        
        // 发送请求
        fetch(url, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include' // 包含 cookie
        })
        .then(response => response.json())
        .then(data => {
          console.log(LOG_PREFIX, '📥 收到响应:', data);
          
          if (data.ret && data.ret[0].includes('SUCCESS')) {
            var userId = data.data && data.data.userId;
            if (userId) {
              console.log(LOG_PREFIX, '✅ 成功获取用户 ID:', userId);
              
              // 保存到全局变量和 localStorage
              window.CURRENT_USER_ID = userId;
              try {
                localStorage.setItem('idle_current_user_id', userId);
              } catch (e) {}
              
              resolve({
                success: true,
                userId: userId,
                data: data.data
              });
            } else {
              console.error(LOG_PREFIX, '❌ 响应中没有 userId:', data);
              resolve({ success: false, error: 'No userId in response' });
            }
          } else {
            console.error(LOG_PREFIX, '❌ API 调用失败:', data.ret);
            resolve({
              success: false,
              error: data.ret ? data.ret[0] : 'Unknown error'
            });
          }
        })
        .catch(error => {
          console.error(LOG_PREFIX, '❌ 网络请求失败:', error);
          resolve({ success: false, error: error.message || 'Network error' });
        });
        
      }).catch(function(err) {
        console.error(LOG_PREFIX, '❌ 签名生成失败:', err);
        resolve({ success: false, error: 'Sign generation failed' });
      });
    });
  }
  
  /**
   * 从 Cookie 获取 token
   * @returns {string|null} Token 或 null
   */
  function getTokenFromCookie() {
    var match = document.cookie.match(/_m_h=([^;]+)/);
    if (match && match[1]) {
      return match[1];
    }
    return null;
  }
  
  /**
   * 快速获取用户 ID（自动从 Cookie 获取 token）
   * @returns {Promise<Object>} 用户信息
   */
  function quickGetUserId() {
    var token = getTokenFromCookie();
    if (!token) {
      console.warn(LOG_PREFIX, '⚠️ 未找到 Cookie token，尝试从其他方式获取...');
      // 可以尝试其他方式
      return Promise.resolve({ success: false, error: 'No token found' });
    }
    return getCurrentUserId(token);
  }
  
  /**
   * 初始化用户 API
   * 自动获取并缓存用户 ID
   */
  function init() {
    console.log(LOG_PREFIX, '🚀 初始化用户 API...');
    
    // 检查是否已有缓存
    try {
      var cachedId = localStorage.getItem('idle_current_user_id');
      if (cachedId) {
        window.CURRENT_USER_ID = cachedId;
        console.log(LOG_PREFIX, '✅ 使用缓存的用户 ID:', cachedId);
        return Promise.resolve({ success: true, userId: cachedId, cached: true });
      }
    } catch (e) {}
    
    // 获取新的用户 ID
    return quickGetUserId().then(function(result) {
      if (result.success) {
        console.log(LOG_PREFIX, '✅ 用户 API 初始化完成');
        return result;
      } else {
        console.warn(LOG_PREFIX, '⚠️ 初始化失败:', result.error);
        return result;
      }
    });
  }
  
  // 导出到全局
  window.UserAPI = {
    getCurrentUserId: getCurrentUserId,
    quickGetUserId: quickGetUserId,
    getTokenFromCookie: getTokenFromCookie,
    generateSign: generateSign,
    init: init,
    getCurrentUserIdSync: function() {
      return window.CURRENT_USER_ID || localStorage.getItem('idle_current_user_id');
    }
  };
  
  console.log(LOG_PREFIX, '✅ UserAPI 已加载');
})();
