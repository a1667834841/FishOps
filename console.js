// console.js - 表格管理控制台脚本

// ==================== 批量爬取状态管理 ====================
const batchCrawlState = {
  isRunning: false,
  currentTaskIndex: 0,
  queue: [],
  results: { total: 0, completed: 0, failed: 0, totalItems: 0 },
  currentTabId: null
};

// ==================== 近期记录管理 ====================
const crawlRecords = [];
const MAX_RECORDS = 50; // 最多保存50条记录

// 加载记录
async function loadCrawlRecords() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['crawlRecords'], (result) => {
      const records = result.crawlRecords || [];
      records.forEach(r => crawlRecords.push(r));
      renderRecords();
      resolve();
    });
  });
}

// 保存记录
function saveCrawlRecords() {
  chrome.storage.local.set({ crawlRecords: crawlRecords });
}

// 添加记录
function addCrawlRecord(keyword, itemCount, status) {
  // 如果是 running 状态，先检查是否已存在相同关键词的 running 记录
  if (status === 'running') {
    const existing = crawlRecords.find(r => r.keyword === keyword && r.status === 'running');
    if (existing) {
      // 更新现有记录
      existing.itemCount = itemCount;
      existing.timestamp = Date.now();
      saveCrawlRecords();
      renderRecords();
      return;
    }
  }

  const record = {
    id: Date.now() + Math.random(),
    keyword: keyword,
    itemCount: itemCount,
    status: status, // 'success', 'failed', 'running'
    timestamp: Date.now()
  };

  // 添加到开头
  crawlRecords.unshift(record);

  // 限制数量
  if (crawlRecords.length > MAX_RECORDS) {
    crawlRecords.splice(MAX_RECORDS);
  }

  saveCrawlRecords();
  renderRecords();
}

// 更新记录状态
function updateCrawlRecord(keyword, itemCount, status) {
  const record = crawlRecords.find(r => r.keyword === keyword && r.status === 'running');
  if (record) {
    record.itemCount = itemCount;
    record.status = status;
    record.timestamp = Date.now();
    saveCrawlRecords();
    renderRecords();
  }
}

// 渲染记录列表
function renderRecords() {
  const recordsBody = document.getElementById('recordsBody');

  if (crawlRecords.length === 0) {
    recordsBody.innerHTML = '<tr><td colspan="5" class="empty-records">暂无爬取记录</td></tr>';
    return;
  }

  recordsBody.innerHTML = crawlRecords.map(record => {
    const statusClass = record.status === 'success' ? 'success' : record.status === 'failed' ? 'failed' : 'running';
    const statusText = record.status === 'success' ? '成功' : record.status === 'failed' ? '失败' : '运行中';
    const time = new Date(record.timestamp).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    return `
      <tr data-record-id="${record.id}">
        <td><strong>${record.keyword}</strong></td>
        <td>${record.itemCount}</td>
        <td><span class="status-badge ${statusClass}">${statusText}</span></td>
        <td class="time">${time}</td>
        <td>
          ${record.status === 'success' && record.itemCount > 0 ? `<button class="btn btn-sm" onclick="sendToFeishu('${record.id}')">发送飞书</button>` : '-'}
        </td>
      </tr>
    `;
  }).join('');
}

// 发送到飞书
async function sendToFeishu(recordId) {
  const record = crawlRecords.find(r => r.id == recordId);
  if (!record) {
    showToast('记录不存在', 'error');
    return;
  }

  const btn = document.querySelector(`tr[data-record-id="${recordId}"] button`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '发送中...';
  }

  addLog('info', `正在发送「${record.keyword}」的数据到飞书...`);

  try {
    // 先设置关键词
    await new Promise((res) => {
      chrome.runtime.sendMessage({ type: 'SET_KEYWORD', keyword: record.keyword }, () => res());
    });

    // 发送到飞书
    const response = await new Promise((res) => {
      chrome.runtime.sendMessage({ type: 'SEND_TO_FEISHU' }, (r) => res(r));
    });

    if (response?.success) {
      addLog('success', `已发送 ${response.productCount || record.itemCount} 条数据到飞书`);
      showToast('发送成功！', 'success');
    } else {
      addLog('error', `发送失败: ${response?.error || '未知错误'}`);
      showToast('发送失败', 'error');
    }
  } catch (error) {
    addLog('error', `发送失败: ${error.message}`);
    showToast('发送失败', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '发送飞书';
    }
  }
}

