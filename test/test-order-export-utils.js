/**
 * test/test-order-export-utils.js - 订单导出工具函数测试
 * 测试 parseSkuText, convertOrderToExcelRow, generateCSVContent
 */

// ==================== 导入被测试的模块 ====================

// 在 Node.js 环境中运行，需要读取并执行 ui-helpers.js
var fs = require('fs');
var path = require('path');

// 读取并执行 ui-helpers.js 以获取函数定义
var uiHelpersPath = path.join(__dirname, '../shared/ui-helpers.js');
var uiHelpersCode = fs.readFileSync(uiHelpersPath, 'utf8');
eval(uiHelpersCode);

// ==================== 测试框架辅助函数 ====================

var passedTests = 0;
var failedTests = 0;

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log('✅ PASS:', message);
    passedTests++;
    return true;
  } else {
    console.error('❌ FAIL:', message);
    console.error('   Expected:', JSON.stringify(expected));
    console.error('   Actual:  ', JSON.stringify(actual));
    failedTests++;
    return false;
  }
}

function assertTrue(condition, message) {
  if (condition) {
    console.log('✅ PASS:', message);
    passedTests++;
    return true;
  } else {
    console.error('❌ FAIL:', message);
    failedTests++;
    return false;
  }
}

function runTest(testName, testFn) {
  console.log('\n🧪 Running:', testName);
  testFn();
}

// ==================== parseSkuText 测试 ====================

runTest('parseSkuText - 正常场景：两个规格', function() {
  var result = parseSkuText('【颜色】:红色;【尺码】:L');
  assertEqual(result, ['红色', 'L'], '应正确解析两个规格');
});

runTest('parseSkuText - 单个规格', function() {
  var result = parseSkuText('【款式】:充电款');
  assertEqual(result, ['充电款', ''], '应只解析第一个规格，第二个为空');
});

runTest('parseSkuText - 无规格文本', function() {
  var result = parseSkuText('');
  assertEqual(result, ['', ''], '空字符串应返回两个空值');
});

runTest('parseSkuText - null/undefined', function() {
  assertEqual(parseSkuText(null), ['', ''], 'null 应返回两个空值');
  assertEqual(parseSkuText(undefined), ['', ''], 'undefined 应返回两个空值');
});

runTest('parseSkuText - 不同格式', function() {
  var result = parseSkuText('【材质】:棉质;【风格】:休闲');
  assertEqual(result, ['棉质', '休闲'], '应正确解析不同属性名');
});

runTest('parseSkuText - 带空格', function() {
  var result = parseSkuText('【颜色】: 红色 ; 【尺码】: L ');
  assertEqual(result, ['红色', 'L'], '应自动去除空格');
});

// ==================== convertOrderToExcelRow 测试 ====================

runTest('convertOrderToExcelRow - 完整订单数据', function() {
  var mockOrder = {
    order_no: '1234567890',
    goods: {
      title: '韩版连衣裙',
      quantity: 2,
      sku_text: '【颜色】:红色;【尺码】:L'
    },
    receiver_name: '张三',
    receiver_mobile: '18739878909',
    prov_name: '浙江省',
    city_name: '杭州市',
    area_name: '西湖区',
    address: '文三路 100 号',
    seller_remark: '请尽快发货'
  };

  var result = convertOrderToExcelRow(mockOrder);
  
  assertTrue(result !== null, '返回值不应为 null');
  assertEqual(result.orderNo, '1234567890', '订单号应正确映射');
  assertEqual(result.goodsTitle, '韩版连衣裙', '商品名称应正确映射');
  assertEqual(result.goodsQuantity, 2, '商品数量应正确映射');
  assertEqual(result.skuSpec1, '红色', '规格 1 应正确解析');
  assertEqual(result.skuSpec2, 'L', '规格 2 应正确解析');
  assertEqual(result.receiverName, '张三', '收件人姓名应正确映射');
  assertEqual(result.receiverMobile, '18739878909', '收件人手机应正确映射');
  assertEqual(result.provName, '浙江省', '省份应正确映射');
  assertEqual(result.cityName, '杭州市', '城市应正确映射');
  assertEqual(result.areaName, '西湖区', '区域应正确映射');
  assertEqual(result.detailAddress, '文三路 100 号', '详细地址应正确映射');
  assertEqual(result.fullAddress, '浙江省杭州市西湖区文三路 100 号', '合并地址应正确');
  assertEqual(result.buyerMessage, '请尽快发货', '买家留言应正确映射（实际是卖家备注）');
  assertEqual(result.item1688Id, '', '1688 商品 ID 应为空（手动填写）');
  assertEqual(result.distributionType, '1', '分销类型应默认为 1');
});

