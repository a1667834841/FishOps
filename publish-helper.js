/**
 * publish-helper.js - 闲鱼商品发布辅助功能
 * 自动填充发布表单
 */

(function() {
  'use strict';
  
  console.log('[闲鱼采集] publish-helper.js 已加载');
  
  // 检测当前URL是否为发布页
  function isPublishPage() {
    const url = window.location.href;
    return url.includes('www.goofish.com/publish');
  }
  
  // 从localStorage获取待发布的商品数据
  function getPendingPublishData() {
    try {
      const data = localStorage.getItem('xianyu_pending_publish');
      if (data) {
        return JSON.parse(data);
      }
      return null;
    } catch (error) {
      console.error('[闲鱼采集] 读取待发布数据失败:', error);
      return null;
    }
  }
  
  // 清除待发布数据
  function clearPendingPublishData() {
    localStorage.removeItem('xianyu_pending_publish');
  }
  
  // 等待元素出现（支持模糊匹配class）
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const checkElement = () => {
        let element;
        
        // 如果是class模糊匹配（包含^=）
        if (selector.includes('^=')) {
          element = document.querySelector(selector);
        } else {
          element = document.querySelector(selector);
        }
        
        if (element) {
          resolve(element);
          return;
        }
        
        if (Date.now() - startTime > timeout) {
          reject(new Error(`元素 ${selector} 超时未找到`));
          return;
        }
        
        setTimeout(checkElement, 200);
      };
      
      checkElement();
    });
  }
  
  // 将图片URL转换为File对象
  async function urlToFile(url, filename) {
    try {
      // 修复跨域问题：确保URL使用https协议
      if (url.startsWith('http://')) {
        url = url.replace('http://', 'https://');
        addLog(`URL已转换为https: ${url.substring(0, 50)}...`, 'info');
      }
      
      const response = await fetch(url);
      const blob = await response.blob();
      return new File([blob], filename, { type: blob.type });
    } catch (error) {
      console.error('[闲鱼采集] 图片转换失败:', url, error);
      throw error;
    }
  }
  
  // 上传主图
  async function uploadMainImage(imageUrl) {
    try {
      addLog('开始上传主图: ' + imageUrl, 'info');
      
      // 查找主图上传区域（模糊匹配class）
      addLog('查找主图上传区域: [class^="upload-content--"]', 'info');
      const uploadArea = await waitForElement('[class^="upload-content--"]');
      
      if (!uploadArea) {
        addLog('未找到主图上传区域', 'error');
        throw new Error('未找到主图上传区域');
      }
      addLog('找到主图上传区域: ' + uploadArea.className, 'success');
      
      // 查找文件输入框 - 扩大搜索范围
      addLog('查找文件输入框...', 'info');
      
      // 方法1: 在上传区域内查找
      let fileInput = uploadArea.querySelector('input[type="file"]');
      addLog(`方法1 - 区域内查找: ${fileInput ? '找到' : '未找到'}`, 'info');
      
      // 方法2: 查找所有input（包括隐藏的）
      if (!fileInput) {
        const allInputs = uploadArea.querySelectorAll('input');
        addLog(`方法2 - 找到 ${allInputs.length} 个 input 元素`, 'info');
        allInputs.forEach((input, index) => {
          addLog(`  Input ${index}: type=${input.type}, accept=${input.accept}, style.display=${input.style.display}`, 'info');
          if (input.accept && input.accept.includes('image')) {
            fileInput = input;
            addLog(`  ✓ 使用 Input ${index}`, 'success');
          }
        });
      }
      
      // 方法3: 在整个文档中查找（有些input可能在上传区域外）
      if (!fileInput) {
        const allFileInputs = document.querySelectorAll('input[type="file"]');
        addLog(`方法3 - 全局找到 ${allFileInputs.length} 个 file input`, 'info');
        allFileInputs.forEach((input, index) => {
          const accept = input.accept || '';
          addLog(`  File Input ${index}: accept=${accept}, display=${getComputedStyle(input).display}`, 'info');
          if (accept.includes('image') && !fileInput) {
            fileInput = input;
            addLog(`  ✓ 使用全局 File Input ${index}`, 'success');
          }
        });
      }
      
      if (!fileInput) {
        addLog('未找到文件上传输入框', 'error');
        throw new Error('未找到文件上传输入框');
      }
      addLog('找到文件输入框: accept=' + fileInput.accept, 'success');
      
      // 转换图片URL为File对象
      addLog('开始下载图片...', 'info');
      const file = await urlToFile(imageUrl, 'main-image.jpg');
      addLog(`图片下载完成: ${file.name}, 大小: ${(file.size / 1024).toFixed(2)}KB`, 'success');
      
      // 创建DataTransfer对象
      addLog('创建 DataTransfer 对象...', 'info');
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      
      // 设置文件
      addLog('设置文件到 input...', 'info');
      fileInput.files = dataTransfer.files;
      addLog(`文件已设置: files.length=${fileInput.files.length}`, 'success');
      
      // 触发change事件
      addLog('触发 change 事件...', 'info');
      const changeEvent = new Event('change', { bubbles: true });
      fileInput.dispatchEvent(changeEvent);
      
      // 也尝试触发input事件
      const inputEvent = new Event('input', { bubbles: true });
      fileInput.dispatchEvent(inputEvent);
      
      addLog('主图上传完成', 'success');
      return true;
      
    } catch (error) {
      addLog('上传主图失败: ' + error.message, 'error');
      console.error('[闲鱼采集] 上传主图失败:', error);
      return false;
    }
  }
  
  // 上传详情图（多张）
  async function uploadDetailImages(imageUrls) {
    try {
      addLog(`开始上传详情图，共 ${imageUrls.length} 张`, 'info');
      
      // 等待一下，确保主图上传完成
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // 查找详情图上传区域
      addLog('查找详情图上传区域: [class^="upload-item--"]', 'info');
      const uploadItem = await waitForElement('[class^="upload-item--"]');
      
      if (!uploadItem) {
        addLog('未找到详情图上传区域', 'error');
        throw new Error('未找到详情图上传区域');
      }
      addLog('找到详情图上传区域: ' + uploadItem.className, 'success');
      
      // 查找详情图文件输入框 - 扩大搜索范围
      addLog('查找详情图文件输入框...', 'info');
      
      // 方法1: 在上传区域内查找
      let fileInput = uploadItem.querySelector('input[type="file"]');
      addLog(`方法1 - 区域内查找: ${fileInput ? '找到' : '未找到'}`, 'info');
      
      // 方法2: 查找所有input
      if (!fileInput) {
        const allInputs = uploadItem.querySelectorAll('input');
        addLog(`方法2 - 找到 ${allInputs.length} 个 input 元素`, 'info');
        allInputs.forEach((input, index) => {
          addLog(`  Input ${index}: type=${input.type}, accept=${input.accept}`, 'info');
          if (input.accept && input.accept.includes('image')) {
            fileInput = input;
            addLog(`  ✓ 使用 Input ${index}`, 'success');
          }
        });
      }
      
      // 方法3: 查找详情图可能的其他选择器
      if (!fileInput) {
        // 尝试查找父元素的兄弟元素
        const parent = uploadItem.parentElement;
        if (parent) {
          const parentInputs = parent.querySelectorAll('input[type="file"]');
          addLog(`方法3 - 父元素找到 ${parentInputs.length} 个 file input`, 'info');
          if (parentInputs.length > 1) {
            // 如果有多个，第二个可能是详情图的
            fileInput = parentInputs[1];
            addLog(`  ✓ 使用第2个 file input`, 'success');
          } else if (parentInputs.length === 1) {
            // 只有一个的话，可能主图和详情图共用
            fileInput = parentInputs[0];
            addLog(`  ✓ 使用唯一的 file input（可能与主图共用）`, 'success');
          }
        }
      }
      
      // 方法4: 全局查找（作为最后的兜底）
      if (!fileInput) {
        const allFileInputs = document.querySelectorAll('input[type="file"]');
        addLog(`方法4 - 全局找到 ${allFileInputs.length} 个 file input`, 'info');
        if (allFileInputs.length > 0) {
          // 使用第一个支持图片的input
          fileInput = allFileInputs[0];
          addLog(`  ✓ 使用全局第1个 file input`, 'success');
        }
      }
      
      if (!fileInput) {
        addLog('未找到详情图文件上传输入框', 'error');
        throw new Error('未找到详情图文件上传输入框');
      }
      addLog('找到详情图输入框: accept=' + fileInput.accept, 'success');
      
      // 转换所有图片URL为File对象
      const files = [];
      for (let i = 0; i < imageUrls.length; i++) {
        try {
          addLog(`下载详情图 ${i + 1}/${imageUrls.length}...`, 'info');
          const file = await urlToFile(imageUrls[i], `detail-image-${i + 1}.jpg`);
          files.push(file);
          addLog(`  ✓ 图片 ${i + 1} 下载完成: ${(file.size / 1024).toFixed(2)}KB`, 'success');
        } catch (error) {
          addLog(`  ✗ 图片 ${i + 1} 下载失败，跳过`, 'warning');
        }
      }
      
      if (files.length === 0) {
        addLog('所有图片下载失败', 'error');
        throw new Error('没有成功转换的图片');
      }
      addLog(`总共下载成功 ${files.length} 张图片`, 'success');
      
      // 创建DataTransfer对象
      addLog('创建 DataTransfer 对象...', 'info');
      const dataTransfer = new DataTransfer();
      files.forEach(file => dataTransfer.items.add(file));
      
      // 设置文件
      addLog('设置文件到 input...', 'info');
      fileInput.files = dataTransfer.files;
      addLog(`文件已设置: files.length=${fileInput.files.length}`, 'success');
      
      // 触发change事件
      addLog('触发 change 事件...', 'info');
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      
      addLog(`详情图上传完成，共 ${files.length} 张`, 'success');
      return true;
      
    } catch (error) {
      addLog('上传详情图失败: ' + error.message, 'error');
      console.error('[闲鱼采集] 上传详情图失败:', error);
      return false;
    }
  }
  
  // 填充商品描述
  async function fillDescription(description) {
    try {
      addLog('开始填充商品描述', 'info');
        
      // 查找描述编辑器（模糊匹配class）
      addLog('查找描述编辑器...', 'info');
      
      // 方法1: 使用class前缀查找
      let editor = document.querySelector('[class^="editor--"]');
      addLog(`方法1 - class前缀查找: ${editor ? '找到' : '未找到'}`, 'info');
      
      // 方法2: 查找所有contenteditable元素
      if (!editor) {
        const editables = document.querySelectorAll('[contenteditable="true"]');
        addLog(`方法2 - 找到 ${editables.length} 个 contenteditable 元素`, 'info');
        editables.forEach((el, index) => {
          addLog(`  Editable ${index}: class=${el.className}, placeholder=${el.getAttribute('data-placeholder')}`, 'info');
          if (el.className.includes('editor--')) {
            editor = el;
            addLog(`  ✓ 使用 Editable ${index}`, 'success');
          }
        });
        // 如果没有editor开头的，使用第一个contenteditable
        if (!editor && editables.length > 0) {
          editor = editables[0];
          addLog(`  ✓ 使用第一个 contenteditable`, 'success');
        }
      }
      
      // 方法3: 通过data-placeholder属性查找
      if (!editor) {
        editor = document.querySelector('[data-placeholder*="描述"]');
        addLog(`方法3 - placeholder查找: ${editor ? '找到' : '未找到'}`, 'info');
      }
      
      // 方法4: 查找所有包含editor的class
      if (!editor) {
        const allDivs = document.querySelectorAll('div[class*="editor"]');
        addLog(`方法4 - 找到 ${allDivs.length} 个包含editor的div`, 'info');
        for (let i = 0; i < allDivs.length; i++) {
          const div = allDivs[i];
          if (div.getAttribute('contenteditable') === 'true') {
            editor = div;
            addLog(`  ✓ 使用第 ${i} 个 editor div`, 'success');
            break;
          }
        }
      }
        
      if (!editor) {
        addLog('未找到描述编辑器', 'error');
        throw new Error('未找到描述编辑器');
      }
      addLog('找到描述编辑器: ' + editor.className, 'success');
        
      // 查找textarea或可编辑div
      addLog('确认输入框类型...', 'info');
      let descInput = editor;
      
      // 如果找到的不是可编辑元素，尝试在其中查找
      if (editor.getAttribute('contenteditable') !== 'true') {
        descInput = editor.querySelector('textarea');
        if (!descInput) {
          descInput = editor.querySelector('[contenteditable="true"]');
        }
      }
        
      if (!descInput) {
        addLog('未找到描述输入框', 'error');
        // 尝试查找所有可能的输入元素
        const textareas = editor.querySelectorAll('textarea');
        const editables = editor.querySelectorAll('[contenteditable]');
        addLog(`找到 ${textareas.length} 个 textarea, ${editables.length} 个 contenteditable`, 'info');
        throw new Error('未找到描述输入框');
      }
        
      const inputType = descInput.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable';
      addLog(`找到输入框: ${inputType}`, 'success');
        
      // 设置值
      addLog(`设置描述内容 (长度: ${description.length})...`, 'info');
      if (descInput.tagName === 'TEXTAREA') {
        descInput.value = description;
        descInput.dispatchEvent(new Event('input', { bubbles: true }));
        descInput.dispatchEvent(new Event('change', { bubbles: true }));
        descInput.dispatchEvent(new Event('blur', { bubbles: true }));
        addLog('描述已填充 (textarea)', 'success');
      } else {
        // contenteditable div
        descInput.textContent = description;
        descInput.dispatchEvent(new Event('input', { bubbles: true }));
        descInput.dispatchEvent(new Event('blur', { bubbles: true }));
        // 也尝试触发原生输入事件
        const inputEvent = new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: description
        });
        descInput.dispatchEvent(inputEvent);
        addLog('描述已填充 (contenteditable)', 'success');
      }
        
      return true;
        
    } catch (error) {
      addLog('填充描述失败: ' + error.message, 'error');
      console.error('[闲鱼采集] 填充描述失败:', error);
      return false;
    }
  }
  
  // 填充价格信息
  async function fillPrice(price, origPrice) {
    try {
      addLog('开始填充价格信息', 'info');
      addLog(`价格: ${price}, 原价: ${origPrice}`, 'info');
      
      // 查找价格输入框（通过label的for属性关联）
      addLog('查找价格输入框...', 'info');
      
      // 方法1: 通过label的for属性查找
      const priceLabel = document.querySelector('label[for="itemPriceDTO_priceInCent"]');
      const origPriceLabel = document.querySelector('label[for="itemPriceDTO_origPriceInCent"]');
      
      let priceInput = null;
      let origPriceInput = null;
      
      if (priceLabel) {
        addLog('找到价格label', 'success');
        // 从label找到对应的输入框（向上找form-item，再找input）
        const priceFormItem = priceLabel.closest('.ant-form-item');
        if (priceFormItem) {
          priceInput = priceFormItem.querySelector('input.ant-input');
          addLog(`找到价格输入框: ${priceInput ? '是' : '否'}`, priceInput ? 'success' : 'warning');
        }
      }
      
      if (origPriceLabel) {
        addLog('找到原价label', 'success');
        const origPriceFormItem = origPriceLabel.closest('.ant-form-item');
        if (origPriceFormItem) {
          origPriceInput = origPriceFormItem.querySelector('input.ant-input');
          addLog(`找到原价输入框: ${origPriceInput ? '是' : '否'}`, origPriceInput ? 'success' : 'warning');
        }
      }
      
      // 方法2: 如果方法1失败，通过占位符查找
      if (!priceInput || !origPriceInput) {
        addLog('方法2 - 通过class查找价格输入框...', 'info');
        const allPriceInputs = document.querySelectorAll('.priceWrap--nKmMUJ5X input.ant-input, div[class*="priceWrap"] input.ant-input');
        addLog(`找到 ${allPriceInputs.length} 个价格相关输入框`, 'info');
        
        if (allPriceInputs.length >= 2) {
          priceInput = priceInput || allPriceInputs[0];
          origPriceInput = origPriceInput || allPriceInputs[1];
          addLog('使用前两个输入框作为价格和原价', 'success');
        }
      }
      
      // 填充价格
      if (priceInput) {
        addLog(`设置价格: ${price}`, 'info');
        priceInput.value = price.toString();
        priceInput.dispatchEvent(new Event('input', { bubbles: true }));
        priceInput.dispatchEvent(new Event('change', { bubbles: true }));
        priceInput.dispatchEvent(new Event('blur', { bubbles: true }));
        addLog('价格已填充', 'success');
      } else {
        addLog('未找到价格输入框', 'warning');
      }
      
      // 填充原价
      if (origPriceInput) {
        addLog(`设置原价: ${origPrice}`, 'info');
        origPriceInput.value = origPrice.toString();
        origPriceInput.dispatchEvent(new Event('input', { bubbles: true }));
        origPriceInput.dispatchEvent(new Event('change', { bubbles: true }));
        origPriceInput.dispatchEvent(new Event('blur', { bubbles: true }));
        addLog('原价已填充', 'success');
      } else {
        addLog('未找到原价输入框', 'warning');
      }
      
      return (priceInput && origPriceInput);
      
    } catch (error) {
      addLog('填充价格失败: ' + error.message, 'error');
      console.error('[闲鱼采集] 填充价格失败:', error);
      return false;
    }
  }
  
  // 检查发布按钮是否可点击
  function isPublishButtonEnabled() {
    try {
      // 查找发布按钮
      const publishButton = document.querySelector('button[class*="publish-button"]');
      
      if (!publishButton) {
        addLog('未找到发布按钮', 'warning');
        return false;
      }
      
      // 检查是否有disabled class或属性
      const hasDisabledClass = publishButton.className.includes('disabled');
      const hasDisabledAttr = publishButton.disabled || publishButton.getAttribute('disabled') !== null;
      
      const isEnabled = !hasDisabledClass && !hasDisabledAttr;
      
      addLog(`发布按钮状态: ${isEnabled ? '可点击' : '不可点击'}`, isEnabled ? 'success' : 'warning');
      addLog(`  - disabled class: ${hasDisabledClass}`, 'info');
      addLog(`  - disabled attr: ${hasDisabledAttr}`, 'info');
      
      return isEnabled;
      
    } catch (error) {
      addLog('检查发布按钮失败: ' + error.message, 'error');
      return false;
    }
  }
  
  // 点击发布按钮
  async function clickPublishButton() {
    try {
      addLog('开始点击发布按钮', 'info');
      
      // 查找发布按钮
      const publishButton = document.querySelector('button[class*="publish-button"]:not([class*="disabled"])');
      
      if (!publishButton) {
        addLog('未找到可点击的发布按钮', 'error');
        return false;
      }
      
      addLog('找到发布按钮: ' + publishButton.className, 'success');
      
      // 点击按钮
      publishButton.click();
      addLog('✅ 发布按钮已点击！', 'success');
      
      return true;
      
    } catch (error) {
      addLog('点击发布按钮失败: ' + error.message, 'error');
      console.error('[闲鱼采集] 点击发布按钮失败:', error);
      return false;
    }
  }
  
  // 显示操作进度提示
  function showProgressTip(message, type = 'info') {
    const existingTip = document.getElementById('xianyu-publish-tip');
    if (existingTip) {
      existingTip.remove();
    }
    
    const colors = {
      info: '#667eea',
      success: '#38ef7d',
      error: '#f45c43',
      warning: '#ffa726'
    };
    
    const tip = document.createElement('div');
    tip.id = 'xianyu-publish-tip';
    tip.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${colors[type] || colors.info};
      color: white;
      padding: 16px 24px;
      border-radius: 8px;
      box-shadow: 0 4px 15px rgba(0,0,0,0.3);
      z-index: 99999;
      font-size: 14px;
      font-weight: 500;
      max-width: 400px;
      animation: slideIn 0.3s ease;
    `;
    
    tip.innerHTML = message;
    document.body.appendChild(tip);
    
    // 同时输出到控制台
    console.log(`[闲鱼采集] ${message.replace(/<[^>]*>/g, '')}`);
    
    return tip;
  }
  
  // 显示详细日志面板
  function createLogPanel() {
    let panel = document.getElementById('xianyu-publish-log');
    if (panel) {
      return panel;
    }
    
    panel = document.createElement('div');
    panel.id = 'xianyu-publish-log';
    panel.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 450px;
      background: rgba(0, 0, 0, 0.95);
      color: #0f0;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      border-radius: 8px;
      z-index: 99998;
      box-shadow: 0 4px 20px rgba(0,0,0,0.6);
      border: 1px solid #333;
    `;
    
    panel.innerHTML = `
      <div style="padding: 12px 15px; color: #fff; font-weight: bold; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.3);">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 16px;">📝</span>
          <span>自动发布日志</span>
        </div>
        <div style="display: flex; gap: 8px;">
          <button id="xianyu-log-expand-btn" title="展开/收起" style="background: transparent; border: none; color: #0ff; cursor: pointer; font-size: 14px; padding: 0 4px;">▼</button>
          <button id="xianyu-log-close-btn" title="关闭" style="background: transparent; border: none; color: #f45c43; cursor: pointer; font-size: 14px; padding: 0 4px;">✖</button>
        </div>
      </div>
      <div id="xianyu-log-content" style="padding: 10px 15px; line-height: 1.8; overflow-y: auto; max-height: 150px;"></div>
    `;
    
    document.body.appendChild(panel);
    
    // 绑定关闭按钮
    const closeBtn = panel.querySelector('#xianyu-log-close-btn');
    closeBtn.addEventListener('click', () => {
      panel.remove();
    });
    
    // 绑定展开/收起按钮
    const expandBtn = panel.querySelector('#xianyu-log-expand-btn');
    const logContent = panel.querySelector('#xianyu-log-content');
    let isExpanded = false;
    
    expandBtn.addEventListener('click', () => {
      isExpanded = !isExpanded;
      if (isExpanded) {
        logContent.style.maxHeight = '500px';
        expandBtn.textContent = '▲';
        expandBtn.title = '收起';
      } else {
        logContent.style.maxHeight = '150px';
        expandBtn.textContent = '▼';
        expandBtn.title = '展开';
      }
    });
    
    return panel;
  }
  
  // 添加日志
  function addLog(message, type = 'info') {
    const panel = createLogPanel();
    const content = document.getElementById('xianyu-log-content');
    
    const colors = {
      info: '#0ff',
      success: '#0f0',
      error: '#f44',
      warning: '#fa0'
    };
    
    const timestamp = new Date().toLocaleTimeString('zh-CN');
    const logEntry = document.createElement('div');
    logEntry.style.color = colors[type] || colors.info;
    logEntry.innerHTML = `[${timestamp}] ${message}`;
    
    content.appendChild(logEntry);
    content.scrollTop = content.scrollHeight;
    
    // 同时输出到控制台
    console.log(`[闲鱼采集][${timestamp}] ${message}`);
  }
  
  // 自动填充受布表单
  async function autoFillPublishForm() {
    const itemData = getPendingPublishData();
      
    if (!itemData) {
      console.log('[闲鱼采集] 没有待发布的数据');
      return;
    }
      
    console.log('[闲鱼采集] 开始自动填充发布表单:', itemData);
    addLog('=== 开始自动填充发布表单 ===', 'info');
    addLog(`商品ID: ${itemData.itemId}`, 'info');
    addLog(`商品标题: ${itemData.fullData.title}`, 'info');
      
    try {
      // 等待页面完全加载
      addLog('等待页面加载...', 'info');
      await new Promise(resolve => setTimeout(resolve, 2000));
      addLog('页面加载完成', 'success');
      
      // 调试：输出完整数据结构
      addLog('数据结构检查:', 'info');
      addLog(`  - itemData.fullData: ${itemData.fullData ? 'exists' : 'undefined'}`, 'info');
      if (itemData.fullData) {
        addLog(`  - itemData.fullData: ${itemData.fullData ? 'exists' : 'undefined'}`, 'info');
        if (itemData.fullData.imageInfos) {
          addLog(`  - itemData.fullData.imageInfos: ${itemData.fullData.imageInfos ? itemData.fullData.imageInfos.length : 'undefined'}`, 'info');
        }
      }
        
      // 修正：优先使用 itemData.imageInfos，其次使用 fullData.itemDO.imageInfos
      const imageInfos =  itemData.fullData?.imageInfos;
      addLog(`总共 ${imageInfos.length} 张图片`, 'info');
      // 1. 上传主图（第一张）
      if (imageInfos.length > 0) {
        addLog('\n--- 步骤1: 上传主图 ---', 'info');
        const mainImageUrl = imageInfos[0].url;
        const success = await uploadMainImage(mainImageUrl);
          
        if (!success) {
          addLog('主图上传失败，继续其他步骤', 'warning');
        }
          
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        addLog('没有图片数据，跳过图片上传', 'warning');
      }
        
      // 2. 上传详情图（第二张及之后的所有图片）
      if (imageInfos.length > 1) {
        addLog('\n--- 步骤2: 上传详情图 ---', 'info');
        const detailImageUrls = imageInfos.slice(1).map(img => img.url);
        const success = await uploadDetailImages(detailImageUrls);
          
        if (!success) {
          addLog('详情图上传失败，继续其他步骤', 'warning');
        }
          
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
        
      // 3. 填充商品描述
      const description = itemData.desc || '';
      if (description) {
        addLog('\n--- 步骤3: 填充商品描述 ---', 'info');
        addLog(`描述内容: ${description.substring(0, 50)}...`, 'info');
        addLog(`描述长度: ${description.length} 字符`, 'info');
        const success = await fillDescription(description);
          
        if (!success) {
          addLog('描述填充失败', 'warning');
        }
          
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        addLog('没有描述数据，跳过', 'warning');
      }
      
      // 4. 填充价格信息
      const soldPrice = itemData.fullData.price || 0;
      if (soldPrice && soldPrice > 0) {
        addLog('\n--- 步骤4: 填充价格信息 ---', 'info');
        
        // 计算价格（单位默认为元）
        const origPrice = (soldPrice * 5).toFixed(2);
        
        addLog(`转换后 - 价格: ${soldPrice} 元, 原价: ${origPrice} 元`, 'info');
        
        const success = await fillPrice(soldPrice, origPrice);
        
        if (!success) {
          addLog('价格填充失败', 'warning');
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        addLog('没有价格数据，跳过', 'warning');
      }
      
      // 5. 检查发布按钮状态并尝试发布
      addLog('\n--- 步骤5: 检查发布按钮 ---', 'info');
      
      // 等待页面更新
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const buttonEnabled = isPublishButtonEnabled();
      
      // 尝试点击发布按钮
      if (buttonEnabled) {
        addLog('\n--- 步骤6: 点击发布按钮 ---', 'info');
        
        const publishSuccess = await clickPublishButton();
        
        if (publishSuccess) {
          addLog('\n🎉 发布操作已执行！', 'success');
          addLog('\n=== 自动填充完成 ===', 'success');
        } else {
          addLog('点击发布按钮失败', 'error');
          addLog('\n=== 自动填充完成 ===', 'success');
        }
      } else {
        addLog('发布按钮不可点击，请手动检查表单', 'warning');
        addLog('\n=== 自动填充完成 ===', 'success');
      }
      
      console.log('[闲鱼采集] 自动填充完成');
        
    } catch (error) {
      console.error('[闲鱼采集] 自动填充失败:', error);
      addLog('自动填充失败: ' + error.message, 'error');
      addLog('Error Stack: ' + error.stack, 'error');
    }
  }
  
  // 导出函数供其他模块使用
  window.XianyuPublishHelper = {
    getPendingPublishData,
    clearPendingPublishData,
    isPublishPage,
    autoFillPublishForm
  };
  
  // 如果是发布页，自动填充表单
  if (isPublishPage()) {
    console.log('[闲鱼采集] 检测到发布页面');
    
    // 页面加载完成后自动填充
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoFillPublishForm);
    } else {
      setTimeout(autoFillPublishForm, 1000);
    }
  }
  
  console.log('[闲鱼采集] publish-helper.js 初始化完成');
})();
