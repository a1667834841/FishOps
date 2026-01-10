// popup.js - Popup页面脚本

// 默认配置
const DEFAULT_CONFIG = {
  startPage: 1,
  pageCount: 3,
  delay: 1500
};

// Toast 提示工具函数
function showToast(message, type = 'info', duration = 3000) {
  const toast = document.getElementById('toast');
  if (!toast) {
    console.error('[闲鱼采集] 未找到 toast 元素');
    return;
  }

  toast.textContent = message;
  toast.className = `toast ${type}`;

  // 触发显示动画
  setTimeout(() => toast.classList.add('show'), 10);

  // 自动隐藏
  setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

// 确认对话框工具函数
function showConfirm(message, options = {}) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('confirmDialog');
    const messageEl = document.getElementById('confirmMessage');
    const titleEl = document.getElementById('confirmTitle');
    const cancelBtn = document.getElementById('confirmCancel');
    const okBtn = document.getElementById('confirmOk');

    if (!dialog || !messageEl || !titleEl || !cancelBtn || !okBtn) {
      console.error('[闲鱼采集] 确认对话框元素缺失');
      resolve(false);
      return;
    }

    // 设置内容
    messageEl.textContent = message;
    titleEl.textContent = options.title || '确认操作';

    // 显示对话框
    dialog.classList.add('show');

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

    const handleBackdropClick = (e) => {
      if (e.target === dialog) {
        handleCancel();
      }
    };

    const cleanup = () => {
      cancelBtn.removeEventListener('click', handleCancel);
      okBtn.removeEventListener('click', handleOk);
      dialog.removeEventListener('click', handleBackdropClick);
    };

    cancelBtn.addEventListener('click', handleCancel);
    okBtn.addEventListener('click', handleOk);
    dialog.addEventListener('click', handleBackdropClick);
  });
}

