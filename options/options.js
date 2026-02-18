// options.js - 配置页面脚本

document.addEventListener('DOMContentLoaded', function () {
  var msgTableBody = document.getElementById('msgTableBody');
  var tableInfo = document.getElementById('tableInfo');
  var maxMessagesInput = document.getElementById('maxMessagesInput');
  
  // 自动回复相关元素
  var autoReplyEnabledCheckbox = document.getElementById('autoReplyEnabled');
  var cooldownInput = document.getElementById('cooldownInput');
  var delayInput = document.getElementById('delayInput');
  var keywordTableBody = document.getElementById('keywordTableBody');
  var keywordCount = document.getElementById('keywordCount');

  // ==================== 导航切换 ====================
  var navItems = document.querySelectorAll('.nav-item');
  var panels = document.querySelectorAll('.panel');

  navItems.forEach(function(item) {
    item.addEventListener('click', function() {
      var panelId = item.dataset.panel;
      navItems.forEach(function(n) { n.classList.remove('active'); });
      item.classList.add('active');
      panels.forEach(function(p) { p.classList.remove('active'); });
      document.getElementById('panel-' + panelId).classList.add('active');
      
      // 切换到自动回复面板时加载关键字列表
      if (panelId === 'auto-reply') {
        loadAutoReplyConfig();
      }
    });
  });

  // ==================== 加载消息列表 ====================
  function loadMessages() {
    chrome.runtime.sendMessage({ type: 'GET_CHAT_MESSAGES', limit: 500 }, function(response) {
      if (chrome.runtime.lastError || !response) return;

      tableInfo.textContent = '共 ' + (response.total || 0) + ' 条消息';

      if (!response.messages || response.messages.length === 0) {
        msgTableBody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#bbb;padding:40px;">暂无消息</td></tr>';
        return;
      }

      msgTableBody.innerHTML = '';
      response.messages.forEach(function(msg) {
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
    chrome.runtime.sendMessage({ type: 'GET_CHAT_CONFIG' }, function(response) {
      if (response && response.success && response.config) {
        maxMessagesInput.value = response.config.maxStoredMessages || 1000;
      } else {
        maxMessagesInput.value = 1000;
      }
    });
  }

  // ==================== 加载自动回复配置 ====================
  function loadAutoReplyConfig() {
    chrome.runtime.sendMessage({ type: 'GET_AUTO_REPLY_CONFIG' }, function(response) {
      if (response && response.success && response.config) {
        var config = response.config;
        
        // 加载基本设置
        autoReplyEnabledCheckbox.checked = config.enabled !== false;
        cooldownInput.value = config.cooldown || 5000;
        delayInput.value = config.delay || 1000;
        
        // 加载关键字列表
        renderKeywordTable(config.keywords || []);
      } else {
        // 使用默认值
        autoReplyEnabledCheckbox.checked = false;
        cooldownInput.value = 5000;
        delayInput.value = 1000;
        renderKeywordTable([]);
      }
    });
  }
  
  // ==================== 渲染关键字表格 ====================
  function renderKeywordTable(keywords) {
    keywordCount.textContent = '共 ' + keywords.length + ' 条规则';
    
    if (keywords.length === 0) {
      keywordTableBody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#bbb;padding:40px;">暂无规则</td></tr>';
      return;
    }
    
    keywordTableBody.innerHTML = '';
    keywords.forEach(function(keyword, index) {
      var tr = document.createElement('tr');
      
      var tdTrigger = document.createElement('td');
      tdTrigger.textContent = keyword.trigger || '';
      tdTrigger.title = keyword.trigger || '';
      
      var tdReply = document.createElement('td');
      tdReply.textContent = keyword.reply || '';
      tdReply.title = keyword.reply || '';
      
      var tdActions = document.createElement('td');
      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-danger';
      deleteBtn.style.padding = '4px 12px';
      deleteBtn.style.fontSize = '12px';
      deleteBtn.textContent = '删除';
      deleteBtn.addEventListener('click', function() {
        deleteKeyword(index);
      });
      
      tdActions.appendChild(deleteBtn);
      
      tr.appendChild(tdTrigger);
      tr.appendChild(tdReply);
      tr.appendChild(tdActions);
      keywordTableBody.appendChild(tr);
    });
  }
  
  // ==================== 添加关键字 ====================
  function addKeyword() {
    var trigger = prompt('请输入触发关键字：');
    if (!trigger) return;
    
    var reply = prompt('请输入回复内容：');
    if (!reply) return;
    
    chrome.runtime.sendMessage({ 
      type: 'ADD_AUTO_REPLY_KEYWORD',
      keyword: { trigger: trigger.trim(), reply: reply.trim() }
    }, function(response) {
      if (response && response.success) {
        showToast('规则已添加', 'success');
        loadAutoReplyConfig();
      } else {
        showToast('添加失败', 'error');
      }
    });
  }
  
  // ==================== 删除关键字 ====================
  function deleteKeyword(index) {
    showConfirm('确定要删除这条规则吗？', { title: '删除规则' })
      .then(function(confirmed) {
        if (!confirmed) return;
        
        chrome.runtime.sendMessage({ 
          type: 'DELETE_AUTO_REPLY_KEYWORD',
          index: index
        }, function(response) {
          if (response && response.success) {
            showToast('规则已删除', 'success');
            loadAutoReplyConfig();
          } else {
            showToast('删除失败', 'error');
          }
        });
      });
  }

  // ==================== 保存配置 ====================
  document.getElementById('saveBtn').addEventListener('click', function() {
    var maxMessages = parseInt(maxMessagesInput.value) || 1000;
    if (maxMessages < 100) maxMessages = 100;
    if (maxMessages > 10000) maxMessages = 10000;
    maxMessagesInput.value = maxMessages;

    chrome.runtime.sendMessage({
      type: 'UPDATE_CHAT_CONFIG',
      config: { maxStoredMessages: maxMessages }
    }, function(response) {
      if (response && response.success) {
        showToast('配置已保存', 'success');
      } else {
        showToast('保存失败', 'error');
      }
    });
  });

  // ==================== 刷新 ====================
  document.getElementById('refreshBtn').addEventListener('click', function() {
    loadMessages();
    showToast('已刷新', 'success');
  });

  // ==================== 导出CSV ====================
  document.getElementById('exportCsvBtn').addEventListener('click', function() {
    chrome.runtime.sendMessage({ type: 'GET_CHAT_MESSAGES', limit: 10000 }, function(response) {
      if (!response || !response.messages || response.messages.length === 0) {
        showToast('没有数据可导出', 'error');
        return;
      }

      var header = '时间,发送人ID,发送人昵称,接收人ID,内容,内容类型,商品ID,会话ID,消息ID,方向\n';
      var rows = response.messages.map(function(msg) {
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
  document.getElementById('clearAllBtn').addEventListener('click', async function() {
    var confirmed = await showConfirm('确定要清空所有聊天消息吗？此操作不可恢复。', { title: '清空全部消息' });
    if (confirmed) {
      chrome.runtime.sendMessage({ type: 'CLEAR_CHAT_MESSAGES' }, function(response) {
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
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      document.getElementById('saveBtn').click();
    }
  });

  // 初始化
  loadMessages();
  loadConfig();
});
