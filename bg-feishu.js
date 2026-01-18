/**
 * bg-feishu.js - 飞书 API 集成逻辑
 */

// ----- 飞书 API 配置 -----
const FEISHU_API_BASE = 'https://open.feishu.cn';

// 获取租户访问令牌
async function getTenantAccessToken() {
    // 如果令牌未过期,直接返回
    if (tenantAccessToken && Date.now() < tokenExpireTime) {
        console.log('[闲鱼采集-飞书] 使用缓存的访问令牌');
        return tenantAccessToken;
    }

    console.log('[闲鱼采集-飞书] 开始获取新的访问令牌...');

    try {
        const url = `${FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`;
        console.log('[闲鱼采集-飞书] Token API URL:', url);

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                app_id: feishuConfig.appId,
                app_secret: feishuConfig.appSecret
            })
        });

        console.log('[闲鱼采集-飞书] Token API 响应状态:', response.status, response.statusText);

        const text = await response.text();
        console.log('[闲鱼采集-飞书] Token API 完整响应:', text);

        let data;
        try {
            data = JSON.parse(text);
        } catch (parseError) {
            console.error('[闲鱼采集-飞书] Token API 响应解析失败:', parseError);
            throw new Error(`无法解析 Token API 响应: ${text}`);
        }

        if (data.code !== 0) {
            console.error('[闲鱼采集-飞书] 获取访问令牌失败:', data);
            throw new Error(data.msg || '获取访问令牌失败');
        }

        tenantAccessToken = data.tenant_access_token;
        // 提前5分钟过期
        tokenExpireTime = Date.now() + (data.expire - 300) * 1000;

        console.log('[闲鱼采集-飞书] 访问令牌已更新，有效期:', data.expire, '秒');
        console.log('[闲鱼采集-飞书] 新令牌:', tenantAccessToken ? `${tenantAccessToken.substring(0, 20)}...` : 'null');
        return tenantAccessToken;
    } catch (error) {
        console.error('[闲鱼采集-飞书] 获取访问令牌异常:', error);
        throw error;
    }
}

// 测试飞书连接
async function testFeishuConnection(config) {
    try {
        const testConfig = { ...feishuConfig, ...config };

        console.log(`\n========== 测试飞书连接 ==========`);
        console.log(`[闲鱼采集-飞书] App ID: ${testConfig.appId ? `${testConfig.appId.substring(0, 15)}...` : '未设置'}`);
        console.log(`[闲鱼采集-飞书] App Secret: ${testConfig.appSecret ? `${testConfig.appSecret.substring(0, 15)}...` : '未设置'}`);
        console.log(`[闲鱼采集-飞书] API 基础地址: ${FEISHU_API_BASE}`);

        const response = await fetch(`${FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                app_id: testConfig.appId,
                app_secret: testConfig.appSecret
            })
        });

        console.log(`[闲鱼采集-飞书] Token API HTTP 状态: ${response.status}`);
        const data = await response.json();
        console.log(`[闲鱼采集-飞书] Token API 响应:`, JSON.stringify(data, null, 2));

        if (data.code !== 0) {
            console.error(`========================================\n`);
            return { success: false, error: `认证失败 (code: ${data.code}): ${data.msg || '未知错误'}` };
        }

        console.log(`[闲鱼采集-飞书] ✓ 认证成功`);

        // 如果配置了表格,也测试表格访问
        if (testConfig.spreadsheetToken && testConfig.productTableId) {
            console.log(`[闲鱼采集-飞书] 测试表格访问...`);
            console.log(`[闲鱼采集-飞书] Spreadsheet Token: ${testConfig.spreadsheetToken}`);
            console.log(`[闲鱼采集-飞书] Product Table ID: ${testConfig.productTableId}`);

            const tableResponse = await fetch(
                `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${testConfig.spreadsheetToken}/tables/${testConfig.productTableId}/records?page_size=1`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${data.tenant_access_token}`
                    }
                }
            );

            console.log(`[闲鱼采集-飞书] 表格 API HTTP 状态: ${tableResponse.status}`);
            const tableData = await tableResponse.json();
            console.log(`[闲鱼采集-飞书] 表格 API 响应:`, JSON.stringify(tableData, null, 2));

            if (tableData.code !== 0) {
                console.error(`========================================\n`);
                return { success: false, error: `表格访问失败 (code: ${tableData.code}): ${tableData.msg}` };
            }

            console.log(`[闲鱼采集-飞书] ✓ 表格访问成功`);
        }

        console.log(`========================================\n`);
        return { success: true };
    } catch (error) {
        console.error(`[闲鱼采集-飞书] 测试连接异常:`, error);
        console.error(`========================================\n`);
        return { success: false, error: error.message };
    }
}

