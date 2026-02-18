/**
 * chat-sender.js - 聊天消息发送器
 * 负责调用闲鱼 API 发送聊天消息
 */

window.XianyuSender = (function() {
  'use strict';

  var LOG_PREFIX = '[消息发送]';
  var targetWebSocket = null;

  /**
   * 获取目标 WebSocket 连接
   * 从页面中找到已建立的闲鱼聊天 WebSocket
   */
  function getTargetWebSocket() {
    // 尝试从全局查找 WebSocket
    if (window.WebSocket && window.WebSocket.all) {
      // 如果有所有 WebSocket 的引用，找到闲鱼的
      var sockets = window.WebSocket.all || [];
      for (var i = 0; i < sockets.length; i++) {
        if (sockets[i].url && sockets[i].url.includes('goofish.com')) {
          return sockets[i];
        }
      }
    }
    
    // 或者使用已保存的引用
    if (targetWebSocket && targetWebSocket.readyState === WebSocket.OPEN) {
      return targetWebSocket;
    }
    
    return null;
  }

  /**
   * 设置目标 WebSocket（由 websocket-data-source 调用）
   */
  function setTargetWebSocket(ws) {
    targetWebSocket = ws;
    console.log(LOG_PREFIX, '✅ 设置目标 WebSocket:', ws.url);
  }

  // 导出设置方法供外部调用
  window.XianyuSenderSetup = {
    setTargetWebSocket: setTargetWebSocket
  };

  /**
   * 发送聊天消息
   * @param {Object} options - 发送选项
   * @param {string} options.sessionId - 会话 ID
   * @param {string} options.receiverId - 接收者 ID
   * @param {string} options.itemId - 商品 ID
   * @param {string} options.content - 消息内容
   * @param {number} options.contentType - 消息类型（101=文本）
   * @returns {Promise<Object>} 发送结果
   */
  function sendMessage(options) {
    return new Promise(function(resolve, reject) {
      console.log(LOG_PREFIX, '📤 准备发送消息:', options);
      console.log(LOG_PREFIX, '🔍 Promise 构造函数已执行');

      // 通过 WebSocket 发送
      console.log(LOG_PREFIX, '🚀 调用 sendViaWebSocket');
      sendViaWebSocket(options)
        .then(function(result) {
          console.log(LOG_PREFIX, '✅ sendViaWebSocket 成功回调');
          resolve(result);
        })
        .catch(function(error) {
          console.error(LOG_PREFIX, '❌ sendViaWebSocket 失败回调:', error);
          reject(error);
        });
    });
  }

  /**
   * 生成 MID (Message ID)
   * 格式：{随机数}{时间戳} 0
   */
  function generateMid() {
    var randomPart = Math.floor(Math.random() * 1000);
    var timestamp = Date.now();
    return randomPart + '' + timestamp + ' 0';
  }

  /**
   * 生成 UUID
   * 闲鱼实际使用格式：-{时间戳}{随机数}
   */
  function generateUuid() {
    var timestamp = Date.now();
    var randomPart = Math.floor(Math.random() * 10000);
    return '-' + timestamp + randomPart;
  }

  /**
   * 通过 WebSocket 发送消息
   * 基于实际抓包结果实现
   */
  function sendViaWebSocket(options) {
    return new Promise(function(resolve, reject) {
      // 如果没有提供 myId，尝试从缓存获取
      if (!options.myId) {
        options.myId = window.CURRENT_USER_ID || (localStorage.getItem('idle_current_user_id') + '');
        console.log(LOG_PREFIX, '⚠️ 未提供 myId，使用缓存值:', options.myId);
      }
      
      if (!options.myId) {
        console.error(LOG_PREFIX, '❌ 无法获取当前用户 ID (myId)');
        console.error(LOG_PREFIX, '💡 请先调用 UserAPI.quickGetUserId() 获取用户 ID');
        reject({
          success: false,
          error: 'Missing myId parameter'
        });
        return;
      }
      
      // 生成标准格式的 ID
      var uuid = generateUuid();
      var mid = generateMid();

      console.log(LOG_PREFIX, '🔑 生成标识符 - MID:', mid, 'UUID:', uuid);

      // 构建消息内容（需要 base64 编码）
      var messageContent = {
        contentType: 1,  // 闲鱼实际使用 1，不是 101
        text: {
          text: options.content
        }
      };
      var messageDataBase = btoa(JSON.stringify(messageContent));

      // 构建请求体（和你提供的抓包数据一致）
      // 关键：actualReceivers 必须包含双方 ID（对方 + 自己）
      var payload = {
        lwp: '/r/MessageSend/sendByReceiverScope',
        headers: {
          mid: mid
        },
        body: [
          {
            uuid: uuid,
            cid: options.sessionId + '@goofish',
            conversationType: 1,
            content: {
              contentType: 101,
              custom: {
                type: 1,
                data: messageDataBase
              }
            },
            redPointPolicy: 0,
            extension: {
              extJson: '{}'
            },
            ctx: {
              appVersion: '1.0',
              platform: 'web'
            },
            mtags: {},
            msgReadStatusSetting: 1
          },
          {
            // 实际接收者数组：[对方 ID, 自己 ID]
            // 这样消息会同步到双方的设备上
            actualReceivers: [
              options.toUserId + '@goofish',    // 对方（消息目标）
              options.myId + '@goofish'         // 自己（用于同步）
            ]
          }
        ]
      };

      console.log(LOG_PREFIX, '📤 发送消息数据:', payload);

      // 获取 WebSocket 连接
      var ws = getTargetWebSocket();
      if (!ws) {
        console.error(LOG_PREFIX, '❌ 未找到 WebSocket 连接');
        reject({
          success: false,
          error: '未找到 WebSocket 连接，请确保已打开聊天页面'
        });
        return;
      }

      if (ws.readyState !== WebSocket.OPEN) {
        console.error(LOG_PREFIX, '❌ WebSocket 未就绪，当前状态:', ws.readyState);
        reject({
          success: false,
          error: 'WebSocket 未就绪'
        });
        return;
      }

      console.log(LOG_PREFIX, '🌐 开始通过 WebSocket 发送...');
      
      // 监听响应
      var messageHandler = function(event) {
        try {
          var response = JSON.parse(event.data);
          // 检查是否是我们这条消息的响应
          if (response.headers && response.headers.mid === mid) {
            ws.removeEventListener('message', messageHandler);
            
            console.log(LOG_PREFIX, '📥 收到 WebSocket 响应:', response);
            
            if (response.code === 200 || response.code === 0) {
              console.log(LOG_PREFIX, '✅ 发送成功');
              resolve({
                success: true,
                data: response,
                messageId: uuid
              });
            } else {
              console.error(LOG_PREFIX, '❌ 发送失败，错误码:', response.code);
              reject({
                success: false,
                error: '服务器返回错误：' + (response.message || response.code)
              });
            }
          }
        } catch (e) {
          // 忽略解析错误
        }
      };

      ws.addEventListener('message', messageHandler);
      
      // 发送消息
      ws.send(JSON.stringify(payload));
      console.log(LOG_PREFIX, '✅ 消息已通过 WebSocket 发送');
      
      // 超时处理
      setTimeout(function() {
        ws.removeEventListener('message', messageHandler);
        reject({
          success: false,
          error: '发送超时'
        });
      }, 10000); // 10 秒超时
    });
  }

  /**
   * 通过闲鱼现有 API 发送（如果页面中有可用的 SDK）
   */
  function sendViaSDK(options) {
    return new Promise(function(resolve, reject) {
      // TODO: 如果闲鱼页面提供了发送消息的 JS 方法，可以在这里调用
      // 例如：window.MTOP.api('mtop.xianyu.chat.send', {...}, callback)
      
      // 检查是否有可用的 API
      if (window.MT && window.MT.api) {
        // 示例：调用 MTOP API
        window.MT.api(
          'mtop.xianyu.chat.sendMessage', // API 名称
          {
            sessionId: options.sessionId,
            receiverId: options.receiverId,
            content: options.content
          },
          function(err, result) {
            if (err) {
              reject({ success: false, error: err });
            } else {
              resolve({ success: true, data: result });
            }
          }
        );
      } else {
        reject({ 
          success: false, 
          error: '未找到可用的发送 API' 
        });
      }
    });
  }

  /**
   * 发送文本消息（快捷方法）
   * @param {string} sessionId - 会话 ID
   * @param {string} toUserId - 对方用户 ID（消息接收者）
   * @param {string} content - 消息内容
   * @param {string} itemId - 商品 ID
   * @param {string} myId - 当前用户 ID（用于 actualReceivers）
   */
  function sendTextMessage(sessionId, toUserId, content, itemId, myId) {
    console.log('[ChatSender] 📞 sendTextMessage 被调用');
    console.log('[ChatSender] 参数:', { sessionId, toUserId, content, itemId, myId });
    
    return sendMessage({
      sessionId: sessionId,
      toUserId: toUserId,        // 对方 ID
      myId: myId,                // 自己 ID
      itemId: itemId,
      content: content,
      contentType: 101
    });
  }

  // 导出接口
  return {
    sendMessage: sendMessage,
    sendTextMessage: sendTextMessage,
    sendViaWebSocket: sendViaWebSocket,
    getTargetWebSocket: getTargetWebSocket,
    generateMid: generateMid,
    generateUuid: generateUuid
  };

})();

console.log('[ChatSender] 消息发送器已加载');