// 使函数全局可用
window.sendToFeishu = sendToFeishu;

// ==================== 监听来自 background 的消息 ====================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'CRAWL_COMPLETED') {
    console.log('[控制台] 收到爬取完成通知');
    // 触发本地事件，保持与原有逻辑兼容
    document.dispatchEvent(new CustomEvent('XIANYU_CRAWL_COMPLETED'));
    sendResponse({ received: true });
    return true;
  }

  if (request.type === 'CRAWL_STOPPED') {
    console.log('[控制台] 收到爬取停止通知');
    document.dispatchEvent(new CustomEvent('XIANYU_CRAWL_STOPPED'));
    sendResponse({ received: true });
    return true;
  }

  return true;
});

// ==================== Tab 切换功能 ====================
function initTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.dataset.tab;

      // 更新按钮状态
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // 更新面板显示
      tabPanes.forEach(pane => pane.classList.remove('active'));
      const targetPane = document.getElementById(`${tabName}-pane`);
      if (targetPane) {
        targetPane.classList.add('active');
      }

      // 如果切换到批量爬取Tab，初始化相关功能
      if (tabName === 'batch-crawl') {
        initBatchCrawlUI();
      }
    });
  });
}

// ==================== 批量爬取 UI 初始化 ====================
function initBatchCrawlUI() {
  // 检查是否已经初始化过
  if (document.getElementById('keywordList').dataset.initialized === 'true') {
    return;
  }
  document.getElementById('keywordList').dataset.initialized = 'true';

  // 加载近期记录
  loadCrawlRecords();

  // 初始化关键词列表
  initKeywordList();

  // 绑定控制按钮
  document.getElementById('startBatchCrawlBtn').addEventListener('click', startBatchCrawl);
  document.getElementById('stopBatchCrawlBtn').addEventListener('click', stopBatchCrawl);

  // 清空日志
  document.getElementById('clearLogBtn').addEventListener('click', () => {
    document.getElementById('logContent').innerHTML = '';
    addLog('info', '日志已清空');
  });

  // 初始化统计显示
  updateProgressDisplay();
}

// ==================== 关键词列表管理 ====================
function initKeywordList() {
  const addBtn = document.getElementById('addKeywordBtn');
  const keywordList = document.getElementById('keywordList');

  // 添加关键词
  addBtn.addEventListener('click', () => {
    const item = createKeywordItem();
    keywordList.appendChild(item);
    updateKeywordCount();
  });

  // 删除关键词
  keywordList.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-keyword-btn')) {
      const item = e.target.closest('.keyword-item');
      item.remove();
      updateKeywordCount();
    }
  });

  // 添加一个默认关键词项
  if (keywordList.children.length === 0) {
    const item = createKeywordItem();
    keywordList.appendChild(item);
  }

  updateKeywordCount();
}

function createKeywordItem() {
  const div = document.createElement('div');
  div.className = 'keyword-item';
  div.innerHTML = `
    <input type="text" class="keyword-input" placeholder="输入关键词...">
    <input type="number" class="page-count-input" placeholder="页数" value="3" min="1" max="50">
    <button class="btn btn-sm remove-keyword-btn" title="删除">×</button>
  `;
  return div;
}

