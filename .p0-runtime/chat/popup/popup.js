/**
 * popup.js - 插件弹窗逻辑
 */

document.addEventListener('DOMContentLoaded', function() {
  const statusEl = document.getElementById('status');
  const openOptionsBtn = document.getElementById('openOptions');
  
  // 检查闲鱼页面是否打开
  checkIdlefishStatus();
  
  // 打开设置页面
  openOptionsBtn.addEventListener('click', function() {
    if (chrome.tabs) {
      chrome.tabs.create({
        url: chrome.runtime.getURL('options/options.html')
      });
    } else if (chrome.runtime) {
      // 如果是 extension service worker 环境
      window.open(chrome.runtime.getURL('options/options.html'));
    }
  });
  
  /**
   * 检查闲鱼页面状态
   */
  async function checkIdlefishStatus() {
    try {
      // 查询闲鱼标签页
      const tabs = await chrome.tabs.query({ 
        url: 'https://www.goofish.com/*' 
      });
      
      if (tabs && tabs.length > 0) {
        updateStatus(true, tabs.length);
      } else {
        updateStatus(false, 0);
      }
    } catch (error) {
      console.error('[Popup] 检查状态失败:', error);
      updateStatus(false, 0);
    }
  }
  
  /**
   * 更新状态显示
   */
  function updateStatus(isActive, tabCount) {
    if (isActive) {
      statusEl.className = 'status active';
      statusEl.textContent = `✅ 已检测到 ${tabCount} 个闲鱼页面`;
    } else {
      statusEl.className = 'status inactive';
      statusEl.textContent = '⚠️ 请打开闲鱼聊天页面';
    }
  }
});
