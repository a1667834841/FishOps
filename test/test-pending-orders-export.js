/**
 * test/test-pending-orders-export.js - 待发货订单导出集成测试
 * 测试整个导出流程，从 API 调用到 CSV 生成
 */

// ==================== 导入被测试的模块 ====================

var fs = require('fs');
var path = require('path');

// 读取并执行 ui-helpers.js 以获取函数定义
var uiHelpersPath = path.join(__dirname, '../shared/ui-helpers.js');
var uiHelpersCode = fs.readFileSync(uiHelpersPath, 'utf8');
eval(uiHelpersCode);

// ==================== Mock 数据 ====================

/**
 * Mock 订单数据（模拟闲管家 API 返回）
 */
var mockOrders = [
  {
    order_no: '3364202298717566229',
    order_status: 22,
    order_time: 1685087039,
    total_amount: 8000,
    pay_amount: 1,
    receiver_mobile: '15889106633',
    receiver_name: '萧祁锐',
    prov_name: '广东省',
    city_name: '深圳市',
    area_name: '南山区',
    town_name: '粤海街道',
    address: '桂庙新村',
    seller_remark: '请及时发货',
    goods: {
      quantity: 1,
      price: 8000,
      product_id: 421611860404485,
      item_id: 709548670377,
      sku_id: 0,
      sku_text: '【颜色】:白色;【尺码】:M',
      title: '佳韵宝哺乳枕 买完后闺蜜又送了一个 标签都还没拆 便宜卖'
    }
  },
  {
    order_no: '3364342266781566229',
    order_status: 22,
    order_time: 1685088183,
    total_amount: 4350,
    pay_amount: 1,
    receiver_mobile: '13800138000',
    receiver_name: '张三',
    prov_name: '浙江省',
    city_name: '杭州市',
    area_name: '西湖区',
    town_name: '',
    address: '文三路 100 号',
    seller_remark: '',
    goods: {
      quantity: 2,
      price: 4350,
      product_id: 421611860506885,
      item_id: 708245707949,
      sku_id: 5146011339969,
      sku_text: '【款式】:充电款',
      title: '小黄鸭宝宝洗澡花洒戏水玩具小孩电动喷水婴儿沐浴儿童男孩女孩'
    }
  },
  {
    order_no: '3364342266781566230',
    order_status: 22,
    order_time: 1685088200,
    total_amount: 9900,
    pay_amount: 9900,
    receiver_mobile: '13900139000',
    receiver_name: '李四',
    prov_name: '上海市',
    city_name: '上海市',
    area_name: '浦东新区',
    town_name: '',
    address: '世纪大道 1000 号',
    seller_remark: '买家留言：请包装完好',
    goods: {
      quantity: 1,
      price: 9900,
      product_id: 421611860506886,
      item_id: 708245707950,
      sku_id: 0,
      sku_text: '',
      title: '测试商品（无规格）'
    }
  }
];

// ==================== 测试辅助函数 ====================

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

// ==================== 集成测试 ====================

runTest('集成测试 - 完整订单转换流程', function() {
  // 测试第一个 mock 订单
  var order = mockOrders[0];
  var row = convertOrderToExcelRow(order);
  
  // 验证所有字段
  assertEqual(row.orderNo, '3364202298717566229', '订单号应正确映射');
  assertEqual(row.goodsTitle, '佳韵宝哺乳枕 买完后闺蜜又送了一个 标签都还没拆 便宜卖', '商品标题应正确映射');
  assertEqual(row.goodsQuantity, 1, '数量应为 1');
  assertEqual(row.skuSpec1, '白色', '规格 1 应解析为白色');
  assertEqual(row.skuSpec2, 'M', '规格 2 应解析为 M');
  assertEqual(row.receiverName, '萧祁锐', '收件人姓名应正确');
  assertEqual(row.receiverMobile, '15889106633', '收件人手机应正确');
  assertEqual(row.provName, '广东省', '省份应正确');
  assertEqual(row.cityName, '深圳市', '城市应正确');
  assertEqual(row.areaName, '南山区', '区域应正确');
  assertEqual(row.detailAddress, '桂庙新村', '详细地址应正确');
  assertEqual(row.fullAddress, '广东省深圳市南山区桂庙新村', '合并地址应正确');
  assertEqual(row.buyerMessage, '请及时发货', '买家留言应正确（实际是卖家备注）');
  assertEqual(row.item1688Id, '', '1688 商品 ID 应为空');
  assertEqual(row.distributionType, '1', '分销类型应默认为 1');
});

runTest('集成测试 - 单规格商品转换', function() {
  var order = mockOrders[1];
  var row = convertOrderToExcelRow(order);
  
  assertEqual(row.skuSpec1, '充电款', '应解析出唯一规格');
  assertEqual(row.skuSpec2, '', '第二个规格应为空');
  assertEqual(row.goodsQuantity, 2, '数量应为 2');
});

runTest('集成测试 - 无规格商品转换', function() {
  var order = mockOrders[2];
  var row = convertOrderToExcelRow(order);
  
  assertEqual(row.skuSpec1, '', '无规格时应为空');
  assertEqual(row.skuSpec2, '', '无规格时应为空');
});