function getKeywordList() {
  const items = document.querySelectorAll('.keyword-item');
  return Array.from(items).map(item => ({
    keyword: item.querySelector('.keyword-input').value.trim(),
    pageCount: parseInt(item.querySelector('.page-count-input').value) || 3
  })).filter(item => item.keyword); // 过滤空关键词
}

function updateKeywordCount() {
  const count = document.querySelectorAll('.keyword-item').length;
  document.getElementById('totalKeywords').textContent = count;
}

// ==================== 批量爬取核心逻辑 ====================
async function startBatchCrawl() {
  // 1. 获取关键词列表
  const keywords = getKeywordList();
  if (keywords.length === 0) {
    showToast('请至少添加一个关键词', 'error');
    return;
  }

  // 2. 检查闲鱼页面是否打开
  const xianyuTab = await findXianyuTab();
  if (!xianyuTab) {
    showToast('未找到闲鱼页面，请先打开闲鱼搜索页面', 'error');
    return;
  }

  batchCrawlState.currentTabId = xianyuTab.id;

  // 3. 获取全局配置
  const startPage = parseInt(document.getElementById('startPage').value) || 1;
  const delay = parseInt(document.getElementById('crawlDelay').value) || 1500;

  // 4. 初始化任务队列
  batchCrawlState.queue = keywords.map(kw => ({
    ...kw,
    status: 'pending'
  }));
  batchCrawlState.currentTaskIndex = 0;
  batchCrawlState.results = {
    total: keywords.length,
    completed: 0,
    failed: 0,
    totalItems: 0
  };
  batchCrawlState.isRunning = true;

  // 5. 更新UI状态
  updateControlButtons(true);
  updateProgressDisplay();
  addLog('info', `批量任务已启动，共 ${keywords.length} 个关键词`);

  // 6. 开始执行队列
  processTaskQueue(startPage, delay);
}

async function processTaskQueue(startPage, delay) {
  const queue = batchCrawlState.queue;

  for (let i = 0; i < queue.length; i++) {
    // 检查停止标志
    if (!batchCrawlState.isRunning) {
      addLog('warning', '批量任务已停止');
      break;
    }

    const task = queue[i];
    batchCrawlState.currentTaskIndex = i;

    // 添加运行中记录
    addCrawlRecord(task.keyword, 0, 'running');

    try {
      addLog('info', `开始爬取: ${task.keyword} (${i + 1}/${queue.length})`);
      addLog('info', `  → 配置: ${task.pageCount} 页, 延迟 ${delay}ms`);

      // 设置关键词
      await new Promise((res) => {
        chrome.runtime.sendMessage(
          { type: 'SET_KEYWORD', keyword: task.keyword },
          () => res()
        );
      });

      // 获取并显示当前过滤条件
      await new Promise((res) => {
        chrome.runtime.sendMessage(
          { type: 'GET_FILTER_CONFIG' },
          (response) => {
            if (response?.config) {
              const fc = response.config;
              if (fc.minWantCnt > 0 || fc.minPrice > 0 || fc.maxPrice > 0 || fc.onlyFreeShip) {
                addLog('warning', `  → 当前过滤条件: 想要人数>=${fc.minWantCnt}, 价格${fc.minPrice}-${fc.maxPrice > 0 ? fc.maxPrice : '不限'}, 包邮=${fc.onlyFreeShip ? '是' : '否'}`);
                addLog('warning', `  → 注意：过滤条件可能会减少采集数量！`);
              }
            }
            res();
          }
        );
      });

      // 清空数据
      await new Promise((res) => {
        chrome.runtime.sendMessage(
          { type: 'CLEAR_DATA' },
          (response) => {
            if (response?.success) {
              addLog('info', `  → 数据已清空，准备采集新数据`);
            }
            res();
          }
        );
      });

      // 发送爬取指令并等待完成
      const result = await executeCrawlTask(task, startPage, delay);

      batchCrawlState.results.completed++;
      batchCrawlState.results.totalItems += result.itemCount || 0;
      addLog('success', `完成: ${task.keyword} - 采集 ${result.itemCount || 0} 件商品`);

      // 更新记录为成功
      updateCrawlRecord(task.keyword, result.itemCount || 0, 'success');

    } catch (error) {
      batchCrawlState.results.failed++;
      addLog('error', `失败: ${task.keyword} - ${error.message}`);

      // 更新记录为失败
      updateCrawlRecord(task.keyword, 0, 'failed');
    }

    // 更新进度显示
    updateProgressDisplay();

    // 如果不是最后一个任务，等待一段时间再继续
    if (i < queue.length - 1 && batchCrawlState.isRunning) {
      addLog('info', '等待 2 秒后继续下一个关键词...');
      await sleep(2000); // 任务间隔2秒
    }
  }

  // 所有任务完成或停止
  const wasRunning = batchCrawlState.isRunning;
  batchCrawlState.isRunning = false;
  updateControlButtons(false);

  if (wasRunning) {
    addLog('info', `========== 批量任务完成 ==========`);
  } else {
    addLog('warning', `========== 批量任务已停止 ==========`);
  }

  addLog('info', `总关键词: ${batchCrawlState.results.total}`);
  addLog('info', `成功: ${batchCrawlState.results.completed}`);
  addLog('info', `失败: ${batchCrawlState.results.failed}`);
  addLog('info', `总商品数: ${batchCrawlState.results.totalItems}`);

  if (wasRunning && batchCrawlState.results.failed === 0) {
    showToast('批量爬取已完成！', 'success');
  } else if (batchCrawlState.results.failed > 0) {
    showToast(`批量爬取完成，成功 ${batchCrawlState.results.completed} 个，失败 ${batchCrawlState.results.failed} 个`, 'warning');
  } else {
    showToast('批量爬取已停止', 'warning');
  }
}

