// search-page-buttons.js - 搜索页面爬取和飞书按钮功能

(function() {
  'use strict';

  console.log('[闲鱼采集-搜索页面] 按钮脚本已加载');

  // 配置项
  const CONFIG = {
    buttonContainerId: 'xianyu-collect-buttons',
    checkInterval: 500,
    maxRetries: 20
  };

  let buttonsAdded = false;
  let retryCount = 0;
  let crawlState = {
    isRunning: false,
    currentPage: 0,
    totalPages: 0,
    itemCount: 0,
    isCompleted: false  // 标记是否已完成爬取
  };

  // 创建按钮容器
  function createButtonContainer() {
    const container = document.createElement('div');
    container.id = CONFIG.buttonContainerId;
    container.className = 'xianyu-collect-buttons';
    
    // 创建爬取按钮
    const crawlBtn = document.createElement('button');
    crawlBtn.className = 'xianyu-btn xianyu-btn-crawl';
    crawlBtn.innerHTML = `<span>开始爬取</span>`;
    crawlBtn.type = 'button';
    crawlBtn.title = '开始采集当前搜索结果';

    // 创建飞书按钮
    const feishuBtn = document.createElement('button');
    feishuBtn.className = 'xianyu-btn xianyu-btn-feishu';
    feishuBtn.innerHTML = `<span>发送飞书</span>`;
    feishuBtn.type = 'button';
    feishuBtn.title = '将采集的数据发送到飞书表格';

    // 创建清空按钮
    const clearBtn = document.createElement('button');
    clearBtn.className = 'xianyu-btn xianyu-btn-clear';
    clearBtn.innerHTML = `<span>清空数据</span>`;
    clearBtn.type = 'button';
    clearBtn.title = '清空已采集的数据';

    // 创建数量显示容器（一直显示）
    const statsContainer = document.createElement('div');
    statsContainer.className = 'xianyu-stats-container';
    statsContainer.innerHTML = `
      <span class="stats-text">已爬取: <strong class="stats-count">0</strong> 件商品</span>
    `;

    // 添加按钮到容器
    container.appendChild(crawlBtn);
    container.appendChild(feishuBtn);
    container.appendChild(clearBtn);
    container.appendChild(statsContainer);

    // 绑定事件
    crawlBtn.addEventListener('click', handleCrawlClick);
    feishuBtn.addEventListener('click', handleFeishuClick);
    clearBtn.addEventListener('click', handleClearClick);

    // 初始化时获取并显示当前数据量
    updateStatsDisplay();

    return container;
  }

  // 处理爬取按钮点击
  async function handleCrawlClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const btn = event.currentTarget;
    const keyword = getSearchKeyword();

    if (!keyword) {
      showToast('请先输入搜索关键词', 'warning');
      return;
    }

    // 禁用按钮
    btn.disabled = true;
    btn.classList.add('loading');
    btn.innerHTML = `<span>爬取中...</span>`;

    try {
      // 获取配置
      const config = await getStorageConfig();
      
      // 在开始爬取前，先清空数据（确保从0开始计数）
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, resolve);
      });
      console.log('[闲鱼采集-搜索页面] 已清空历史数据');
      
      // 初始化爬取状态
      crawlState = {
        isRunning: true,
        currentPage: 0,
        totalPages: config.pageCount || 3,
        itemCount: 0,
        isCompleted: false
      };
      
      // 先设置关键词
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'SET_KEYWORD',
          keyword: keyword
        }, resolve);
      });

      // 启动进度监听
      startProgressMonitor();

      // 直接通过 DOM 事件发送爬取指令到 inject.js
      document.dispatchEvent(new CustomEvent('XIANYU_START_AUTO_CRAWL', {
        detail: {
          keyword: keyword,
          startPage: config.startPage || 1,
          pageCount: config.pageCount || 3,
          delay: config.delay || 1500
        }
      }));

      console.log('[闲鱼采集-搜索页面] 已发送爬取指令');
      showToast(`开始爬取「${keyword}」，共 ${config.pageCount || 3} 页`, 'success');

    } catch (error) {
      console.error('[闲鱼采集-搜索页面] 爬取失败:', error);
      showToast('爬取失败：' + error.message, 'error');
      resetCrawlButton(btn);
      crawlState.isRunning = false;
    }
  }

  // 处理飞书按钮点击
  async function handleFeishuClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const btn = event.currentTarget;

    // 禁用按钮
    btn.disabled = true;
    btn.classList.add('loading');
    btn.innerHTML = `<span>发送中...</span>`;

    try {
      // 检查是否有数据
      const stats = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_STATS' }, resolve);
      });

      if (!stats || stats.itemCount === 0) {
        showToast('没有数据可发送，请先进行爬取', 'warning');
        resetFeishuButton(btn);
        return;
      }

      // 发送到飞书
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'SEND_TO_FEISHU' }, resolve);
      });

      if (response?.success) {
        showToast(`成功发送 ${response.productCount || stats.itemCount} 条数据到飞书`, 'success');
        resetFeishuButton(btn, true);
      } else {
        showToast('发送失败：' + (response?.error || '未知错误'), 'error');
        resetFeishuButton(btn, false);
      }

    } catch (error) {
      console.error('[闲鱼采集-搜索页面] 发送飞书失败:', error);
      showToast('发送失败：' + error.message, 'error');
      resetFeishuButton(btn, false);
    }
  }

  // 处理清空按钮点击
  async function handleClearClick(event) {
    event.preventDefault();
    event.stopPropagation();

    if (!confirm('确定要清空所有已采集的数据吗？')) {
      return;
    }

    const btn = event.currentTarget;
    btn.disabled = true;
    btn.innerHTML = `<span>清空中...</span>`;

    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, resolve);
      });

      showToast('数据已清空', 'success');
      updateStatsDisplay();
    } catch (error) {
      console.error('[闲鱼采集-搜索页面] 清空数据失败:', error);
      showToast('清空失败：' + error.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<span>清空数据</span>`;
    }
  }

  // 重置爬取按钮
  function resetCrawlButton(btn, completed = false) {
    btn.disabled = false;
    btn.classList.remove('loading');
    if (completed) {
      btn.innerHTML = `<span>重新爬取</span>`;
      btn.classList.add('completed');
    } else {
      btn.innerHTML = `<span>开始爬取</span>`;
      btn.classList.remove('completed');
    }
  }

  // 更新数量显示
  function updateStatsDisplay() {
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response) => {
      const statsCount = document.querySelector('.stats-count');
      if (statsCount && response) {
        const itemCount = response.itemCount || 0;
        statsCount.textContent = itemCount;
        console.log('[闲鱼采集-搜索页面] 更新数量显示:', itemCount, '件商品');
      }
    });
  }

  // 启动进度监听
  function startProgressMonitor() {
    // 记录开始时的统计数据
    let lastRequestCount = 0;
    let lastItemCount = 0;
    let stableCount = 0; // 连续稳定次数（用于检测爬取完成）
      
    const monitorInterval = setInterval(() => {
      if (!crawlState.isRunning) {
        clearInterval(monitorInterval);
        return;
      }
  
      // 获取当前统计信息
      chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response) => {
        if (!response) return;
  
        const currentRequestCount = response.requestCount || 0;
        const currentItemCount = response.itemCount || 0;
  
        // 更新爬取状态
        crawlState.currentPage = currentRequestCount;
        crawlState.itemCount = currentItemCount;
  
        // 更新显示
        updateStatsDisplay();
          
        // 更新按钮文案，显示进度
        const crawlBtn = document.querySelector('.xianyu-btn-crawl');
        if (crawlBtn && crawlBtn.classList.contains('loading')) {
          crawlBtn.innerHTML = `<span>爬取中 ${currentRequestCount}/${crawlState.totalPages} 页...</span>`;
        }
  
        // 检测变化
        const hasChange = currentRequestCount !== lastRequestCount || currentItemCount !== lastItemCount;
          
        if (hasChange) {
          console.log(`[闲鱼采集-搜索页面] 进度更新: ${crawlState.currentPage}/${crawlState.totalPages} 页, ${crawlState.itemCount} 件商品`);
          stableCount = 0; // 重置稳定计数
        } else {
          stableCount++;
        }
  
        lastRequestCount = currentRequestCount;
        lastItemCount = currentItemCount;
  
        // 判断是否完成：
        // 1. 达到预期页数
        // 2. 或者连续3秒没有变化且已经有请求（可能爬取已结束）
        const shouldComplete = crawlState.currentPage >= crawlState.totalPages || 
                              (stableCount >= 3 && crawlState.currentPage > 0);
  
        if (shouldComplete) {
          console.log(`[闲鱼采集-搜索页面] 爬取完成检测: currentPage=${crawlState.currentPage}, totalPages=${crawlState.totalPages}, stableCount=${stableCount}`);
            
          // 延迟一秒后标记完成
          setTimeout(() => {
            crawlState.isRunning = false;
            crawlState.isCompleted = true;
            updateStatsDisplay();
              
            // 恢复按钮状态，显示为"重新爬取"
            const crawlBtn = document.querySelector('.xianyu-btn-crawl');
            if (crawlBtn) {
              resetCrawlButton(crawlBtn, true);
            }
              
            showToast(`爬取完成！共采集 ${crawlState.itemCount} 件商品`, 'success');
          }, 1000);
            
          clearInterval(monitorInterval);
        }
      });
    }, 1000); // 每1秒更新一次
  }

  // 重置飞书按钮
  function resetFeishuButton(btn, completed = false) {
    btn.disabled = false;
    btn.classList.remove('loading');
    if (completed) {
      btn.innerHTML = `<span>发送成功</span>`;
      btn.classList.add('completed');
      // 2秒后恢夏原文案
      setTimeout(() => {
        btn.innerHTML = `<span>发送飞书</span>`;
        btn.classList.remove('completed');
      }, 2000);
    } else {
      btn.innerHTML = `<span>发送飞书</span>`;
      btn.classList.remove('completed');
    }
  }

  // 获取搜索关键词
  function getSearchKeyword() {
    const input = document.querySelector('.search-input--WY2l9QD3');
    return input ? input.value.trim() : '';
  }

  // 获取存储的配置
  function getStorageConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['startPage', 'pageCount', 'delay'], (result) => {
        resolve({
          startPage: result.startPage || 1,
          pageCount: result.pageCount || 3,
          delay: result.delay || 1500
        });
      });
    });
  }

  // 显示提示消息
  function showToast(message, type = 'info') {
    const existingToast = document.getElementById('xianyu-collect-toast');
    if (existingToast) {
      existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.id = 'xianyu-collect-toast';
    toast.className = `xianyu-toast xianyu-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // 触发动画
    setTimeout(() => toast.classList.add('show'), 10);

    // 3秒后移除
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // 尝试插入按钮
  function tryInsertButtons() {
    if (buttonsAdded) return;

    const searchForm = document.querySelector('.search-container--mD4RMUzE');
    const searchButton = document.querySelector('.search-icon--bewLHteU');

    if (searchForm && searchButton) {
      // 检查是否已经添加过按钮
      if (document.getElementById(CONFIG.buttonContainerId)) {
        console.log('[闲鱼采集-搜索页面] 按钮已存在，跳过添加');
        buttonsAdded = true;
        return;
      }

      const buttonContainer = createButtonContainer();
      
      // 在搜索按钮后面插入按钮容器
      searchButton.parentNode.insertBefore(buttonContainer, searchButton.nextSibling);
      
      console.log('[闲鱼采集-搜索页面] 按钮已添加');
      buttonsAdded = true;
    } else {
      retryCount++;
      if (retryCount < CONFIG.maxRetries) {
        setTimeout(tryInsertButtons, CONFIG.checkInterval);
      } else {
        console.log('[闲鱼采集-搜索页面] 未找到搜索表单，停止尝试');
      }
    }
  }

  // 监听页面变化（用于 SPA 路由切换）
  function observePageChanges() {
    const observer = new MutationObserver((mutations) => {
      // 检查 URL 是否变化
      const pathname = window.location.pathname;
      if ((pathname === '/search' || pathname === '/') && !buttonsAdded) {
        retryCount = 0;
        tryInsertButtons();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // 初始化
  function init() {
    console.log('[闲鱼采集-搜索页面] 初始化开始');
    
    // 检查当前页面是否是搜索页或首页
    const pathname = window.location.pathname;
    if (pathname === '/search' || pathname === '/') {
      // 延迟执行，确保页面元素已加载
      setTimeout(() => {
        tryInsertButtons();
      }, 1000);
    }

    // 监听页面变化
    observePageChanges();
  }

  // 页面加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
