/**
 * bg-csv.js - CSV 导出逻辑
 */

// 生成请求记录CSV数据
function generateRequestsCSV(logs) {
    if (!logs || logs.length === 0) {
        throw new Error('没有请求记录可导出');
    }

    // CSV表头
    const headers = [
        '序号', '请求时间', '请求方法', '请求URL', '基础URL', 'URL参数', '请求体(FormData)', '返回商品数', '返回数据'
    ];

    let csvContent = headers.join(',') + '\n';

    // 遍历所有请求记录
    logs.forEach((log, index) => {
        try {
            // 将URL参数转为JSON字符串
            const urlParamsStr = JSON.stringify(log.urlParams || {}).replace(/"/g, '""');

            // 将请求体转为JSON字符串
            const requestBodyStr = JSON.stringify(log.requestBody || '').replace(/"/g, '""');

            // 将返回数据转为JSON字符串
            const responseStr = JSON.stringify(log.response || {}).replace(/"/g, '""');

            // 构建CSV行
            const row = [
                index + 1,
                log.captureTime || '',
                log.method || 'GET',
                `"${(log.url || '').replace(/"/g, '""')}"`,
                `"${(log.baseUrl || '').replace(/"/g, '""')}"`,
                `"${urlParamsStr}"`,
                `"${requestBodyStr}"`,
                log.itemCount || 0,
                `"${responseStr}"`
            ];

            csvContent += row.join(',') + '\n';
        } catch (error) {
            console.error('[闲鱼采集] 处理请求记录出错:', error);
        }
    });

    return csvContent;
}

// 生成商品CSV数据（使用 PRODUCT_SCHEMA 自动生成）
function generateProductCSV(processedData) {
    if (!processedData || processedData.length === 0) {
        throw new Error('没有商品数据可导出');
    }

    // 使用 SCHEMA 生成 CSV 表头
    const headers = getCSVHeaders();
    let csvContent = headers.join(',') + '\n';

    // 获取需要导出的字段（按 csvOrder 排序）
    const fields = Object.entries(PRODUCT_SCHEMA)
        .filter(([key, config]) => config.csvOrder > 0)
        .sort((a, b) => a[1].csvOrder - b[1].csvOrder)
        .map(([key, config]) => key);

    // 遍历所有数据
    processedData.forEach(item => {
        try {
            const row = fields.map(fieldKey => {
                const value = item[fieldKey];
                const config = PRODUCT_SCHEMA[fieldKey];

                // 根据类型处理值
                if (value === null || value === undefined) {
                    return '';
                } else if (config.type === 'number') {
                    return value;
                } else {
                    // 字符串类型，需要转义引号
                    return `"${String(value).replace(/"/g, '""')}"`;
                }
            });

            csvContent += row.join(',') + '\n';
        } catch (error) {
            console.error('[闲鱼采集] 处理商品数据出错:', error, item);
        }
    });

    return csvContent;
}

// 生成商家CSV数据
function generateSellerCSV(processedData) {
    if (!processedData || processedData.length === 0) {
        throw new Error('没有商家数据可导出');
    }

    // CSV表头（移除详情相关字段）
    const headers = [
        '商家名称', '地点'
    ];

    let csvContent = headers.join(',') + '\n';

    // 用于去重的商家名称集合
    const seenSellerNicks = new Set();

    // 遍历所有数据，提取唯一商家
    processedData.forEach(item => {
        try {
            const sellerNick = item.sellerNick;
            // 如果没有商家名称，跳过
            if (!sellerNick || seenSellerNicks.has(sellerNick)) {
                return; // 跳过重复商家
            }
            seenSellerNicks.add(sellerNick);

            // 构建CSV行
            const row = [
                `"${(item.sellerNick || '').replace(/"/g, '""')}"`,
                `"${item.sellerCity || ''}"`
            ];

            csvContent += row.join(',') + '\n';
        } catch (error) {
            console.error('[闲鱼采集] 处理商家数据出错:', error, item);
        }
    });

    return csvContent;
}
