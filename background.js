try {
  // 加载辅助模块 (同步执行)
  importScripts('utils.js', 'bg-state.js', 'bg-utils.js', 'bg-csv.js', 'bg-feishu.js');
  console.log('[闲鱼采集] 所有辅助模块加载完成');
} catch (e) {
  console.error('[闲鱼采集] ❌ 模块加载失败:', e);
  if (e.stack) console.error(e.stack);
}

// 核验关键模块是否加载成功
if (typeof FishOpsState === 'undefined') {
  console.error('[闲鱼采集] ❌ 严重错误: FishOpsState 未定义，插件功能将无法正常运行');
}

// 监听来自content script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[闲鱼采集] Background收到消息:', request.type);

  // 统一异步处理逻辑
  const handleMessage = async () => {
    try {
      // 处理特定消息前同步最新状态
      const needsSync = [
        'API_DATA_CAPTURED', 'GET_STATS', 'EXPORT_CSV', 'EXPORT_REQUESTS',
        'EXPORT_PRODUCT_SELLER_CSV', 'SEND_TO_FEISHU', 'FLUSH_PENDING_ITEMS',
        'GET_KEYWORD', 'GET_FILTER_CONFIG', 'GET_CONFIG', 'GET_FEISHU_CONFIG'
      ].includes(request.type);

      if (needsSync) {
        await FishOpsState.sync();
      }

      // 设置当前关键词
      if (request.type === 'SET_KEYWORD') {
        currentKeyword = request.keyword || '';
        console.log('[闲鱼采集] 设置关键词:', currentKeyword);
        await FishOpsState.update({ currentKeyword: currentKeyword });
        sendResponse({ success: true });
        return;
      }

      // 获取当前关键词
      if (request.type === 'GET_KEYWORD') {
        sendResponse({ keyword: currentKeyword });
        return;
      }

      // 获取过滤条件配置
      if (request.type === 'GET_FILTER_CONFIG') {
        sendResponse({ config: filterConfig });
        return;
      }

      if (request.type === 'API_DATA_CAPTURED') {
        const apiData = request.data;
        const resultList = apiData.response?.data?.resultList || [];
        console.log('[闲鱼采集] 收到 API 数据:', apiData.apiType, '商品数:', resultList.length, 'asyncSyncState.enabled:', asyncSyncState.enabled);

        if (resultList.length > 0) {
          // 结构验证日志：检查第一个商品的路径
          const firstItem = resultList[0];
          console.log('[闲鱼采集] 结构核验(Item 0):', {
            hasMain: !!firstItem.data?.item?.main,
            hasExContent: !!firstItem.data?.item?.main?.exContent,
            itemId: firstItem.data?.item?.main?.clickParam?.args?.item_id || 'null'
          });
        }

        // 记录请求信息
        try {
          let fullUrl = apiData.url;
          if (fullUrl.startsWith('//')) {
            fullUrl = 'https:' + fullUrl;
          }
          const urlObj = new URL(fullUrl);
          const requestParams = {};
          urlObj.searchParams.forEach((value, key) => {
            requestParams[key] = value;
          });

          let parsedRequestBody = apiData.requestBody;
          if (typeof apiData.requestBody === 'string') {
            try {
              parsedRequestBody = JSON.parse(apiData.requestBody);
            } catch (e) { }
          }

          requestLogs.push({
            timestamp: apiData.timestamp,
            captureTime: new Date(apiData.timestamp).toLocaleString(),
            url: apiData.url,
            method: apiData.method || 'GET',
            baseUrl: urlObj.origin + urlObj.pathname,
            urlParams: requestParams,
            requestBody: parsedRequestBody,
            // 优化点：不存储完整的 API 响应，只存储提取后的结果
            // response: apiData.response, 
            itemCount: resultList.length
          });

        } catch (error) {
          console.error('[闲鱼采集] 记录请求信息失败:', error);
        }

        // 过滤已采集的商品并应用过滤条件
        let filteredByConditions = 0;
        let filteredByDuplicate = 0;
        const newItems = resultList.filter((item) => {
          const mainData = item.data?.item?.main;
          if (!mainData) return false;
          const exContent = mainData.exContent || {};
          const clickParam = mainData.clickParam?.args || {};
          const itemId = clickParam.item_id || exContent.itemId || '';

          if (!itemId) return false;

          // 提取想要人数
          const fishTags = exContent.fishTags || {};
          let wantCnt = 0;
          Object.values(fishTags).forEach(region => {
            const tagList = region?.tagList || [];
            tagList.forEach(tag => {
              const content = tag?.data?.content;
              if (content && content.endsWith('人想要')) {
                wantCnt = parseInt(content.replace('人想要', '')) || 0;
              }
            });
          });

          // 提取价格
          const priceStr = (exContent.price || []).map(p => p.text || '').join('');
          const priceNumber = parseFloat(priceStr.replace(/[^\d.]/g, '')) || 0;

          // 判断包邮
          const isFreeShip = clickParam.tag?.includes('freeship') ||
            clickParam.tagname?.includes('包邮') ||
            fishTags?.r1?.tagList?.some(t => t.data?.content === '包邮');

          // 应用过滤条件
          if (filterConfig.minWantCnt > 0 && wantCnt < filterConfig.minWantCnt) {
            filteredByConditions++;
            return false;
          }
          if (filterConfig.minPrice > 0 && priceNumber < filterConfig.minPrice) {
            filteredByConditions++;
            return false;
          }
          if (filterConfig.maxPrice > 0 && priceNumber > filterConfig.maxPrice) {
            filteredByConditions++;
            return false;
          }
          if (filterConfig.onlyFreeShip && !isFreeShip) {
            filteredByConditions++;
            return false;
          }

          const compositeKey = `${itemId}_${wantCnt}_${priceStr}`;
          if (capturedItemIds.has(compositeKey)) {
            filteredByDuplicate++;
            return false;
          }

          capturedItemIds.add(compositeKey);
          return true;
        });

        const newItemCount = newItems.length;
        statistics.requestCount++;
        console.log(`[闲鱼采集] 页面处理完成: 总 ${resultList.length} 条, 过滤掉已采集 ${filteredByDuplicate} 条, 过滤条件过滤 ${filteredByConditions} 条, 新增 ${newItemCount} 条`);

        if (newItemCount > 0) {
          const pageRecord = {
            url: apiData.url,
            // 优化点：在持久化时剥离巨大的原始响应对象
            // response: apiData.response, 
            items: newItems,
            timestamp: apiData.timestamp,
            captureTime: new Date(apiData.timestamp).toLocaleString()
          };
          capturedData.push(pageRecord);
          statistics.pageCount = capturedData.length;
          statistics.itemCount += newItemCount;
          statistics.lastCaptureTime = new Date(apiData.timestamp).toLocaleString();
        }

        await FishOpsState.update({
          capturedData: capturedData,
          capturedItemIds: Array.from(capturedItemIds),
          requestLogs: requestLogs,
          statistics: statistics
        });

        // 异步飞书同步逻辑
        if (asyncSyncState.enabled && newItemCount > 0) {
          const pageRecordForSync = {
            items: newItems,
            timestamp: apiData.timestamp
          };
          const newProcessedItems = processListData([pageRecordForSync]);
          asyncSyncState.pendingItems.push(...newProcessedItems);

          // 立即持久化 asyncSyncState，确保 pendingItems 不会被 sync() 覆盖
          await FishOpsState.update({ asyncSyncState });

          console.log(`[闲鱼采集-异步同步] 已加入待发队列: ${newProcessedItems.length} 条, 当前积压: ${asyncSyncState.pendingItems.length}/${asyncSyncState.batchSize}`);

          if (asyncSyncState.pendingItems.length >= (asyncSyncState.batchSize || 30) && !asyncSyncState.isSending) {
            console.log(`[闲鱼采集-异步同步] 触发批量发送，积压: ${asyncSyncState.pendingItems.length}, batchSize: ${asyncSyncState.batchSize}, isSending: ${asyncSyncState.isSending}`);
            triggerAsyncBatchSend();
          } else {
            console.log(`[闲鱼采集-异步同步] 未触发批量发送，原因: ${asyncSyncState.isSending ? '正在发送中' : `积压不足 (${asyncSyncState.pendingItems.length}/${asyncSyncState.batchSize})`}`);
          }
        } else if (!asyncSyncState.enabled) {
          // 仅在有新商品且未启用时打印一次，避免日志过载
          if (newItemCount > 0 && statistics.pageCount === 1) {
            console.log('[闲鱼采集] 实时同步未启用');
          }
        }

        sendResponse({
          success: true,
          pageCount: statistics.pageCount,
          requestCount: statistics.requestCount,
          itemCount: statistics.itemCount,
          newItems: newItemCount,
          asyncSyncState: {
            enabled: asyncSyncState.enabled,
            syncedCount: asyncSyncState.syncedCount,
            pendingCount: asyncSyncState.pendingItems.length,
            isSending: asyncSyncState.isSending
          }
        });
        return;
      }

      // 获取统计信息
      if (request.type === 'GET_STATS') {
        sendResponse({
          pageCount: statistics.pageCount,
          requestCount: statistics.requestCount,
          itemCount: statistics.itemCount,
          lastCaptureTime: statistics.lastCaptureTime || '无',
          asyncSyncState: {
            enabled: asyncSyncState.enabled,
            syncedCount: asyncSyncState.syncedCount,
            pendingCount: asyncSyncState.pendingItems.length,
            failedCount: asyncSyncState.failedCount,
            isSending: asyncSyncState.isSending,
            lastSyncTime: asyncSyncState.lastSyncTime
          }
        });
        return;
      }

      // 清空数据
      if (request.type === 'CLEAR_DATA') {
        capturedData = [];
        capturedItemIds = new Set();
        requestLogs = [];
        statistics = {
          pageCount: 0,
          requestCount: 0,
          itemCount: 0,
          lastCaptureTime: null
        };
        asyncSyncState.pendingItems = [];
        asyncSyncState.syncedCount = 0;
        asyncSyncState.failedCount = 0;
        asyncSyncState.lastSyncTime = null;

        try {
          await FishOpsState.update({
            capturedData: [],
            capturedItemIds: [],
            requestLogs: [],
            statistics: statistics,
            asyncSyncState: asyncSyncState
          });
          sendResponse({ success: true });
        } catch (e) {
          console.error('[闲鱼采集] 清空数据失败:', e);
          sendResponse({ success: false, error: e.message });
        }
        return;
      }

      // 导出CSV数据
      if (request.type === 'EXPORT_CSV') {
        try {
          const processedData = processListData(capturedData);
          const csvData = generateProductCSV(processedData);
          sendResponse({ success: true, csvData: csvData });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
        return;
      }

      // 导出请求记录
      if (request.type === 'EXPORT_REQUESTS') {
        try {
          const csvData = generateRequestsCSV(requestLogs);
          sendResponse({ success: true, csvData: csvData });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
        return;
      }

      // 导出商品和商家CSV
      if (request.type === 'EXPORT_PRODUCT_SELLER_CSV') {
        try {
          const processedData = processListData(capturedData);
          const productCsvData = generateProductCSV(processedData);
          const sellerCsvData = generateSellerCSV(processedData);
          sendResponse({
            success: true,
            productCsvData: productCsvData,
            sellerCsvData: sellerCsvData
          });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
        return;
      }

      // 设置配置
      if (request.type === 'SET_CONFIG') {
        if (request.config) {
          config = { ...config, ...request.config };
          await FishOpsState.update({ config: config });
          sendResponse({ success: true, config: config });
        } else {
          sendResponse({ success: false, error: '无效的配置' });
        }
        return;
      }

      // 获取配置
      if (request.type === 'GET_CONFIG') {
        sendResponse({ success: true, config: config });
        return;
      }

      // ========== 飞书相关消息处理 ==========

      if (request.type === 'TEST_FEISHU_CONNECTION') {
        const result = await testFeishuConnection(request.config);
        sendResponse(result);
        return;
      }

      if (request.type === 'SEND_TO_FEISHU') {
        const processedData = processListData(capturedData);
        const result = await sendToFeishu(processedData);
        sendResponse(result);
        return;
      }

      if (request.type === 'FLUSH_PENDING_ITEMS') {
        const result = await flushPendingItems();
        sendResponse(result);
        return;
      }

      if (request.type === 'UPDATE_FEISHU_CONFIG') {
        if (request.config) {
          // 只覆盖存在的字段，避免 undefined 覆盖现有值
          Object.keys(request.config).forEach(key => {
            if (request.config[key] !== undefined) {
              feishuConfig[key] = request.config[key];
            }
          });
          await FishOpsState.update({ feishuConfig: feishuConfig });
          // 同步更新 asyncSyncState（使用默认值保护）
          asyncSyncState.enabled = feishuConfig.realtimeSync || false;
          asyncSyncState.batchSize = feishuConfig.batchSize || 100;
          console.log('[闲鱼采集] 配置已更新, asyncSyncState.enabled:', asyncSyncState.enabled, 'batchSize:', asyncSyncState.batchSize);
          sendResponse({ success: true, config: feishuConfig });
        } else {
          sendResponse({ success: false, error: '无效的配置' });
        }
        return;
      }

      if (request.type === 'GET_FEISHU_CONFIG') {
        sendResponse({ success: true, config: feishuConfig });
        return;
      }

      // 未匹配的消息
      sendResponse({ success: false, error: '未知消息类型: ' + request.type });
    } catch (error) {
      console.error('[闲鱼采集] Background 消息处理异常:', error);
      sendResponse({ success: false, error: '后台处理出错: ' + error.message });
    }
  };

  handleMessage();
  return true; // 保持通道开启
});

// 后台脚本已通过 bg-state.js 自动管理同步
console.log('[闲鱼采集] Background 核心路由就绪');