// 获取表格字段列表
async function getTableFields(tableId, appToken) {
    const accessToken = await getTenantAccessToken();

    // 使用传入的 appToken，如果没有则使用 feishuConfig.spreadsheetToken
    const token = appToken || feishuConfig.spreadsheetToken;
    if (!token) {
        throw new Error('缺少 appToken，无法获取字段列表');
    }

    try {
        const response = await fetch(
            `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${token}/tables/${tableId}/fields`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );

        const data = await response.json();

        if (data.code !== 0) {
            console.error('[闲鱼采集-飞书] 获取字段列表失败:', data);
            throw new Error(data.msg || '获取字段列表失败');
        }

        return data.data?.items || [];
    } catch (error) {
        console.error('[闲鱼采集-飞书] 获取字段列表异常:', error);
        throw error;
    }
}

// 创建表格字段
async function createTableField(appToken, tableId, fieldConfig) {
    const token = await getTenantAccessToken();

    try {
        const response = await fetch(
            `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    field_name: fieldConfig.name,
                    type: fieldConfig.type
                })
            }
        );

        const data = await response.json();

        if (data.code !== 0) {
            console.error(`[闲鱼采集-飞书] 创建字段失败 [${fieldConfig.name}]:`, data);
            throw new Error(data.msg || `创建字段失败: ${fieldConfig.name}`);
        }

        console.log(`[闲鱼采集-飞书] 成功创建字段: ${fieldConfig.name}`);
        return data.data?.field;
    } catch (error) {
        console.error(`[闲鱼采集-飞书] 创建字段异常 [${fieldConfig.name}]:`, error);
        throw error;
    }
}

// 确保表格字段存在
async function ensureTableFields(tableId, fieldConfigs, appToken) {
    console.log(`[闲鱼采集-飞书] 开始检查表格字段...`);

    // 使用传入的 appToken，如果没有则使用 feishuConfig.spreadsheetToken
    const token = appToken || feishuConfig.spreadsheetToken;
    if (!token) {
        throw new Error('缺少 appToken，无法创建字段');
    }

    // 获取现有字段
    const existingFields = await getTableFields(tableId, token);
    const existingFieldNames = new Set(existingFields.map(f => f.field_name));

    console.log(`[闲鱼采集-飞书] 现有字段:`, Array.from(existingFieldNames));

    // 找出缺失的字段
    const missingFields = fieldConfigs.filter(config => !existingFieldNames.has(config.name));

    if (missingFields.length === 0) {
        console.log(`[闲鱼采集-飞书] 所有字段已存在`);
        return;
    }

    console.log(`[闲鱼采集-飞书] 需要创建 ${missingFields.length} 个字段:`, missingFields.map(f => f.name));

    // 逐个创建缺失的字段
    for (const fieldConfig of missingFields) {
        await createTableField(token, tableId, fieldConfig);
        // 避免速率限制
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log(`[闲鱼采集-飞书] 字段创建完成`);
}

// 转换商品数据为飞书记录格式（使用 PRODUCT_SCHEMA 自动转换）
function convertProductToFeishuRecord(item) {
    const fields = {
        // 添加关键字字段（不在 schema 中）
        '关键字': String(currentKeyword || '')
    };

    const processedFields = new Set(); // 用于记录已处理的飞书字段名

    // 先处理有 feishuField 的字段（优先级更高）
    Object.entries(PRODUCT_SCHEMA)
        .filter(([key, config]) => config.feishuField)
        .forEach(([key, config]) => {
            const fieldName = config.feishuField;
            const value = item[key];

            if (!processedFields.has(fieldName)) {
                // 根据飞书字段类型转换数据
                if (config.feishuType === 1) {
                    // 文本类型
                    fields[fieldName] = String(value || '');
                } else if (config.feishuType === 2) {
                    // 数字类型
                    fields[fieldName] = Number(value) || 0;
                } else if (config.feishuType === 5) {
                    // 日期类型（时间戳）
                    fields[fieldName] = value || null;
                } else if (config.feishuType === 15) {
                    // URL类型
                    const url = normalizeUrl(value || '');
                    fields[fieldName] = url ? { link: url } : null;
                } else {
                    // 默认处理
                    fields[fieldName] = value;
                }
                processedFields.add(fieldName);
            }
        });

    // 再处理没有 feishuField 的字段（使用 label）
    Object.entries(PRODUCT_SCHEMA)
        .filter(([key, config]) => !config.feishuField)
        .forEach(([key, config]) => {
            const fieldName = config.label;
            const value = item[key];

            if (!processedFields.has(fieldName)) {
                // 根据飞书字段类型转换数据
                if (config.feishuType === 1) {
                    // 文本类型
                    fields[fieldName] = String(value || '');
                } else if (config.feishuType === 2) {
                    // 数字类型
                    fields[fieldName] = Number(value) || 0;
                } else if (config.feishuType === 5) {
                    // 日期类型（时间戳）
                    fields[fieldName] = value || null;
                } else if (config.feishuType === 15) {
                    // URL类型
                    const url = normalizeUrl(value || '');
                    fields[fieldName] = url ? { link: url } : null;
                } else {
                    // 默认处理
                    fields[fieldName] = value;
                }
                processedFields.add(fieldName);
            }
        });

    return { fields };
}

// 获取表格中已存在的商品组合键（用于去重）
async function getExistingItemIds(tableId) {
    const token = await getTenantAccessToken();
    const existingKeys = new Set();

    try {
        let hasMore = true;
        let pageToken = undefined;

        while (hasMore) {
            const url = new URL(`${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${feishuConfig.spreadsheetToken}/tables/${tableId}/records`);
            url.searchParams.append('page_size', '500');
            url.searchParams.append('field_names', '["商品ID", "想要人数", "价格"]');
            if (pageToken) {
                url.searchParams.append('page_token', pageToken);
            }

            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            const data = await response.json();

            if (data.code !== 0) {
                console.error('[闲鱼采集-飞书] 获取已存在商品失败:', data);
                throw new Error(data.msg || '获取已存在商品失败');
            }

            // 收集商品组合键（商品ID + 想要数 + 价格）
            (data.data?.items || []).forEach(item => {
                const itemId = item.fields?.['商品ID'];
                const wantCnt = item.fields?.['想要人数'] || 0;
                const price = item.fields?.['价格'] || 0;
                if (itemId) {
                    const compositeKey = `${itemId}_${wantCnt}_${price}`;
                    existingKeys.add(compositeKey);
                }
            });

            hasMore = data.data?.has_more || false;
            pageToken = data.data?.page_token;

            // 避免速率限制
            if (hasMore) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        console.log(`[闲鱼采集-飞书] 已存在的商品组合键数量: ${existingKeys.size}`);
        return existingKeys;
    } catch (error) {
        console.error('[闲鱼采集-飞书] 获取已存在商品异常:', error);
        // 如果获取失败，返回空集合，继续执行（不影响主流程）
        return new Set();
    }
}

// 批量创建记录
async function batchCreateRecords(tableId, records) {
    const token = await getTenantAccessToken();

    // 飞书 API 每次最多创建 500 条记录
    const batchSize = 500;
    const results = [];

    for (let batchStartIndex = 0; batchStartIndex < records.length; batchStartIndex += batchSize) {
        const batch = records.slice(batchStartIndex, batchStartIndex + batchSize);

        try {
            const url = `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${feishuConfig.spreadsheetToken}/tables/${tableId}/records/batch_create`;
            console.log('[闲鱼采集-飞书] 请求 URL:', url);
            console.log('[闲鱼采集-飞书] 请求数据数量:', batch.length);

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    records: batch
                })
            });

            console.log('[闲鱼采集-飞书] HTTP 响应状态:', response.status, response.statusText);

            const data = await response.json();
            console.log('[闲鱼采集-飞书] 响应数据:', data);

            if (data.code !== 0) {
                console.error('[闲鱼采集-飞书] 批量创建记录失败:', data);
                throw new Error(data.msg || '批量创建记录失败');
            }

            results.push(...(data.data?.records || []));
            console.log(`[闲鱼采集-飞书] 成功创建 ${batch.length} 条记录`);

            // 速率限制: 每次请求后等待 200ms
            if (batchStartIndex + batchSize < records.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        } catch (error) {
            console.error('[闲鱼采集-飞书] 批量创建记录异常:', error);
            throw error;
        }
    }

    return results;
}

// 发送数据到飞书
async function sendToFeishu(processedData) {
    // 注意：此函数用于手动发送，不检查 enabled 开关（enabled 仅控制自动同步行为）
    if (!feishuConfig.appId || !feishuConfig.appSecret) {
        return { success: false, error: '请先配置飞书 App ID 和 App Secret' };
    }

    // ========== 自动创建数据表逻辑 ==========
    // 如果启用了自动创建表格，且有关键词
    if (feishuConfig.autoCreateTable && currentKeyword) {
        console.log('[闲鱼采集-飞书] 自动创建数据表模式已启用');

        // 检查是否配置了 spreadsheetToken
        if (!feishuConfig.spreadsheetToken) {
            return { success: false, error: '请先配置飞书表格 Token，或者关闭「自动创建表格」功能' };
        }

        console.log(`[闲鱼采集-飞书] 当前关键词: ${currentKeyword}`);
        console.log(`[闲鱼采集-飞书] 表格 Token: ${feishuConfig.spreadsheetToken}`);

        // 获取飞书中实际存在的数据表列表
        let existingTables;
        try {
            console.log(`[闲鱼采集-飞书] 获取现有数据表列表...`);
            existingTables = await getDataTableList(feishuConfig.spreadsheetToken);
        } catch (error) {
            console.error('[闲鱼采集-飞书] 获取数据表列表失败:', error);
            return { success: false, error: `获取数据表列表失败: ${error.message}` };
        }

        // 检查映射中的表格是否真实存在于飞书中
        const cachedMapping = keywordTableMap[currentKeyword];
        let needsCreate = true;

        if (cachedMapping && cachedMapping.productTableId) {
            // 验证缓存的 tableId 是否在飞书中真实存在
            const tableExists = existingTables.some(t => t.tableId === cachedMapping.productTableId);
            if (tableExists) {
                needsCreate = false;
                console.log(`[闲鱼采集-飞书] 使用缓存的表格 ID: ${cachedMapping.productTableId}`);
            } else {
                console.warn(`[闲鱼采集-飞书] 缓存的表格 ${cachedMapping.productTableId} 已不存在，将重新创建`);
                // 清除无效的映射
                delete keywordTableMap[currentKeyword];
            }
        }

        if (needsCreate) {
            console.log(`[闲鱼采集-飞书] 关键词 "${currentKeyword}" 需要创建数据表...`);

            try {
                // 检查是否有同名表可以复用
                const existingTable = existingTables.find(t => t.tableName === currentKeyword);

                let productTable;

                if (existingTable) {
                    // 找到已存在的同名表，直接使用
                    console.log(`[闲鱼采集-飞书] 找到已存在的数据表: ${currentKeyword} (ID: ${existingTable.tableId})`);
                    productTable = {
                        tableId: existingTable.tableId,
                        name: existingTable.tableName
                    };
                } else {
                    // 不存在，创建新的数据表
                    console.log(`[闲鱼采集-飞书] 创建新的商品数据表: ${currentKeyword}`);
                    productTable = await createDataTable(feishuConfig.spreadsheetToken, currentKeyword, PRODUCT_FIELD_CONFIGS);
                    console.log(`[闲鱼采集-飞书] 商品表创建成功:`, productTable);
                }

                // 保存映射关系
                keywordTableMap[currentKeyword] = {
                    spreadsheetToken: feishuConfig.spreadsheetToken,
                    productTableId: productTable.tableId,
                    productTableName: productTable.name,
                    createTime: Date.now(),
                    updateTime: Date.now()
                };

                console.log(`[闲鱼采集-飞书] 映射关系:`, keywordTableMap[currentKeyword]);

                // 持久化到 storage
                await FishOpsState.update({ keywordTableMap });

                console.log('[闲鱼采集-飞书] 数据表准备完成，映射关系已保存');
            } catch (error) {
                console.error('[闲鱼采集-飞书] 自动创建数据表失败:', error);
                console.error('[闲鱼采集-飞书] 错误堆栈:', error.stack);
                return { success: false, error: `自动创建数据表失败: ${error.message}` };
            }
        }

        // 更新当前使用的配置为关键词对应的数据表配置
        const mapping = keywordTableMap[currentKeyword];
        feishuConfig.productTableId = mapping.productTableId;
        console.log(`[闲鱼采集-飞书] 当前使用的商品表ID: ${feishuConfig.productTableId}`);
    }

    // 检查必要的配置
    if (!feishuConfig.spreadsheetToken || !feishuConfig.productTableId) {
        return { success: false, error: '请先配置飞书表格 Token 和商品表 ID，或启用「自动创建表格」功能' };
    }

    try {
        // 自动创建商品表字段
        console.log('[闲鱼采集-飞书] 开始检查并创建商品表字段...');
        await ensureTableFields(feishuConfig.productTableId, PRODUCT_FIELD_CONFIGS);

        console.log('[闲鱼采集-飞书] 当前关键词:', currentKeyword);
        console.log('[闲鱼采集-飞书] 处理后数据量:', processedData.length);

        // 打印前3条数据，检查是否有空值
        if (processedData.length > 0) {
            console.log('[闲鱼采集-飞书] 第1条数据:', {
                itemId: processedData[0].itemId,
                title: processedData[0].title?.substring(0, 20),
                price: processedData[0].price,
                hasAllFields: !!(processedData[0].itemId && processedData[0].title)
            });
        }

        const productRecords = processedData
            .filter(item => {
                // 过滤掉关键字段为空的记录
                const hasValidData = item.itemId && item.title;
                if (!hasValidData) {
                    console.warn('[闲鱼采集-飞书] 过滤空记录:', item);
                }
                return hasValidData;
            })
            .map(convertProductToFeishuRecord);

        console.log('[闲鱼采集-飞书] 过滤后的记录数:', productRecords.length);

        // 获取已存在的商品组合键，用于去重
        console.log('[闲鱼采集-飞书] 开始获取已存在的商品组合键...');
        const existingItemKeys = await getExistingItemIds(feishuConfig.productTableId);

        // 过滤掉已存在的商品（根据组合键）
        const newProductRecords = productRecords.filter(record => {
            const itemId = record.fields['商品ID'];
            const wantCnt = record.fields['想要人数'] || 0;
            const priceNum = record.fields['价格'] || 0;
            const compositeKey = `${itemId}_${wantCnt}_${priceNum}`;
            const isNew = !existingItemKeys.has(compositeKey);
            if (!isNew) {
                console.log(`[闲鱼采集-飞书] 跳过已存在的商品: ${compositeKey}`);
            }
            return isNew;
        });

        console.log(`[闲鱼采集-飞书] 去重后待创建的记录数: ${newProductRecords.length}/${productRecords.length}`);

        // 如果没有新记录，直接返回
        if (newProductRecords.length === 0) {
            console.log('[闲鱼采集-飞书] 没有新记录需要创建');
            return {
                success: true,
                productCount: 0,
                message: '所有商品已存在，未添加新记录'
            };
        }

        // 创建商品记录
        const productResults = await batchCreateRecords(feishuConfig.productTableId, newProductRecords);

        return {
            success: true,
            productCount: productResults.length
        };
    } catch (error) {
        console.error('[闲鱼采集-飞书] 发送数据失败:', error);
        return { success: false, error: error.message };
    }
}

// 触发异步批量发送
async function triggerAsyncBatchSend() {
    if (asyncSyncState.isSending || asyncSyncState.pendingItems.length === 0) {
        return;
    }

    asyncSyncState.isSending = true;

    // 取出当前批次的商品
    const batch = asyncSyncState.pendingItems.splice(0, asyncSyncState.batchSize);
    const batchCount = batch.length;

    console.log(`[闲鱼采集-异步同步] 开始发送批次，数量: ${batchCount}`);

    try {
        const result = await sendBatchToFeishu(batch);

        if (result.success) {
            // 统计实际发送的数量（不是去重后的数量）
            asyncSyncState.syncedCount += batchCount;
            asyncSyncState.lastSyncTime = new Date().toLocaleString();
            console.log(`[闲鱼采集-异步同步] ✅ 批次发送成功，本批: ${batchCount}, 实际新增: ${result.productCount || 0}, 累计已同步: ${asyncSyncState.syncedCount}`);
        } else {
            asyncSyncState.failedCount += batchCount;
            console.error(`[闲鱼采集-异步同步] ❌ 批次发送失败:`, result.error);
        }
    } catch (error) {
        asyncSyncState.failedCount += batchCount;
        console.error(`[闲鱼采集-异步同步] ❌ 批次发送异常:`, error);
    } finally {
        asyncSyncState.isSending = false;

        // 持久化当前进度
        await FishOpsState.update({ asyncSyncState });

        // 如果还有待发送的数据，继续发送（不再要求达到 batchSize）
        if (asyncSyncState.pendingItems.length > 0) {
            console.log(`[闲鱼采集-异步同步] 继续发送下一批次，剩余: ${asyncSyncState.pendingItems.length}`);
            triggerAsyncBatchSend(); // 直接调用，由 isSending 锁保护
        }
    }
}

// 发送剩余的待发送数据（爬取完成时调用）
async function flushPendingItems() {
    console.log(`[闲鱼采集-异步同步] flushPendingItems 被调用，当前待发送: ${asyncSyncState.pendingItems.length}, isSending: ${asyncSyncState.isSending}`);

    // 等待正在进行的发送完成（最多等待30秒）
    let waitCount = 0;
    while (asyncSyncState.isSending && waitCount < 60) {
        console.log(`[闲鱼采集-异步同步] 等待正在进行的发送完成... (${waitCount * 500}ms)`);
        await new Promise(resolve => setTimeout(resolve, 500));
        waitCount++;
    }

    // 再次检查是否有待发送数据（可能在等待期间被其他批次发送掉了）
    if (asyncSyncState.pendingItems.length === 0) {
        console.log('[闲鱼采集-异步同步] 无待发送数据（可能已被前序批次处理）');
        return { success: true, count: 0, message: '无待发送数据' };
    }

    const pendingCount = asyncSyncState.pendingItems.length;
    console.log(`[闲鱼采集-异步同步] 开始发送剩余数据，数量: ${pendingCount}`);

    // 发送所有剩余数据
    const batch = asyncSyncState.pendingItems.splice(0, asyncSyncState.pendingItems.length);
    const batchCount = batch.length;

    try {
        asyncSyncState.isSending = true;
        const result = await sendBatchToFeishu(batch);

        if (result.success) {
            // 统计实际发送的数量
            asyncSyncState.syncedCount += batchCount;
            asyncSyncState.lastSyncTime = new Date().toLocaleString();
            console.log(`[闲鱼采集-异步同步] ✅ 剩余数据发送成功，本批: ${batchCount}, 实际新增: ${result.productCount || 0}, 累计已同步: ${asyncSyncState.syncedCount}`);
            return { success: true, count: batchCount };
        } else {
            asyncSyncState.failedCount += batchCount;
            console.error(`[闲鱼采集-异步同步] ❌ 剩余数据发送失败:`, result.error);
            return { success: false, error: result.error };
        }
    } catch (error) {
        asyncSyncState.failedCount += batchCount;
        console.error(`[闲鱼采集-异步同步] ❌ 剩余数据发送异常:`, error);
        return { success: false, error: error.message };
    } finally {
        asyncSyncState.isSending = false;
        // 持久化当前进度
        await FishOpsState.update({ asyncSyncState });
    }
}

// 批量发送数据到飞书（复用 sendToFeishu 的核心逻辑）
async function sendBatchToFeishu(batchData) {
    if (!batchData || batchData.length === 0) {
        return { success: true, productCount: 0 };
    }

    if (!feishuConfig.appId || !feishuConfig.appSecret) {
        return { success: false, error: '请先配置飞书 App ID 和 App Secret' };
    }

    // 如果启用了自动创建表格，且有关键词
    if (feishuConfig.autoCreateTable && currentKeyword) {
        if (!feishuConfig.spreadsheetToken) {
            return { success: false, error: '请先配置飞书表格 Token' };
        }

        // 获取飞书中实际存在的数据表列表
        let existingTables;
        try {
            existingTables = await getDataTableList(feishuConfig.spreadsheetToken);
        } catch (error) {
            return { success: false, error: `获取数据表列表失败: ${error.message}` };
        }

        // 检查映射中的表格是否真实存在于飞书中
        const cachedMapping = keywordTableMap[currentKeyword];
        let needsCreate = true;

        if (cachedMapping && cachedMapping.productTableId) {
            // 验证缓存的 tableId 是否在飞书中真实存在
            const tableExists = existingTables.some(t => t.tableId === cachedMapping.productTableId);
            if (tableExists) {
                needsCreate = false;
                console.log(`[闲鱼采集-飞书] 使用缓存的表格 ID: ${cachedMapping.productTableId}`);
            } else {
                console.warn(`[闲鱼采集-飞书] 缓存的表格 ${cachedMapping.productTableId} 已不存在，将重新创建`);
                // 清除无效的映射
                delete keywordTableMap[currentKeyword];
            }
        }

        if (needsCreate) {
            try {
                // 检查是否有同名表可以复用
                const existingTable = existingTables.find(t => t.tableName === currentKeyword);

                let productTable;
                if (existingTable) {
                    productTable = { tableId: existingTable.tableId, name: existingTable.tableName };
                    console.log(`[闲鱼采集-飞书] 找到同名表格: ${existingTable.tableId}`);
                } else {
                    productTable = await createDataTable(feishuConfig.spreadsheetToken, currentKeyword, PRODUCT_FIELD_CONFIGS);
                    console.log(`[闲鱼采集-飞书] 创建新表格: ${productTable.tableId}`);
                }

                keywordTableMap[currentKeyword] = {
                    spreadsheetToken: feishuConfig.spreadsheetToken,
                    productTableId: productTable.tableId,
                    productTableName: productTable.name,
                    createTime: Date.now(),
                    updateTime: Date.now()
                };

                await FishOpsState.update({ keywordTableMap });
            } catch (error) {
                return { success: false, error: `自动创建数据表失败: ${error.message}` };
            }
        }

        const mapping = keywordTableMap[currentKeyword];
        feishuConfig.productTableId = mapping.productTableId;
    }

    if (!feishuConfig.spreadsheetToken || !feishuConfig.productTableId) {
        return { success: false, error: '请先配置飞书表格 Token 和商品表 ID' };
    }

    try {
        // 确保字段存在
        await ensureTableFields(feishuConfig.productTableId, PRODUCT_FIELD_CONFIGS);

        const productRecords = batchData
            .filter(item => item.itemId && item.title)
            .map(convertProductToFeishuRecord);

        if (productRecords.length === 0) {
            return { success: true, productCount: 0, message: '无有效记录' };
        }

        // 获取已存在的商品组合键，用于去重
        const existingItemKeys = await getExistingItemIds(feishuConfig.productTableId);

        // 过滤掉已存在的商品
        const newProductRecords = productRecords.filter(record => {
            const itemId = record.fields['商品ID'];
            const wantCnt = record.fields['想要人数'] || 0;
            const priceNum = record.fields['价格'] || 0;
            const compositeKey = `${itemId}_${wantCnt}_${priceNum}`;
            return !existingItemKeys.has(compositeKey);
        });

        if (newProductRecords.length === 0) {
            return { success: true, productCount: 0, message: '所有商品已存在' };
        }

        // 创建商品记录
        const productResults = await batchCreateRecords(feishuConfig.productTableId, newProductRecords);

        return { success: true, productCount: productResults.length };
    } catch (error) {
        console.error('[闲鱼采集-异步同步] 批量发送失败:', error);
        return { success: false, error: error.message };
    }
}

// 获取指定多维表格下的所有数据表列表
async function getDataTableList(appToken) {
    const token = await getTenantAccessToken();

    try {
        let hasMore = true;
        let pageToken = undefined;
        const tables = [];

        while (hasMore) {
            const url = new URL(`${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${appToken}/tables`);
            url.searchParams.append('page_size', '100');
            if (pageToken) {
                url.searchParams.append('page_token', pageToken);
            }

            console.log(`[闲鱼采集-飞书] 获取数据表列表请求 URL:`, url.toString());

            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            console.log(`[闲鱼采集-飞书] 获取数据表列表 HTTP 状态: ${response.status} ${response.statusText}`);

            const text = await response.text();

            // 检查响应是否为 HTML（错误页面）
            if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html>') || text.trim().startsWith('<HTML>')) {
                throw new Error('飞书 API 返回错误页面，请检查应用权限');
            }

            if (!text || text.trim() === '') {
                throw new Error('飞书 API 返回空响应');
            }

            let data;
            try {
                data = JSON.parse(text);
            } catch (parseError) {
                throw new Error(`飞书 API 返回无效 JSON: ${text.substring(0, 100)}`);
            }

            if (data.code !== 0) {
                console.error('[闲鱼采集-飞书] 获取数据表列表失败:', data);
                throw new Error(data.msg || '获取数据表列表失败');
            }

            // 收集数据表信息
            (data.data?.items || []).forEach(table => {
                tables.push({
                    tableId: table.table_id,
                    tableName: table.name,
                    revision: table.revision
                });
            });

            hasMore = data.data?.has_more || false;
            pageToken = data.data?.page_token;

            if (hasMore) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        console.log(`[闲鱼采集-飞书] 获取到 ${tables.length} 个数据表`);
        return tables;
    } catch (error) {
        console.error('[闲鱼采集-飞书] 获取数据表列表异常:', error);
        throw error;
    }
}

// 创建数据表（先创建空表，再添加字段）
async function createDataTable(appToken, tableName, fieldConfigs) {
    const accessToken = await getTenantAccessToken();

    try {
        // 步骤1: 创建空的数据表（不指定字段）
        console.log(`[闲鱼采集-飞书] 准备创建数据表: ${tableName}`);
        console.log(`[闲鱼采集-飞书] appToken: ${appToken}`);

        const requestBody = {
            table: {
                name: tableName,
                default_view: {
                    type: 'grid'
                }
            }
        };
        console.log(`[闲鱼采集-飞书] 请求体:`, JSON.stringify(requestBody));

        const url = `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${appToken}/tables`;
        console.log(`[闲鱼采集-飞书] 请求 URL:`, url);

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        console.log(`[闲鱼采集-飞书] 创建数据表 HTTP 状态: ${response.status} ${response.statusText}`);

        const text = await response.text();
        console.log(`[闲鱼采集-飞书] 响应类型: ${response.headers.get('content-type')}`);
        console.log(`[闲鱼采集-飞书] 完整响应内容:`, text);

        // 检查响应是否为 HTML（错误页面）
        if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html>') || text.trim().startsWith('<HTML>')) {
            console.error(`[闲鱼采集-飞书] 收到 HTML 响应，可能 API URL 或权限有问题`);
            throw new Error('飞书 API 返回错误页面，请检查应用权限是否包含「查看、创建、编辑和删除多维表格」权限');
        }

        // 检查响应是否为空
        if (!text || text.trim() === '') {
            throw new Error('飞书 API 返回空响应，可能网络连接异常');
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch (parseError) {
            console.error(`[闲鱼采集-飞书] JSON 解析失败:`, parseError);
            throw new Error(`飞书 API 返回无效 JSON: ${text.substring(0, 100)}`);
        }

        if (data.code !== 0) {
            console.error(`[闲鱼采集-飞书] 创建数据表失败 [${tableName}]:`, data);
            throw new Error(data.msg || `创建数据表失败: ${tableName}`);
        }

        const tableId = data.data?.table_id;
        if (!tableId) {
            console.error(`[闲鱼采集-飞书] 响应数据结构异常:`, data);
            throw new Error('创建数据表成功，但无法获取表ID。响应数据: ' + JSON.stringify(data));
        }

        console.log(`[闲鱼采集-飞书] 成功创建空数据表: ${tableName} (ID: ${tableId})`);

        // 步骤2: 使用 ensureTableFields 添加字段（传递 appToken）
        console.log(`[闲鱼采集-飞书] 开始为表 ${tableName} 添加字段...`);
        await ensureTableFields(tableId, fieldConfigs, appToken);

        return {
            tableId: tableId,
            name: tableName
        };
    } catch (error) {
        console.error(`[闲鱼采集-飞书] 创建数据表异常 [${tableName}]:`, error);
        throw error;
    }
}