document.addEventListener('DOMContentLoaded', function() {
  console.log('[闲鱼采集] Popup页面已加载');

  const pageCountEl = document.getElementById('pageCount');
  const itemCountEl = document.getElementById('itemCount');
  const lastTimeEl = document.getElementById('lastTime');

  // 配置输入框
  const keywordInput = document.getElementById('keywordInput');

  // 按钮元素
  const startCrawlBtn = document.getElementById('startCrawl');
  const exportCSVBtn = document.getElementById('exportCSV');
  const clearDataBtn = document.getElementById('clearData');
  const openConfigBtn = document.getElementById('openConfig');
  const sendFeishuBtn = document.getElementById('sendFeishu');
  const feishuStatus = document.getElementById('feishuStatus');
  const feishuStatusText = document.getElementById('feishuStatusText');
  const suggestWordsContainer = document.getElementById('suggestWordsContainer');
  const suggestWordsList = document.getElementById('suggestWordsList');
  const suggestWordsHidden = document.getElementById('suggestWordsHidden');
  const fetchSuggestBtn = document.getElementById('fetchSuggestBtn');

  // 更新统计信息
  function updateStats() {
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response) => {
      if (response) {
        if (pageCountEl) {
          pageCountEl.textContent = response.pageCount || 0;
        }
        if (itemCountEl) {
          itemCountEl.textContent = response.itemCount || 0;
        }
        if (lastTimeEl) {
          lastTimeEl.textContent = response.lastCaptureTime || '无';
          lastTimeEl.style.fontSize = response.lastCaptureTime === '无' ? '12px' : '10px';
        }
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

  // 打开配置页面按钮
  openConfigBtn.addEventListener('click', function() {
    chrome.tabs.create({ url: 'options.html' });
    window.close();
  });

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

    // 从 storage 读取配置
    chrome.storage.local.get(DEFAULT_CONFIG, function(config) {
      // 开始爬取
      const keyword = keywordInput.value.trim();
      const startPage = config.startPage || DEFAULT_CONFIG.startPage;
      const pageCount = config.pageCount || DEFAULT_CONFIG.pageCount;
      const delay = config.delay || DEFAULT_CONFIG.delay;

      // 参数校验
      if (!keyword) {
        showToast('请输入搜索关键词！', 'warning');
        return;
      }
      if (pageCount <= 0) {
        showToast('采集页数必须大于0！请在配置页面调整。', 'warning');
        return;
      }
      if (pageCount > 50) {
        showToast('单次采集页数不能超过50页！请在配置页面调整。', 'warning');
        return;
      }
      if (startPage < 1) {
        showToast('起始页码必须大于等于1！请在配置页面调整。', 'warning');
        return;
      }
      if (delay < 500) {
        showToast('间隔时间不能小于500毫秒！请在配置页面调整。', 'warning');
        return;
      }
      if (delay > 10000) {
        showToast('间隔时间不能超过10000毫秒！请在配置页面调整。', 'warning');
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

        // 先获取流量词
        fetchSuggestWords(currentTab.id, keyword);

        // 发送消息到 content script
        isCrawling = true;
        startCrawlBtn.textContent = '⏸️ 停止爬取';
        startCrawlBtn.classList.remove('btn-start');
        startCrawlBtn.classList.add('btn-pause');

        // 先设置关键词
        chrome.runtime.sendMessage({
          type: 'SET_KEYWORD',
          keyword: keyword
        }, function() {
          // 然后开始爬取
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
    });
  });

  // 导出CSV按钮
  exportCSVBtn.addEventListener('click', function() {
    exportCSVBtn.disabled = true;
    exportCSVBtn.textContent = '⚙️ 生成中...';

    chrome.runtime.sendMessage({ type: 'EXPORT_CSV' }, (response) => {
      exportCSVBtn.disabled = false;
      exportCSVBtn.textContent = '📄 导出CSV文件';

      if (response && response.success) {
        const blob = new Blob([response.csvData], { type: 'text/csv;charset=utf-8-bom;' });
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `闲鱼商品数据_${timestamp}.csv`;

        chrome.downloads.download({
          url: url,
          filename: filename,
          saveAs: false
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            showToast('下载失败！' + chrome.runtime.lastError.message, 'error');
          } else {
            showToast('CSV导出成功', 'success');
          }
          URL.revokeObjectURL(url);
        });
      } else {
        showToast('导出失败！' + (response?.error || '没有数据，请先进行采集'), 'error');
      }
    });
  });

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
          showToast('数据已清空', 'success');
        } else {
          showToast('清空失败：' + (response?.error || '未知错误'), 'error');
        }
      });
    }
  });

  // 发送到飞书按钮
  sendFeishuBtn.addEventListener('click', async function() {
    // 检查是否有数据
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, (statsResponse) => {
      if (!statsResponse || statsResponse.itemCount === 0) {
        showToast('没有数据可发送，请先进行采集', 'warning');
        return;
      }

      // 检查飞书配置
      chrome.runtime.sendMessage({ type: 'GET_FEISHU_CONFIG' }, (feishuResponse) => {
        const config = feishuResponse?.config || {};
        

        if (!config.appId || !config.appSecret) {
          showToast('请先配置飞书 App ID 和 App Secret', 'warning');
          return;
        }

        if (!config.spreadsheetToken || !config.productTableId) {
          showToast('请先配置飞书表格 Token 和商品表 ID', 'warning');
          return;
        }

        // 禁用按钮,显示状态
        sendFeishuBtn.disabled = true;
        sendFeishuBtn.textContent = '发送中...';
        feishuStatus.style.display = 'block';
        feishuStatusText.textContent = '正在发送数据到飞书...';

        // 发送数据到飞书
        chrome.runtime.sendMessage({ type: 'SEND_TO_FEISHU' }, (response) => {
          sendFeishuBtn.disabled = false;
          sendFeishuBtn.textContent = '飞书';

          if (response && response.success) {
            feishuStatusText.textContent = `发送成功！商品 ${response.productCount} 条` +
              (response.sellerCount > 0 ? `，商家 ${response.sellerCount} 条` : '');
            feishuStatus.style.background = '#e8f5e9';
            feishuStatus.style.color = '#2e7d32';
            showToast('数据已成功发送到飞书', 'success');

            // 3秒后隐藏状态
            setTimeout(() => {
              feishuStatus.style.display = 'none';
            }, 3000);
          } else {
            feishuStatusText.textContent = '发送失败: ' + (response?.error || '未知错误');
            feishuStatus.style.background = '#ffebee';
            feishuStatus.style.color = '#c62828';
            showToast('发送失败: ' + (response?.error || '未知错误'), 'error');

            // 5秒后隐藏状态
            setTimeout(() => {
              feishuStatus.style.display = 'none';
            }, 5000);
          }
        });
      });
    });
  });

  // 爬取流量词按钮（如果存在）
  if (fetchSuggestBtn) {
    fetchSuggestBtn.addEventListener('click', function() {
    const keyword = keywordInput.value.trim();

    if (!keyword) {
      showToast('请先输入关键词！', 'warning');
      return;
    }

    // 禁用按钮
    fetchSuggestBtn.disabled = true;
    fetchSuggestBtn.textContent = '爬取中...';

    // 获取当前活动的标签页
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (!tabs || tabs.length === 0) {
        showToast('未找到活动标签页！', 'error');
        fetchSuggestBtn.disabled = false;
        fetchSuggestBtn.textContent = '🔍 爬取流量词';
        return;
      }

      const currentTab = tabs[0];

      // 检查是否在闲鱼页面
      if (!currentTab.url || !currentTab.url.includes('goofish.com')) {
        showToast('请在闲鱼（goofish.com）页面使用此功能！', 'warning');
        fetchSuggestBtn.disabled = false;
        fetchSuggestBtn.textContent = '🔍 爬取流量词';
        return;
      }

      // 发送消息到 content script 执行爬取
      chrome.tabs.sendMessage(currentTab.id, {
        type: 'FETCH_SUGGEST_WORDS',
        keyword: keyword
      }, function(response) {
        fetchSuggestBtn.disabled = false;
        fetchSuggestBtn.textContent = '🔍 爬取流量词';

        if (chrome.runtime.lastError) {
          console.error('[闲鱼采集] 发送流量词请求失败:', chrome.runtime.lastError.message);
          showToast('爬取失败：' + chrome.runtime.lastError.message, 'error', 4000);
          return;
        }

        if (response && response.success && response.words && response.words.length > 0) {
          // 显示流量词列表
          displaySuggestWords(response.words);
          showToast(`成功获取 ${response.words.length} 个流量词`, 'success');
        } else {
          showToast('未获取到流量词，请稍后重试', 'warning');
        }
      });
    });
  });
  }

  // 获取流量词函数
  function fetchSuggestWords(tabId, keyword) {
    chrome.tabs.sendMessage(tabId, {
      type: 'FETCH_SUGGEST_WORDS',
      keyword: keyword
    }, function(response) {
      if (chrome.runtime.lastError) {
        console.error('[闲鱼采集] 获取流量词失败:', chrome.runtime.lastError.message);
        return;
      }

      if (response && response.success && response.words && response.words.length > 0) {
        displaySuggestWords(response.words);
        console.log(`[闲鱼采集] 成功获取 ${response.words.length} 个流量词`);
      }
    });
  }

  // 显示流量词列表
  function displaySuggestWords(words) {
    if (!words || words.length === 0) return;

    // 清空显示区域
    suggestWordsList.innerHTML = '';
    suggestWordsHidden.innerHTML = '';

    // 保存所有流量词到隐藏区域（用于复制）
    suggestWordsHidden.textContent = words.join('\n');

    // 只显示前3个
    const displayWords = words.slice(0, 3);
    
    displayWords.forEach(word => {
      const tag = document.createElement('div');
      tag.className = 'suggest-word-tag';
      tag.textContent = word;
      suggestWordsList.appendChild(tag);
    });

    // 如果超过3个，显示“+N”提示
    if (words.length > 3) {
      const moreTag = document.createElement('div');
      moreTag.className = 'suggest-word-more';
      moreTag.textContent = `+${words.length - 3}`;
      suggestWordsList.appendChild(moreTag);
    }

    // 点击整行复制所有流量词
    suggestWordsList.onclick = function() {
      copyAllSuggestWords(words);
    };

    suggestWordsContainer.style.display = 'block';
  }

  // 复制所有流量词
  function copyAllSuggestWords(words) {
    const text = words.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      showToast(`已复制 ${words.length} 个流量词`, 'success', 2000);
    }).catch(err => {
      console.error('复制失败:', err);
      showToast('复制失败', 'error');
    });
  }
});