async function executeCrawlTask(task, startPage, delay) {
  return new Promise(async (resolve, reject) => {
    addLog('info', `  → 正在发送爬取指令到闲鱼页面...`);

    // 设置超时保护 - 每页最多2分钟
    const timeoutMs = 120000 * task.pageCount;
    const timeout = setTimeout(() => {
      cleanup();
      addLog('error', `  → 等待超时（${timeoutMs/1000}秒）`);
      addLog('error', `  → 可能原因：闲鱼页面未响应、API模块未加载、或页面已刷新`);
      reject(new Error('爬取超时'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      document.removeEventListener('XIANYU_CRAWL_COMPLETED', completedHandler);
      document.removeEventListener('XIANYU_CRAWL_STOPPED', stoppedHandler);
    };

    const completedHandler = () => {
      cleanup();
      addLog('info', `  → 收到爬取完成事件`);
      // 获取统计信息
      chrome.runtime.sendMessage(
        { type: 'GET_STATS' },
        (response) => {
          const itemCount = response?.itemCount || 0;
          const pageCount = response?.pageCount || 0;
          addLog('info', `  → 采集完成: ${pageCount} 页, ${itemCount} 件商品`);
          resolve({ itemCount });
        }
      );
    };

    const stoppedHandler = () => {
      cleanup();
      addLog('warning', `  → 爬取被用户停止`);
      reject(new Error('爬取被停止'));
    };

    document.addEventListener('XIANYU_CRAWL_COMPLETED', completedHandler);
    document.addEventListener('XIANYU_CRAWL_STOPPED', stoppedHandler);

    // 发送开始爬取消息到闲鱼页面
    chrome.tabs.sendMessage(
      batchCrawlState.currentTabId,
      {
        type: 'START_AUTO_CRAWL',
        keyword: task.keyword,
        startPage: startPage,
        pageCount: task.pageCount,
        delay: delay
      },
      (response) => {
        if (chrome.runtime.lastError) {
          cleanup();
          addLog('error', `  → 发送消息失败: ${chrome.runtime.lastError.message}`);
          addLog('error', `  → 请确保闲鱼页面已打开并刷新`);
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          addLog('info', `  → 指令已发送，等待爬取完成...`);
          addLog('info', `  → 预计需要约 ${task.pageCount * delay / 1000} 秒`);
        }
      }
    );
  });
}

// ==================== 辅助功能 ====================
async function findXianyuTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: '*://*.goofish.com/*' }, (tabs) => {
      if (tabs.length > 0) {
        resolve(tabs[0]);
      } else {
        resolve(null);
      }
    });
  });
}