runTest('集成测试 - 批量订单转换为 CSV', function() {
  // 将所有 mock 订单转换为 Excel 行
  var excelRows = [];
  for (var i = 0; i < mockOrders.length; i++) {
    var row = convertOrderToExcelRow(mockOrders[i]);
    if (row) {
      excelRows.push(row);
    }
  }
  
  assertTrue(excelRows.length === 3, '应转换 3 个订单');
  
  // 生成 CSV
  var csvContent = generateCSVContent(excelRows);
  
  // 验证 CSV 格式
  assertTrue(csvContent.startsWith('\uFEFF'), '应包含 BOM 头');
  
  var lines = csvContent.split('\n');
  assertTrue(lines.length === 4, '应有 1 行表头 +3 行数据');
  
  // 验证表头
  var header = lines[0];
  assertTrue(header.includes('订单号'), '表头应包含订单号列');
  assertTrue(header.includes('商品名称'), '表头应包含商品名称列');
  assertTrue(header.includes('商品规格 1'), '表头应包含规格 1 列');
  assertTrue(header.includes('商品规格 2'), '表头应包含规格 2 列');
  assertTrue(header.includes('收货地址（省/市/区/详细地址合并的收货地址）'), '表头应包含合并地址列');
  assertTrue(header.includes('1688 商品 id'), '表头应包含 1688 商品 ID 列');
  assertTrue(header.includes('分销 or 现货'), '表头应包含分销类型列');
  
  // 验证数据行
  assertTrue(lines[1].includes('3364202298717566229'), '第一行应包含第一个订单号');
  assertTrue(lines[1].includes('白色'), '第一行应包含规格 1');
  assertTrue(lines[1].includes('M'), '第一行应包含规格 2');
  
  assertTrue(lines[2].includes('3364342266781566229'), '第二行应包含第二个订单号');
  assertTrue(lines[2].includes('充电款'), '第二行应包含唯一规格');
  
  assertTrue(lines[3].includes('3364342266781566230'), '第三行应包含第三个订单号');
});

runTest('集成测试 - CSV 文件可被 Excel 正确解析', function() {
  var excelRows = [];
  for (var i = 0; i < mockOrders.length; i++) {
    excelRows.push(convertOrderToExcelRow(mockOrders[i]));
  }
  
  var csvContent = generateCSVContent(excelRows);
  
  // 保存 CSV 到临时文件
  var tempFilePath = path.join(__dirname, 'temp_test_orders.csv');
  fs.writeFileSync(tempFilePath, csvContent, 'utf8');
  
  // 读取并验证
  var readContent = fs.readFileSync(tempFilePath, 'utf8');
  assertTrue(readContent.startsWith('\uFEFF'), '文件应以 BOM 头开始');
  
  // 清理临时文件
  fs.unlinkSync(tempFilePath);
  console.log('   📝 临时文件已清理:', tempFilePath);
});

runTest('集成测试 - 特殊字符处理', function() {
  var specialOrder = {
    order_no: 'TEST"001',
    goods: {
      title: '测试，商品"带引号"',
      quantity: 1,
      sku_text: ''
    },
    receiver_name: '张三，李四',
    receiver_mobile: '13800138000',
    prov_name: '',
    city_name: '',
    area_name: '',
    address: '测试地址，带"引号"'
  };
  
  var row = convertOrderToExcelRow(specialOrder);
  var csvContent = generateCSVContent([row]);
  
  // 验证引号被转义（双引号变""）
  assertTrue(csvContent.indexOf('""') > -1, '双引号应被转义为 ""');
  
  // 验证逗号在引号内
  var lines = csvContent.split('\n');
  var dataLine = lines[1];
  // 统计未被引号包裹的逗号数量
  var commaCount = 0;
  var inQuote = false;
  for (var i = 0; i < dataLine.length; i++) {
    if (dataLine[i] === '"') {
      inQuote = !inQuote;
    } else if (dataLine[i] === ',' && !inQuote) {
      commaCount++;
    }
  }
  assertEqual(commaCount, 14, '应有 14 个分隔逗号（15 列）');
});

// ==================== 性能测试 ====================

runTest('性能测试 - 大批量订单转换', function() {
  // 生成 100 个 mock 订单
  var largeOrders = [];
  for (var i = 0; i < 100; i++) {
    largeOrders.push(JSON.parse(JSON.stringify(mockOrders[i % 3])));
  }
  
  var startTime = Date.now();
  
  var excelRows = [];
  for (var i = 0; i < largeOrders.length; i++) {
    excelRows.push(convertOrderToExcelRow(largeOrders[i]));
  }
  
  var csvContent = generateCSVContent(excelRows);
  
  var endTime = Date.now();
  var duration = endTime - startTime;
  
  console.log('   ⏱️ 处理 100 个订单耗时:', duration, 'ms');
  assertTrue(duration < 1000, '应在 1 秒内完成（实际：' + duration + 'ms）');
  
  var lines = csvContent.split('\n');
  assertEqual(lines.length, 101, '应有 1 行表头 +100 行数据');
});

// ==================== 测试结果汇总 ====================

console.log('\n========================================');
console.log('📊 集成测试结果汇总:');
console.log('   ✅ 通过:', passedTests);
console.log('   ❌ 失败:', failedTests);
console.log('   📝 总计:', passedTests + failedTests);
console.log('========================================\n');

if (failedTests > 0) {
  console.error('❌ 部分集成测试未通过，请检查实现代码');
  process.exit(1);
} else {
  console.log('✅ 所有集成测试通过！');
  console.log('\n💡 提示：在实际使用前，需要配置闲管家 API 凭证并进行真实 API 调用测试');
}
