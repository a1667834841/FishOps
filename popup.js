// popup.js - Popup页面脚本

// Toast 提示工具函数
function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  
  container.appendChild(toast);
  
  // 触发显示动画
  setTimeout(() => toast.classList.add('show'), 10);
  
  // 自动隐藏
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// 确认对话框工具函数
function showConfirm(message, options = {}) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('confirmDialog');
    const messageEl = document.getElementById('confirmMessage');
    const titleEl = document.getElementById('confirmTitle');
    const iconEl = document.getElementById('confirmIcon');
    const cancelBtn = document.getElementById('confirmCancel');
    const okBtn = document.getElementById('confirmOk');
    
    // 设置内容
    messageEl.textContent = message;
    titleEl.textContent = options.title || '确认操作';
    iconEl.textContent = options.icon || '⚠️';
    
    // 显示对话框
    dialog.classList.add('show');
    
    // 事件处理
    const handleCancel = () => {
      dialog.classList.remove('show');
      resolve(false);
      cleanup();
    };
    
    const handleOk = () => {
      dialog.classList.remove('show');
      resolve(true);
      cleanup();
    };
    
    const cleanup = () => {
      cancelBtn.removeEventListener('click', handleCancel);
      okBtn.removeEventListener('click', handleOk);
    };
    
    cancelBtn.addEventListener('click', handleCancel);
    okBtn.addEventListener('click', handleOk);
    
    // 点击背景关闭
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) handleCancel();
    });
  });
}

