/**
 * inject.js - 注入到页面上下文的入口文件
 * 这是一个兼容层，用于在开发模式下加载模块化代码
 */

(function() {
  'use strict';
  console.log('[闲鱼采集] inject.js 已注入到页面上下文');

  // ==================== WebSocket 拦截功能 (最高优先级) ====================
  // 必须在任何其他代码之前 hook WebSocket，确保在 WebSocket 被创建之前拦截

  const originalWebSocket = window.WebSocket;
  
  window.WebSocket = function(url, protocols) {
    console.log('[闲鱼采集] WebSocket 连接创建:', url);
    
    // 创建原始 WebSocket 实例
    const ws = new originalWebSocket(url, protocols);
    
    // 判断是否是闲鱼聊天的 WebSocket
    if (url.includes('wss-goofish.dingtalk.com')) {
      console.log('[闲鱼采集] 🎯 检测到闲鱼聊天 WebSocket 连接');
      
      // Hook send 方法（发送的消息）
      const originalSend = ws.send;
      ws.send = function(data) {
        try {
          // console.log('[闲鱼采集] 📤 发送消息:', data);
          
          // 尝试解析 JSON
          if (typeof data === 'string') {
            try {
              const parsed = JSON.parse(data);
              // console.log('[闲鱼采集] 📤 发送消息(已解析):', parsed);
            } catch (e) {
              // 不是 JSON 格式
            }
          }
        } catch (error) {
          console.error('[闲鱼采集] 处理发送消息失败:', error);
        }
        
        return originalSend.apply(this, arguments);
      };
      
      
      // Hook onmessage 属性（关键！）
      let actualOnMessageHandler = null;
      Object.defineProperty(ws, 'onmessage', {
        get: function() {
          return actualOnMessageHandler;
        },
        set: function(handler) {
          console.log('[闲鱼采集] 🎯 检测到 onmessage 被设置');
          actualOnMessageHandler = handler;
          
          // 包装原始 handler
          const wrappedHandler = function(event) {
            // 关键：始终先调用原始 handler，确保闲鱼功能正常
            const result = handler ? handler.call(this, event) : undefined;

            // 然后调用 XianyuAPI 处理消息
            try {
              if (typeof event.data === 'string' && window.XianyuAPI) {
                window.XianyuAPI.handleWebSocketMessage(event.data);
              }
            } catch (error) {
              console.error('[闲鱼采集] 处理接收消息失败(onmessage):', error);
            }
            
            // 返回原始 handler 的返回值
            return result;
          };
          
          // 使用原型链上的原始 setter 设置包装后的 handler
          Object.getOwnPropertyDescriptor(originalWebSocket.prototype, 'onmessage').set.call(ws, wrappedHandler);
        },
        configurable: true
      });
      
      // 监听连接事件
      const originalOpen = ws.addEventListener.bind(ws);
      originalOpen('open', function(event) {
        console.log('[闲鱼采集] ✅ WebSocket 连接已建立:', url);
      });
      
      originalOpen('close', function(event) {
        console.log('[闲鱼采集] ❌ WebSocket 连接已关闭:', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean
        });
      });
      
      originalOpen('error', function(event) {
        console.error('[闲鱼采集] ⚠️ WebSocket 连接错误:', event);
      });
    }
    
    return ws;
  };
  
  // 复制原始 WebSocket 的属性
  window.WebSocket.prototype = originalWebSocket.prototype;
  window.WebSocket.CONNECTING = originalWebSocket.CONNECTING;
  window.WebSocket.OPEN = originalWebSocket.OPEN;
  window.WebSocket.CLOSING = originalWebSocket.CLOSING;
  window.WebSocket.CLOSED = originalWebSocket.CLOSED;

  console.log('[闲鱼采集] WebSocket 拦截器已安装完成');

  // 检查 MessageBus 是否已加载
  if (!window.MessageBus) {
    console.error('[闲鱼采集] ❌ MessageBus 未找到！数据无法转发');
  }

  // ==================== 加载模块化代码 ====================

  // 由于 content scripts 不支持 ES Modules imports，
  // 这里暂时保留原有的实现，或者等待打包工具处理
  // 开发模式建议使用 npm run dev + 打包后的文件

  // 目标API URL特征
  const TARGET_API_URL = 'h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search/1.0/';
  const DETAIL_API_URL = 'h5api.m.goofish.com/h5/mtop.taobao.idle.pc.detail/1.0/';

  // 判断API类型
  function getApiType(url) {
    if (url.includes(DETAIL_API_URL)) return 'DETAIL';
    if (url.includes(TARGET_API_URL)) return 'SEARCH';
    return null;
  }

  // Hook XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this._url = url;
    this._method = method;
    return originalXHROpen.apply(this, [method, url, ...args]);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const apiType = getApiType(this._url);

    if (apiType) {
      const eventName = apiType === 'DETAIL' ? 'XIANYU_DETAIL_DATA' : 'XIANYU_API_DATA';

      // 保存请求体以便后续使用
      this._requestBody = body;
      this._apiType = apiType;

      this.addEventListener('load', function() {
        if (this.status === 200) {
          try {
            const responseData = JSON.parse(this.responseText);

            // 使用消息总线发送数据
            const dataToSend = {
              url: this._url,
              method: this._method,
              requestBody: this._requestBody,
              response: responseData,
              timestamp: Date.now(),
              apiType: this._apiType
            };

            console.log(`[闲鱼采集] ${apiType === 'DETAIL' ? '详情' : '搜索'}API已拦截`);

            if (window.MessageBus) {
              window.MessageBus.send(eventName, dataToSend);
            } else {
              console.error(`[闲鱼采集] ❌ MessageBus 未找到`);
            }
          } catch (e) {
            console.error('[闲鱼采集] 解析响应数据失败:', e);
          }
        }
      });
    }
    return originalXHRSend.apply(this, [body]);
  };

  // Hook Fetch API
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = args[0];
    const options = args[1] || {};

    if (typeof url === 'string') {
      const apiType = getApiType(url);

      if (apiType) {
        const eventName = apiType === 'DETAIL' ? 'XIANYU_DETAIL_DATA' : 'XIANYU_API_DATA';

        // 解析请求体数据（URL编码格式，类似formdata）
        let parsedRequestData = null;
        if (options.body instanceof FormData) {

        } else if (typeof options.body === 'string') {
          // 解析URL编码数据 (如: data=%7B%22itemId%22%3A%22...)
          const urlParams = new URLSearchParams(options.body);
          parsedRequestData = {};
          for (let [key, value] of urlParams.entries()) {
            parsedRequestData[key] = value;
          }
        }

        return originalFetch.apply(this, args).then(response => {
          // 克隆response以便我们可以读取它
          const clonedResponse = response.clone();

          clonedResponse.json().then(data => {
            // 使用消息总线发送数据
            const dataToSend = {
              url: url,
              method: options.method || 'GET',
              requestBody: options.body,
              requestData: parsedRequestData,  // 解析后的请求数据
              response: data,
              timestamp: Date.now(),
              apiType: apiType
            };

            console.log(`[闲鱼采集] ${apiType === 'DETAIL' ? '详情' : '搜索'}API已拦截`);

            if (window.MessageBus) {
              window.MessageBus.send(eventName, dataToSend);
            } else {
              console.error(`[闲鱼采集] ❌ MessageBus 未找到`);
            }
          }).catch(e => {
            console.error('[闲鱼采集] 解析Fetch响应数据失败:', e);
          });

          return response;
        });
      }
    }

    return originalFetch.apply(this, args);
  };

  console.log('[闲鱼采集] API拦截器已安装完成');

  // ==================== 自动爬取功能 ====================

  let isAutoCrawling = false;
  let shouldStopCrawling = false;

  /**
   * 自动爬取函数
   * @param {string} keyword - 搜索关键词
   * @param {number} startPage - 起始页码
   * @param {number} pageCount - 采集页数
   * @param {number} delayMs - 每次请求间隔（毫秒）
   */
  async function autoCrawl(keyword, startPage, pageCount, delayMs = 1500) {
    if (isAutoCrawling) {
      console.warn('[闲鱼采集] 爬取任务已在运行中，请勿重复启动！');
      return;
    }

    // 检查 API 模块是否存在（优先使用 XianyuAPI，兼容 SignGenerator）
    const apiModule = window.XianyuAPI || window.SignGenerator;
    if (!apiModule) {
      console.error('[闲鱼采集] API 模块未找到，无法启动自动爬取！');
      alert('API 模块未加载，请刷新页面后重试！');
      return;
    }

    // 检查 token
    const token = apiModule.getToken ? apiModule.getToken() : null;
    if (!token) {
      console.error('[闲鱼采集] 未找到 MTOP token，可能未登录或 cookie 失效！');
      alert('未找到登录 Token！\n请确保：\n1. 已登录闲鱼账号\n2. Cookie 没有过期\n3. 刷新页面后重试');
      return;
    }

    isAutoCrawling = true;
    shouldStopCrawling = false;
    const endPage = startPage + pageCount - 1;

    try {
      for (let i = 0; i < pageCount; i++) {
        // 检查是否需要停止
        if (shouldStopCrawling) {
          console.log('[闲鱼采集] 爬取已被用户停止');
          break;
        }

        const currentPage = startPage + i;

        console.log(`[闲鱼采集] 正在爬取第 ${currentPage} 页... (${i + 1}/${pageCount})`);

        try {
          // 调用 API 模块的搜索方法
          const result = await apiModule.fetchSearchData(currentPage, keyword);

          const itemCount = result?.data?.resultList?.length || 0;
          console.log(`[闲鱼采集] ✅ 第 ${currentPage} 页采集完成，商品数：${itemCount}`);

          // 如果不是最后一页，等待一段时间
          if (i < pageCount - 1 && !shouldStopCrawling) {
            console.log(`[闲鱼采集] 等待 ${delayMs}ms 后继续...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        } catch (error) {
          console.error(`[闲鱼采集] ❗ 第 ${currentPage} 页爬取失败:`, error);
          // 继续爬取下一页，不中断
        }
      }

      if (shouldStopCrawling) {
        console.log('[闲鱼采集] ========== 爬取已停止 ==========');
        console.log('[闲鱼采集] 用户主动停止了爬取任务。');
        console.log('[闲鱼采集] ====================================');

        // 通知 popup 爬取已停止
        document.dispatchEvent(new CustomEvent('XIANYU_CRAWL_STOPPED'));
      } else {
        console.log('[闲鱼采集] ========== 自动爬取完成 ==========');
        console.log('[闲鱼采集] 已完成所有页码的爬取！');
        console.log('[闲鱼采集] 请在插件页面点击"导出CSV文件"获取数据。');
        console.log('[闲鱼采集] ====================================');

        // 通知 popup 爬取已完成
        document.dispatchEvent(new CustomEvent('XIANYU_CRAWL_COMPLETED'));
      }

    } catch (error) {
      console.error('[闲鱼采集] 自动爬取发生错误:', error);
      alert('爬取过程中发生错误！\n' + error.message);
    } finally {
      isAutoCrawling = false;
      shouldStopCrawling = false;
    }
  }

  // 监听来自 content script 的 DOM 事件（开始爬取）
  document.addEventListener('XIANYU_START_AUTO_CRAWL', function(event) {
    console.log('[闲鱼采集] 收到自动爬取指令（DOM事件）:', event.detail);

    const { keyword, startPage, pageCount, delay } = event.detail;

    // 启动自动爬取
    autoCrawl(keyword, startPage, pageCount, delay || 1500);
  });

  // 监听来自 content script 的 DOM 事件（停止爬取）
  document.addEventListener('XIANYU_STOP_AUTO_CRAWL', function(event) {
    console.log('[闲鱼采集] 收到停止爬取指令（DOM事件）');

    if (isAutoCrawling) {
      shouldStopCrawling = true;
      console.log('[闲鱼采集] 已设置停止标志，当前页采集完成后将停止');
    } else {
      console.log('[闲鱼采集] 当前没有正在运行的爬取任务');
    }
  });

  // ==================== 流量词功能 ====================

  // 监听来自 content script 的 DOM 事件（获取流量词）
  document.addEventListener('XIANYU_FETCH_SUGGEST_WORDS', async function(event) {
    console.log('[闲鱼采集] 收到流量词请求（DOM事件）:', event.detail);

    const { keyword } = event.detail;

    try {
      // 检查 API 模块是否存在
      if (!window.XianyuAPI) {
        throw new Error('XianyuAPI 模块未加载');
      }

      // 调用 API 获取流量词
      const words = await window.XianyuAPI.fetchSuggestWords(keyword, { simpleMode: true });

      console.log('[闲鱼采集] 流量词获取成功:', words);

      // 发送响应给 content script
      document.dispatchEvent(new CustomEvent('XIANYU_SUGGEST_WORDS_RESPONSE', {
        detail: {
          success: true,
          words: words
        }
      }));
    } catch (error) {
      console.error('[闲鱼采集] 流量词获取失败:', error);

      // 发送错误响应
      document.dispatchEvent(new CustomEvent('XIANYU_SUGGEST_WORDS_RESPONSE', {
        detail: {
          success: false,
          error: error.message
        }
      }));
    }
  });

  console.log('[闲鱼采集] 自动爬取功能已初始化');
})();
