/**
 * auto-reply-options.js - 自动回复设置页面逻辑
 */

(function() {
  'use strict';

  var defaultConfig = {
    enabled: false,
    keywords: [
      { trigger: '123', reply: '456' },
      { trigger: '你好', reply: '您好！有什么可以帮您？' },
      { trigger: '在吗', reply: '您好，请问有什么事吗？' }
    ],
    delay: 1000,
    cooldown: 60000,
    blacklist: []
  };

  var currentConfig = null;

  // DOM 元素
  const elements = {
    enableToggle: document.getElementById('enableToggle'),
    keywordList: document.getElementById('keywordList'),
    addKeywordBtn: document.getElementById('addKeywordBtn'),
    delayInput: document.getElementById('delayInput'),
    cooldownInput: document.getElementById('cooldownInput'),
    saveBtn: document.getElementById('saveBtn'),
    statusBar: document.getElementById('statusBar'),
    statusText: document.getElementById('statusText')
  };

  // 加载配置
  function loadConfig() {
    chrome.runtime.sendMessage({
      type: 'GET_AUTO_REPLY_CONFIG'
    }, function(response) {
      if (response && response.config) {
        currentConfig = Object.assign({}, defaultConfig, response.config);
        renderConfig();
      } else {
        currentConfig = Object.assign({}, defaultConfig);
        renderConfig();
      }
    });
  }

  // 渲染配置到页面
  function renderConfig() {
    // 启用开关
    elements.enableToggle.checked = currentConfig.enabled;

    // 高级设置
    elements.delayInput.value = currentConfig.delay;
    elements.cooldownInput.value = currentConfig.cooldown / 1000; // 转换为秒

    // 关键字列表
    renderKeywordList();
  }

  // 渲染关键字列表
  function renderKeywordList() {
    elements.keywordList.innerHTML = '';

    if (!currentConfig.keywords || currentConfig.keywords.length === 0) {
      elements.keywordList.innerHTML = `
        <div class="empty-state">
          <div style="font-size: 48px; margin-bottom: 8px;">📝</div>
          <p>暂无回复规则，点击上方按钮添加</p>
        </div>
      `;
      return;
    }

    currentConfig.keywords.forEach(function(keyword, index) {
      const item = document.createElement('div');
      item.className = 'keyword-item';
      item.innerHTML = `
        <input type="text" placeholder="触发关键字" value="${escapeHtml(keyword.trigger)}" data-index="${index}" data-field="trigger">
        <span style="color: #999;">→</span>
        <input type="text" placeholder="回复内容" value="${escapeHtml(keyword.reply)}" data-index="${index}" data-field="reply">
        <button class="btn btn-danger" onclick="removeKeyword(${index})">删除</button>
      `;
      elements.keywordList.appendChild(item);
    });

    // 绑定输入事件
    const inputs = elements.keywordList.querySelectorAll('input');
    inputs.forEach(function(input) {
      input.addEventListener('input', function(e) {
        const index = parseInt(e.target.dataset.index);
        const field = e.target.dataset.field;
        currentConfig.keywords[index][field] = e.target.value;
      });
    });
  }

  // 删除关键字
  window.removeKeyword = function(index) {
    currentConfig.keywords.splice(index, 1);
    renderKeywordList();
  };

  // 添加关键字
  elements.addKeywordBtn.addEventListener('click', function() {
    if (!currentConfig.keywords) {
      currentConfig.keywords = [];
    }
    currentConfig.keywords.push({ trigger: '', reply: '' });
    renderKeywordList();
    
    // 滚动到底部
    setTimeout(function() {
      elements.keywordList.scrollTop = elements.keywordList.scrollHeight;
    }, 100);
  });

  // 保存配置
  elements.saveBtn.addEventListener('click', function() {
    // 验证并清理空的关键字
    currentConfig.keywords = currentConfig.keywords.filter(function(k) {
      return k.trigger.trim() && k.reply.trim();
    });

    // 更新设置
    currentConfig.delay = parseInt(elements.delayInput.value) || 1000;
    currentConfig.cooldown = (parseInt(elements.cooldownInput.value) || 60) * 1000;

    // 保存到 storage
    chrome.runtime.sendMessage({
      type: 'UPDATE_AUTO_REPLY_CONFIG',
      config: currentConfig
    }, function(response) {
      if (response && response.success) {
        showStatus('✅ 设置已保存', true);
        
        // 通知 processors 配置已更新
        chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
          if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              type: 'AUTO_REPLY_CONFIG_UPDATED',
              config: currentConfig
            });
          }
        });
      } else {
        showStatus('❌ 保存失败', false);
      }
    });
  });

  // 显示状态栏
  function showStatus(message, isSuccess) {
    elements.statusText.textContent = message;
    elements.statusBar.style.display = 'block';
    elements.statusBar.style.background = isSuccess ? '#e6f7ff' : '#fff1f0';
    elements.statusBar.style.borderColor = isSuccess ? '#91d5ff' : '#ffa39e';
    elements.statusBar.style.color = isSuccess ? '#0050b3' : '#cf1322';

    setTimeout(function() {
      elements.statusBar.style.display = 'none';
    }, 3000);
  }

  // HTML 转义
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // 初始化
  loadConfig();

})();
