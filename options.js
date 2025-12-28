// options.js - 配置页面脚本

// 默认配置
const DEFAULT_CONFIG = {
  startPage: 1,
  pageCount: 3,
  delay: 1500
};

// 飞书默认配置
const DEFAULT_FEISHU_CONFIG = {
  appId: '',
  appSecret: '',
  spreadsheetToken: '',
  productTableId: '',
  sellerTableId: '',
  enabled: false
};

// Toast 提示
function showToast(message, type = 'info', duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => toast.classList.remove('show'), duration);
}

// 加载配置
function loadConfig() {
  chrome.storage.local.get(DEFAULT_CONFIG, (result) => {
    document.getElementById('startPageInput').value = result.startPage || DEFAULT_CONFIG.startPage;
    document.getElementById('pageCountInput').value = result.pageCount || DEFAULT_CONFIG.pageCount;
    document.getElementById('delayInput').value = result.delay || DEFAULT_CONFIG.delay;
  });

  // 加载飞书配置 - 使用数组指定键名，确保与保存时一致
  chrome.storage.local.get(['appId', 'appSecret', 'spreadsheetToken', 'productTableId', 'sellerTableId', 'enabled'], (result) => {
    document.getElementById('feishuAppId').value = result.appId || '';
    document.getElementById('feishuAppSecret').value = result.appSecret || '';
    document.getElementById('feishuSpreadsheetToken').value = result.spreadsheetToken || '';
    document.getElementById('feishuProductTableId').value = result.productTableId || '';
    document.getElementById('feishuSellerTableId').value = result.sellerTableId || '';
    document.getElementById('feishuEnabled').checked = result.enabled || false;
    console.log('[配置页面] 飞书配置已加载:', result);
  });
}

// 保存配置
function saveConfig() {
  const startPage = parseInt(document.getElementById('startPageInput').value) || DEFAULT_CONFIG.startPage;
  const pageCount = parseInt(document.getElementById('pageCountInput').value) || DEFAULT_CONFIG.pageCount;
  const delay = parseInt(document.getElementById('delayInput').value) || DEFAULT_CONFIG.delay;

  // 参数校验
  if (startPage < 1) {
    showToast('起始页码必须 >= 1', 'error');
    return false;
  }
  if (startPage > 100) {
    showToast('起始页码不能超过 100', 'error');
    return false;
  }
  if (pageCount < 1) {
    showToast('采集页数必须 > 0', 'error');
    return false;
  }
  if (pageCount > 50) {
    showToast('采集页数不能超过 50', 'error');
    return false;
  }
  if (delay < 500) {
    showToast('间隔时间不能 < 500ms', 'error');
    return false;
  }
  if (delay > 10000) {
    showToast('间隔时间不能 > 10000ms', 'error');
    return false;
  }

  const config = { startPage, pageCount, delay };
  chrome.storage.local.set(config, () => {
    if (chrome.runtime.lastError) {
      showToast('保存失败', 'error');
    } else {
      showToast('配置已保存', 'success');
    }
  });

  // 保存飞书配置
  const feishuConfig = {
    appId: document.getElementById('feishuAppId').value.trim(),
    appSecret: document.getElementById('feishuAppSecret').value.trim(),
    spreadsheetToken: document.getElementById('feishuSpreadsheetToken').value.trim(),
    productTableId: document.getElementById('feishuProductTableId').value.trim(),
    sellerTableId: document.getElementById('feishuSellerTableId').value.trim(),
    enabled: document.getElementById('feishuEnabled').checked
  };
  chrome.storage.local.set(feishuConfig, () => {
    if (chrome.runtime.lastError) {
      console.error('[配置页面] 保存飞书配置失败:', chrome.runtime.lastError);
    } else {
      console.log('[配置页面] 飞书配置已保存:', feishuConfig);
    }
  });

  return true;
}

// 恢复默认
function resetConfig() {
  if (confirm('确定恢复默认配置？')) {
    document.getElementById('startPageInput').value = DEFAULT_CONFIG.startPage;
    document.getElementById('pageCountInput').value = DEFAULT_CONFIG.pageCount;
    document.getElementById('delayInput').value = DEFAULT_CONFIG.delay;

    // 恢复飞书配置
    document.getElementById('feishuAppId').value = DEFAULT_FEISHU_CONFIG.appId;
    document.getElementById('feishuAppSecret').value = DEFAULT_FEISHU_CONFIG.appSecret;
    document.getElementById('feishuSpreadsheetToken').value = DEFAULT_FEISHU_CONFIG.spreadsheetToken;
    document.getElementById('feishuProductTableId').value = DEFAULT_FEISHU_CONFIG.productTableId;
    document.getElementById('feishuSellerTableId').value = DEFAULT_FEISHU_CONFIG.sellerTableId;
    document.getElementById('feishuEnabled').checked = DEFAULT_FEISHU_CONFIG.enabled;

    saveConfig();
  }
}

// 导航切换
function initNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const panels = document.querySelectorAll('.panel');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const panelId = item.dataset.panel;

      // 更新导航状态
      navItems.forEach(nav => nav.classList.remove('active'));
      item.classList.add('active');

      // 更新面板显示
      panels.forEach(panel => panel.classList.remove('active'));
      document.getElementById(`panel-${panelId}`).classList.add('active');
    });
  });
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  initNavigation();

  document.getElementById('saveBtn').addEventListener('click', saveConfig);
  document.getElementById('resetBtn').addEventListener('click', resetConfig);

  // 测试飞书连接
  document.getElementById('testFeishuBtn')?.addEventListener('click', async () => {
    const feishuConfig = {
      appId: document.getElementById('feishuAppId').value.trim(),
      appSecret: document.getElementById('feishuAppSecret').value.trim(),
      spreadsheetToken: document.getElementById('feishuSpreadsheetToken').value.trim(),
      productTableId: document.getElementById('feishuProductTableId').value.trim(),
    };

    const resultEl = document.getElementById('feishuTestResult');

    if (!feishuConfig.appId || !feishuConfig.appSecret) {
      resultEl.textContent = '请先填写 App ID 和 App Secret';
      resultEl.style.color = '#f44336';
      return;
    }

    resultEl.textContent = '测试中...';
    resultEl.style.color = '#999';

    chrome.runtime.sendMessage({
      type: 'TEST_FEISHU_CONNECTION',
      config: feishuConfig
    }, (response) => {
      if (response?.success) {
        resultEl.textContent = '连接成功';
        resultEl.style.color = '#28a745';
      } else {
        resultEl.textContent = '连接失败: ' + (response?.error || '未知错误');
        resultEl.style.color = '#f44336';
      }
    });
  });

  // Ctrl+S 快捷保存
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveConfig();
    }
  });
});