runTest('convertOrderToExcelRow - 缺少部分地址字段', function() {
  var mockOrder = {
    order_no: '9876543210',
    goods: {
      title: '测试商品',
      quantity: 1,
      sku_text: ''
    },
    receiver_name: '李四',
    receiver_mobile: '13800138000',
    prov_name: '广东省',
    city_name: '',
    area_name: '',
    address: '天河路 200 号'
  };

  var result = convertOrderToExcelRow(mockOrder);
  
  assertEqual(result.fullAddress, '广东省天河路 200 号', '合并不全的地址字段');
  assertEqual(result.skuSpec1, '', '空 SKU 文本应返回空字符串');
  assertEqual(result.skuSpec2, '', '空 SKU 文本应返回空字符串');
});

runTest('convertOrderToExcelRow - null 输入', function() {
  var result = convertOrderToExcelRow(null);
  assertEqual(result, null, 'null 输入应返回 null');
});

// ==================== generateCSVContent 测试 ====================

runTest('generateCSVContent - 空数组', function() {
  var result = generateCSVContent([]);
  assertEqual(result, '', '空数组应返回空字符串');
});

runTest('generateCSVContent - 单条订单', function() {
  var orders = [{
    orderNo: '1234',
    goodsTitle: '测试商品',
    goodsQuantity: 1,
    skuSpec1: '红色',
    skuSpec2: 'L',
    receiverName: '张三',
    receiverMobile: '18739878909',
    provName: '浙江省',
    cityName: '杭州市',
    areaName: '西湖区',
    detailAddress: '文三路 100 号',
    fullAddress: '浙江省杭州市西湖区文三路 100 号',
    buyerMessage: '请尽快发货',
    item1688Id: '',
    distributionType: '1'
  }];

  var result = generateCSVContent(orders);
  
  assertTrue(result.startsWith('\uFEFF'), '应包含 BOM 头');
  assertTrue(result.includes('订单号'), '应包含表头');
  assertTrue(result.includes('1234'), '应包含订单号');
  assertTrue(result.includes('测试商品'), '应包含商品名称');
  
  // 验证列数（15 列）- 注意 CSV 中逗号分隔，但要考虑引号包裹的情况
  var lines = result.split('\n');
  // 简单验证：统计未被引号包裹的逗号数量 +1
  var dataLine = lines[1];
  var commaCount = 0;
  var inQuote = false;
  for (var i = 0; i < dataLine.length; i++) {
    if (dataLine[i] === '"') {
      inQuote = !inQuote;
    } else if (dataLine[i] === ',' && !inQuote) {
      commaCount++;
    }
  }
  var colCount = commaCount + 1;
  assertEqual(colCount, 15, '数据行应有 15 列（正确解析 CSV 逗号）');
});

runTest('generateCSVContent - 多笔订单', function() {
  var orders = [
    {
      orderNo: '001',
      goodsTitle: '商品 A',
      goodsQuantity: 1,
      skuSpec1: '',
      skuSpec2: '',
      receiverName: '用户 1',
      receiverMobile: '11111111111',
      provName: '',
      cityName: '',
      areaName: '',
      detailAddress: '',
      fullAddress: '',
      buyerMessage: '',
      item1688Id: '',
      distributionType: '1'
    },
    {
      orderNo: '002',
      goodsTitle: '商品 B',
      goodsQuantity: 2,
      skuSpec1: '',
      skuSpec2: '',
      receiverName: '用户 2',
      receiverMobile: '22222222222',
      provName: '',
      cityName: '',
      areaName: '',
      detailAddress: '',
      fullAddress: '',
      buyerMessage: '',
      item1688Id: '',
      distributionType: '1'
    }
  ];

  var result = generateCSVContent(orders);
  var lines = result.split('\n');
  
  assertEqual(lines.length, 3, '应有 1 行表头 +2 行数据');
  assertTrue(result.includes('001'), '应包含订单 001');
  assertTrue(result.includes('002'), '应包含订单 002');
});

runTest('generateCSVContent - 包含特殊字符（逗号、引号）', function() {
  var orders = [{
    orderNo: '999',
    goodsTitle: '测试，商品"带引号"',
    goodsQuantity: 1,
    skuSpec1: '',
    skuSpec2: '',
    receiverName: '张三',
    receiverMobile: '13800138000',
    provName: '',
    cityName: '',
    areaName: '',
    detailAddress: '',
    fullAddress: '',
    buyerMessage: '',
    item1688Id: '',
    distributionType: '1'
  }];

  var result = generateCSVContent(orders);
  
  // 验证引号被正确转义（双引号变""）
  assertTrue(result.includes('""带引号""'), '双引号应转义为 ""');
});

// ==================== 测试结果汇总 ====================

console.log('\n========================================');
console.log('📊 测试结果汇总:');
console.log('   ✅ 通过:', passedTests);
console.log('   ❌ 失败:', failedTests);
console.log('   📝 总计:', passedTests + failedTests);
console.log('========================================\n');

if (failedTests > 0) {
  console.error('❌ 部分测试未通过，请检查实现代码');
} else {
  console.log('✅ 所有测试通过！');
}
