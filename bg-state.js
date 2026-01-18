/**
 * bg-state.js - 状态定义与 Schema 配置
 */

/**
 * 商品数据标准结构
 * 所有采集的数据都应该符合这个结构
 */
var PRODUCT_SCHEMA = {
    itemId: { type: 'string', label: '商品ID', csvOrder: 1, feishuType: 1 },
    title: { type: 'string', label: '商品标题', csvOrder: 2, feishuType: 1 },
    price: { type: 'string', label: '价格', csvOrder: 3, feishuType: 1 },
    priceNumber: { type: 'number', label: '价格数值', csvOrder: 0, feishuType: 2, feishuField: '价格' }, // 不导出到CSV，仅用于飞书
    originalPrice: { type: 'string', label: '原价', csvOrder: 4, feishuType: 1 },
    originalPriceNumber: { type: 'number', label: '原价数值', csvOrder: 0, feishuType: 2, feishuField: '原价' }, // 不导出到CSV，仅用于飞书
    wantCnt: { type: 'number', label: '想要人数', csvOrder: 5, feishuType: 2 },
    publishTime: { type: 'string', label: '发布时间', csvOrder: 6, feishuType: 1 },
    publishTimeMs: { type: 'number', label: '发布时间戳', csvOrder: 0, feishuType: 5, feishuField: '发布时间' }, // 不导出到CSV，仅用于飞书
    captureTime: { type: 'string', label: '采集时间', csvOrder: 0, feishuType: 1 }, // 不导出到CSV
    captureTimeMs: { type: 'number', label: '采集时间戳', csvOrder: 0, feishuType: 5, feishuField: '采集时间' }, // 不导出到CSV，仅用于飞书
    sellerNick: { type: 'string', label: '卖家昵称', csvOrder: 7, feishuType: 1 },
    sellerCity: { type: 'string', label: '地区', csvOrder: 8, feishuType: 1 },
    freeShip: { type: 'string', label: '包邮', csvOrder: 10, feishuType: 1 },
    tags: { type: 'string', label: '商品标签', csvOrder: 11, feishuType: 1 },
    coverUrl: { type: 'string', label: '封面URL', csvOrder: 12, feishuType: 15 },
    detailUrl: { type: 'string', label: '商品详情URL', csvOrder: 13, feishuType: 15 },
    exposureHeat: { type: 'number', label: '曝光热度', csvOrder: 0, feishuType: 2 } // 不导出到CSV，仅用于飞书
};

// 从 SCHEMA 生成 CSV 表头（按 csvOrder 排序，跳过 csvOrder 为 0 的字段）
function getCSVHeaders() {
    return Object.entries(PRODUCT_SCHEMA)
        .filter(([key, config]) => config.csvOrder > 0)
        .sort((a, b) => a[1].csvOrder - b[1].csvOrder)
        .map(([key, config]) => config.label);
}

// 从 SCHEMA 生成飞书字段配置
function getFeishuFieldConfigs() {
    const configs = [];
    const addedFields = new Set();

    // 先处理有 feishuField 的字段（优先级更高，如 priceNumber 使用数字类型）
    Object.entries(PRODUCT_SCHEMA)
        .filter(([key, config]) => config.feishuField)
        .forEach(([key, config]) => {
            const fieldName = config.feishuField;
            if (!addedFields.has(fieldName)) {
                configs.push({
                    name: fieldName,
                    type: config.feishuType
                });
                addedFields.add(fieldName);
            }
        });

    // 再处理没有 feishuField 的字段（使用 label）
    Object.entries(PRODUCT_SCHEMA)
        .filter(([key, config]) => !config.feishuField)
        .forEach(([key, config]) => {
            const fieldName = config.label;
            if (!addedFields.has(fieldName)) {
                configs.push({
                    name: fieldName,
                    type: config.feishuType
                });
                addedFields.add(fieldName);
            }
        });

    // 添加关键字字段（不在 schema 中，但飞书需要）
    configs.unshift({ name: '关键字', type: 1 });

    return configs;
}

// 商品表字段配置（从 PRODUCT_SCHEMA 自动生成）
var PRODUCT_FIELD_CONFIGS = getFeishuFieldConfigs();

// ==================== 全局状态变量 ====================

// ----- 采集数据状态 -----
var capturedData = [];                    // 采集到的原始页面数据
var capturedItemIds = new Set();          // 用于采集时去重的商品组合键集合（商品ID+想要数+价格）
var requestLogs = [];                     // 存储每次请求的URL、参数 and 返回值
var currentKeyword = '';                  // 当前搜索关键词

// ----- 采集统计信息 -----
var statistics = {
    pageCount: 0,                           // 有效采集页数（有新商品的页面）
    requestCount: 0,                        // 实际请求页数（总请求数）
    itemCount: 0,                           // 商品总数
    lastCaptureTime: null                   // 最后采集时间
};

// ----- 过滤条件配置 -----
var filterConfig = {
    minWantCnt: 0,                          // 最小想要人数
    minPrice: 0,                            // 最小价格
    maxPrice: 0,                            // 最大价格（0表示不限）
    onlyFreeShip: false                     // 只看包邮
};

// ----- 通用配置选项 -----
var config = {
    autoFetchDetail: false,                 // 是否自动调用详情API
    detailFetchDelay: 1000                  // 详情API请求间隔(ms)
};

