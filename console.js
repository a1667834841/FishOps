// console.js - 表格管理控制台脚本

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

// 加载关键词-表格映射
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

// 渲染表格列表
function renderTableList(keywordTableMap) {
  const tableBody = document.getElementById('tableBody');
  const totalCountEl = document.getElementById('totalCount');
  const createdCountEl = document.getElementById('createdCount');
  const existingCountEl = document.getElementById('existingCount');

  const keywords = Object.keys(keywordTableMap);
  totalCountEl.textContent = keywords.length;

  let createdCount = 0;
  let existingCount = 0;

  // 统计创建类型（假设 createTime 和 updateTime 相同则为新建）
  keywords.forEach(keyword => {
    const mapping = keywordTableMap[keyword];
    if (mapping.createTime === mapping.updateTime) {
      createdCount++;
    } else {
      existingCount++;
    }
  });

  createdCountEl.textContent = createdCount;
  existingCountEl.textContent = existingCount;

  if (keywords.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-state">
          <div class="icon">📊</div>
          <div>暂无表格记录</div>
          <div style="margin-top: 8px; font-size: 12px;">启用「自动创建表格」后，爬取数据时会自动创建飞书多维表格</div>
        </td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = keywords.map(keyword => {
    const mapping = keywordTableMap[keyword];
    const isCreated = mapping.createTime === mapping.updateTime;

    return `
      <tr data-keyword="${keyword}">
        <td><strong>${keyword}</strong></td>
        <td>${keyword}</td>
        <td><span class="time">${formatTime(mapping.createTime)}</span></td>
        <td class="actions">
          <button class="btn btn-sm" onclick="openTable('${keyword}')">打开表格</button>
          <button class="btn btn-sm" onclick="copyLink('${keyword}')">复制链接</button>
          <button class="btn btn-sm btn-danger" onclick="deleteMapping('${keyword}')">删除</button>
        </td>
      </tr>
    `;
  }).join('');
}

// 打开表格
function openTable(keyword) {
  chrome.runtime.sendMessage(
    { type: 'GET_KEYWORD_TABLE_MAP' },
    (response) => {
      const mapping = response?.map?.[keyword];
      if (mapping?.spreadsheetUrl) {
        chrome.tabs.create({ url: mapping.spreadsheetUrl });
      } else {
        showToast('表格链接不存在', 'error');
      }
    }
  );
}

// 复制链接
function copyLink(keyword) {
  chrome.runtime.sendMessage(
    { type: 'GET_KEYWORD_TABLE_MAP' },
    (response) => {
      const mapping = response?.map?.[keyword];
      if (mapping?.spreadsheetUrl) {
        navigator.clipboard.writeText(mapping.spreadsheetUrl).then(() => {
          showToast('链接已复制到剪贴板', 'success');
        }).catch(() => {
          showToast('复制失败', 'error');
        });
      } else {
        showToast('表格链接不存在', 'error');
      }
    }
  );
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
  renderTableList(keywordTableMap);
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  loadAndRender();

  // 刷新按钮
  document.getElementById('refreshBtn').addEventListener('click', () => {
    loadAndRender();
    showToast('已刷新', 'success', 1500);
  });

  // 清空按钮
  document.getElementById('clearBtn').addEventListener('click', clearAllMappings);
});