function updateControlButtons(isRunning) {
  document.getElementById('startBatchCrawlBtn').disabled = isRunning;
  document.getElementById('stopBatchCrawlBtn').disabled = !isRunning;
}

function updateProgressDisplay() {
  const { results, currentTaskIndex } = batchCrawlState;

  document.getElementById('totalKeywords').textContent = results.total;
  document.getElementById('completedKeywords').textContent = results.completed;
  document.getElementById('totalItems').textContent = results.totalItems;

  const progress = results.total > 0 ? Math.round((currentTaskIndex / results.total) * 100) : 0;
  document.getElementById('progressFill').style.width = `${progress}%`;
  document.getElementById('progressText').textContent = `${progress}%`;
}

function addLog(type, message) {
  const logContent = document.getElementById('logContent');
  const timestamp = new Date().toLocaleTimeString('zh-CN');
  const logItem = document.createElement('div');
  logItem.className = `log-item ${type}`;
  logItem.textContent = `[${timestamp}] ${message}`;
  logContent.appendChild(logItem);
  logContent.scrollTop = logContent.scrollHeight;

  // 限制日志数量
  const logItems = logContent.querySelectorAll('.log-item');
  if (logItems.length > 500) {
    logItems[0].remove();
  }
}

function stopBatchCrawl() {
  batchCrawlState.isRunning = false;
  addLog('warning', '用户停止了批量任务');
  updateControlButtons(false);
  showToast('批量爬取已停止', 'warning');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 原有功能保持不变 ====================
// 显示 Toast 提示
function showToast(message, type = 'info', duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  setTimeout(() => toast.classList.remove('show'), duration);
}

// 格式化时间
function formatTime(timestamp) {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// 加载关键词-数据表映射
async function loadKeywordTableMap() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'GET_KEYWORD_TABLE_MAP' },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error('[控制台] 获取映射列表失败:', chrome.runtime.lastError);
          showToast('获取映射列表失败', 'error');
          resolve({});
        } else {
          resolve(response?.map || {});
        }
      }
    );
  });
}

// 加载所有数据表列表
async function loadAllDataTables() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'GET_ALL_DATA_TABLES' },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error('[控制台] 获取数据表列表失败:', chrome.runtime.lastError);
          showToast('获取数据表列表失败', 'error');
          resolve({ tables: [], spreadsheetToken: '' });
        } else if (!response?.success) {
          showToast(response?.error || '获取数据表失败', 'error');
          resolve({ tables: [], spreadsheetToken: '' });
        } else {
          resolve({ tables: response.tables || [], spreadsheetToken: response.spreadsheetToken || '' });
        }
      }
    );
  });
}

