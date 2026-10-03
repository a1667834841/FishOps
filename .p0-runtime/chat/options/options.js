// options.js - 配置页面脚本 (v3.0 - 规则引擎)

document.addEventListener('DOMContentLoaded', function () {
  // ==================== DOM 引用 ====================
  // 消息列表相关 DOM 已移除，仅保留同步和导出功能

  // 同步
  var syncBtn = document.getElementById('syncBtn');
  var syncCountSelect = document.getElementById('syncCountSelect');
  var syncStatusEl = document.getElementById('syncStatus');

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

  // 闲管家配置
  var xgjAppIdInput = document.getElementById('xgjAppIdInput');
  var xgjAppKeyInput = document.getElementById('xgjAppKeyInput');
  var xgjAppSecretInput = document.getElementById('xgjAppSecretInput');
  var testXgjResult = document.getElementById('testXgjResult');
  var shopTableBody = document.getElementById('shopTableBody');
  var shopCount = document.getElementById('shopCount');

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

  // 商品选择器
  var goodsSelector = document.getElementById('goodsSelector');
  var goodsSelectedTags = document.getElementById('goodsSelectedTags');
  var goodsSearchInput = document.getElementById('goodsSearchInput');
  var goodsDropdown = document.getElementById('goodsDropdown');

  // 商品列表缓存和状态
  var goodsListCache = [];
  var goodsCurrentPage = 1;
  var goodsHasMore = true;
  var goodsIsLoading = false;
  var selectedItemIds = [];

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
      if (panelId === 'xiangguanjia') {
        loadXiangguanjiaData();
      }
      if (panelId === 'products') {
        loadProductList(1);
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

  // ==================== 闲管家配置折叠 ====================
  var xgjConfigToggle = document.getElementById('xgjConfigToggle');
  var xgjConfigBody = document.getElementById('xgjConfigBody');

  if (xgjConfigToggle) {
    xgjConfigToggle.addEventListener('click', function () {
      xgjConfigToggle.classList.toggle('open');
      xgjConfigBody.classList.toggle('show');
    });
  }

  // ==================== 全局开关 ====================
  globalEnabledSwitch.addEventListener('click', function () {
    globalEnabledSwitch.classList.toggle('on');
  });

  // ==================== 加载配置 ====================
  // maxMessages 配置已不再使用

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

  // ==================== 加载闲管家配置 ====================
  function loadXiangguanjiaData() {
    chrome.runtime.sendMessage({ type: 'GET_AUTO_REPLY_GLOBAL_CONFIG' }, function (response) {
      if (chrome.runtime.lastError || !response || !response.success) {
        console.error('加载闲管家配置失败:', response);
        return;
      }

      var config = response.config || {};
      xgjAppIdInput.value = config.xgjAppId || '';
      xgjAppKeyInput.value = config.xgjAppKey || '';
      xgjAppSecretInput.value = config.xgjAppSecret || '';
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

  // ==================== 商品选择器 ====================

  /**
   * 加载商品列表
   */
  function loadGoodsList(pageNumber, append = false) {
    if (goodsIsLoading) return;
    if (!append && pageNumber === 1) {
      goodsListCache = [];
      goodsCurrentPage = 1;
    }

    goodsIsLoading = true;

    // 显示加载状态
    if (!append) {
      goodsDropdown.innerHTML = '<div class="goods-dropdown-loading">加载中...</div>';
    }

    // 通过 background 获取商品列表
    chrome.runtime.sendMessage({
      type: 'FETCH_GOODS_LIST',
      pageNumber: pageNumber,
      pageSize: 20
    }, function (result) {
      goodsIsLoading = false;

      if (chrome.runtime.lastError) {
        console.error('加载商品列表失败:', chrome.runtime.lastError);
        goodsDropdown.innerHTML = '<div class="goods-dropdown-empty">加载失败，请重试</div>';
        return;
      }

      if (result && result.success) {
        if (append) {
          goodsListCache = goodsListCache.concat(result.goodsList);
        } else {
          goodsListCache = result.goodsList;
        }
        goodsHasMore = result.hasMore;
        goodsCurrentPage = pageNumber;
        renderGoodsDropdown(goodsListCache);
      } else {
        console.error('加载商品列表失败:', result ? result.error : '未知错误');
        goodsDropdown.innerHTML = '<div class="goods-dropdown-empty">' + (result && result.error ? result.error : '加载失败') + '</div>';
      }
    });
  }

  /**
   * 渲染下拉列表选项
   */
  function renderGoodsDropdown(goodsList) {
    if (!goodsList || goodsList.length === 0) {
      goodsDropdown.innerHTML = '<div class="goods-dropdown-empty">暂无商品</div>';
      return;
    }

    var html = '';
    goodsList.forEach(function (goods) {
      var isSelected = selectedItemIds.indexOf(goods.itemId) !== -1;
      var selectedClass = isSelected ? ' selected' : '';
      var priceText = goods.price ? '¥' + goods.price : '';
      var imgSrc = goods.picUrl || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="40" height="40"%3E%3Crect fill="%23f5f5f5" width="40" height="40"/%3E%3C/svg%3E';

      html += '<div class="goods-option' + selectedClass + '" data-item-id="' + goods.itemId + '">' +
        '<img class="goods-option-img" src="' + imgSrc + '" alt="" onerror="this.src=\'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2240%22%3E%3Crect fill=%22%23f5f5f5%22 width=%2240%22 height=%2240%22/%3E%3C/svg%3E\'" />' +
        '<div class="goods-option-info">' +
        '<div class="goods-option-title">' + (goods.title || '未命名商品') + '</div>' +
        '<div class="goods-option-price">' + priceText + '</div>' +
        '</div>' +
        '<div class="goods-option-check">✓</div>' +
        '</div>';
    });

    if (goodsHasMore) {
      html += '<div class="goods-dropdown-loading" id="loadMoreGoods">滚动加载更多...</div>';
    }

    goodsDropdown.innerHTML = html;

    // 绑定选项点击事件
    var options = goodsDropdown.querySelectorAll('.goods-option');
    options.forEach(function (option) {
      option.addEventListener('click', function () {
        var itemId = this.getAttribute('data-item-id');
        toggleGoodsSelection(itemId);
      });
    });
  }

  /**
   * 渲染已选商品标签
   */
  function renderSelectedTags() {
    goodsSelectedTags.innerHTML = '';

    if (selectedItemIds.length === 0) return;

    selectedItemIds.forEach(function (itemId) {
      // 从缓存中查找商品信息
      var goods = goodsListCache.find(function (g) { return g.itemId === itemId; });
      var title = goods ? goods.title : itemId;
      var displayTitle = title.length > 10 ? title.substring(0, 10) + '...' : title;
      var imgSrc = goods && goods.picUrl ? goods.picUrl : 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24"%3E%3Crect fill="%23f5f5f5" width="24" height="24"/%3E%3C/svg%3E';

      var tag = document.createElement('div');
      tag.className = 'goods-tag';
      tag.innerHTML = '<img class="goods-tag-img" src="' + imgSrc + '" alt="" onerror="this.src=\'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22%3E%3Crect fill=%22%23f5f5f5%22 width=%2224%22 height=%2224%22/%3E%3C/svg%3E\'" />' +
        '<span class="goods-tag-text" title="' + title + '">' + displayTitle + '</span>' +
        '<span class="goods-tag-remove" data-item-id="' + itemId + '">×</span>';

      var removeBtn = tag.querySelector('.goods-tag-remove');
      removeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = this.getAttribute('data-item-id');
        removeGoodsSelection(id);
      });

      goodsSelectedTags.appendChild(tag);
    });
  }

  /**
   * 切换商品选中状态
   */
  function toggleGoodsSelection(itemId) {
    var index = selectedItemIds.indexOf(itemId);
    if (index === -1) {
      selectedItemIds.push(itemId);
    } else {
      selectedItemIds.splice(index, 1);
    }
    renderGoodsDropdown(goodsListCache);
    renderSelectedTags();
  }

  /**
   * 移除商品选中
   */
  function removeGoodsSelection(itemId) {
    var index = selectedItemIds.indexOf(itemId);
    if (index !== -1) {
      selectedItemIds.splice(index, 1);
    }
    renderGoodsDropdown(goodsListCache);
    renderSelectedTags();
  }

  /**
   * 根据关键字过滤商品
   */
  function filterGoods(keyword) {
    if (!keyword || keyword.trim() === '') {
      renderGoodsDropdown(goodsListCache);
      return;
    }

    keyword = keyword.toLowerCase().trim();
    var filtered = goodsListCache.filter(function (goods) {
      return (goods.title && goods.title.toLowerCase().indexOf(keyword) !== -1) ||
        (goods.itemId && goods.itemId.indexOf(keyword) !== -1);
    });

    renderGoodsDropdown(filtered);
  }

  /**
   * 初始化商品选择器
   */
  function initGoodsSelector(itemIds = []) {
    selectedItemIds = itemIds.slice();
    goodsCurrentPage = 1;
    goodsHasMore = true;
    renderSelectedTags();
    loadGoodsList(1);
  }

  /**
   * 重置商品选择器
   */
  function resetGoodsSelector() {
    selectedItemIds = [];
    goodsCurrentPage = 1;
    goodsHasMore = true;
    goodsSearchInput.value = '';
    goodsDropdown.classList.remove('show');
    goodsSelectedTags.innerHTML = '';
  }

  // 商品选择器事件绑定
  if (goodsSearchInput) {
    // 搜索框聚焦时显示下拉列表
    goodsSearchInput.addEventListener('focus', function () {
      goodsDropdown.classList.add('show');
      if (goodsListCache.length === 0) {
        loadGoodsList(1);
      }
    });

    // 搜索框输入时过滤
    var searchTimeout = null;
    goodsSearchInput.addEventListener('input', function () {
      if (searchTimeout) clearTimeout(searchTimeout);
      var keyword = this.value;
      searchTimeout = setTimeout(function () {
        filterGoods(keyword);
      }, 300);
    });

    // 滚动加载更多
    goodsDropdown.addEventListener('scroll', function () {
      if (goodsDropdown.scrollTop + goodsDropdown.clientHeight >= goodsDropdown.scrollHeight - 20) {
        if (goodsHasMore && !goodsIsLoading) {
          loadGoodsList(goodsCurrentPage + 1, true);
        }
      }
    });
  }

  // 点击外部关闭下拉列表
  document.addEventListener('click', function (e) {
    if (goodsSelector && !goodsSelector.contains(e.target)) {
      goodsDropdown.classList.remove('show');
    }
  });

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
      rulePriorityInput.value = rule.priority || 10;
      ruleCooldownInput.value = rule.cooldown || 0;
      ruleDelayInput.value = rule.delay || 0;
      // 初始化商品选择器（回显已选中的商品）
      initGoodsSelector(rule.itemIds || []);
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
      rulePriorityInput.value = 10;
      ruleCooldownInput.value = 0;
      ruleDelayInput.value = 0;
      // 重置商品选择器
      resetGoodsSelector();
    }

    updateTypeFields();
    validateRegex();
    ruleModal.classList.add('show');
  }

  function closeRuleModal() {
    ruleModal.classList.remove('show');
    editingRuleId = null;
    // 重置商品选择器
    resetGoodsSelector();
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

    // 从商品选择器获取选中的商品ID
    var itemIds = selectedItemIds.slice();

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
      aiModel: aiModelInput.value.trim() || 'gpt-4o-mini',
      xgjAppId: xgjAppIdInput ? xgjAppIdInput.value.trim() : '',
      xgjAppKey: xgjAppKeyInput ? xgjAppKeyInput.value.trim() : '',
      xgjAppSecret: xgjAppSecretInput ? xgjAppSecretInput.value.trim() : ''
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

    // 测试多模态能力 - 发送一张图片让AI描述（图片在前，文字在后）
    var testImageUrl = 'https://emoji.cdn.bcebos.com/yige-aigc/index_aigc/final/toolspics/0.png';

    chrome.runtime.sendMessage({
      type: 'AI_CHAT_COMPLETION',
      messages: [
        { role: 'system', content: '你是一个能看懂图片的AI助手，请描述用户发送的图片内容。用中文回答。' },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: testImageUrl } },
          { type: 'text', text: '请描述这张图片' }
        ]}
      ],
      aiConfig: { aiApiKey: apiKey, aiBaseUrl: baseUrl, aiModel: model }
    }, function (response) {
      if (response && response.success) {
        testAiResult.textContent = '✅ 多模态连接成功 (' + (response.model || model) + ')';
        testAiResult.style.color = '#28a745';
        // 显示图片分析结果
        var desc = response.content || '';
        if (desc.length > 50) {
          desc = desc.substring(0, 50) + '...';
        }
        showToast('图片分析: ' + desc, 'success');
      } else {
        testAiResult.textContent = '❌ ' + (response && response.error || '未知错误');
        testAiResult.style.color = '#f44336';
      }
    });
  });

  // ==================== 闲管家测试连接 ====================
  if (document.getElementById('testXgjBtn')) {
    document.getElementById('testXgjBtn').addEventListener('click', function () {
      var appKey = xgjAppKeyInput.value.trim();
      var appSecret = xgjAppSecretInput.value.trim();

      if (!appKey || !appSecret) {
        showToast('请先输入 App Key 和 App Secret', 'error');
        return;
      }

      testXgjResult.textContent = '测试中...';
      testXgjResult.style.color = '#666';

      // 先保存配置，再测试
      saveXiangguanjiaConfig(function () {
        chrome.runtime.sendMessage({
          type: 'TEST_XIANGGUANJIA_CONNECTION'
        }, function (response) {
          if (response && response.success) {
            testXgjResult.textContent = '✅ ' + response.message;
            testXgjResult.style.color = '#28a745';
          } else {
            testXgjResult.textContent = '❌ ' + (response && response.error || '连接失败');
            testXgjResult.style.color = '#f44336';
          }
        });
      });
    });
  }

  // ==================== 查询闲鱼店铺 ====================
  if (document.getElementById('queryShopsBtn')) {
    document.getElementById('queryShopsBtn').addEventListener('click', function () {
      var appKey = xgjAppKeyInput.value.trim();
      var appSecret = xgjAppSecretInput.value.trim();

      if (!appKey || !appSecret) {
        showToast('请先配置 App Key 和 App Secret', 'error');
        return;
      }

      var queryBtn = document.getElementById('queryShopsBtn');
      queryBtn.disabled = true;
      queryBtn.textContent = '查询中...';

      // 先保存配置，再查询
      saveXiangguanjiaConfig(function () {
        chrome.runtime.sendMessage({
          type: 'QUERY_XIANGYU_SHOPS'
        }, function (response) {
          queryBtn.disabled = false;
          queryBtn.textContent = '查询店铺';

          if (response && response.success) {
            var shops = response.shops || [];
            shopCount.textContent = '共 ' + shops.length + ' 个店铺';
            renderShopTable(shops);
            showToast('查询成功，共 ' + shops.length + ' 个店铺', 'success');
          } else {
            shopCount.textContent = '共 0 个店铺';
            renderShopTable([]);
            showToast('查询失败: ' + (response && response.error || '未知错误'), 'error');
          }
        });
      });
    });
  }

  // ==================== 保存闲管家配置（内部函数） ====================
  function saveXiangguanjiaConfig(callback) {
    chrome.runtime.sendMessage({
      type: 'GET_AUTO_REPLY_GLOBAL_CONFIG'
    }, function (response) {
      if (!response || !response.success) {
        if (callback) callback();
        return;
      }

      var currentConfig = response.config || {};
      currentConfig.xgjAppId = xgjAppIdInput.value.trim();
      currentConfig.xgjAppKey = xgjAppKeyInput.value.trim();
      currentConfig.xgjAppSecret = xgjAppSecretInput.value.trim();

      chrome.runtime.sendMessage({
        type: 'UPDATE_AUTO_REPLY_GLOBAL_CONFIG',
        config: currentConfig
      }, function () {
        if (callback) callback();
      });
    });
  }

  // ==================== 渲染店铺表格 ====================
  function renderShopTable(shops) {
    shopTableBody.textContent = '';
  
    if (!shops || shops.length === 0) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.setAttribute('colspan', '6');
      td.style.cssText = 'text-align:center;color:#bbb;padding:40px;';
      td.textContent = '暂无店铺数据';
      tr.appendChild(td);
      shopTableBody.appendChild(tr);
      return;
    }
  
    shops.forEach(function (shop) {
      var tr = document.createElement('tr');
  
      // 用户 ID (user_identity)
      var tdId = document.createElement('td');
      tdId.textContent = shop.user_identity || shop.user_id || '-';
      tdId.title = shop.user_identity || shop.user_id || '';
  
      // 店铺名称 (shop_name)
      var tdName = document.createElement('td');
      tdName.textContent = shop.shop_name || '-';
      tdName.title = shop.shop_name || '';
  
      // 用户昵称 (user_nick)
      var tdNickname = document.createElement('td');
      tdNickname.textContent = shop.user_nick || '-';
      tdNickname.title = shop.user_nick || '';
  
      // 用户名 (user_name)
      var tdRealName = document.createElement('td');
      tdRealName.textContent = shop.user_name || '-';
      tdRealName.title = shop.user_name || '';
  
      // 订购状态
      var tdValid = document.createElement('td');
      var isValid = shop.is_valid === true;
      tdValid.textContent = isValid ? '有效' : '无效';
      tdValid.style.color = isValid ? '#28a745' : '#999';
  
      // 准入业务类型 (item_biz_types)
      var tdTypes = document.createElement('td');
      var types = shop.item_biz_types || '';
      if (types) {
        // 类型映射：2=闲置，10=全新，19=虚拟
        var typeMap = { '2': '闲置', '10': '全新', '19': '虚拟' };
        var typeLabels = types.split(',').map(function (t) {
          return typeMap[t.trim()] || t;
        }).join(', ');
        tdTypes.textContent = typeLabels;
        tdTypes.title = types;
      } else {
        tdTypes.textContent = '-';
        tdTypes.style.color = '#999';
      }
  
      tr.appendChild(tdId);
      tr.appendChild(tdName);
      tr.appendChild(tdNickname);
      tr.appendChild(tdRealName);
      tr.appendChild(tdValid);
      tr.appendChild(tdTypes);
      shopTableBody.appendChild(tr);
    });
    
    console.log('[店铺查询] 店铺列表已更新，共', shops.length, '个店铺');
    
    // 同时更新订单查询的店铺选择框
    updateOrderShopSelect(shops);
  }

  // ==================== 刷新 AI 暂停状态 ====================
  if (document.getElementById('refreshAiPauseStatusBtn')) {
    document.getElementById('refreshAiPauseStatusBtn').addEventListener('click', function () {
      refreshAiPauseStatus();
      showToast('状态已刷新', 'success');
    });
  }

  // ==================== 刷新 ====================
  // 刷新功能已移除，无需刷新列表
  
  // ==================== 同步消息 ====================
  syncBtn.addEventListener('click', function () {
    var count = parseInt(syncCountSelect.value) || 50;
    var messageCount = 20; // 每个会话默认获取20条消息
    syncBtn.disabled = true;
    syncBtn.textContent = '同步中...';
    syncStatusEl.textContent = '正在获取 ' + count + ' 个会话列表...';
  
    chrome.runtime.sendMessage({
      type: 'SYNC_CHAT_HISTORY',
      conversationCount: count,
      messageCount: messageCount
    }, function (response) {
      syncBtn.disabled = false;
      syncBtn.textContent = '🔄 同步消息';
  
      if (response && response.success) {
        var s = response.stats || {};
        syncStatusEl.textContent = '✅ 同步完成！获取 ' + (s.syncedConversations || 0) + ' 个会话，共 ' + (s.totalMessages || 0) + ' 条消息（每会话 ' + messageCount + ' 条）';
        syncStatusEl.style.color = '#28a745';
      } else {
        syncStatusEl.textContent = '❌ ' + (response && response.error || '同步失败');
        syncStatusEl.style.color = '#f44336';
      }
  
      // 5 秒后清除状态文字
      setTimeout(function () {
        syncStatusEl.textContent = '';
        syncStatusEl.style.color = '#1a73e8';
      }, 5000);
    });
  });
  
  // ==================== 分页 ====================
  // 分页功能已移除

  // ==================== 导出CSV（实时获取） ====================
  document.getElementById('exportCsvBtn').addEventListener('click', function () {
    var count = parseInt(syncCountSelect.value) || 50;
    var messageCount = 20;
    
    showToast('正在实时获取消息...', 'info');
    
    // 直接调用同步接口获取消息
    chrome.runtime.sendMessage({
      type: 'SYNC_CHAT_HISTORY',
      conversationCount: count,
      messageCount: messageCount
    }, function (response) {
      if (!response || !response.success || !response.stats || !response.stats.allMessages) {
        showToast('获取消息失败', 'error');
        return;
      }
      
      var messages = response.stats.allMessages;
      
      if (messages.length === 0) {
        showToast('没有数据可导出', 'error');
        return;
      }

      var header = '时间,发送人,接收人,会话ID,商品名称,商品ID,内容,方向\n';
      var rows = messages.map(function (msg) {
        return [
          '"' + (msg.timestamp || '').replace(/"/g, '""') + '"',
          '"' + (msg.senderName || msg.senderId || '').replace(/"/g, '""') + '"',
          '"' + (msg.receiverName || msg.receiverId || '').replace(/"/g, '""') + '"',
          '"' + (msg.chatId || msg.cid || '').replace(/"/g, '""') + '"',
          '"' + (msg.itemTitle || '').replace(/"/g, '""') + '"',
          '"' + (msg.itemId || '').replace(/"/g, '""') + '"',
          '"' + (msg.content || '').replace(/"/g, '""') + '"',
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
      showToast('CSV 导出成功（共 ' + messages.length + ' 条）', 'success');
    });
  });

  // ==================== 导出TXT（实时获取） ====================
  document.getElementById('exportTxtBtn').addEventListener('click', function () {
    var count = parseInt(syncCountSelect.value) || 50;
    var messageCount = 20;
    
    showToast('正在实时获取消息...', 'info');
    
    // 直接调用同步接口获取消息
    chrome.runtime.sendMessage({
      type: 'SYNC_CHAT_HISTORY',
      conversationCount: count,
      messageCount: messageCount
    }, function (response) {
      if (!response || !response.success || !response.stats || !response.stats.allMessages) {
        showToast('获取消息失败', 'error');
        return;
      }
      
      var messages = response.stats.allMessages;
      
      if (messages.length === 0) {
        showToast('没有数据可导出', 'error');
        return;
      }

      var lines = messages.map(function (msg) {
        var sender = msg.senderName || msg.senderId || '未知';
        var receiver = msg.receiverName || msg.receiverId || '未知';
        var sessionId = msg.chatId || msg.cid || '';
        var itemName = msg.itemTitle || msg.itemId || '';
        var content = (msg.content || '').replace(/\n/g, ' ');
        return '[' + (msg.timestamp || '') + '] '
          + sender + ' → ' + receiver
          + ' | 会话:' + sessionId
          + ' | 商品:' + itemName
          + ' | ' + content;
      }).join('\n');

      var blob = new Blob([lines], { type: 'text/plain;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '闲鱼聊天消息_' + new Date().toISOString().slice(0, 10) + '.txt';
      a.click();
      URL.revokeObjectURL(url);
      showToast('TXT 导出成功（共 ' + messages.length + ' 条）', 'success');
    });
  });

  // ==================== 清空全部 ====================
  // 清空功能已移除，无消息存储

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

  // ==================== 订单列表查询功能 ====================
  
  // 订单查询相关 DOM
  var orderShopSelect = document.getElementById('orderShopSelect');
  var orderStatusSelect = document.getElementById('orderStatusSelect');
  var refundStatusSelect = document.getElementById('refundStatusSelect');
  var queryOrdersBtn = document.getElementById('queryOrdersBtn');
  var orderQueryStatus = document.getElementById('orderQueryStatus');
  var orderTableBody = document.getElementById('orderTableBody');
  var prevPageBtn = document.getElementById('prevPageBtn');
  var nextPageBtn = document.getElementById('nextPageBtn');
  var pageInfo = document.getElementById('pageInfo');
  
  // 订单查询状态
  var orderCurrentPage = 1;
  var orderPageSize = 50;
  var orderTotalCount = 0;
  var currentSelectedShopId = '';
  var currentOrderStatus = 0;
  var currentRefundStatus = -1;
  
  /**
   * 更新店铺选择下拉框（用于订单查询）
   */
  function updateOrderShopSelect(shops) {
    if (!orderShopSelect) {
      console.warn('[订单查询] orderShopSelect 元素不存在');
      return;
    }
    
    // 清空现有选项（保留“请选择”）
    orderShopSelect.innerHTML = '<option value="">请选择店铺</option>';
    
    if (!shops || shops.length === 0) {
      return;
    }
    
    shops.forEach(function(shop) {
      var option = document.createElement('option');
      // 使用 user_identity 作为店铺 ID
      option.value = shop.user_identity || shop.user_id || '';
      // 显示文本：店铺名称 或 用户昵称
      option.textContent = shop.shop_name || shop.user_nick || '未命名店铺';
      orderShopSelect.appendChild(option);
    });
    
    console.log('[订单查询] 店铺下拉框已更新，共', shops.length, '个店铺');
  }
  
  /**
   * 查询订单列表
   */
  function queryOrderList() {
    currentSelectedShopId = orderShopSelect.value;
    currentOrderStatus = parseInt(orderStatusSelect.value) || 0;
    var refundStatusValue = parseInt(refundStatusSelect.value);
    currentRefundStatus = isNaN(refundStatusValue) ? -1 : refundStatusValue;
    
    if (!currentSelectedShopId) {
      showToast('请先选择店铺', 'error');
      return;
    }
    
    // 显示查询中状态
    if (queryOrdersBtn) {
      queryOrdersBtn.disabled = true;
      queryOrdersBtn.textContent = '查询中...';
    }
    if (orderQueryStatus) {
      orderQueryStatus.textContent = '正在查询订单...';
      orderQueryStatus.style.color = '#1a73e8';
    }
    
    console.log('[订单查询] 开始查询，店铺 ID:', currentSelectedShopId, '订单状态:', currentOrderStatus, '退款状态:', currentRefundStatus, '页码:', orderCurrentPage);
    
    // 发送请求到 background
    chrome.runtime.sendMessage({
      type: 'QUERY_ORDER_LIST',
      authorizeId: currentSelectedShopId,
      orderStatus: currentOrderStatus,
      refundStatus: currentRefundStatus,
      pageNo: orderCurrentPage,
      pageSize: orderPageSize
    }, function (response) {
      // 恢复按钮状态
      if (queryOrdersBtn) {
        queryOrdersBtn.disabled = false;
        queryOrdersBtn.textContent = '🔍 查询订单';
      }
      
      if (!response || !response.success) {
        var errorMsg = response && response.error ? response.error : '查询失败';
        if (orderQueryStatus) {
          orderQueryStatus.textContent = '❌ ' + errorMsg;
          orderQueryStatus.style.color = '#f44336';
        }
        showToast('订单查询失败：' + errorMsg, 'error');
        renderOrderTable([]);
        return;
      }
      
      var orders = response.orders || [];
      orderTotalCount = response.count || 0;
      
      console.log('[订单查询] 查询成功，本页', orders.length, '条，总计', orderTotalCount, '条');
      
      if (orders.length === 0 && orderCurrentPage === 1) {
        if (orderQueryStatus) {
          orderQueryStatus.textContent = '⚠️ 该店铺没有订单';
          orderQueryStatus.style.color = '#ff9800';
        }
        showToast('该店铺没有订单', 'warning');
      }
      
      // 渲染表格
      renderOrderTable(orders);
      
      // 更新分页信息
      updatePagination(response.pageNo, response.pageSize, orderTotalCount);
    });
  }
  
  /**
   * 渲染订单表格
   */
  function renderOrderTable(orders) {
    if (!orderTableBody) return;
    
    // 清空表格
    orderTableBody.innerHTML = '';
    
    if (!orders || orders.length === 0) {
      orderTableBody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#bbb;padding:40px;">暂无数据</td></tr>';
      return;
    }
    
    // 订单状态映射
    var statusMap = {
      0: '未知',
      11: '待付款',
      12: '待发货',
      21: '已发货',
      22: '已完成',
      23: '已退款',
      24: '已关闭'
    };
    
    // 退款状态映射
    var refundStatusMap = {
      0: '未申请退款',
      1: '待商家处理',
      2: '待买家退货',
      3: '待商家收货',
      4: '退款关闭',
      5: '退款成功',
      6: '已拒绝退款',
      8: '待确认退货地址'
    };
    
    // 格式化时间戳
    function formatTimestamp(timestamp) {
      if (!timestamp || timestamp === 0) return '-';
      var date = new Date(timestamp * 1000);
      return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    }
    
    // 构建地址
    function buildAddress(order) {
      var parts = [];
      if (order.prov_name) parts.push(order.prov_name);
      if (order.city_name) parts.push(order.city_name);
      if (order.area_name) parts.push(order.area_name);
      if (order.town_name) parts.push(order.town_name);
      if (order.address) parts.push(order.address);
      var fullAddress = parts.join('');
      console.log('[地址构建] 完整地址:', fullAddress);
      return fullAddress;
    }
    
    // 渲染每一行
    orders.forEach(function(order) {
      var tr = document.createElement('tr');
      
      // 调试输出：打印订单数据
      console.log('[订单渲染] 订单数据:', order);
      console.log('[订单渲染] receiver_mobile:', order.receiver_mobile);
      console.log('[订单渲染] prov_name:', order.prov_name, 'city_name:', order.city_name, 'area_name:', order.area_name);
      
      // 订单编号
      var tdOrderNo = document.createElement('td');
      tdOrderNo.textContent = order.order_no || '-';
      tdOrderNo.style.fontFamily = 'monospace';
      tdOrderNo.style.fontSize = '12px';
      tr.appendChild(tdOrderNo);
      
      // 订单状态
      var tdStatus = document.createElement('td');
      var statusText = statusMap[order.order_status] || '未知';
      tdStatus.textContent = statusText;
      tdStatus.style.fontWeight = '500';
      // 根据状态设置颜色
      if (order.order_status === 12) tdStatus.style.color = '#ff9800'; // 待发货
      else if (order.order_status === 21) tdStatus.style.color = '#2196f3'; // 已发货
      else if (order.order_status === 22) tdStatus.style.color = '#4caf50'; // 已完成
      else if (order.order_status === 23) tdStatus.style.color = '#f44336'; // 已退款
      else if (order.order_status === 24) tdStatus.style.color = '#9e9e9e'; // 已关闭
      tr.appendChild(tdStatus);
      
      // 退款状态
      var tdRefundStatus = document.createElement('td');
      var refundStatusText = refundStatusMap[order.refund_status] !== undefined ? 
                             refundStatusMap[order.refund_status] : '-';
      tdRefundStatus.textContent = refundStatusText;
      tdRefundStatus.style.fontSize = '12px';
      // 根据退款状态设置颜色
      if (order.refund_status === 0) tdRefundStatus.style.color = '#9e9e9e'; // 未申请退款
      else if (order.refund_status === 1 || order.refund_status === 2) tdRefundStatus.style.color = '#ff9800'; // 处理中
      else if (order.refund_status === 3 || order.refund_status === 4) tdRefundStatus.style.color = '#2196f3'; // 处理中
      else if (order.refund_status === 5) tdRefundStatus.style.color = '#4caf50'; // 退款成功
      else if (order.refund_status === 6) tdRefundStatus.style.color = '#f44336'; // 已拒绝
      tr.appendChild(tdRefundStatus);
      
      // 商品名称
      var tdTitle = document.createElement('td');
      tdTitle.textContent = order.goods?.title || '-';
      tdTitle.style.maxWidth = '200px';
      tdTitle.style.overflow = 'hidden';
      tdTitle.style.textOverflow = 'ellipsis';
      tdTitle.style.whiteSpace = 'nowrap';
      tdTitle.title = order.goods?.title || '-';
      tr.appendChild(tdTitle);
      
      // 数量
      var tdQuantity = document.createElement('td');
      tdQuantity.textContent = order.goods?.quantity || 0;
      tdQuantity.style.textAlign = 'center';
      tr.appendChild(tdQuantity);
      
      // 订单金额
      var tdAmount = document.createElement('td');
      var amount = (order.pay_amount || 0) / 100; // 转换为元
      tdAmount.textContent = '¥' + amount.toFixed(2);
      tdAmount.style.color = '#f44336';
      tdAmount.style.fontWeight = '500';
      tr.appendChild(tdAmount);
      
      // 买家信息
      var tdBuyer = document.createElement('td');
      tdBuyer.textContent = order.buyer_nick || '-';
      tdBuyer.style.maxWidth = '120px';
      tdBuyer.style.overflow = 'hidden';
      tdBuyer.style.textOverflow = 'ellipsis';
      tdBuyer.style.whiteSpace = 'nowrap';
      tr.appendChild(tdBuyer);
      
      // 联系电话
      var tdMobile = document.createElement('td');
      tdMobile.textContent = order.receiver_mobile || '-';
      tdMobile.style.fontSize = '12px';
      tdMobile.style.fontFamily = 'monospace';
      tdMobile.style.whiteSpace = 'nowrap'; // 不换行
      tr.appendChild(tdMobile);
      
      // 收货地址
      var tdAddress = document.createElement('td');
      var address = buildAddress(order);
      tdAddress.textContent = address || '-';
      tdAddress.style.maxWidth = '200px';
      tdAddress.style.overflow = 'hidden';
      tdAddress.style.textOverflow = 'ellipsis';
      tdAddress.style.whiteSpace = 'nowrap';
      tdAddress.title = address; // 鼠标悬停显示完整地址
      tr.appendChild(tdAddress);
      
      // 下单时间
      var tdTime = document.createElement('td');
      tdTime.textContent = formatTimestamp(order.order_time);
      tdTime.style.fontSize = '12px';
      tr.appendChild(tdTime);
      
      orderTableBody.appendChild(tr);
    });
  }
  
  /**
   * 更新分页信息
   */
  function updatePagination(pageNo, pageSize, totalCount) {
    if (!pageInfo) return;
    
    var totalPages = Math.ceil(totalCount / pageSize);
    pageInfo.textContent = '第 ' + pageNo + ' 页 / 共 ' + totalPages + ' 页 (' + totalCount + '条)';
    
    // 更新上一页按钮
    if (prevPageBtn) {
      prevPageBtn.disabled = pageNo <= 1;
    }
    
    // 更新下一页按钮
    if (nextPageBtn) {
      nextPageBtn.disabled = pageNo >= totalPages || totalCount === 0;
    }
  }
  
  // 绑定查询按钮事件
  if (queryOrdersBtn) {
    queryOrdersBtn.addEventListener('click', function() {
      orderCurrentPage = 1; // 重置为第一页
      queryOrderList();
    });
  }
  
  // 绑定上一页按钮
  if (prevPageBtn) {
    prevPageBtn.addEventListener('click', function() {
      if (orderCurrentPage > 1) {
        orderCurrentPage--;
        queryOrderList();
      }
    });
  }
  
  // 绑定下一页按钮
  if (nextPageBtn) {
    nextPageBtn.addEventListener('click', function() {
      orderCurrentPage++;
      queryOrderList();
    });
  }

  // ==================== 订单导出功能 ====================

  var exportOrdersBtn = document.getElementById('exportOrdersBtn');
  var exportProgressToast = null;

  /**
   * 显示导出进度提示
   */
  function showExportProgress(message, type) {
    if (exportProgressToast) {
      exportProgressToast.remove();
    }

    var toast = document.createElement('div');
    toast.className = 'toast' + (type ? ' ' + type : '');
    toast.style.cssText = 'position: fixed; top: 80px; left: 50%; transform: translateX(-50%); z-index: 10003;';
    toast.textContent = message;
    document.body.appendChild(toast);
    exportProgressToast = toast;

    // 强制重绘以触发动画
    setTimeout(function() {
      toast.classList.add('show');
    }, 10);
  }

  /**
   * 隐藏导出进度提示
   */
  function hideExportProgress() {
    if (exportProgressToast) {
      exportProgressToast.remove();
      exportProgressToast = null;
    }
  }

  /**
   * 下载 CSV 文件
   */
  function downloadCsvFile(csvContent, filename) {
    // 创建 Blob
    var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });

    // 创建下载链接
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.style.display = 'none';

    // 触发下载
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // 释放 URL
    setTimeout(function() {
      URL.revokeObjectURL(link.href);
    }, 100);
  }

  /**
   * 导出订单
   */
  function exportOrders() {
    var shopId = orderShopSelect.value;
    if (!shopId) {
      showToast('请先选择店铺', 'error');
      return;
    }

    var status = parseInt(orderStatusSelect.value) || 0;
    var refundStatus = parseInt(refundStatusSelect.value);
    refundStatus = isNaN(refundStatus) ? -1 : refundStatus;

    // 禁用导出按钮
    if (exportOrdersBtn) {
      exportOrdersBtn.disabled = true;
      exportOrdersBtn.textContent = '导出中...';
    }

    // 监听进度消息
    function handleExportProgress(message) {
      if (message.type !== 'EXPORT_PROGRESS') return;

      var detail = message.detail || {};
      var stage = detail.stage || 'querying';
      var current = detail.current || 0;
      var total = detail.total || 100;

      var stageText = stage === 'querying' ? '查询订单' :
                      stage === 'formatting' ? '格式化数据' :
                      stage === 'generating' ? '生成 CSV' : '导出中';

      var percent = Math.floor((current / total) * 100);
      showExportProgress(stageText + '... ' + percent + '%', '');
    }

    // 添加监听器
    chrome.runtime.onMessage.addListener(handleExportProgress);

    // 发送导出请求
    chrome.runtime.sendMessage({
      type: 'EXPORT_ORDERS',
      authorizeId: shopId,
      orderStatus: status,
      refundStatus: refundStatus
    }, function(response) {
      // 移除监听器
      chrome.runtime.onMessage.removeListener(handleExportProgress);

      // 恢复按钮状态
      if (exportOrdersBtn) {
        exportOrdersBtn.disabled = false;
        exportOrdersBtn.textContent = '📥 导出 CSV';
      }

      if (!response || !response.success) {
        hideExportProgress();
        showToast('导出失败：' + (response && response.error ? response.error : '未知错误'), 'error');
        return;
      }

      // 下载文件
      hideExportProgress();
      downloadCsvFile(response.csvContent, response.filename);
      showToast('导出成功，共 ' + response.count + ' 条订单', 'success');
    });

    // 显示初始进度
    showExportProgress('开始查询订单...', '');
  }

  // 绑定导出按钮
  if (exportOrdersBtn) {
    exportOrdersBtn.addEventListener('click', exportOrders);
  }

  // ==================== 商品管理功能 ====================

  // 商品管理相关 DOM
  var queryProductsBtn = document.getElementById('queryProductsBtn');
  var productCountEl = document.getElementById('productCount');
  var productListContainer = document.getElementById('productListContainer');
  var productPagination = document.getElementById('productPagination');
  var productPrevPageBtn = document.getElementById('productPrevPageBtn');
  var productNextPageBtn = document.getElementById('productNextPageBtn');
  var productPageInfo = document.getElementById('productPageInfo');

  // 商品管理状态
  var productCurrentPage = 1;
  var productPageSize = 15;
  var productTotalCount = 0;
  var expandedProductId = null; // 当前展开的商品ID
  var productCurrentList = []; // 当前页的商品列表（缓存，含主图和 SKU）

  /**
   * 加载商品列表
   */
  function loadProductList(pageNo) {
    productCurrentPage = pageNo || 1;

    if (queryProductsBtn) {
      queryProductsBtn.disabled = true;
      queryProductsBtn.textContent = '查询中...';
    }

    chrome.runtime.sendMessage({
      type: 'QUERY_PRODUCT_LIST',
      pageNo: productCurrentPage,
      pageSize: productPageSize,
      saleStatus: 2
    }, function (response) {
      if (queryProductsBtn) {
        queryProductsBtn.disabled = false;
        queryProductsBtn.textContent = '查询商品';
      }

      if (!response || !response.success) {
        var errorMsg = response && response.error ? response.error : '查询失败';
        productListContainer.innerHTML = '<div class="empty-state">' + errorMsg + '</div>';
        if (productCountEl) productCountEl.textContent = '共 0 个商品';
        showToast('商品查询失败：' + errorMsg, 'error');
        return;
      }

      var products = response.products || [];
      productTotalCount = response.count || 0;

      if (productCountEl) {
        productCountEl.textContent = '共 ' + productTotalCount + ' 个商品';
      }

      if (products.length === 0 && productCurrentPage === 1) {
        productListContainer.innerHTML = '<div class="empty-state">暂无商品数据</div>';
        updateProductPagination();
        return;
      }

      // 商品列表接口不返回主图，需要批量获取商品详情（含主图和 SKU）
      // 同时加载映射状态
      Promise.all([
        getAllProductSpecMappings(),
        loadProductCoverImages(products)
      ]).then(function (results) {
        var allMappings = results[0] || {};
        var productsWithImages = results[1] || [];
        // 保存到缓存变量，供 toggleProductDetail 使用
        productCurrentList = productsWithImages;
        renderProductList(productsWithImages, allMappings);
        updateProductPagination();
      }).catch(function (err) {
        console.error('[商品管理] 加载商品详情失败:', err);
        // 降级处理：直接渲染（无主图）
        productCurrentList = products;
        chrome.runtime.sendMessage({
          type: 'GET_ALL_PRODUCT_SPEC_MAPPINGS'
        }, function (mappingResponse) {
          var allMappings = (mappingResponse && mappingResponse.success) ? mappingResponse.mappings : {};
          renderProductList(products, allMappings);
          updateProductPagination();
        });
      });
    });
  }

  /**
   * 批量加载商品主图（从商品详情接口）
   * @param {Array} products - 商品列表
   * @returns {Promise<Array>} 包含 coverImage 属性的商品列表
   */
  function loadProductCoverImages(products) {
    if (!products || products.length === 0) {
      return Promise.resolve([]);
    }

    // 为每个商品创建获取详情的 Promise
    var promises = products.map(function (product) {
      return new Promise(function (resolve) {
        var productId = String(product.product_id || '');
        if (!productId) {
          resolve(product);
          return;
        }

        chrome.runtime.sendMessage({
          type: 'QUERY_PRODUCT_DETAIL',
          productId: productId
        }, function (response) {
          if (response && response.success && response.detail) {
            var detail = response.detail;
            // 从 publish_shop[0].images 获取主图
            var coverImage = (detail.publish_shop && detail.publish_shop[0] && detail.publish_shop[0].images && detail.publish_shop[0].images.length > 0)
              ? detail.publish_shop[0].images[0]
              : '';
            product.coverImage = coverImage;
            // 同时缓存 sku_items 供展开详情时使用，避免重复请求
            if (detail.sku_items) {
              product._skuItemsCache = detail.sku_items;
            }
            // 缓存 sku_images 供 SKU 图片展示使用
            if (detail.sku_images) {
              product._skuImagesCache = detail.sku_images;
            }
          }
          resolve(product);
        });
      });
    });

    // 并行获取所有商品的主图（限制并发数为 15，避免请求过多）
    return Promise.all(promises);
  }

  /**
   * 获取所有商品规格映射
   * @returns {Promise<Object>} 映射数据 { productId: mapping }
   */
  function getAllProductSpecMappings() {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage({
        type: 'GET_ALL_PRODUCT_SPEC_MAPPINGS'
      }, function (response) {
        var allMappings = (response && response.success) ? response.mappings : {};
        resolve(allMappings);
      });
    });
  }

  /**
   * 渲染商品列表
   */
  function renderProductList(products, allMappings) {
    productListContainer.innerHTML = '';
    expandedProductId = null;

    if (!products || products.length === 0) {
      productListContainer.innerHTML = '<div class="empty-state">暂无商品数据</div>';
      return;
    }

    products.forEach(function (product) {
      var productId = String(product.product_id || product.id || '');
      var title = product.title || '未命名商品';
      var price = product.price != null ? '¥' + (product.price / 100).toFixed(2) : '';
      var stock = product.stock != null ? '库存: ' + product.stock : '';
      // 优先使用从详情接口获取的主图，其次使用列表返回的图片字段
      var coverImage = product.coverImage || '';
      var picUrl = product.cover_pic || product.pic_url || '';
      var imgSrc = coverImage || picUrl || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="48" height="48"%3E%3Crect fill="%23f5f5f5" width="48" height="48"/%3E%3C/svg%3E';

      // 检查映射状态
      var hasMapping = allMappings && allMappings[productId] && allMappings[productId].item1688Link;

      var item = document.createElement('div');
      item.className = 'product-item';
      item.setAttribute('data-product-id', productId);

      // 头部区域
      var header = document.createElement('div');
      header.className = 'product-item-header';

      var img = document.createElement('img');
      img.className = 'product-item-thumb';
      img.src = imgSrc;
      img.alt = '';
      img.onerror = function () {
        this.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="48" height="48"%3E%3Crect fill="%23f5f5f5" width="48" height="48"/%3E%3C/svg%3E';
      };

      var info = document.createElement('div');
      info.className = 'product-item-info';

      var titleEl = document.createElement('div');
      titleEl.className = 'product-item-title';
      titleEl.textContent = title;
      titleEl.title = title;

      var meta = document.createElement('div');
      meta.className = 'product-item-meta';

      var priceEl = document.createElement('span');
      priceEl.className = 'product-item-price';
      priceEl.textContent = price;

      var stockEl = document.createElement('span');
      stockEl.textContent = stock;

      var idEl = document.createElement('span');
      idEl.textContent = 'ID: ' + productId;

      meta.appendChild(priceEl);
      meta.appendChild(stockEl);
      meta.appendChild(idEl);

      info.appendChild(titleEl);
      info.appendChild(meta);

      // 映射状态标签
      var statusBadge = document.createElement('span');
      statusBadge.className = 'product-mapping-status ' + (hasMapping ? 'mapping-configured' : 'mapping-unconfigured');
      statusBadge.textContent = hasMapping ? '已配置' : '未配置';
      statusBadge.setAttribute('data-status-for', productId);

      // 编辑按钮
      var actionsDiv = document.createElement('div');
      actionsDiv.className = 'product-item-actions';

      var editBtn = document.createElement('button');
      editBtn.className = 'btn btn-small';
      editBtn.textContent = '编辑';
      editBtn.addEventListener('click', (function (pid, itemEl) {
        return function (e) {
          e.stopPropagation();
          toggleProductDetail(pid, itemEl);
        };
      })(productId, item));

      actionsDiv.appendChild(editBtn);

      header.appendChild(img);
      header.appendChild(info);
      header.appendChild(statusBadge);
      header.appendChild(actionsDiv);

      // 点击头部也可以展开/折叠
      header.addEventListener('click', (function (pid, itemEl) {
        return function () {
          toggleProductDetail(pid, itemEl);
        };
      })(productId, item));

      // 详情区域（默认隐藏）
      var detail = document.createElement('div');
      detail.className = 'product-detail';
      detail.setAttribute('data-detail-for', productId);

      item.appendChild(header);
      item.appendChild(detail);
      productListContainer.appendChild(item);
    });
  }

  /**
   * 切换商品详情展开/折叠
   */
  function toggleProductDetail(productId, itemEl) {
    var detail = itemEl.querySelector('[data-detail-for="' + productId + '"]');
    if (!detail) return;

    if (detail.classList.contains('show')) {
      // 折叠
      detail.classList.remove('show');
      expandedProductId = null;
      return;
    }

    // 先折叠其他所有已展开的
    var allDetails = productListContainer.querySelectorAll('.product-detail.show');
    allDetails.forEach(function (d) { d.classList.remove('show'); });

    // 展开当前
    expandedProductId = productId;
    detail.innerHTML = '<div class="product-loading">加载中...</div>';
    detail.classList.add('show');

    // 查找已缓存的商品数据（loadProductCoverImages 已获取）
    var cachedProduct = null;
    // 从当前列表中查找已缓存的商品数据
    for (var i = 0; i < productCurrentList.length; i++) {
      if (String(productCurrentList[i].product_id) === productId) {
        cachedProduct = productCurrentList[i];
        break;
      }
    }

    // 如果有缓存的 SKU 数据，直接使用，否则调用 API 获取
    if (cachedProduct && cachedProduct._skuItemsCache && cachedProduct.coverImage) {
      // 使用缓存数据
      chrome.runtime.sendMessage({
        type: 'GET_PRODUCT_SPEC_MAPPING',
        productId: productId
      }, function (response) {
        var existingMapping = (response && response.success && response.mapping) ? response.mapping : null;
        renderProductDetail(productId, detail, cachedProduct._skuItemsCache, existingMapping, cachedProduct.coverImage, cachedProduct._skuImagesCache);
      });
    } else {
      // 无缓存，调用 API 获取详情
      var productDetail = null;
      var existingMapping = null;
      var loadedCount = 0;

      function onBothLoaded() {
        loadedCount++;
        if (loadedCount < 2) return;
        var skuItems = (productDetail && productDetail.sku_items) ? productDetail.sku_items : [];
        // 从 publish_shop[0].images 获取主图
        var coverImage = (productDetail && productDetail.publish_shop && productDetail.publish_shop[0] && productDetail.publish_shop[0].images && productDetail.publish_shop[0].images.length > 0)
          ? productDetail.publish_shop[0].images[0]
          : '';
        var skuImages = (productDetail && productDetail.sku_images) ? productDetail.sku_images : [];
        renderProductDetail(productId, detail, skuItems, existingMapping, coverImage, skuImages);
      }

      chrome.runtime.sendMessage({
        type: 'QUERY_PRODUCT_DETAIL',
        productId: productId
      }, function (response) {
        if (response && response.success && response.detail) {
          productDetail = response.detail;
        } else {
          productDetail = null;
        }
        onBothLoaded();
      });

      chrome.runtime.sendMessage({
        type: 'GET_PRODUCT_SPEC_MAPPING',
        productId: productId
      }, function (response) {
        if (response && response.success && response.mapping) {
          existingMapping = response.mapping;
        } else {
          existingMapping = null;
        }
        onBothLoaded();
      });
    }
  }

  /**
   * 渲染商品详情区域
   */
  function renderProductDetail(productId, detailEl, skuItems, existingMapping, coverImage, skuImages) {
    detailEl.innerHTML = '';

    // 商品主图预览（如果有）
    if (coverImage) {
      var imgSection = document.createElement('div');
      imgSection.className = 'product-detail-section';
      imgSection.style.cssText = 'display: flex; align-items: center; gap: 12px;';

      var imgPreview = document.createElement('img');
      imgPreview.src = coverImage;
      imgPreview.style.cssText = 'width: 64px; height: 64px; border-radius: 4px; object-fit: cover; border: 1px solid #eee;';
      imgPreview.onerror = function () { this.style.display = 'none'; };

      var imgHint = document.createElement('span');
      imgHint.style.cssText = 'font-size: 12px; color: #999;';
      imgHint.textContent = '商品主图（来自 publish_shop.images）';

      imgSection.appendChild(imgPreview);
      imgSection.appendChild(imgHint);
      detailEl.appendChild(imgSection);
    }

    // 1688 链接配置
    var linkSection = document.createElement('div');
    linkSection.className = 'product-detail-section';

    var linkLabel = document.createElement('div');
    linkLabel.className = 'product-detail-label';
    linkLabel.textContent = '1688 商品链接';

    var linkInput = document.createElement('input');
    linkInput.type = 'text';
    linkInput.className = 'product-link-input';
    linkInput.placeholder = '输入1688商品链接，如 https://detail.1688.com/offer/...';
    linkInput.value = (existingMapping && existingMapping.item1688Link) || '';
    linkInput.setAttribute('data-link-input', productId);

    linkSection.appendChild(linkLabel);
    linkSection.appendChild(linkInput);
    detailEl.appendChild(linkSection);

    // SKU 规格映射
    var skuSection = document.createElement('div');
    skuSection.className = 'product-detail-section';

    var skuLabel = document.createElement('div');
    skuLabel.className = 'product-detail-label';
    skuLabel.textContent = 'SKU 规格映射' + (skuItems && skuItems.length > 0 ? ' (' + skuItems.length + '个规格)' : '');

    skuSection.appendChild(skuLabel);

    if (!skuItems || skuItems.length === 0) {
      var noSku = document.createElement('div');
      noSku.style.cssText = 'padding: 12px; color: #999; font-size: 13px; background: white; border: 1px solid #eee; border-radius: 4px;';
      noSku.textContent = '该商品无多规格信息（单规格商品无需配置SKU映射）';
      skuSection.appendChild(noSku);
    } else {
      var skuList = document.createElement('div');
      skuList.className = 'sku-list';

      var savedSkuMapping = (existingMapping && existingMapping.skuMapping) || {};

      skuItems.forEach(function (sku) {
        var skuId = String(sku.sku_id || sku.xy_sku_id || '');
        var xySkuText = sku.sku_text || '';
        var skuPrice = sku.price != null ? '¥' + (sku.price / 100).toFixed(2) : '';
        var skuStock = sku.stock != null ? '库存:' + sku.stock : '';

        // 查找已保存的映射
        var savedSpec1 = '';
        var savedSpec2 = '';
        if (savedSkuMapping[skuId]) {
          savedSpec1 = savedSkuMapping[skuId].spec1688_1 || '';
          savedSpec2 = savedSkuMapping[skuId].spec1688_2 || '';
        }

        // 查找对应的 SKU 图片（通过 sku_text 匹配）
        var skuImageSrc = '';
        if (skuImages && skuImages.length > 0) {
          var matchedSkuImage = skuImages.find(function (img) {
            return img.sku_text === xySkuText;
          });
          if (matchedSkuImage && matchedSkuImage.src) {
            skuImageSrc = matchedSkuImage.src;
          }
        }

        var skuItem = document.createElement('div');
        skuItem.className = 'sku-item';

        // 闲鱼规格（只读）
        var xySpecDiv = document.createElement('div');
        xySpecDiv.className = 'sku-xy-spec';

        var xySpecLabel = document.createElement('div');
        xySpecLabel.className = 'sku-xy-spec-label';
        xySpecLabel.textContent = '闲鱼规格';

        var xySpecValue = document.createElement('div');
        xySpecValue.textContent = xySkuText || '(无规格文本)';
        xySpecValue.style.fontSize = '13px';

        xySpecDiv.appendChild(xySpecLabel);
        xySpecDiv.appendChild(xySpecValue);

        // SKU 图片（如果有）
        if (skuImageSrc) {
          var skuImg = document.createElement('img');
          skuImg.src = skuImageSrc;
          skuImg.style.cssText = 'width: 40px; height: 40px; object-fit: cover; border: 1px solid #eee; border-radius: 4px; margin-left: 8px;';
          skuImg.onerror = function () { this.style.display = 'none'; };
          xySpecDiv.appendChild(skuImg);
        }

        // 箭头
        var arrow = document.createElement('div');
        arrow.className = 'sku-arrow';
        arrow.textContent = '\u2192';

        // 1688规格1输入
        var specInput1Div = document.createElement('div');
        specInput1Div.className = 'sku-1688-spec';

        var specInput1Label = document.createElement('div');
        specInput1Label.className = 'sku-1688-spec-label';
        specInput1Label.textContent = '1688规格1（如颜色）';

        var specInput1 = document.createElement('input');
        specInput1.type = 'text';
        specInput1.className = 'sku-1688-input';
        specInput1.placeholder = '如: 红色';
        specInput1.value = savedSpec1;
        specInput1.setAttribute('data-sku-id', skuId);
        specInput1.setAttribute('data-sku-text', xySkuText);
        specInput1.setAttribute('data-spec-index', '1');

        specInput1Div.appendChild(specInput1Label);
        specInput1Div.appendChild(specInput1);

        // 1688规格2输入
        var specInput2Div = document.createElement('div');
        specInput2Div.className = 'sku-1688-spec';

        var specInput2Label = document.createElement('div');
        specInput2Label.className = 'sku-1688-spec-label';
        specInput2Label.textContent = '1688规格2（如尺码）';

        var specInput2 = document.createElement('input');
        specInput2.type = 'text';
        specInput2.className = 'sku-1688-input';
        specInput2.placeholder = '如: L';
        specInput2.value = savedSpec2;
        specInput2.setAttribute('data-sku-id', skuId);
        specInput2.setAttribute('data-sku-text', xySkuText);
        specInput2.setAttribute('data-spec-index', '2');

        specInput2Div.appendChild(specInput2Label);
        specInput2Div.appendChild(specInput2);

        // 额外信息
        var extraInfo = document.createElement('div');
        extraInfo.className = 'sku-extra-info';
        extraInfo.innerHTML = skuPrice + '<br>' + skuStock;

        skuItem.appendChild(xySpecDiv);
        skuItem.appendChild(arrow);
        skuItem.appendChild(specInput1Div);
        skuItem.appendChild(specInput2Div);
        skuItem.appendChild(extraInfo);
        skuList.appendChild(skuItem);
      });

      skuSection.appendChild(skuList);
    }

    detailEl.appendChild(skuSection);

    // 底部操作栏
    var footer = document.createElement('div');
    footer.className = 'product-detail-footer';

    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = '保存映射';
    saveBtn.addEventListener('click', function () {
      saveProductMapping(productId, detailEl);
    });

    footer.appendChild(saveBtn);
    detailEl.appendChild(footer);
  }

  /**
   * 保存商品规格映射
   */
  function saveProductMapping(productId, detailEl) {
    // 收集1688链接
    var linkInput = detailEl.querySelector('[data-link-input="' + productId + '"]');
    var item1688Link = linkInput ? linkInput.value.trim() : '';

    // 收集SKU映射（双规格）
    var skuMapping = {};
    var skuInputs = detailEl.querySelectorAll('[data-sku-id]');
    skuInputs.forEach(function (input) {
      var skuId = input.getAttribute('data-sku-id');
      var skuText = input.getAttribute('data-sku-text');
      var specIndex = input.getAttribute('data-spec-index');

      if (skuId) {
        if (!skuMapping[skuId]) {
          skuMapping[skuId] = {
            sku_text: skuText || '',
            spec1688_1: '',
            spec1688_2: ''
          };
        }
        if (specIndex === '1') {
          skuMapping[skuId].spec1688_1 = input.value.trim();
        } else if (specIndex === '2') {
          skuMapping[skuId].spec1688_2 = input.value.trim();
        }
      }
    });

    chrome.runtime.sendMessage({
      type: 'SAVE_PRODUCT_SPEC_MAPPING',
      productId: productId,
      item1688Link: item1688Link,
      skuMapping: skuMapping
    }, function (response) {
      if (response && response.success) {
        showToast('映射已保存', 'success');

        // 更新状态标签
        var statusBadge = document.querySelector('[data-status-for="' + productId + '"]');
        if (statusBadge) {
          var hasMapping = item1688Link || Object.keys(skuMapping).some(function (k) {
            return skuMapping[k].spec1688_1 || skuMapping[k].spec1688_2;
          });
          statusBadge.className = 'product-mapping-status ' + (hasMapping ? 'mapping-configured' : 'mapping-unconfigured');
          statusBadge.textContent = hasMapping ? '已配置' : '未配置';
        }
      } else {
        showToast('保存失败：' + (response && response.error || '未知错误'), 'error');
      }
    });
  }

  /**
   * 更新商品分页
   */
  function updateProductPagination() {
    if (!productPagination) return;

    var totalPages = Math.ceil(productTotalCount / productPageSize);

    if (totalPages <= 1) {
      productPagination.style.display = 'none';
      return;
    }

    productPagination.style.display = 'flex';

    if (productPageInfo) {
      productPageInfo.textContent = '第 ' + productCurrentPage + ' 页 / 共 ' + totalPages + ' 页 (' + productTotalCount + '个)';
    }
    if (productPrevPageBtn) {
      productPrevPageBtn.disabled = productCurrentPage <= 1;
    }
    if (productNextPageBtn) {
      productNextPageBtn.disabled = productCurrentPage >= totalPages;
    }
  }

  // 绑定商品管理按钮事件
  if (queryProductsBtn) {
    queryProductsBtn.addEventListener('click', function () {
      loadProductList(1);
    });
  }

  if (productPrevPageBtn) {
    productPrevPageBtn.addEventListener('click', function () {
      if (productCurrentPage > 1) {
        loadProductList(productCurrentPage - 1);
      }
    });
  }

  if (productNextPageBtn) {
    productNextPageBtn.addEventListener('click', function () {
      loadProductList(productCurrentPage + 1);
    });
  }

  
  // 初始化（不再需要 loadMessages 和 loadConfig）
  loadAutoReplyData();
});
