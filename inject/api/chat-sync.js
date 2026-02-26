/**
 * chat-sync.js - 聊天历史同步模块 (运行在 MAIN world)
 * 负责调用 ChatHistoryAPI 和 GoodsAPI，拼接完整数据并持久化
 */
(function () {
    'use strict';

    var LOG_PREFIX = '[ChatSync]';

    /**
     * 查询商品名称（利用 GoodsAPI 缓存）
     */
    function fetchItemTitle(itemId) {
        if (!itemId || !window.GoodsAPI) return Promise.resolve('');

        var cached = window.GoodsAPI.getCachedGoods(itemId);
        if (cached && cached.title) return Promise.resolve(cached.title);

        return window.GoodsAPI.fetchGoodsDetail(itemId)
            .then(function (detail) {
                return (detail && detail.title) || '';
            })
            .catch(function () { return ''; });
    }

    /**
     * 同步单个会话的消息（只获取前 20 条）
     * @param {string} chatId - 会话 ID
     * @param {number} index - 会话序号（用于日志）
     * @param {string} peerUserName - 对方用户名
     * @param {number} messageCount - 消息获取条数，默认 20
     */
    function syncSingleConversation(chatId, index, peerUserName, messageCount) {
        var myId = window.CURRENT_USER_ID || '';
        messageCount = messageCount || 20;

        // 只获取前 N 条消息（单页），默认 20 条
        return window.ChatHistoryAPI.getMessageHistory(chatId, undefined, messageCount)
            .then(function (result) {
                if (!result.success || !result.messages) {
                    return { success: false, error: '会话 ' + chatId + ' 消息获取失败' };
                }

                var messages = result.messages;
                console.log(LOG_PREFIX, '💬 会话 [' + (index + 1) + '] ' + chatId + ':', messages.length, '条消息');

                // 补充接收人名称
                messages.forEach(function (msg) {
                    if (msg.direction === 'out') {
                        msg.receiverName = peerUserName || msg.receiverId || '';
                    } else {
                        msg.receiverName = '我';
                        if (!msg.senderName || msg.senderName === '未知用户') {
                            msg.senderName = peerUserName || msg.senderId || '未知用户';
                        }
                    }
                });

                // 收集需要查询商品名称的 itemId（去重）
                var itemIdsToFetch = {};
                messages.forEach(function (msg) {
                    if (msg.itemId && !msg.itemTitle) {
                        itemIdsToFetch[msg.itemId] = true;
                    }
                });
                var uniqueItemIds = Object.keys(itemIdsToFetch);

                var titlePromise;
                if (uniqueItemIds.length > 0) {
                    var titleMap = {};
                    titlePromise = uniqueItemIds.reduce(function (chain, itemId) {
                        return chain.then(function () {
                            return fetchItemTitle(itemId).then(function (title) {
                                if (title) titleMap[itemId] = title;
                            });
                        });
                    }, Promise.resolve()).then(function () {
                        messages.forEach(function (msg) {
                            if (msg.itemId && !msg.itemTitle && titleMap[msg.itemId]) {
                                msg.itemTitle = titleMap[msg.itemId];
                            }
                        });
                    });
                } else {
                    titlePromise = Promise.resolve();
                }

                return titlePromise.then(function () {
                    // 消息不再存储，直接返回统计信息
                    console.log(LOG_PREFIX, '  ✅ 已获取', messages.length, '条消息');

                    return {
                        success: true,
                        chatId: chatId,
                        messageCount: messages.length,
                        messages: messages  // 返回消息数据，供导出使用
                    };
                });
            })
            .catch(function (error) {
                console.warn(LOG_PREFIX, '⚠️ 会话 ' + chatId + ' 同步失败:', error);
                return { success: false, error: error.message };
            });
    }

    /**
     * 根据会话 ID 列表批量同步消息
     * @param {Array<string>} conversationIds - 会话 ID 列表
     * @param {number} messageCount - 每个会话获取的消息条数
     */
    function syncMessagesByIds(conversationIds, messageCount) {
        if (!conversationIds || conversationIds.length === 0) {
            return Promise.resolve({
                success: true,
                stats: {
                    totalConversations: 0,
                    totalMessages: 0,
                    syncedConversations: 0,
                    errors: []
                }
            });
        }

        messageCount = messageCount || 20;

        var stats = {
            totalConversations: conversationIds.length,
            totalMessages: 0,
            syncedConversations: 0,
            errors: [],
            allMessages: []  // 收集所有消息
        };

        console.log(LOG_PREFIX, '💬 开始同步', conversationIds.length, '个会话的消息，每个会话', messageCount, '条');

        // 需要获取会话详情（用于提取 peerUserName）
        var conversationMap = {};

        // 分批获取所有会话详情（解决超过 50 个会话的场景）
        function fetchConversationDetails(startIndex) {
            if (startIndex >= conversationIds.length) {
                return Promise.resolve();
            }

            var batchSize = 50;
            var endIndex = Math.min(startIndex + batchSize, conversationIds.length);
            console.log(LOG_PREFIX, '📋 获取会话详情 [' + (startIndex + 1) + '-' + endIndex + ']...');

            return window.ChatHistoryAPI.getConversationList(undefined, batchSize)
                .then(function (result) {
                    if (result.success && result.conversations) {
                        result.conversations.forEach(function (conv) {
                            conversationMap[conv.cid] = conv;
                        });
                    }

                    // 如果还有更多需要获取，继续下一批
                    if (endIndex < conversationIds.length && result.hasMore && result.nextSortIndex) {
                        return new Promise(function (resolve) {
                            setTimeout(resolve, 200);
                        }).then(function () {
                            return fetchConversationDetails(endIndex);
                        });
                    }
                    return Promise.resolve();
                });
        }

        // 第一步：获取所有会话详情
        return fetchConversationDetails(0)
            .then(function () {
                console.log(LOG_PREFIX, '✅ 已获取', Object.keys(conversationMap).length, '个会话详情');

                // 第二步：依次同步每个会话的消息
                var index = 0;
                function syncNext() {
                    if (index >= conversationIds.length) {
                        return Promise.resolve();
                    }

                    var chatId = conversationIds[index];
                    var conv = conversationMap[chatId];
                    var peerUserName = conv ? conv.peerUserName : '';
                    var currentIndex = index;
                    index++;

                    console.log(LOG_PREFIX, '📤 [' + (currentIndex + 1) + '/' + conversationIds.length + '] 同步会话:', chatId, '(' + (peerUserName || '未知') + ')');

                    return syncSingleConversation(chatId, currentIndex, peerUserName, messageCount)
                        .then(function (r) {
                            if (r && r.success) {
                                stats.totalMessages += r.messageCount;
                                stats.syncedConversations++;
                                // 收集消息
                                if (r.messages && r.messages.length > 0) {
                                    stats.allMessages = stats.allMessages.concat(r.messages);
                                }
                            } else if (r && r.error) {
                                stats.errors.push(r.error);
                            }
                            // 添加间隔，避免频率限制
                            return new Promise(function (resolve) {
                                setTimeout(resolve, 200);
                            }).then(syncNext);
                        })
                        .catch(function (error) {
                            stats.errors.push('会话 ' + chatId + ' 失败: ' + error.message);
                            return syncNext();
                        });
                }

                return syncNext();
            })
            .then(function () {
                console.log(LOG_PREFIX, '✅ 消息同步完成:', stats);
                return { success: true, stats: stats };
            });
    }

    /**
     * 同步指定数量的会话历史（新版本：两阶段获取）
     * @param {number} conversationCount - 要获取的会话数量
     * @param {number} messageCount - 每个会话获取的消息条数，默认 20
     */
    function startSync(conversationCount, messageCount) {
        if (!window.ChatHistoryAPI) {
            return Promise.reject(new Error('ChatHistoryAPI 不可用，请确保已打开聊天页面'));
        }

        conversationCount = conversationCount || 50;
        messageCount = messageCount || 20;

        console.log(LOG_PREFIX, '🚀 开始两阶段同步：');
        console.log(LOG_PREFIX, '  📋 阶段 1：获取', conversationCount, '个会话 ID');
        console.log(LOG_PREFIX, '  💬 阶段 2：每个会话获取', messageCount, '条消息');

        // 阶段 1：获取会话 ID 列表（轻量级查询）
        return window.ChatHistoryAPI.getConversationIds(conversationCount)
            .then(function (result) {
                if (!result.success || !result.conversationIds || result.conversationIds.length === 0) {
                    console.warn(LOG_PREFIX, '⚠️ 未获取到会话 ID');
                    return {
                        success: true,
                        stats: {
                            totalConversations: 0,
                            totalMessages: 0,
                            syncedConversations: 0,
                            errors: []
                        }
                    };
                }

                console.log(LOG_PREFIX, '✅ 阶段 1 完成：获取到', result.conversationIds.length, '个会话 ID');

                // 阶段 2：批量获取消息
                return syncMessagesByIds(result.conversationIds, messageCount);
            })
            .then(function (result) {
                console.log(LOG_PREFIX, '✅ 两阶段同步完成:', result.stats);
                return result;
            })
            .catch(function (error) {
                console.error(LOG_PREFIX, '❌ 同步失败:', error);
                return { success: false, error: error.message };
            });
    }

    // 监听来自 ISOLATED world 的同步要求
    window.addEventListener('message', function (event) {
        if (event.data && event.data.source === 'XIANYU_UTILS' && event.data.type === 'SYNC_CHAT_HISTORY') {
            var count = event.data.conversationCount || 50;
            var messageCount = event.data.messageCount || 20;
            var requestId = event.data.requestId;

            startSync(count, messageCount)
                .then(function (result) {
                    window.postMessage({
                        source: 'CHAT_SYNC_PROCESSOR',
                        type: 'SYNC_CHAT_HISTORY_RESPONSE',
                        requestId: requestId,
                        result: result
                    }, '*');
                })
                .catch(function (error) {
                    window.postMessage({
                        source: 'CHAT_SYNC_PROCESSOR',
                        type: 'SYNC_CHAT_HISTORY_RESPONSE',
                        requestId: requestId,
                        result: { success: false, error: error.message }
                    }, '*');
                });
        }
    });

    window.ChatSyncAPI = {
        startSync: startSync
    };

    console.log(LOG_PREFIX, '模块已加载');
})();