document.addEventListener('DOMContentLoaded', function() {
  console.log('[闲鱼采集] Popup页面已加载');

  const pageCountEl = document.getElementById('pageCount');
  const itemCountEl = document.getElementById('itemCount');
  const lastTimeEl = document.getElementById('lastTime');
  
  // 配置输入框
  const keywordInput = document.getElementById('keywordInput');
  const startPageInput = document.getElementById('startPageInput');
  const pageCountInput = document.getElementById('pageCountInput');
  const delayInput = document.getElementById('delayInput');
  
  // 按钮元素
  const startCrawlBtn = document.getElementById('startCrawl');
  const exportCSVBtn = document.getElementById('exportCSV');
  const clearDataBtn = document.getElementById('clearData');

  // 更新统计信息
  function updateStats() {
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response) => {
      if (response) {
        pageCountEl.textContent = response.pageCount || 0;
        itemCountEl.textContent = response.itemCount || 0;
        lastTimeEl.textContent = response.lastCaptureTime || '无';
        lastTimeEl.style.fontSize = response.lastCaptureTime === '无' ? '12px' : '10px';
      }
    });
  }

  // 初始加载统计
  updateStats();

  // 定时更新统计（每2秒）
  setInterval(updateStats, 2000);
  
  // 监听来自 background 的爬取状态消息
  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.type === 'CRAWL_COMPLETED' || request.type === 'CRAWL_STOPPED') {
      // 爬取完成或停止，恢复按钮状态
      isCrawling = false;
      startCrawlBtn.textContent = '🚀 开始爬取';
      startCrawlBtn.classList.remove('btn-pause');
      startCrawlBtn.classList.add('btn-start');
    }
  });

  // 折叠面板功能
  const infoToggle = document.getElementById('infoToggle');
  const infoContent = document.getElementById('infoContent');
  const infoToggleIcon = document.getElementById('infoToggleIcon');
  
  if (infoToggle && infoContent && infoToggleIcon) {
    infoToggle.addEventListener('click', function() {
      const isExpanded = infoContent.classList.contains('expanded');
      if (isExpanded) {
        infoContent.classList.remove('expanded');
        infoToggleIcon.classList.remove('expanded');
      } else {
        infoContent.classList.add('expanded');
        infoToggleIcon.classList.add('expanded');
      }
    });
  }

  // 开始/停止爬取按钮
  let isCrawling = false;
  let currentTabId = null;
  
  startCrawlBtn.addEventListener('click', function() {
    if (isCrawling) {
      // 停止爬取
      if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, {
          type: 'STOP_AUTO_CRAWL'
        }, function(response) {
          if (chrome.runtime.lastError) {
            console.error('[闲鱼采集] 发送停止指令失败:', chrome.runtime.lastError.message);
          } else {
            console.log('[闲鱼采集] 爬取已停止');
          }
        });
      }
      
      isCrawling = false;
      startCrawlBtn.textContent = '🚀 开始爬取';
      startCrawlBtn.classList.remove('btn-pause');
      startCrawlBtn.classList.add('btn-start');
      return;
    }
    
    // 开始爬取
    const keyword = keywordInput.value.trim();
    const startPage = parseInt(startPageInput.value) || 1;
    const pageCount = parseInt(pageCountInput.value) || 0;
    const delay = parseInt(delayInput.value) || 1500;

    // 参数校验
    if (!keyword) {
      showToast('请输入搜索关键词！', 'warning');
      return;
    }
    if (pageCount <= 0) {
      showToast('采集页数必须大于0！', 'warning');
      return;
    }
    if (pageCount > 50) {
      showToast('单次采集页数不能超过50页！', 'warning');
      return;
    }
    if (startPage < 1) {
      showToast('起始页码必须大于等于1！', 'warning');
      return;
    }
    if (delay < 500) {
      showToast('间隔时间不能小于500毫秒！', 'warning');
      return;
    }
    if (delay > 10000) {
      showToast('间隔时间不能超过10000毫秒！', 'warning');
      return;
    }

    // 获取当前活动的标签页
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (!tabs || tabs.length === 0) {
        showToast('未找到活动标签页！', 'error');
        return;
      }

      const currentTab = tabs[0];
      currentTabId = currentTab.id;
      
      // 检查是否在闲鱼页面
      if (!currentTab.url || !currentTab.url.includes('goofish.com')) {
        showToast('请在闲鱼（goofish.com）页面使用此功能！', 'warning');
        return;
      }

      // 发送消息到 content script
      isCrawling = true;
      startCrawlBtn.textContent = '⏸️ 停止爬取';
      startCrawlBtn.classList.remove('btn-start');
      startCrawlBtn.classList.add('btn-pause');

      chrome.tabs.sendMessage(currentTab.id, {
        type: 'START_AUTO_CRAWL',
        keyword: keyword,
        startPage: startPage,
        pageCount: pageCount,
        delay: delay
      }, function(response) {
        if (chrome.runtime.lastError) {
          console.error('[闲鱼采集] 发送爬取指令失败:', chrome.runtime.lastError.message);
          showToast('启动爬取失败：' + chrome.runtime.lastError.message, 'error', 4000);
          
          isCrawling = false;
          startCrawlBtn.textContent = '🚀 开始爬取';
          startCrawlBtn.classList.remove('btn-pause');
          startCrawlBtn.classList.add('btn-start');
        } else {
          console.log('[闲鱼采集] 爬取已启动，响应:', response);
        }
      });
    });
  });

  // 导出CSV按钮
  exportCSVBtn.addEventListener('click', function() {
    // 显示加载状态
    exportCSVBtn.disabled = true;
    exportCSVBtn.textContent = '⚙️ 生成中...';

    chrome.runtime.sendMessage({ type: 'EXPORT_CSV' }, (response) => {
      exportCSVBtn.disabled = false;
      exportCSVBtn.textContent = '📄 导出CSV文件';

      if (response && response.success) {
        // 创建Blob并下载
        const blob = new Blob([response.csvData], { type: 'text/csv;charset=utf-8-bom;' });
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `闲鱼商品数据_${timestamp}.csv`;

        chrome.downloads.download({
          url: url,
          filename: filename,
          saveAs: true
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            showToast('下载失败！' + chrome.runtime.lastError.message, 'error');
          } else {
            console.log(`CSV文件导出成功！\n文件名：${filename}`);
          }
          URL.revokeObjectURL(url);
        });
      } else {
        showToast('导出失败！' + (response?.error || '没有数据'), 'error');
      }
    });
  });

  // 导出请求记录按钮 - 已移除此功能
  // exportRequestsBtn.addEventListener('click', function() { ... });

  // 清空数据按钮
  clearDataBtn.addEventListener('click', async function() {
    const confirmed = await showConfirm(
      '确定要清空所有数据吗？包括商品数据和请求记录。',
      { title: '清空数据', icon: '🗑️' }
    );
    
    if (confirmed) {
      console.log('[闲鱼采集] 发送清空数据请求...');
      
      chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[闲鱼采集] 清空数据出错:', chrome.runtime.lastError);
          showToast('清空失败：' + chrome.runtime.lastError.message, 'error');
          return;
        }
        
        console.log('[闲鱼采集] 收到清空响应:', response);
        
        if (response && response.success) {
          updateStats();
        } else {
          showToast('清空失败：' + (response?.error || '未知错误'), 'error');
        }
      });
    }
  });
});
