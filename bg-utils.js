/**
 * bg-utils.js - 通用工具函数
 */

// 处理列表数据，返回符合 PRODUCT_SCHEMA 的标准数据结构
function processListData(capturedData) {
    const processedMap = new Map();
    const currentTime = Date.now();
    const currentTimeStr = new Date(currentTime).toLocaleString('zh-CN');

    // 处理列表数据
    capturedData.forEach(pageData => {
        const items = pageData.items || [];
        items.forEach(item => {
            try {
                const mainData = item.data?.item?.main;
                if (!mainData) return;

                const exContent = mainData.exContent || {};
                const clickParam = mainData.clickParam?.args || {};

                const itemId = clickParam.item_id || exContent.itemId || '';
                if (!itemId) return;

                // 从 fishTags提取想要人数
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

                // 提取商品标签
                const tagContents = [];
                Object.values(fishTags).forEach(region => {
                    const tagList = region?.tagList || [];
                    tagList.forEach(tag => {
                        const content = tag?.data?.content;
                        if (content && !content.endsWith('人想要')) {
                            // 标签里如果包含freeShippingIcon，替换成包邮
                            if (content && content.includes('freeShippingIcon')) {
                                tagContents.push('包邮');
                            } else {
                                tagContents.push(content);
                            }
                        }

                    });
                });
                const tagsStr = [...new Set(tagContents)].join('、');

                // 判断包邮
                const isFreeShip = clickParam.tag?.includes('freeship') ||
                    clickParam.tagname?.includes('包邮') ||
                    exContent.fishTags?.r1?.tagList?.some(t => t.data?.content === '包邮');

                // 获取封面图
                const picUrl = exContent.picUrl || '';

                // 提取价格（字符串和数值）
                const priceStr = (exContent.price || []).map(p => p.text || '').join('');
                const priceNumber = parseFloat(priceStr.replace(/[^\d.]/g, '')) || 0;

                // 提取原价（字符串和数值）
                const originalPriceStr = exContent.oriPrice || '';
                const originalPriceNumber = parseFloat(originalPriceStr.replace(/[^\d.]/g, '')) || 0;

                // 提取发布时间
                const publishTimeMs = clickParam.publishTime ? parseInt(clickParam.publishTime) : 0;
                const publishTimeStr = publishTimeMs ? new Date(publishTimeMs).toLocaleString('zh-CN') : '';

                // 构建组合键：商品ID + 想要数 + 价格
                const compositeKey = `${itemId}_${wantCnt}_${priceStr}`;

                // 计算曝光热度：(想要人数*100) / (DAYS(采集时间,发布时间)/24+1)
                let exposureHeat = 0;
                if (publishTimeMs > 0) {
                    const daysDiff = (currentTime - publishTimeMs) / (1000 * 60 * 60 * 24); // 天数差
                    exposureHeat = (wantCnt * 100) / (daysDiff + 1);
                    // 保留两位小数
                    exposureHeat = Math.round(exposureHeat * 100) / 100;
                }

                // 构建符合 PRODUCT_SCHEMA 的标准数据结构
                processedMap.set(compositeKey, {
                    // 基本信息
                    itemId: itemId,
                    title: exContent.title || '',

                    // 价格相关（字符串和数值两种形式）
                    price: priceStr,
                    priceNumber: priceNumber,
                    originalPrice: originalPriceStr,
                    originalPriceNumber: originalPriceNumber,

                    // 其他字段
                    wantCnt: wantCnt,

                    // 时间相关（字符串和时间戳两种形式）
                    publishTime: publishTimeStr,
                    publishTimeMs: publishTimeMs,
                    captureTime: currentTimeStr,
                    captureTimeMs: currentTime,

                    // 卖家信息
                    sellerNick: exContent.userNickName || '',
                    sellerCity: exContent.area || '',

                    // 其他属性
                    freeShip: isFreeShip ? '是' : '否',
                    tags: tagsStr,

                    // URL
                    coverUrl: normalizeUrl(picUrl),
                    detailUrl: normalizeUrl(`https://www.goofish.com/item?id=${itemId}`),

                    // 曝光热度
                    exposureHeat: exposureHeat
                });
            } catch (error) {
                console.error('[闲鱼采集] 处理列表数据出错:', error);
            }
        });
    });

    return Array.from(processedMap.values());
}

// URL 规范化函数：处理 // 开头的协议相对地址
function normalizeUrl(url) {
    if (!url || typeof url !== 'string') return '';

    let trimmed = url.trim();

    // 如果是 // 开头，补上 https:
    if (trimmed.startsWith('//')) {
        trimmed = 'https:' + trimmed;
    }

    return trimmed;
}