// ----- 飞书 API 配置 -----
var feishuConfig = {
    appId: '',                              // 飞书应用 App ID
    appSecret: '',                          // 飞书应用 App Secret
    spreadsheetToken: '',                   // 多维表格 Token
    productTableId: '',                     // 商品表 ID
    sellerTableId: '',                      // 商家表 ID
    enabled: false,                         // 是否启用飞书同步
    autoCreateTable: false,                 // 是否自动创建表格
    parentFolderToken: '',                  // 父文件夹 token（可选）
    realtimeSync: false,                    // 边爬边同步
    batchSize: 100                          // 批量发送大小
};

var tenantAccessToken = null;             // 飞书租户访问令牌缓存
var tokenExpireTime = 0;                  // 令牌过期时间
var keywordTableMap = {};                 // 关键词与数据表的映射关系

// ----- 异步飞书同步状态 -----
var asyncSyncState = {
    enabled: false,                         // 是否启用边爬边同步（与 feishuConfig.realtimeSync 同步）
    batchSize: 100,                         // 每批发送数量（与 feishuConfig.batchSize 同步）
    pendingItems: [],                       // 待发送的商品处理后数据
    isSending: false,                       // 是否正在发送
    syncedCount: 0,                         // 已同步商品数
    failedCount: 0,                         // 失败数量
    lastSyncTime: null                      // 最后同步时间
};

// ==================== 状态管理器 (无状态重构核心) ====================

// 定义全局状态管理器
var FishOpsState = {
    // 需要持久化的状态键名
    keys: [
        'capturedData', 'capturedItemIds', 'requestLogs', 'statistics',
        'config', 'currentKeyword', 'minWantCnt', 'minPrice', 'maxPrice',
        'onlyFreeShip', 'feishuConfig', 'keywordTableMap', 'asyncSyncState'
    ],

    // 异步获取最新状态并同步到当前内存变量
    async sync() {
        return new Promise(resolve => {
            chrome.storage.local.get(this.keys, (result) => {
                if (result.capturedData) capturedData = result.capturedData;
                if (result.capturedItemIds) capturedItemIds = new Set(result.capturedItemIds);
                if (result.requestLogs) requestLogs = result.requestLogs;
                if (result.statistics) statistics = result.statistics;
                if (result.config) config = { ...config, ...result.config };
                // 只在 currentKeyword 还未在内存中设置时才从 storage 加载
                // 避免覆盖刚通过 SET_KEYWORD 设置的新值（解决竞争条件）
                if (result.currentKeyword && !currentKeyword) {
                    currentKeyword = result.currentKeyword;
                }

                if (result.minWantCnt !== undefined) filterConfig.minWantCnt = result.minWantCnt;
                if (result.minPrice !== undefined) filterConfig.minPrice = result.minPrice;
                if (result.maxPrice !== undefined) filterConfig.maxPrice = result.maxPrice;
                if (result.onlyFreeShip !== undefined) filterConfig.onlyFreeShip = result.onlyFreeShip;

                // 合并飞书配置（只覆盖存在的字段，避免 undefined 覆盖现有值）
                if (result.feishuConfig) {
                    Object.keys(result.feishuConfig).forEach(key => {
                        if (result.feishuConfig[key] !== undefined) {
                            feishuConfig[key] = result.feishuConfig[key];
                        }
                    });
                }

                if (result.keywordTableMap) keywordTableMap = result.keywordTableMap;

                // 同步异步同步状态
                if (result.asyncSyncState) {
                    const { pendingItems, syncedCount, failedCount, lastSyncTime } = result.asyncSyncState;
                    asyncSyncState.pendingItems = pendingItems || [];
                    asyncSyncState.syncedCount = syncedCount || 0;
                    asyncSyncState.failedCount = failedCount || 0;
                    asyncSyncState.lastSyncTime = lastSyncTime || null;
                }

                // 关键配置覆盖运行状态（使用默认值保护）
                asyncSyncState.enabled = feishuConfig.realtimeSync || false;
                asyncSyncState.batchSize = feishuConfig.batchSize || 100;

                console.log('[闲鱼采集] 状态层同步完成');
                resolve(result);
            });
        });
    },

    // 安全更新状态并持久化
    async update(updates) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.set(updates, () => {
                if (chrome.runtime.lastError) {
                    console.error('[FishOpsState] ❌ Storage update failed:', chrome.runtime.lastError);
                    reject(chrome.runtime.lastError);
                } else {
                    // 更新后立即同步一次，确保内存变量也是最新的
                    this.sync().then(resolve);
                }
            });
        });
    }
};

// 监听存储变化，自动同步到内存变量
// 注意：不监听 'feishuConfig' 和 'asyncSyncState' 的变化，因为这些在 update() 中已经处理
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
        // 如果只有 feishuConfig 或 asyncSyncState 变化，跳过同步（避免重复同步）
        const changedKeys = Object.keys(changes);
        const onlyConfigChanged = changedKeys.length === 1 &&
            (changedKeys[0] === 'feishuConfig' || changedKeys[0] === 'asyncSyncState');
        if (!onlyConfigChanged) {
            FishOpsState.sync();
        }
    }
});

// 初始化加载
FishOpsState.sync().then(() => {
    console.log('[闲鱼采集] bg-state.js 状态初始化完成');
});
