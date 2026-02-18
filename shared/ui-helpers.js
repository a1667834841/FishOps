/**
 * ui-helpers.js - 统一UI工具函数
 * Toast提示、确认对话框等UI组件的共享实现
 */

/**
 * Toast 提示工具函数
 * @param {string} message - 提示消息
 * @param {string} type - 提示类型 ('info' | 'success' | 'warning' | 'error')
 * @param {number} duration - 显示时长(ms)
 */
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

/**
 * 确认对话框工具函数
 * @param {string} message - 确认消息
 * @param {Object} options - 配置选项
 * @param {string} options.title - 对话框标题
 * @returns {Promise<boolean>} 用户选择结果
 */
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

// 导出供其他模块使用
if (typeof window !== 'undefined') {
  window.showToast = showToast;
  window.showConfirm = showConfirm;
}