// 渲染表格列表
function renderTableList(tables, keywordTableMap, spreadsheetToken) {
  const tableBody = document.getElementById('tableBody');
  const totalCountEl = document.getElementById('totalCount');
  const mappedCountEl = document.getElementById('mappedCount');
  const unmappedCountEl = document.getElementById('unmappedCount');

  totalCountEl.textContent = tables.length;

  // 构建反向映射： tableId -> keyword
  const tableIdToKeyword = {};
  Object.entries(keywordTableMap).forEach(([keyword, mapping]) => {
    if (mapping.productTableId) {
      tableIdToKeyword[mapping.productTableId] = keyword;
    }
  });

  // 统计映射和未映射的表
  const mappedTables = tables.filter(t => tableIdToKeyword[t.tableId]);
  const unmappedTables = tables.filter(t => !tableIdToKeyword[t.tableId]);

  mappedCountEl.textContent = mappedTables.length;
  unmappedCountEl.textContent = unmappedTables.length;

  if (tables.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-state">
          <div class="icon">📊</div>
          <div>暂无数据表记录</div>
          <div style="margin-top: 8px; font-size: 12px;">启用「自动创建表格」后，爬取数据时会自动创建飞书数据表</div>
        </td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = tables.map(table => {
    const keyword = tableIdToKeyword[table.tableId] || '-';
    const isMapped = !!tableIdToKeyword[table.tableId];
    
    return `
      <tr data-table-id="${table.tableId}">
        <td><strong>${table.tableName}</strong></td>
        <td>${keyword}</td>
        <td><span class="time">${table.tableId}</span></td>
        <td class="actions">
          <button class="btn btn-sm" onclick="openTable('${spreadsheetToken}', '${table.tableId}')">打开表格</button>
          <button class="btn btn-sm" onclick="copyTableLink('${spreadsheetToken}', '${table.tableId}')">复制链接</button>
          ${isMapped ? `<button class="btn btn-sm btn-danger" onclick="deleteMapping('${keyword}')">删除映射</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

// 打开表格
function openTable(spreadsheetToken, tableId) {
  // 飞书多维表格数据表链接格式
  const url = `https://www.feishu.cn/base/${spreadsheetToken}?table=${tableId}`;
  chrome.tabs.create({ url: url });
}

// 复制链接
function copyTableLink(spreadsheetToken, tableId) {
  const url = `https://www.feishu.cn/base/${spreadsheetToken}?table=${tableId}`;
  navigator.clipboard.writeText(url).then(() => {
    showToast('链接已复制到剪贴板', 'success');
  }).catch(() => {
    showToast('复制失败', 'error');
  });
}

// 删除映射记录
function deleteMapping(keyword) {
  if (!confirm(`确定要删除关键词「${keyword}」的映射记录吗？\n\n注意：这只是删除本地记录，不会删除飞书中的实际表格。`)) {
    return;
  }

  chrome.runtime.sendMessage(
    { type: 'DELETE_KEYWORD_MAPPING', keyword: keyword },
    (response) => {
      if (chrome.runtime.lastError) {
        showToast('删除失败: ' + chrome.runtime.lastError.message, 'error');
      } else if (response?.success) {
        showToast('删除成功', 'success');
        // 重新加载列表
        loadAndRender();
      } else {
        showToast('删除失败', 'error');
      }
    }
  );
}

// 清空所有记录
function clearAllMappings() {
  if (!confirm('确定要清空所有映射记录吗？\n\n注意：这只是删除本地记录，不会删除飞书中的实际表格。')) {
    return;
  }

  chrome.runtime.sendMessage(
    { type: 'CLEAR_KEYWORD_MAPPING' },
    (response) => {
      if (chrome.runtime.lastError) {
        showToast('清空失败: ' + chrome.runtime.lastError.message, 'error');
      } else if (response?.success) {
        showToast('清空成功', 'success');
        // 重新加载列表
        loadAndRender();
      } else {
        showToast('清空失败', 'error');
      }
    }
  );
}

// 加载并渲染
async function loadAndRender() {
  const keywordTableMap = await loadKeywordTableMap();
  const { tables, spreadsheetToken } = await loadAllDataTables();
  renderTableList(tables, keywordTableMap, spreadsheetToken);
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  // 初始化 Tab 切换
  initTabs();

  // 加载并渲染表格列表
  loadAndRender();

  // 刷新按钮
  document.getElementById('refreshBtn').addEventListener('click', () => {
    loadAndRender();
    showToast('已刷新', 'success', 1500);
  });

  // 清空按钮
  document.getElementById('clearBtn').addEventListener('click', clearAllMappings);
});
