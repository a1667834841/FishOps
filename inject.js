// inject.js - 注入到页面上下文，用于拦截API请求
(function() {
  'use strict';

  console.log('[闲鱼采集] inject.js 已注入到页面上下文');

  // 目标API URL特征
  const TARGET_API_URL = 'h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search/1.0/';

  // Hook XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this._url = url;
    this._method = method;
    return originalXHROpen.apply(this, [method, url, ...args]);
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (this._url && this._url.includes(TARGET_API_URL)) {
      
      // 尝试解析FormData
      if (body instanceof FormData) {
    
      } else if (typeof body === 'string') {

        try {
          const parsed = JSON.parse(body);
        } catch (e) {
          console.log('[闲鱼采集] ✅ URL编码数据:', new URLSearchParams(body));
        }
      }
      
      // 保存请求体以便后续使用
      this._requestBody = body;

      this.addEventListener('load', function() {
        if (this.status === 200) {
          try {
            const responseData = JSON.parse(this.responseText);

            // 通过自定义事件发送给content script
            const event = new CustomEvent('XIANYU_API_DATA', {
              detail: {
                url: this._url,
                method: this._method,
                requestBody: this._requestBody,
                response: responseData,
                timestamp: Date.now()
              }
            });
            document.dispatchEvent(event);
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
    
    if (typeof url === 'string' && url.includes(TARGET_API_URL)) {

      
      // 解析请求体数据（URL编码格式，类似formdata）
      let parsedRequestData = null;
      if (options.body instanceof FormData) {
  
      } else if (typeof options.body === 'string') {
        // 解析URL编码数据 (如: data=%7B%22pageNumber%22%3A1...)
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

          // 通过自定义事件发送给content script
          const event = new CustomEvent('XIANYU_API_DATA', {
            detail: {
              url: url,
              method: options.method || 'GET',
              requestBody: options.body,
              requestData: parsedRequestData,  // 解析后的请求数据
              response: data,
              timestamp: Date.now()
            }
          });
          document.dispatchEvent(event);
        }).catch(e => {
          console.error('[闲鱼采集] 解析Fetch响应数据失败:', e);
        });

        return response;
      });
    }

    return originalFetch.apply(this, args);
  };

  console.log('[闲鱼采集] API拦截器已安装完成');

  // ==================== 自动爬取功能 ====================
  
  let isAutoCrawling = false;
  let shouldStopCrawling = false; // 新增：停止爬取标志

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

    // 检查 SignGenerator 是否存在
    if (!window.SignGenerator) {
      console.error('[闲鱼采集] SignGenerator 未找到，无法启动自动爬取！');
      alert('SignGenerator 未加载，请刷新页面后重试！');
      return;
    }

    // 检查 token
    const token = window.SignGenerator.getToken();
    if (!token) {
      console.error('[闲鱼采集] 未找到 MTOP token，可能未登录或 cookie 失效！');
      alert('未找到登录 Token！\n请确保：\n1. 已登录闲鱼账号\n2. Cookie 没有过期\n3. 刷新页面后重试');
      return;
    }

    isAutoCrawling = true;
    shouldStopCrawling = false; // 重置停止标志
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
          // 调用 SignGenerator.fetchSearchData
          const result = await window.SignGenerator.fetchSearchData(currentPage, keyword);
          
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
        console.log('[闲鱼采集] 请在插件页面点击“导出CSV文件”获取数据。');
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

  console.log('[闲鱼采集] 自动爬取功能已初始化');
})();
