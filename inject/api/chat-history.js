/**
 * chat-history.js - 聊天记录获取 API
 * 通过 WebSocket LWP 协议（RPC）获取闲鱼聊天记录
 * 
 * LWP 路由：
 *   - 会话列表：/r/Conversation/listNewestPagination
 *   - 消息历史：/r/Conversation/listUserMessages
 */

window.ChatHistoryAPI = (function () {
    'use strict';

    var LOG_PREFIX = '[聊天记录]';

    // ==================== 常量 ====================

    var LWP_ROUTES = {
        LIST_SESSIONS: '/r/Conversation/listNewestPagination',
        LIST_MESSAGES: '/r/MessageManager/listUserMessages'
    };

    // 初始锚点：JavaScript 安全最大整数
    var MAX_SAFE_INTEGER = 9007199254740991;
    var DEFAULT_PAGE_SIZE = 20;
    var SESSION_PAGE_SIZE = 20;
    var FETCH_INTERVAL = 300; // 分页间隔（毫秒），避免限流

    // ==================== WebSocket 请求工具 ====================

    /**
     * 生成 MID (Message ID)
     */
    function generateMid() {
        var randomPart = Math.floor(Math.random() * 1000);
        var timestamp = Date.now();
        return randomPart + '' + timestamp + ' 0';
    }

    /**
     * 获取当前活跃的 WebSocket 连接
     */
    function getWebSocket() {
        if (window.XianyuSender && typeof window.XianyuSender.getTargetWebSocket === 'function') {
            return window.XianyuSender.getTargetWebSocket();
        }
        return null;
    }

    /**
     * 通过 WebSocket 发送 RPC 请求并等待响应
     * @param {string} lwpPath - LWP 路由
     * @param {Array} body - 请求参数数组
     * @param {number} [timeout=15000] - 超时时间（毫秒）
     * @returns {Promise<Object>} 响应 body
     */
    function sendRpc(lwpPath, body, timeout) {
        timeout = timeout || 15000;

        return new Promise(function (resolve, reject) {
            var ws = getWebSocket();
            if (!ws) {
                reject({ success: false, error: '未找到 WebSocket 连接，请确保已打开聊天页面' });
                return;
            }

            if (ws.readyState !== WebSocket.OPEN) {
                reject({ success: false, error: 'WebSocket 未就绪，当前状态: ' + ws.readyState });
                return;
            }

            var mid = generateMid();
            var payload = {
                lwp: lwpPath,
                headers: { mid: mid },
                body: body
            };

            console.log(LOG_PREFIX, '📤 发送 RPC:', lwpPath, 'MID:', mid);

            var timer = null;
            var messageHandler = function (event) {
                try {
                    var response = JSON.parse(event.data);
                    if (response.headers && response.headers.mid === mid) {
                        clearTimeout(timer);
                        ws.removeEventListener('message', messageHandler);

                        console.log(LOG_PREFIX, '📥 收到响应:', response);

                        if (response.code === 200 || response.code === 0) {
                            resolve(response.body || response);
                        } else {
                            reject({
                                success: false,
                                error: '服务器返回错误: ' + (response.message || response.code),
                                code: response.code,
                                raw: response
                            });
                        }
                    }
                } catch (e) {
                    // 忽略非 JSON 或不匹配的消息
                }
            };

            ws.addEventListener('message', messageHandler);
            ws.send(JSON.stringify(payload));

            timer = setTimeout(function () {
                ws.removeEventListener('message', messageHandler);
                reject({ success: false, error: '请求超时 (' + timeout + 'ms)' });
            }, timeout);
        });
    }

    // ==================== 消息解析 ====================

    /**
     * 解析单条 RPC 消息
     * @param {Object} model - userMessageModel 对象
     * @returns {Object|null}
     */
    function parseRpcMessage(model) {
        try {
            var msg = model.message;
            if (!msg) return null;

            var cid = msg.cid || '';
            var chatId = cid.includes('@') ? cid.split('@')[0] : cid;

            // 提取发送者
            var senderId = '';
            if (msg.extension && msg.extension.senderUserId) {
                senderId = msg.extension.senderUserId;
            } else if (msg.sender && msg.sender.uid) {
                senderId = msg.sender.uid.includes('@') ? msg.sender.uid.split('@')[0] : msg.sender.uid;
            }

            var senderName = (msg.extension && msg.extension.reminderTitle) || '未知用户';

            // 解析消息内容
            var content = '';
            var contentType = 0;
            var rawData = undefined;

            var custom = msg.content && msg.content.custom;
            if (custom) {
                contentType = custom.contentType || custom.type || 0;
                content = custom.summary || '';
                rawData = custom.data;

                // summary 为空时，尝试从 base64 data 解析
                if (!content && rawData) {
                    try {
                        var decoded = decodeURIComponent(escape(atob(rawData)));
                        var parsed = JSON.parse(decoded);
                        if (parsed.text && parsed.text.text) {
                            content = parsed.text.text;
                        } else if (typeof parsed === 'string') {
                            content = parsed;
                        }
                    } catch (e) {
                        // data 不是可解析的文本格式
                    }
                }
            }

            if (!content) return null;

            // 提取商品信息
            var itemId = '';
            var itemTitle = '';

            // 1. 从 extension.reminderUrl 提取
            if (msg.extension && msg.extension.reminderUrl) {
                var itemIdMatch = msg.extension.reminderUrl.match(/itemId=(\d+)/);
                if (itemIdMatch) {
                    itemId = itemIdMatch[1];
                }
            }

            // 2. 从 extension.itemId 直接提取
            if (!itemId && msg.extension && msg.extension.itemId) {
                itemId = String(msg.extension.itemId);
            }

            // 3. 从 rawData 中解析商品卡片
            if (!itemId && rawData) {
                try {
                    var decodedCard = decodeURIComponent(escape(atob(rawData)));
                    var cardData = JSON.parse(decodedCard);
                    if (cardData.dxCard && cardData.dxCard.item && cardData.dxCard.item.main) {
                        var targetUrl = cardData.dxCard.item.main.targetUrl;
                        if (targetUrl) {
                            var cardMatch = targetUrl.match(/item\.htm\?id=(\d+)/);
                            if (cardMatch) itemId = cardMatch[1];
                        }
                        if (cardData.dxCard.item.main.title) {
                            itemTitle = cardData.dxCard.item.main.title;
                        }
                    }
                } catch (e) {
                    // 忽略
                }
            }

            // 判断消息方向 & 接收人
            var myId = window.CURRENT_USER_ID || '';
            var direction = (senderId === myId) ? 'out' : 'in';

            // 推断接收人：1v1 会话中，非发送方即为接收方
            var receiverId = '';
            var receiverName = '';
            if (direction === 'out') {
                // 我发出的消息，接收人是对方
                receiverId = chatId || '';
            } else {
                // 对方发来的消息，接收人是我
                receiverId = myId;
            }

            // 更新缓存的商品 ID
            if (itemId) {
                _lastKnownItemId = itemId;
            }

            return {
                type: 'chat',
                messageId: msg.messageId || '',
                cid: cid,
                chatId: chatId,
                senderId: senderId,
                senderName: senderName,
                receiverId: receiverId,
                receiverName: receiverName,
                content: content,
                contentType: contentType,
                rawData: rawData,
                createAt: msg.createAt || 0,
                timestamp: msg.createAt ? new Date(msg.createAt).toLocaleString() : '',
                readStatus: model.readStatus || 0,
                direction: direction,
                itemId: itemId,
                itemTitle: itemTitle
            };
        } catch (e) {
            console.warn(LOG_PREFIX, '⚠️ 解析消息失败:', e);
            return null;
        }
    }

    /**
     * 解析会话项
     * @param {Object} item - userConvs 数组中的单项
     * @returns {Object|null}
     */
    function parseConversationItem(item) {
        try {
            var userConv = item.singleChatUserConversation || {};
            var chatConv = item.singleChatConversation || {};
            var lastMsg = (userConv.lastMessage && userConv.lastMessage.message) || {};

            var rawCid = lastMsg.cid || '';
            var cid = rawCid.includes('@') ? rawCid.split('@')[0] : rawCid;

            if (!cid) return null;

            // 提取最后一条消息的摘要
            var lastMessageSummary = '';
            if (lastMsg.content && lastMsg.content.custom && lastMsg.content.custom.summary) {
                lastMessageSummary = lastMsg.content.custom.summary;
            }

            // 提取对方用户名
            var peerUserName = '';
            if (lastMsg.extension && lastMsg.extension.reminderTitle) {
                peerUserName = lastMsg.extension.reminderTitle;
            }

            // 提取商品 ID
            var itemId = '';
            if (lastMsg.extension && lastMsg.extension.reminderUrl) {
                var match = lastMsg.extension.reminderUrl.match(/itemId=(\d+)/);
                if (match) itemId = match[1];
            }

            return {
                cid: cid,
                peerUserName: peerUserName,
                lastMessage: lastMessageSummary,
                lastMessageTime: lastMsg.createAt || userConv.modifyTime || 0,
                unreadCount: userConv.redPoint || 0,
                sortIndex: userConv.modifyTime || userConv.joinTime || 0,
                visible: userConv.visible,
                itemId: itemId,
                extension: chatConv.extension || {},
                raw: item
            };
        } catch (e) {
            console.warn(LOG_PREFIX, '⚠️ 解析会话失败:', e);
            return null;
        }
    }

    // ==================== 核心 API ====================

    /**
     * 获取会话列表（单页）
     *
     * @param {number} [maxSortIndex] - 分页游标（首次不传，后续传上页返回的 nextSortIndex）
     * @param {number} [pageSize=20] - 每页条数
     * @returns {Promise<Object>} { conversations, hasMore, nextSortIndex }
     *
     * @example
     * ChatHistoryAPI.getConversationList().then(function(r) {
     *   r.conversations.forEach(function(c) {
     *     console.log(c.cid, c.peerUserName, c.lastMessage);
     *   });
     *   if (r.hasMore) {
     *     // 获取下一页
     *     ChatHistoryAPI.getConversationList(r.nextSortIndex);
     *   }
     * });
     */
    function getConversationList(maxSortIndex, pageSize) {
        maxSortIndex = maxSortIndex || MAX_SAFE_INTEGER;
        pageSize = pageSize || SESSION_PAGE_SIZE;

        return sendRpc(LWP_ROUTES.LIST_SESSIONS, [maxSortIndex, pageSize])
            .then(function (body) {
                var conversations = [];
                var hasMore = false;
                var nextSortIndex = undefined;

                if (body && body.userConvs && Array.isArray(body.userConvs)) {
                    // 新版响应格式
                    body.userConvs.forEach(function (item) {
                        var conv = parseConversationItem(item);
                        if (conv) conversations.push(conv);
                    });

                    // 优先使用服务器返回的 hasMore 标志
                    if (typeof body.hasMore !== 'undefined') {
                        hasMore = body.hasMore;
                    } else if (typeof body.hasNextPage !== 'undefined') {
                        hasMore = body.hasNextPage;
                    } else {
                        // 退而求其次：根据返回数量判断
                        hasMore = conversations.length >= pageSize;
                        console.log(LOG_PREFIX, '⚠️ 服务器未返回 hasMore，根据数量判断:', hasMore);
                    }

                    if (conversations.length > 0) {
                        nextSortIndex = conversations[conversations.length - 1].sortIndex;
                    }
                } else if (Array.isArray(body)) {
                    // 旧版数组格式
                    conversations = body;
                    hasMore = conversations.length >= pageSize;
                    if (conversations.length > 0) {
                        nextSortIndex = conversations[conversations.length - 1].sortIndex;
                    }
                }

                console.log(LOG_PREFIX, '📋 获取到', conversations.length, '个会话, hasMore:', hasMore, ', nextSortIndex:', nextSortIndex);

                return {
                    success: true,
                    conversations: conversations,
                    hasMore: hasMore,
                    nextSortIndex: nextSortIndex,
                    raw: body
                };
            });
    }

    /**
     * 获取全部会话列表（自动分页）
     *
     * @param {number} [maxPages=10] - 最大分页数
     * @returns {Promise<Object>} { conversations }
     *
     * @example
     * ChatHistoryAPI.getAllConversations().then(function(r) {
     *   console.log('共', r.conversations.length, '个会话');
     * });
     */
    function getAllConversations(maxPages) {
        maxPages = maxPages || 10;
        var allConversations = [];
        var page = 0;

        function fetchPage(sortIndex) {
            if (page >= maxPages) {
                console.log(LOG_PREFIX, '⚠️ 达到最大分页数', maxPages, '，已获取', allConversations.length, '个会话');
                return Promise.resolve({ success: true, conversations: allConversations });
            }

            return getConversationList(sortIndex).then(function (result) {
                if (!result.conversations || result.conversations.length === 0) {
                    console.log(LOG_PREFIX, '✅ 会话列表拉取完毕，共', allConversations.length, '个');
                    return { success: true, conversations: allConversations };
                }

                allConversations = allConversations.concat(result.conversations);
                page++;

                if (!result.hasMore || !result.nextSortIndex) {
                    console.log(LOG_PREFIX, '✅ 会话列表拉取完毕，共', allConversations.length, '个');
                    return { success: true, conversations: allConversations };
                }

                // 间隔请求，避免限流
                return sleep(FETCH_INTERVAL).then(function () {
                    return fetchPage(result.nextSortIndex);
                });
            });
        }

        console.log(LOG_PREFIX, '🚀 开始拉取全部会话列表...');
        return fetchPage(MAX_SAFE_INTEGER);
    }

    /**
     * 获取指定数量的会话 ID 列表（轻量级）
     *
     * @param {number} [count=50] - 需要获取的会话数量
     * @returns {Promise<Object>} { success, conversationIds: [] }
     *
     * @example
     * ChatHistoryAPI.getConversationIds(100).then(function(r) {
     *   console.log('获取到', r.conversationIds.length, '个会话ID');
     *   r.conversationIds.forEach(function(cid) {
     *     console.log('会话ID:', cid);
     *   });
     * });
     */
    function getConversationIds(count) {
        count = count || 50;
        var allIds = [];

        console.log(LOG_PREFIX, '🎯 开始获取', count, '个会话ID...');

        function fetchPage(maxSortIndex) {
            return getConversationList(maxSortIndex, 20).then(function (result) {
                if (!result.success || !result.conversations) {
                    return { success: false, error: '获取会话列表失败' };
                }

                // 提取会话 ID
                result.conversations.forEach(function (conv) {
                    if (conv.cid) {
                        allIds.push(conv.cid);
                    }
                });

                console.log(LOG_PREFIX, '📋 已获取', allIds.length, '个会话ID，hasMore:', result.hasMore);

                // 如果还没达到目标数量，且还有更多数据，继续获取
                if (allIds.length < count && result.hasMore && result.nextSortIndex) {
                    console.log(LOG_PREFIX, '  ⏭️  继续获取下一页（目标:', count, '，当前:', allIds.length, '）');
                    return sleep(FETCH_INTERVAL).then(function () {
                        return fetchPage(result.nextSortIndex);
                    });
                }

                // 截取指定数量
                var slicedIds = allIds.slice(0, count);
                console.log(LOG_PREFIX, '✅ 共获取', slicedIds.length, '个会话ID');

                return {
                    success: true,
                    conversationIds: slicedIds,
                    hasMore: result.hasMore || allIds.length > count
                };
            });
        }

        return fetchPage(MAX_SAFE_INTEGER);
    }

    /**
     * 获取单个会话的消息历史（单页）
     *
     * @param {string} chatId - 会话 ID（如 "123456789"）
     * @param {number} [anchor] - 翻页锚点（首次不传，后续传 nextCursor）
     * @param {number} [count=20] - 获取条数
     * @returns {Promise<Object>} { messages, nextCursor, hasMore }
     *
     * @example
     * ChatHistoryAPI.getMessageHistory('123456789').then(function(r) {
     *   r.messages.forEach(function(m) {
     *     console.log(m.senderName + ': ' + m.content);
     *   });
     *   if (r.hasMore) {
     *     ChatHistoryAPI.getMessageHistory('123456789', r.nextCursor);
     *   }
     * });
     */
    function getMessageHistory(chatId, anchor, count) {
        if (!chatId) {
            return Promise.reject({ success: false, error: 'chatId 不能为空' });
        }

        anchor = anchor || MAX_SAFE_INTEGER;
        count = count || DEFAULT_PAGE_SIZE;

        var cid = chatId.includes('@') ? chatId : chatId + '@goofish';

        return sendRpc(LWP_ROUTES.LIST_MESSAGES, [cid, false, anchor, count, false])
            .then(function (body) {
                var nextCursor = (body && body.nextCursor) || 0;
                var models = (body && body.userMessageModels) || [];

                var messages = [];
                models.forEach(function (model) {
                    var parsed = parseRpcMessage(model);
                    if (parsed) messages.push(parsed);
                });

                console.log(LOG_PREFIX, '💬 获取到', messages.length, '条消息 (chatId:', chatId, ', nextCursor:', nextCursor, ')');

                return {
                    success: true,
                    chatId: chatId,
                    messages: messages,
                    nextCursor: nextCursor,
                    hasMore: messages.length >= count && nextCursor > 0,
                    raw: body
                };
            });
    }

    /**
     * 获取指定会话的全部消息历史（自动分页）
     *
     * @param {string} chatId - 会话 ID
     * @param {number} [maxPages=10] - 最大分页数
     * @returns {Promise<Object>} { messages }
     *
     * @example
     * ChatHistoryAPI.getAllMessages('123456789').then(function(r) {
     *   console.log('共', r.messages.length, '条消息');
     * });
     */
    function getAllMessages(chatId, maxPages) {
        if (!chatId) {
            return Promise.reject({ success: false, error: 'chatId 不能为空' });
        }

        maxPages = maxPages || 10;
        var allMessages = [];
        var page = 0;

        function fetchPage(anchor) {
            if (page >= maxPages) {
                console.log(LOG_PREFIX, '⚠️ 达到最大分页数', maxPages, '，已获取', allMessages.length, '条');
                return Promise.resolve({ success: true, chatId: chatId, messages: allMessages });
            }

            return getMessageHistory(chatId, anchor).then(function (result) {
                if (!result.messages || result.messages.length === 0) {
                    console.log(LOG_PREFIX, '✅ 消息拉取完毕 (', chatId, ')，共', allMessages.length, '条');
                    return { success: true, chatId: chatId, messages: allMessages };
                }

                allMessages = allMessages.concat(result.messages);
                page++;

                if (!result.hasMore || !result.nextCursor) {
                    console.log(LOG_PREFIX, '✅ 消息拉取完毕 (', chatId, ')，共', allMessages.length, '条');
                    return { success: true, chatId: chatId, messages: allMessages };
                }

                return sleep(FETCH_INTERVAL).then(function () {
                    return fetchPage(result.nextCursor);
                });
            });
        }

        console.log(LOG_PREFIX, '🚀 开始拉取会话', chatId, '的全部消息...');
        return fetchPage(MAX_SAFE_INTEGER);
    }

    /**
     * 获取当前聊天的商品 ID
     *
     * @returns {string|null} 商品 ID
     *
     * @example
     * var itemId = ChatHistoryAPI.getCurrentChatItemId();
     */
    function getCurrentChatItemId() {
        // 1. 从 URL 参数提取
        try {
            var urlParams = new URLSearchParams(window.location.search);
            var itemId = urlParams.get('itemId');
            if (itemId) {
                console.log(LOG_PREFIX, '✅ 从 URL 获取商品 ID:', itemId);
                return itemId;
            }
        } catch (e) { /* 忽略 */ }

        // 2. 从 URL hash 提取
        try {
            var hash = window.location.hash;
            if (hash) {
                var hashMatch = hash.match(/itemId=([^&]+)/);
                if (hashMatch) {
                    console.log(LOG_PREFIX, '✅ 从 hash 获取商品 ID:', hashMatch[1]);
                    return hashMatch[1];
                }
            }
        } catch (e) { /* 忽略 */ }

        // 3. 从缓存获取（实时消息中提取的）
        if (_lastKnownItemId) {
            console.log(LOG_PREFIX, '📦 使用缓存的商品 ID:', _lastKnownItemId);
            return _lastKnownItemId;
        }

        console.log(LOG_PREFIX, '⚠️ 未找到当前商品 ID');
        return null;
    }

    // ==================== 内部状态与工具 ====================

    var _lastKnownItemId = null;

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // 监听实时消息，自动缓存商品 ID
    function initItemIdTracker() {
        if (!window.EventBus) return;

        window.EventBus.on(window.ChatEventType.MESSAGE, function (context) {
            var msg = context.message;
            if (msg && msg.itemId) {
                _lastKnownItemId = msg.itemId;
            }
        });

        console.log(LOG_PREFIX, '✅ 商品 ID 追踪已启动');
    }

    // ==================== 路由诊断工具 ====================

    /**
     * 抓取页面实际使用的 WebSocket RPC 路由
     * 使用方法：调用后点击一个会话，观察控制台输出
     * 
     * @example
     * ChatHistoryAPI.captureRoutes();
     * // 然后点击一个聊天会话，控制台会打印出所有 RPC 路由
     */
    function captureRoutes() {
        var ws = getWebSocket();
        if (!ws) {
            console.error(LOG_PREFIX, '❌ 未找到 WebSocket 连接');
            return;
        }

        var originalSend = ws.send.bind(ws);
        var captured = [];

        ws.send = function (data) {
            try {
                var parsed = JSON.parse(data);
                if (parsed.lwp) {
                    console.log(LOG_PREFIX, '🔍 [捕获发送] 路由:', parsed.lwp, '参数:', JSON.stringify(parsed.body));
                    captured.push({ direction: 'send', lwp: parsed.lwp, body: parsed.body, raw: parsed });
                }
            } catch (e) { /* 忽略 */ }
            return originalSend(data);
        };

        var messageHandler = function (event) {
            try {
                var parsed = JSON.parse(event.data);
                if (parsed.lwp) {
                    console.log(LOG_PREFIX, '🔍 [捕获接收] 路由:', parsed.lwp, '响应:', parsed);
                    captured.push({ direction: 'recv', lwp: parsed.lwp, raw: parsed });
                }
            } catch (e) { /* 忽略 */ }
        };
        ws.addEventListener('message', messageHandler);

        console.log(LOG_PREFIX, '🎯 路由捕获已启动！请点击一个聊天会话，然后查看控制台输出。');
        console.log(LOG_PREFIX, '💡 停止捕获请调用: ChatHistoryAPI.stopCapture()');

        // 保存停止方法
        _captureCleanup = function () {
            ws.send = originalSend;
            ws.removeEventListener('message', messageHandler);
            console.log(LOG_PREFIX, '⏹️ 路由捕获已停止，共捕获', captured.length, '条记录：');
            captured.forEach(function (item, i) {
                console.log('  [' + (i + 1) + '] ' + item.direction + ' ' + item.lwp);
            });
            _captureCleanup = null;
        };

        return captured;
    }

    var _captureCleanup = null;

    function stopCapture() {
        if (_captureCleanup) {
            _captureCleanup();
        } else {
            console.log(LOG_PREFIX, '⚠️ 没有正在进行的路由捕获');
        }
    }

    // ==================== 初始化 ====================

    try {
        initItemIdTracker();
    } catch (e) {
        console.warn(LOG_PREFIX, '⚠️ 商品 ID 追踪初始化失败:', e);
    }
    console.log(LOG_PREFIX, '✅ ChatHistoryAPI 已加载');

    // ==================== 导出接口 ====================

    return {
        // 单页 API
        getConversationList: getConversationList,
        getMessageHistory: getMessageHistory,
        // 全量拉取 API
        getAllConversations: getAllConversations,
        getAllMessages: getAllMessages,
        // 会话 ID 获取（轻量级）
        getConversationIds: getConversationIds,
        // 商品 ID
        getCurrentChatItemId: getCurrentChatItemId,
        // 诊断工具
        captureRoutes: captureRoutes,
        stopCapture: stopCapture,
        // 底层方法（调试用）
        _sendRpc: sendRpc,
        _parseRpcMessage: parseRpcMessage
    };

})();
