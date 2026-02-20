// options.js - 配置页面脚本 (v3.0 - 规则引擎)

document.addEventListener('DOMContentLoaded', function () {
  // ==================== DOM 引用 ====================
  var msgTableBody = document.getElementById('msgTableBody');
  var tableInfo = document.getElementById('tableInfo');
  var maxMessagesInput = document.getElementById('maxMessagesInput');

  // 全局配置
  var globalEnabledSwitch = document.getElementById('globalEnabledSwitch');
  var defaultCooldownInput = document.getElementById('defaultCooldownInput');
  var defaultDelayInput = document.getElementById('defaultDelayInput');

  // AI 配置
  var aiApiKeyInput = document.getElementById('aiApiKeyInput');
  var aiBaseUrlInput = document.getElementById('aiBaseUrlInput');
  var aiModelInput = document.getElementById('aiModelInput');
  var testAiResult = document.getElementById('testAiResult');
  
  // AI 暂停配置
  var aiPauseEnabledSwitch = document.getElementById('aiPauseEnabledSwitch');
  var aiPauseDurationInput = document.getElementById('aiPauseDurationInput');
  var aiPauseStatusDisplay = document.getElementById('aiPauseStatusDisplay');

  // 规则相关
  var ruleTableBody = document.getElementById('ruleTableBody');
  var ruleCount = document.getElementById('ruleCount');

  // 弹窗
  var ruleModal = document.getElementById('ruleModal');
  var ruleModalTitle = document.getElementById('ruleModalTitle');
  var ruleNameInput = document.getElementById('ruleNameInput');
  var ruleTypeSelect = document.getElementById('ruleTypeSelect');
  var rulePatternInput = document.getElementById('rulePatternInput');
  var ruleReplyInput = document.getElementById('ruleReplyInput');
  var rulePromptInput = document.getElementById('rulePromptInput');
  var ruleMaxHistoryInput = document.getElementById('ruleMaxHistoryInput');
  var ruleItemIdsInput = document.getElementById('ruleItemIdsInput');
  var rulePriorityInput = document.getElementById('rulePriorityInput');
  var ruleCooldownInput = document.getElementById('ruleCooldownInput');
  var ruleDelayInput = document.getElementById('ruleDelayInput');
  var regexPreview = document.getElementById('regexPreview');
  var keywordFields = document.getElementById('keywordFields');
  var aiFields = document.getElementById('aiFields');

  // 当前编辑的规则 ID（null 表示新增）
  var editingRuleId = null;

  // ==================== 导航切换 ====================
  var navItems = document.querySelectorAll('.nav-item');
  var panels = document.querySelectorAll('.panel');

  navItems.forEach(function (item) {
    item.addEventListener('click', function () {
      var panelId = item.dataset.panel;
      navItems.forEach(function (n) { n.classList.remove('active'); });
      item.classList.add('active');
      panels.forEach(function (p) { p.classList.remove('active'); });
      document.getElementById('panel-' + panelId).classList.add('active');

      if (panelId === 'auto-reply') {
        loadAutoReplyData();
      }
    });
  });

  // ==================== AI 配置折叠 ====================
  var aiConfigToggle = document.getElementById('aiConfigToggle');
  var aiConfigBody = document.getElementById('aiConfigBody');

  aiConfigToggle.addEventListener('click', function () {
    aiConfigToggle.classList.toggle('open');
    aiConfigBody.classList.toggle('show');
  });
  
  // ==================== AI 暂停配置折叠 ====================
  var aiPauseConfigToggle = document.getElementById('aiPauseConfigToggle');
  var aiPauseConfigBody = document.getElementById('aiPauseConfigBody');
  
  aiPauseConfigToggle.addEventListener('click', function () {
    aiPauseConfigToggle.classList.toggle('open');
    aiPauseConfigBody.classList.toggle('show');
  });
  
  // AI 暂停开关
  if (aiPauseEnabledSwitch) {
    aiPauseEnabledSwitch.addEventListener('click', function () {
      aiPauseEnabledSwitch.classList.toggle('on');
    });
  }

  // ==================== 全局开关 ====================
  globalEnabledSwitch.addEventListener('click', function () {
    globalEnabledSwitch.classList.toggle('on');
  });

  // ==================== 加载消息列表 ====================
  function loadMessages() {
    chrome.runtime.sendMessage({ type: 'GET_CHAT_MESSAGES', limit: 500 }, function (response) {
      if (chrome.runtime.lastError || !response) return;

      tableInfo.textContent = '共 ' + (response.total || 0) + ' 条消息';

      if (!response.messages || response.messages.length === 0) {
        msgTableBody.textContent = '';
        var tr = document.createElement('tr');
        var td = document.createElement('td');
        td.setAttribute('colspan', '5');
        td.style.cssText = 'text-align:center;color:#bbb;padding:40px;';
        td.textContent = '暂无消息';
        tr.appendChild(td);
        msgTableBody.appendChild(tr);
        return;
      }

      msgTableBody.textContent = '';
      response.messages.forEach(function (msg) {
        var tr = document.createElement('tr');

        var tdTime = document.createElement('td');
        tdTime.textContent = msg.timestamp || '';
        tdTime.style.whiteSpace = 'nowrap';

        var tdSender = document.createElement('td');
        tdSender.textContent = msg.senderName || msg.senderId || '';

        var tdContent = document.createElement('td');
        tdContent.textContent = msg.content || '';
        tdContent.title = msg.content || '';

        var tdItem = document.createElement('td');
        tdItem.textContent = msg.itemId || '';

        var tdSession = document.createElement('td');
        tdSession.textContent = msg.sessionId || '';
        tdSession.title = msg.sessionId || '';

        tr.appendChild(tdTime);
        tr.appendChild(tdSender);
        tr.appendChild(tdContent);
        tr.appendChild(tdItem);
        tr.appendChild(tdSession);
        msgTableBody.appendChild(tr);
      });
    });
  }

  // ==================== 加载配置 ====================
  function loadConfig() {
    chrome.runtime.sendMessage({ type: 'GET_CHAT_CONFIG' }, function (response) {
      if (response && response.success && response.config) {
        maxMessagesInput.value = response.config.maxStoredMessages || 1000;
      } else {
        maxMessagesInput.value = 1000;
      }
    });
  }

  // ==================== 加载自动回复数据 ====================
  function loadAutoReplyData() {
    chrome.runtime.sendMessage({ type: 'GET_AUTO_REPLY_RULES' }, function (response) {
      if (chrome.runtime.lastError || !response || !response.success) {
        console.error('加载规则失败:', response);
        return;
      }

      var config = response.globalConfig || {};
      var rules = response.rules || [];

      // 全局配置
      if (config.enabled) {
        globalEnabledSwitch.classList.add('on');
      } else {
        globalEnabledSwitch.classList.remove('on');
      }
      defaultCooldownInput.value = config.defaultCooldown || 60000;
      defaultDelayInput.value = config.defaultDelay || 1000;

      // AI 配置
      aiApiKeyInput.value = config.aiApiKey || '';
      aiBaseUrlInput.value = config.aiBaseUrl || 'https://api.openai.com/v1';
      aiModelInput.value = config.aiModel || 'gpt-4o-mini';
      
      // 加载 AI 暂停配置
      loadAiPauseConfig();

      // 规则列表
      renderRuleTable(rules);
    });
  }
  
  // ==================== 加载 AI 暂停配置 ====================
  function loadAiPauseConfig() {
    chrome.runtime.sendMessage({ type: 'GET_AI_PAUSE_CONFIG' }, function (response) {
      if (chrome.runtime.lastError || !response || !response.success) {
        console.warn('加载 AI 暂停配置失败:', response);
        return;
      }
      
      var config = response.config || {};
      
      if (config.enabled) {
        aiPauseEnabledSwitch.classList.add('on');
      } else {
        aiPauseEnabledSwitch.classList.remove('on');
      }
      aiPauseDurationInput.value = config.pauseDuration || 300000;
      
      // 刷新状态显示
      refreshAiPauseStatus();
    });
  }
  
  // ==================== 刷新 AI 暂停状态 ====================
  function refreshAiPauseStatus() {
    chrome.runtime.sendMessage({ type: 'GET_AI_PAUSE_STATUS' }, function (response) {
      if (chrome.runtime.lastError || !response || !response.success) {
        return;
      }
      
      var status = response.status || {};
      if (status.isPaused) {
        var remainingSeconds = status.remainingSeconds || 0;
        var minutes = Math.floor(remainingSeconds / 60);
        var seconds = remainingSeconds % 60;
        aiPauseStatusDisplay.textContent = '暂停中 (' + minutes + '分' + seconds + '秒)';
        aiPauseStatusDisplay.style.color = '#ff9800';
        aiPauseStatusDisplay.style.fontWeight = 'bold';
      } else {
        aiPauseStatusDisplay.textContent = '正常运行';
        aiPauseStatusDisplay.style.color = '#4caf50';
      }
    });
  }

  // ==================== 渲染规则表格 ====================
  function renderRuleTable(rules) {
    ruleCount.textContent = '共 ' + rules.length + ' 条规则';

    ruleTableBody.textContent = '';

    if (rules.length === 0) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.setAttribute('colspan', '7');
      td.style.cssText = 'text-align:center;color:#bbb;padding:40px;';
      td.textContent = '暂无规则，点击"添加规则"创建';
      tr.appendChild(td);
      ruleTableBody.appendChild(tr);
      return;
    }

    // 按优先级降序显示
    var sorted = rules.slice().sort(function (a, b) {
      return (b.priority || 0) - (a.priority || 0);
    });

    sorted.forEach(function (rule) {
      var tr = document.createElement('tr');

      // 名称
      var tdName = document.createElement('td');
      tdName.textContent = rule.name || '未命名';
      tdName.title = rule.name || '';

      // 类型
      var tdType = document.createElement('td');
      var badge = document.createElement('span');
      badge.className = 'rule-type-badge';
      if (rule.type === 'keyword') {
        badge.classList.add('badge-keyword');
        badge.textContent = '关键词';
      } else {
        badge.classList.add('badge-ai');
        badge.textContent = 'AI';
      }
      tdType.appendChild(badge);

      // 优先级
      var tdPriority = document.createElement('td');
      tdPriority.textContent = rule.priority || 0;

      // 匹配/提示词
      var tdMatch = document.createElement('td');
      if (rule.type === 'keyword') {
        tdMatch.textContent = '/' + (rule.pattern || '') + '/ → ' + (rule.reply || '').substring(0, 30);
      } else {
        tdMatch.textContent = (rule.prompt || '').substring(0, 50);
      }
      tdMatch.title = rule.type === 'keyword' ? (rule.pattern + ' → ' + rule.reply) : (rule.prompt || '');

      // 绑定商品
      var tdItems = document.createElement('td');
      if (rule.itemIds && rule.itemIds.length > 0) {
        tdItems.textContent = rule.itemIds.join(', ');
        tdItems.title = rule.itemIds.join(', ');
      } else {
        tdItems.textContent = '全部';
        tdItems.style.color = '#999';
      }

      // 状态
      var tdStatus = document.createElement('td');
      var statusSwitch = document.createElement('div');
      statusSwitch.className = 'switch' + (rule.enabled ? ' on' : '');
      statusSwitch.style.cssText = 'transform: scale(0.8); transform-origin: left center;';
      statusSwitch.addEventListener('click', (function (ruleId, sw) {
        return function () {
          sw.classList.toggle('on');
          toggleRuleEnabled(ruleId, sw.classList.contains('on'));
        };
      })(rule.id, statusSwitch));
      tdStatus.appendChild(statusSwitch);

      // 操作
      var tdActions = document.createElement('td');

      var editBtn = document.createElement('button');
      editBtn.className = 'btn btn-small';
      editBtn.textContent = '编辑';
      editBtn.addEventListener('click', (function (r) {
        return function () { openRuleModal(r); };
      })(rule));

      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-small btn-danger';
      deleteBtn.textContent = '删除';
      deleteBtn.addEventListener('click', (function (ruleId) {
        return function () { deleteRule(ruleId); };
      })(rule.id));

      tdActions.appendChild(editBtn);
      tdActions.appendChild(document.createTextNode(' '));
      tdActions.appendChild(deleteBtn);

      tr.appendChild(tdName);
      tr.appendChild(tdType);
      tr.appendChild(tdPriority);
      tr.appendChild(tdMatch);
      tr.appendChild(tdItems);
      tr.appendChild(tdStatus);
      tr.appendChild(tdActions);
      ruleTableBody.appendChild(tr);
    });
  }

  // ==================== 规则 CRUD ====================

  function toggleRuleEnabled(ruleId, enabled) {
    chrome.runtime.sendMessage({ type: 'GET_AUTO_REPLY_RULES' }, function (response) {
      if (!response || !response.success) return;
      var rules = response.rules || [];
      for (var i = 0; i < rules.length; i++) {
        if (rules[i].id === ruleId) {
          rules[i].enabled = enabled;
          chrome.runtime.sendMessage({
            type: 'SAVE_AUTO_REPLY_RULE',
            rule: rules[i]
          }, function (res) {
            if (res && res.success) {
              showToast(enabled ? '规则已启用' : '规则已禁用', 'success');
            }
          });
          break;
        }
      }
    });
  }

  function deleteRule(ruleId) {
    showConfirm('确定要删除这条规则吗？', { title: '删除规则' })
      .then(function (confirmed) {
        if (!confirmed) return;
        chrome.runtime.sendMessage({
          type: 'DELETE_AUTO_REPLY_RULE',
          ruleId: ruleId
        }, function (response) {
          if (response && response.success) {
            showToast('规则已删除', 'success');
            loadAutoReplyData();
          } else {
            showToast('删除失败: ' + (response && response.error || ''), 'error');
          }
        });
      });
  }

  // ==================== 规则弹窗 ====================

  function openRuleModal(rule) {
    if (rule) {
      // 编辑模式
      editingRuleId = rule.id;
      ruleModalTitle.textContent = '编辑规则';
      ruleNameInput.value = rule.name || '';
      ruleTypeSelect.value = rule.type || 'keyword';
      rulePatternInput.value = rule.pattern || '';
      ruleReplyInput.value = rule.reply || '';
      rulePromptInput.value = rule.prompt || '';
      ruleMaxHistoryInput.value = rule.maxHistoryMessages || 10;
      ruleItemIdsInput.value = (rule.itemIds || []).join(', ');
      rulePriorityInput.value = rule.priority || 10;
      ruleCooldownInput.value = rule.cooldown || 0;
      ruleDelayInput.value = rule.delay || 0;
    } else {
      // 新增模式
      editingRuleId = null;
      ruleModalTitle.textContent = '添加规则';
      ruleNameInput.value = '';
      ruleTypeSelect.value = 'keyword';
      rulePatternInput.value = '';
      ruleReplyInput.value = '';
      rulePromptInput.value = '';
      ruleMaxHistoryInput.value = 10;
      ruleItemIdsInput.value = '';
      rulePriorityInput.value = 10;
      ruleCooldownInput.value = 0;
      ruleDelayInput.value = 0;
    }

    updateTypeFields();
    validateRegex();
    ruleModal.classList.add('show');
  }

  function closeRuleModal() {
    ruleModal.classList.remove('show');
    editingRuleId = null;
  }

  function updateTypeFields() {
    var type = ruleTypeSelect.value;
    if (type === 'keyword') {
      keywordFields.classList.add('show');
      aiFields.classList.remove('show');
    } else {
      keywordFields.classList.remove('show');
      aiFields.classList.add('show');
    }
  }

  function validateRegex() {
    var pattern = rulePatternInput.value.trim();
    if (!pattern) {
      regexPreview.textContent = '输入正则表达式后实时校验';
      regexPreview.className = 'regex-preview';
      return true;
    }
    try {
      new RegExp(pattern, 'i');
      regexPreview.textContent = '✅ 正则语法有效: /' + pattern + '/i';
      regexPreview.className = 'regex-preview success';
      return true;
    } catch (e) {
      regexPreview.textContent = '❌ 语法错误: ' + e.message;
      regexPreview.className = 'regex-preview error';
      return false;
    }
  }

  function saveRule() {
    var name = ruleNameInput.value.trim();
    var type = ruleTypeSelect.value;

    if (!name) {
      showToast('请输入规则名称', 'error');
      return;
    }

    if (type === 'keyword') {
      if (!rulePatternInput.value.trim()) {
        showToast('请输入正则表达式', 'error');
        return;
      }
      if (!validateRegex()) {
        showToast('正则表达式语法错误', 'error');
        return;
      }
      if (!ruleReplyInput.value.trim()) {
        showToast('请输入回复内容', 'error');
        return;
      }
    }

    if (type === 'ai') {
      if (!rulePromptInput.value.trim()) {
        showToast('请输入提示词', 'error');
        return;
      }
    }

    // 解析商品 ID
    var itemIdsStr = ruleItemIdsInput.value.trim();
    var itemIds = [];
    if (itemIdsStr) {
      itemIds = itemIdsStr.split(/[,，\s]+/).filter(function (id) {
        return id.trim().length > 0;
      }).map(function (id) { return id.trim(); });
    }

    var rule = {
      name: name,
      type: type,
      priority: parseInt(rulePriorityInput.value) || 10,
      enabled: true,
      pattern: type === 'keyword' ? rulePatternInput.value.trim() : '',
      reply: type === 'keyword' ? ruleReplyInput.value.trim() : '',
      prompt: type === 'ai' ? rulePromptInput.value.trim() : '',
      maxHistoryMessages: type === 'ai' ? (parseInt(ruleMaxHistoryInput.value) || 10) : 0,
      itemIds: itemIds,
      cooldown: parseInt(ruleCooldownInput.value) || 0,
      delay: parseInt(ruleDelayInput.value) || 0
    };

    if (editingRuleId) {
      rule.id = editingRuleId;
    }

    chrome.runtime.sendMessage({
      type: 'SAVE_AUTO_REPLY_RULE',
      rule: rule
    }, function (response) {
      if (response && response.success) {
        showToast(editingRuleId ? '规则已更新' : '规则已添加', 'success');
        closeRuleModal();
        loadAutoReplyData();
      } else {
        showToast('保存失败: ' + (response && response.error || ''), 'error');
      }
    });
  }

  // ==================== 事件绑定 ====================

  // 规则弹窗
  document.getElementById('addRuleBtn').addEventListener('click', function () {
    openRuleModal(null);
  });

  document.getElementById('ruleModalClose').addEventListener('click', closeRuleModal);
  document.getElementById('ruleModalCancelBtn').addEventListener('click', closeRuleModal);
  document.getElementById('ruleModalSaveBtn').addEventListener('click', saveRule);

  ruleTypeSelect.addEventListener('change', updateTypeFields);
  rulePatternInput.addEventListener('input', validateRegex);

  // 点击遮罩关闭
  ruleModal.addEventListener('click', function (e) {
    if (e.target === ruleModal) closeRuleModal();
  });

  // ==================== 保存配置 ====================
  document.getElementById('saveBtn').addEventListener('click', function () {
    // 保存监听设置
    var maxMessages = parseInt(maxMessagesInput.value) || 1000;
    if (maxMessages < 100) maxMessages = 100;
    if (maxMessages > 10000) maxMessages = 10000;
    maxMessagesInput.value = maxMessages;

    chrome.runtime.sendMessage({
      type: 'UPDATE_CHAT_CONFIG',
      config: { maxStoredMessages: maxMessages }
    });

    // 保存自动回复全局配置
    var cooldown = parseInt(defaultCooldownInput.value) || 60000;
    var delay = parseInt(defaultDelayInput.value) || 1000;
    if (cooldown < 1000) cooldown = 1000;
    if (cooldown > 3600000) cooldown = 3600000;
    if (delay < 0) delay = 0;
    if (delay > 60000) delay = 60000;
    defaultCooldownInput.value = cooldown;
    defaultDelayInput.value = delay;

    var globalConfig = {
      enabled: globalEnabledSwitch.classList.contains('on'),
      defaultCooldown: cooldown,
      defaultDelay: delay,
      aiApiKey: aiApiKeyInput.value.trim(),
      aiBaseUrl: aiBaseUrlInput.value.trim() || 'https://api.openai.com/v1',
      aiModel: aiModelInput.value.trim() || 'gpt-4o-mini'
    };

    chrome.runtime.sendMessage({
      type: 'UPDATE_AUTO_REPLY_GLOBAL_CONFIG',
      config: globalConfig
    }, function (response) {
      if (response && response.success) {
        // 保存 AI 暂停配置
        var pauseEnabled = aiPauseEnabledSwitch ? aiPauseEnabledSwitch.classList.contains('on') : true;
        var pauseDuration = parseInt(aiPauseDurationInput.value) || 300000;
        if (pauseDuration < 60000) pauseDuration = 60000;
        if (pauseDuration > 3600000) pauseDuration = 3600000;
        aiPauseDurationInput.value = pauseDuration;

        chrome.runtime.sendMessage({
          type: 'UPDATE_AI_PAUSE_CONFIG',
          config: {
            enabled: pauseEnabled,
            pauseDuration: pauseDuration
          }
        }, function (pauseResponse) {
          if (pauseResponse && pauseResponse.success) {
            showToast('配置已保存', 'success');
            // 刷新状态显示
            refreshAiPauseStatus();
          } else {
            showToast('保存失败', 'error');
          }
        });
      } else {
        showToast('保存失败', 'error');
      }
    });
  });

  // ==================== AI 测试连接 ====================
  document.getElementById('testAiBtn').addEventListener('click', function () {
    var apiKey = aiApiKeyInput.value.trim();
    var baseUrl = aiBaseUrlInput.value.trim() || 'https://api.openai.com/v1';
    var model = aiModelInput.value.trim() || 'gpt-4o-mini';

    if (!apiKey) {
      showToast('请先输入 API Key', 'error');
      return;
    }

    testAiResult.textContent = '测试中...';
    testAiResult.style.color = '#666';

    chrome.runtime.sendMessage({
      type: 'AI_CHAT_COMPLETION',
      messages: [
        { role: 'system', content: 'Reply with exactly: OK' },
        { role: 'user', content: 'ping' }
      ],
      aiConfig: { aiApiKey: apiKey, aiBaseUrl: baseUrl, aiModel: model }
    }, function (response) {
      if (response && response.success) {
        testAiResult.textContent = '✅ 连接成功 (' + (response.model || model) + ')';
        testAiResult.style.color = '#28a745';
      } else {
        testAiResult.textContent = '❌ ' + (response && response.error || '未知错误');
        testAiResult.style.color = '#f44336';
      }
    });
  });
  
  // ==================== 刷新 AI 暂停状态 ====================
  if (document.getElementById('refreshAiPauseStatusBtn')) {
    document.getElementById('refreshAiPauseStatusBtn').addEventListener('click', function () {
      refreshAiPauseStatus();
      showToast('状态已刷新', 'success');
    });
  }

  // ==================== 刷新 ====================
  document.getElementById('refreshBtn').addEventListener('click', function () {
    loadMessages();
    showToast('已刷新', 'success');
  });

  // ==================== 导出CSV ====================
  document.getElementById('exportCsvBtn').addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'GET_CHAT_MESSAGES', limit: 10000 }, function (response) {
      if (!response || !response.messages || response.messages.length === 0) {
        showToast('没有数据可导出', 'error');
        return;
      }

      var header = '时间,发送人ID,发送人昵称,接收人ID,内容,内容类型,商品ID,会话ID,消息ID,方向\n';
      var rows = response.messages.map(function (msg) {
        return [
          '"' + (msg.timestamp || '').replace(/"/g, '""') + '"',
          '"' + (msg.senderId || '').replace(/"/g, '""') + '"',
          '"' + (msg.senderName || '').replace(/"/g, '""') + '"',
          '"' + (msg.receiverId || '').replace(/"/g, '""') + '"',
          '"' + (msg.content || '').replace(/"/g, '""') + '"',
          msg.contentType || '',
          '"' + (msg.itemId || '').replace(/"/g, '""') + '"',
          '"' + (msg.sessionId || '').replace(/"/g, '""') + '"',
          '"' + (msg.messageId || '').replace(/"/g, '""') + '"',
          msg.direction || ''
        ].join(',');
      }).join('\n');

      var csv = '\uFEFF' + header + rows;
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '闲鱼聊天消息_' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      URL.revokeObjectURL(url);
      showToast('CSV 导出成功', 'success');
    });
  });

  // ==================== 清空全部 ====================
  document.getElementById('clearAllBtn').addEventListener('click', async function () {
    var confirmed = await showConfirm('确定要清空所有聊天消息吗？此操作不可恢复。', { title: '清空全部消息' });
    if (confirmed) {
      chrome.runtime.sendMessage({ type: 'CLEAR_CHAT_MESSAGES' }, function (response) {
        if (response && response.success) {
          loadMessages();
          showToast('消息已清空', 'success');
        } else {
          showToast('清空失败', 'error');
        }
      });
    }
  });

  // ==================== Ctrl+S 快捷保存 ====================
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      document.getElementById('saveBtn').click();
    }
  });

  // ESC 关闭弹窗
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && ruleModal.classList.contains('show')) {
      closeRuleModal();
    }
  });

  // 初始化
  loadMessages();
  loadConfig();
});
