// popup.js - 聊天监听 Popup 页面
document.addEventListener('DOMContentLoaded', function () {
  var msgCountEl = document.getElementById('msgCount');
  var msgListEl = document.getElementById('msgList');
  var openConfigBtn = document.getElementById('openConfig');
  var clearDataBtn = document.getElementById('clearData');

  function loadMessages() {
    chrome.runtime.sendMessage({ type: 'GET_CHAT_MESSAGES', limit: 20 }, function(response) {
      if (chrome.runtime.lastError || !response) return;

      msgCountEl.textContent = response.total || 0;

      if (!response.messages || response.messages.length === 0) {
        msgListEl.innerHTML = '';
        var empty = document.createElement('div');
        empty.className = 'empty-msg';
        empty.textContent = '暂无聊天消息';
        msgListEl.appendChild(empty);
        return;
      }

      msgListEl.innerHTML = '';
      response.messages.forEach(function(msg) {
        var item = document.createElement('div');
        item.className = 'msg-item';

        var senderSpan = document.createElement('span');
        senderSpan.className = 'msg-sender';
        senderSpan.textContent = msg.senderName || msg.senderId || '未知';

        var contentSpan = document.createElement('span');
        contentSpan.className = 'msg-content';
        var contentText = msg.content || '';
        contentSpan.textContent = contentText.length > 60 ? contentText.substring(0, 60) + '...' : contentText;

        var timeDiv = document.createElement('div');
        timeDiv.className = 'msg-time';
        var parts = [];
        if (msg.timestamp) parts.push(msg.timestamp);
        if (msg.itemId) parts.push('商品:' + msg.itemId);
        timeDiv.textContent = parts.join(' | ');

        item.appendChild(senderSpan);
        item.appendChild(contentSpan);
        item.appendChild(timeDiv);
        msgListEl.appendChild(item);
      });
    });
  }

  loadMessages();
  setInterval(loadMessages, 2000);

  openConfigBtn.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  clearDataBtn.addEventListener('click', async function () {
    var confirmed = await showConfirm('确定要清空所有聊天消息吗？', { title: '清空消息' });
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
});
