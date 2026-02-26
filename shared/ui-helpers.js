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

// ==================== 订单导出工具函数 ====================

/**
 * 解析 SKU 文本，提取规格信息
 * @param {string} skuText - SKU 文本，如 "【颜色】:红色;【尺码】:L" 或 "【款式】:充电款"
 * @returns {Array<string>} [规格 1, 规格 2]，如 ['红色', 'L'] 或 ['', '']
 */
function parseSkuText(skuText) {
  if (!skuText || typeof skuText !== 'string') {
    return ['', ''];
  }

  var specs = [];
  // 匹配模式：】:后面的内容，直到遇到;或【或字符串结束
  var matches = skuText.match(/】:([^;【]+)/g) || [];
  
  matches.forEach(function(m) {
    // 移除前缀】:并去除空格
    var specValue = m.replace('】:', '').trim();
    specs.push(specValue);
  });

  // 返回两个规格值，不足的用空字符串填充
  return [specs[0] || '', specs[1] || ''];
}

/**
 * 将 API 订单对象转换为 Excel 行数据
 * @param {Object} order - 闲管家 API 返回的订单对象
 * @returns {Object} Excel 行数据对象，包含 15 个字段
 */
function convertOrderToExcelRow(order) {
  if (!order) {
    return null;
  }

  // 解析商品规格
  var skuSpecs = parseSkuText(order.goods?.sku_text || '');

  // 构建合并地址
  var fullAddress = (order.prov_name || '') + 
                    (order.city_name || '') + 
                    (order.area_name || '') + 
                    (order.address || '');

  // 映射为 Excel 导入模板的 15 列
  return {
    // 必填列（红色字体）
    orderNo: order.order_no || '',                          // 订单号
    goodsTitle: order.goods?.title || '',                   // 商品名称
    goodsQuantity: order.goods?.quantity || 0,              // 商品数量 (件)
    skuSpec1: skuSpecs[0],                                  // 商品规格 1（如：颜色）
    skuSpec2: skuSpecs[1],                                  // 商品规格 2（如：尺码）
    receiverName: order.receiver_name || '',                // 收件人 - 姓名
    receiverMobile: order.receiver_mobile || '',            // 收件人 - 手机
    provName: order.prov_name || '',                        // 收件人 - 省
    cityName: order.city_name || '',                        // 收件人 - 市
    areaName: order.area_name || '',                        // 收件人 - 区
    detailAddress: order.address || '',                     // 收件人 - 详细地址
    fullAddress: fullAddress,                               // 收货地址（省/市/区/详细地址合并的收货地址）
    
    // 非必填列（蓝色字体）
    buyerMessage: order.seller_remark || '',                // 买家留言（实际是卖家备注，API 限制）
    item1688Id: '',                                         // 1688 商品 id/1688 商品链接（留空，手动填）
    distributionType: '1'                                   // 分销 or 现货（默认 1 走分销）
  };
}

/**
 * 生成 CSV 内容（带 BOM 头）
 * @param {Array<Object>} orders - 订单数组
 * @returns {string} CSV 格式字符串
 */
function generateCSVContent(orders) {
  if (!orders || orders.length === 0) {
    return '';
  }

  // CSV 表头（15 列）
  var header = '订单号，商品名称，商品数量 (件),商品规格 1（如：颜色）,商品规格 2（如：尺码）,收件人 - 姓名，收件人 - 手机，收件人 - 省，收件人 - 市，收件人 - 区，收件人 - 详细地址，收货地址（省/市/区/详细地址合并的收货地址）,买家留言，1688 商品 id/1688 商品链接，分销 or 现货（默认或者填 1 走分销，0 走现货）';

  // 转换每行数据
  var rows = orders.map(function(row) {
    // 确保所有字段都是字符串，并用双引号包裹（处理逗号）
    return [
      '"' + String(row.orderNo || '').replace(/"/g, '""') + '"',
      '"' + String(row.goodsTitle || '').replace(/"/g, '""') + '"',
      String(row.goodsQuantity || 0),
      '"' + String(row.skuSpec1 || '').replace(/"/g, '""') + '"',
      '"' + String(row.skuSpec2 || '').replace(/"/g, '""') + '"',
      '"' + String(row.receiverName || '').replace(/"/g, '""') + '"',
      '"' + String(row.receiverMobile || '').replace(/"/g, '""') + '"',
      '"' + String(row.provName || '').replace(/"/g, '""') + '"',
      '"' + String(row.cityName || '').replace(/"/g, '""') + '"',
      '"' + String(row.areaName || '').replace(/"/g, '""') + '"',
      '"' + String(row.detailAddress || '').replace(/"/g, '""') + '"',
      '"' + String(row.fullAddress || '').replace(/"/g, '""') + '"',
      '"' + String(row.buyerMessage || '').replace(/"/g, '""') + '"',
      '"' + String(row.item1688Id || '').replace(/"/g, '""') + '"',
      '"' + String(row.distributionType || '1') + '"'
    ].join(',');
  }).join('\n');

  // 添加 BOM 头和换行符
  return '\uFEFF' + header + '\n' + rows;
}

// 导出供其他模块使用
if (typeof window !== 'undefined') {
  window.showToast = showToast;
  window.showConfirm = showConfirm;
  window.parseSkuText = parseSkuText;
  window.convertOrderToExcelRow = convertOrderToExcelRow;
  window.generateCSVContent = generateCSVContent;
}
