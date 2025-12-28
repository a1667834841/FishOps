/**
 * item-download.js - 商品详情页下载功能
 * 检测 URL 是否为 https://www.goofish.com/item?id=xxx 格式
 * 如果是，则在页面右下角显示下载按钮
 */

(function() {
  'use strict';
  
  console.log('[闲鱼采集] item-download.js 已加载');
  
  // 检测当前URL是否为商品详情页
  function isItemDetailPage() {
    const url = window.location.href;
    // 兼容多种商品详情页URL格式:
    // https://www.goofish.com/item?id=xxx
    // https://www.goofish.com/item?spm=xxx&id=xxx&categoryId=xxx
    return url.includes('www.goofish.com/item') && url.includes('id=');
  }
  
  // 从URL中提取商品ID
  function getItemIdFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('id');
  }
  
  // 创建下载按钮
  function createDownloadButton() {
    // 检查按钮是否已存在
    if (document.getElementById('xianyu-download-btn')) {
      console.log('[闲鱼采集] 下载按钮已存在');
      return;
    }
    
    // 创建下载按钮元素
    const button = document.createElement('button');
    button.id = 'xianyu-download-btn';
    button.className = 'xianyu-download-btn';
    button.setAttribute('data-tooltip', '下载商品信息');
    button.innerHTML = '⬇️';
    button.title = '下载商品信息';
    
    // 添加点击事件
    button.addEventListener('click', handleDownloadClick);
    
    // 创建控制台按钮元素
    const consoleButton = document.createElement('button');
    consoleButton.id = 'xianyu-console-btn';
    consoleButton.className = 'xianyu-console-btn';
    consoleButton.setAttribute('data-tooltip', '下载记录');
    consoleButton.innerHTML = '📋';
    consoleButton.title = '查看下载记录';
    
    // 添加控制台点击事件
    consoleButton.addEventListener('click', toggleConsolePanel);
    
    // 添加到页面
    document.body.appendChild(button);
    document.body.appendChild(consoleButton);
    
    console.log('[闲鱼采集] 下载按钮和控制台按钮已添加到页面');
  }
  
  // 移除下载按钮
  function removeDownloadButton() {
    const button = document.getElementById('xianyu-download-btn');
    if (button) {
      button.remove();
      console.log('[闲鱼采集] 下载按钮已移除');
    }
    const consoleButton = document.getElementById('xianyu-console-btn');
    if (consoleButton) {
      consoleButton.remove();
    }
    const panel = document.getElementById('xianyu-console-panel');
    if (panel) {
      panel.remove();
    }
  }
  
  // 商品数据缓存
  let cachedItemData = null;
  
  // 监听商品详情数据
  document.addEventListener('XIANYU_DETAIL_DATA', function(event) {
    console.log('[闲鱼采集] 收到商品详情数据:', event.detail);
    cachedItemData = event.detail;
  });
  
  // 处理下载按钮点击
  async function handleDownloadClick() {
    const button = document.getElementById('xianyu-download-btn');
    if (!button) return;
    
    // 获取商品ID
    const itemId = getItemIdFromUrl();
    if (!itemId) {
      showButtonError(button, '无法获取商品ID');
      return;
    }
    
    // 设置加载状态
    button.classList.add('loading');
    button.setAttribute('data-tooltip', '正在获取商品信息...');
    
    try {
      // 等待一下数据,如果已有缓存数据则直接使用
      if (!cachedItemData) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      let itemData;
      
      // 如果有缓存数据,直接使用
      if (cachedItemData && cachedItemData.response) {
        console.log('[闲鱼采集] 使用缓存的商品数据');
        itemData = cachedItemData.response;
      } else {
        // 否则尝试主动获取数据
        console.log('[闲鱼采集] 主动获取商品数据');
        itemData = await fetchItemDetail(itemId);
      }
      
      // 解析并下载数据
      if (itemData && itemData.data) {
        await downloadItemData(itemData.data, itemId);
        showButtonSuccess(button, '下载成功！');
      } else {
        throw new Error('商品数据格式错误');
      }
      
    } catch (error) {
      console.error('[闲鱼采集] 下载失败:', error);
      showButtonError(button, '下载失败: ' + error.message);
    } finally {
      // 重置按钮状态
      setTimeout(() => {
        button.classList.remove('loading', 'success', 'error');
        button.setAttribute('data-tooltip', '下载商品信息');
      }, 2000);
    }
  }
  
  // 主动获取商品详情
  async function fetchItemDetail(itemId) {
    // 检查 API 模块是否存在
    if (!window.XianyuAPI) {
      throw new Error('XianyuAPI 模块未加载');
    }
    
    console.log('[闲鱼采集] 调用 XianyuAPI 获取商品详情:', itemId);
    
    try {
      const result = await window.XianyuAPI.fetchItemDetail(itemId);
      return result;
    } catch (error) {
      console.error('[闲鱼采集] API调用失败:', error);
      throw error;
    }
  }
  
  // 下载商品数据为JSON文件
  async function downloadItemData(itemData, itemId) {
    try {
      // 提取关键信息
      const downloadData = {
        itemId: itemId,
        title: itemData.itemDO?.title || '未知标题',
        price: itemData.itemDO?.soldPrice || '未知价格',
        sellerId: itemData.sellerDO?.sellerId || '',
        sellerNick: itemData.sellerDO?.nick || '',
        uniqueName: itemData.sellerDO?.uniqueName || '',
        location: itemData.itemDO?.city || itemData.sellerDO?.city || '',
        description: itemData.itemDO?.desc || '',
        images: itemData.itemDO?.imageInfos?.map(img => img.url) || [],
        imageInfos: itemData.itemDO?.imageInfos || [],
        createTime: itemData.itemDO?.GMT_CREATE_DATE_KEY || '',
        browseCnt: itemData.itemDO?.browseCnt || 0,
        collectCnt: itemData.itemDO?.collectCnt || 0,
        wantCnt: itemData.itemDO?.wantCnt || 0,
        category: itemData.itemDO?.categoryId || '',
        fullData: itemData // 保存完整数据
      };
      
      // 保存到本地存储（不再下载文件）
      await saveDownloadRecord(downloadData);
      
      console.log('[闲鱼采集] 商品数据已保存到localStorage:', itemId);
      
    } catch (error) {
      console.error('[闲鱼采集] 保存数据失败:', error);
      throw error;
    }
  }
  
  // 显示成功状态
  function showButtonSuccess(button, message) {
    button.classList.remove('loading', 'error');
    button.classList.add('success');
    button.setAttribute('data-tooltip', message);
    button.innerHTML = '✓';
    
    setTimeout(() => {
      button.innerHTML = '⬇️';
    }, 2000);
  }
  
  // 显示错误状态
  function showButtonError(button, message) {
    button.classList.remove('loading', 'success');
    button.classList.add('error');
    button.setAttribute('data-tooltip', message);
    button.innerHTML = '✗';
    
    setTimeout(() => {
      button.innerHTML = '⬇️';
    }, 2000);
  }
  
  // ==================== 控制台面板功能 ====================
  
  // 保存下载记录到本地存储
  async function saveDownloadRecord(itemData) {
    try {
      const record = {
        id: Date.now(),
        itemId: itemData.itemId,
        uniqueName: itemData.uniqueName,
        desc: itemData.description,
        imageUrl: itemData.imageInfos?.[0]?.url || '',
        wantCnt: itemData.wantCnt || 0,
        browseCnt: itemData.browseCnt || 0,
        createTime: itemData.createTime || '',
        downloadTime: new Date().toLocaleString('zh-CN'),
        fullData: itemData
      };
      
      // 获取现有记录
      const records = await getDownloadRecords();
      
      // 添加新记录（最新的在前面）
      records.unshift(record);
      
      // 保留最近100条记录
      const limitedRecords = records.slice(0, 100);
      
      // 保存到localStorage
      localStorage.setItem('xianyu_download_records', JSON.stringify(limitedRecords));
      
      console.log('[闲鱼采集] 下载记录已保存');
    } catch (error) {
      console.error('[闲鱼采集] 保存记录失败:', error);
    }
  }
  
  // 获取下载记录
  async function getDownloadRecords() {
    try {
      const records = localStorage.getItem('xianyu_download_records');
      return records ? JSON.parse(records) : [];
    } catch (error) {
      console.error('[闲鱼采集] 读取记录失败:', error);
      return [];
    }
  }
  
  // 切换控制台面板显示/隐藏
  async function toggleConsolePanel() {
    let panel = document.getElementById('xianyu-console-panel');
    
    if (panel) {
      // 如果已存在，切换显示状态
      if (panel.style.display === 'none') {
        panel.style.display = 'block';
        await refreshConsolePanel();
      } else {
        panel.style.display = 'none';
      }
    } else {
      // 创建控制台面板
      await createConsolePanel();
    }
  }
  
  // 创建控制台面板
  async function createConsolePanel() {
    const panel = document.createElement('div');
    panel.id = 'xianyu-console-panel';
    panel.className = 'xianyu-console-panel';
    
    panel.innerHTML = `
      <div class="console-header">
        <h3>📋 下载记录</h3>
        <div class="console-actions">
          <button class="console-refresh-btn" title="刷新记录">🔄 刷新</button>
          <button class="console-clear-btn" title="清空记录">🗑️ 清空</button>
          <button class="console-close-btn" title="关闭">✖</button>
        </div>
      </div>
      <div class="console-body">
        <div class="console-loading">加载中...</div>
      </div>
    `;
    
    document.body.appendChild(panel);
    
    // 绑定事件
    panel.querySelector('.console-close-btn').addEventListener('click', () => {
      panel.style.display = 'none';
    });
    
    panel.querySelector('.console-refresh-btn').addEventListener('click', async () => {
      await refreshConsolePanel();
    });
    
    panel.querySelector('.console-clear-btn').addEventListener('click', async () => {
      if (confirm('确定要清空所有下载记录吗？')) {
        localStorage.removeItem('xianyu_download_records');
        await refreshConsolePanel();
      }
    });
    
    // 加载数据
    await refreshConsolePanel();
  }
  
  // 刷新控制台面板数据
  async function refreshConsolePanel() {
    const panel = document.getElementById('xianyu-console-panel');
    if (!panel) return;
    
    const records = await getDownloadRecords();
    const consoleBody = panel.querySelector('.console-body');
    
    if (records.length === 0) {
      consoleBody.innerHTML = '<div class="console-empty">暂无下载记录</div>';
      return;
    }
    
    // 构建表格
    let tableHTML = `
      <table class="console-table">
        <thead>
          <tr>
            <th style="width: 70px;">商品图片</th>
            <th style="width: 100px;">卖家昵称</th>
            <th style="width: 180px;">商品描述</th>
            <th style="width: 80px;">想要人数</th>
            <th style="width: 80px;">浏览量</th>
            <th style="width: 140px;">发布时间</th>
            <th style="width: 140px;">下载时间</th>
            <th style="width: 150px;">操作</th>
          </tr>
        </thead>
        <tbody>
    `;
    
    records.forEach(record => {
      const descShort = (record.desc || '').substring(0, 20) + (record.desc?.length > 20 ? '...' : '');
      const imageUrl = record.imageUrl || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="60" height="60"%3E%3Crect fill="%23ddd" width="60" height="60"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23999"%3E无图%3C/text%3E%3C/svg%3E';
      
      tableHTML += `
        <tr data-record-id="${record.id}">
          <td><img src="${imageUrl}" class="item-thumb" alt="商品图片" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2260%22 height=%2260%22%3E%3Crect fill=%22%23ddd%22 width=%2260%22 height=%2260%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22 fill=%22%23999%22%3E无图%3C/text%3E%3C/svg%3E'"></td>
          <td><div class="text-ellipsis" title="${record.uniqueName || '未知'}">${record.uniqueName || '未知'}</div></td>
          <td><div class="text-ellipsis" title="${record.desc || '无描述'}">${descShort || '无描述'}</div></td>
          <td>${record.wantCnt || 0}</td>
          <td>${record.browseCnt || 0}</td>
          <td>${record.createTime || '-'}</td>
          <td>${record.downloadTime}</td>
          <td>
            <button class="publish-btn" data-record-id="${record.id}">🚀 发布</button>
            <button class="delete-btn" data-record-id="${record.id}">🗑️ 删除</button>
          </td>
        </tr>
      `;
    });
    
    tableHTML += `
        </tbody>
      </table>
    `;
    
    consoleBody.innerHTML = tableHTML;
    
    // 绑定发布按钮事件
    consoleBody.querySelectorAll('.publish-btn').forEach(btn => {
      btn.addEventListener('click', handlePublish);
    });
    
    // 绑定删除按钮事件
    consoleBody.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', handleDelete);
    });
  }
  
  // 处理发布按钮点击
  async function handlePublish(event) {
    const recordId = parseInt(event.target.getAttribute('data-record-id'));
    const records = await getDownloadRecords();
    const record = records.find(r => r.id === recordId);
    
    if (!record) {
      alert('记录不存在');
      return;
    }
    
    console.log('[闲鱼采集] 准备发布商品:', record);
    
    // 保存待发布数据到localStorage
    try {
      localStorage.setItem('xianyu_pending_publish', JSON.stringify(record));
      
      // 打开发布页面
      window.open('https://www.goofish.com/publish?', '_blank');
            
    } catch (error) {
      console.error('[闲鱼采集] 保存待发布数据失败:', error);
      alert('保存数据失败，请重试！');
    }
  }
  
  // 处理删除按钮点击
  async function handleDelete(event) {
    const recordId = parseInt(event.target.getAttribute('data-record-id'));
    
    if (!confirm('确定要删除这条记录吗？')) {
      return;
    }
    
    try {
      // 获取现有记录
      const records = await getDownloadRecords();
      
      // 过滤掉要删除的记录
      const newRecords = records.filter(r => r.id !== recordId);
      
      // 保存更新后的记录
      localStorage.setItem('xianyu_download_records', JSON.stringify(newRecords));
      
      // 刷新页面
      await refreshConsolePanel();
      
      console.log('[闲鱼采集] 记录已删除:', recordId);
    } catch (error) {
      console.error('[闲鱼采集] 删除记录失败:', error);
      alert('删除失败！');
    }
  }
  
  // 初始化函数
  function init() {
    // 检查是否为商品详情页
    if (isItemDetailPage()) {
      console.log('[闲鱼采集] 检测到商品详情页,准备添加下载按钮');
      
      // 等待页面加载完成后添加按钮
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createDownloadButton);
      } else {
        createDownloadButton();
      }
    } else {
      console.log('[闲鱼采集] 非商品详情页,不添加下载按钮');
    }
  }
  
  // 监听URL变化(SPA应用)
  let lastUrl = window.location.href;
  
  function checkUrlChange() {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      console.log('[闲鱼采集] URL已变化:', currentUrl);
      lastUrl = currentUrl;
      
      // 清空缓存数据
      cachedItemData = null;
      
      // 检查新URL
      if (isItemDetailPage()) {
        createDownloadButton();
      } else {
        removeDownloadButton();
      }
    }
  }
  
  // 使用 MutationObserver 监听 URL 变化
  const observer = new MutationObserver(checkUrlChange);
  observer.observe(document.querySelector('head > title'), {
    childList: true
  });
  
  // 监听 popstate 事件(浏览器前进后退)
  window.addEventListener('popstate', checkUrlChange);
  
  // 监听 pushState 和 replaceState
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function() {
    originalPushState.apply(this, arguments);
    checkUrlChange();
  };
  
  history.replaceState = function() {
    originalReplaceState.apply(this, arguments);
    checkUrlChange();
  };
  
  // 执行初始化
  init();
  
  console.log('[闲鱼采集] item-download.js 初始化完成');
})();
