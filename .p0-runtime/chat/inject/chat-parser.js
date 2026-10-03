/**
 * chat-parser.js - 闲鱼聊天消息解析模块
 * 负责解析 WebSocket 聊天消息 (MessagePack / JSON)
 */

window.XianyuAPI = (function () {
  'use strict';

  // ==================== MessagePack 解析工具 ====================

  class MessagePackDecoder {
    constructor(buffer) {
      this.view = new DataView(buffer);
      this.offset = 0;
    }

    decode() {
      return this.parse();
    }

    parse() {
      const byte = this.view.getUint8(this.offset++);

      if (byte <= 0x7f) return byte;
      if (byte >= 0x80 && byte <= 0x8f) return this.parseMap(byte - 0x80);
      if (byte >= 0x90 && byte <= 0x9f) return this.parseArray(byte - 0x90);
      if (byte >= 0xa0 && byte <= 0xbf) return this.parseString(byte - 0xa0);
      if (byte === 0xc0) return null;
      if (byte === 0xc2) return false;
      if (byte === 0xc3) return true;

      if (byte === 0xc4) {
        const len = this.view.getUint8(this.offset++);
        return this.parseBytes(len);
      }
      if (byte === 0xc5) {
        const len = this.view.getUint16(this.offset);
        this.offset += 2;
        return this.parseBytes(len);
      }
      if (byte === 0xc6) {
        const len = this.view.getUint32(this.offset);
        this.offset += 4;
        return this.parseBytes(len);
      }
      if (byte === 0xca) {
        const val = this.view.getFloat32(this.offset);
        this.offset += 4;
        return val;
      }
      if (byte === 0xcb) {
        const val = this.view.getFloat64(this.offset);
        this.offset += 8;
        return val;
      }
      if (byte === 0xcc) return this.view.getUint8(this.offset++);
      if (byte === 0xcd) {
        const val = this.view.getUint16(this.offset);
        this.offset += 2;
        return val;
      }
      if (byte === 0xce) {
        const val = this.view.getUint32(this.offset);
        this.offset += 4;
        return val;
      }
      if (byte === 0xcf) {
        const val = this.view.getBigUint64(this.offset);
        this.offset += 8;
        return Number(val);
      }
      if (byte === 0xd0) return this.view.getInt8(this.offset++);
      if (byte === 0xd1) {
        const val = this.view.getInt16(this.offset);
        this.offset += 2;
        return val;
      }
      if (byte === 0xd2) {
        const val = this.view.getInt32(this.offset);
        this.offset += 4;
        return val;
      }
      if (byte === 0xd3) {
        const val = this.view.getBigInt64(this.offset);
        this.offset += 8;
        return Number(val);
      }
      if (byte === 0xd9) {
        const len = this.view.getUint8(this.offset++);
        return this.parseString(len);
      }
      if (byte === 0xda) {
        const len = this.view.getUint16(this.offset);
        this.offset += 2;
        return this.parseString(len);
      }
      if (byte === 0xdb) {
        const len = this.view.getUint32(this.offset);
        this.offset += 4;
        return this.parseString(len);
      }
      if (byte === 0xdc) {
        const len = this.view.getUint16(this.offset);
        this.offset += 2;
        return this.parseArray(len);
      }
      if (byte === 0xdd) {
        const len = this.view.getUint32(this.offset);
        this.offset += 4;
        return this.parseArray(len);
      }
      if (byte === 0xde) {
        const len = this.view.getUint16(this.offset);
        this.offset += 2;
        return this.parseMap(len);
      }
      if (byte === 0xdf) {
        const len = this.view.getUint32(this.offset);
        this.offset += 4;
        return this.parseMap(len);
      }
      if (byte >= 0xe0) return byte - 256;

      throw new Error(`Unknown byte: 0x${byte.toString(16)} at offset ${this.offset - 1}`);
    }

    parseString(length) {
      const bytes = new Uint8Array(this.view.buffer, this.offset, length);
      this.offset += length;
      return new TextDecoder('utf-8').decode(bytes);
    }

    parseBytes(length) {
      const bytes = new Uint8Array(this.view.buffer, this.offset, length);
      this.offset += length;
      return bytes;
    }

    parseArray(length) {
      const arr = [];
      for (let i = 0; i < length; i++) {
        arr.push(this.parse());
      }
      return arr;
    }

    parseMap(length) {
      const obj = {};
      for (let i = 0; i < length; i++) {
        const key = this.parse();
        const value = this.parse();
        obj[key] = value;
      }
      return obj;
    }
  }

  // ==================== 数据解码工具 ====================

  function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function parseMessagePackData(base64Data) {
    try {
      const buffer = base64ToArrayBuffer(base64Data);
      const decoder = new MessagePackDecoder(buffer);
      return decoder.decode();
    } catch (error) {
      return null;
    }
  }

  function isValidJSON(str) {
    try {
      JSON.parse(str);
      return true;
    } catch (e) {
      return false;
    }
  }

  function decodeChatData(base64Data) {
    if (!base64Data || typeof base64Data !== 'string') return null;

    const cleanedData = base64Data.trim();

    const msgPackData = parseMessagePackData(cleanedData);
    if (msgPackData) return msgPackData;

    let decodedText;
    try {
      decodedText = atob(cleanedData);
    } catch (decodeError) {
      return null;
    }

    if (!isValidJSON(decodedText)) return null;

    try {
      return JSON.parse(decodedText);
    } catch (parseError) {
      return null;
    }
  }

  // ==================== 编码修复 ====================

  function fixUTF8Encoding(str) {
    if (typeof str !== 'string') return str;
    try {
      const hasMojibake =
        /[\u00C0-\u00FF]{2,}/.test(str) ||
        /[\u00C2-\u00DF][\u0080-\u00BF]/.test(str) ||
        /[\u00E0-\u00EF][\u0080-\u00BF]{2}/.test(str);

      if (!hasMojibake) return str;

      const bytes = [];
      for (let i = 0; i < str.length; i++) {
        bytes.push(str.charCodeAt(i) & 0xff);
      }
      return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
    } catch (error) {
      return str;
    }
  }

  function fixEncodingInObject(obj) {
    if (typeof obj === 'string') return fixUTF8Encoding(obj);
    if (Array.isArray(obj)) return obj.map(item => fixEncodingInObject(item));
    if (typeof obj === 'object' && obj !== null) {
      const fixed = {};
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          fixed[key] = fixEncodingInObject(obj[key]);
        }
      }
      return fixed;
    }
    return obj;
  }

  function safeJSONParse(str) {
    try {
      const parsed = JSON.parse(str);
      return fixEncodingInObject(parsed);
    } catch (e) {
      return null;
    }
  }

  // ==================== URL 参数提取 ====================

  function extractReceiverId(reminderUrl) {
    if (!reminderUrl) return null;
    const match = reminderUrl.match(/peerUserId=([^&]+)/);
    return match ? match[1] : null;
  }

  function extractSessionId(reminderUrl) {
    if (!reminderUrl) return null;
    const match = reminderUrl.match(/sid=([^&]+)/);
    return match ? match[1] : null;
  }

  function extractItemId(reminderUrl) {
    if (!reminderUrl) return null;
    const match = reminderUrl.match(/itemId=([^&]+)/);
    return match ? match[1] : null;
  }

  // ==================== 消息类型判断 ====================

  function isOrderMessage(data) {
    return data && data['3'] && data['3']['redReminder'];
  }

  function isTypingStatus(data) {
    try {
      return (
        typeof data === 'object' && data !== null &&
        '1' in data && Array.isArray(data['1']) &&
        data['1'].length > 0 &&
        typeof data['1'][0] === 'object' && data['1'][0] !== null &&
        '1' in data['1'][0] &&
        typeof data['1'][0]['1'] === 'string' &&
        data['1'][0]['1'].includes('@goofish')
      );
    } catch (e) {
      return false;
    }
  }

  function isSystemMessage(data) {
    return data && data['3'] && data['3']['systemNotice'];
  }

  function isChatMessage(data) {
    return data && data['1'] && data['1']['10'] && data['1']['10']['reminderContent'];
  }

  function getMessageType(data) {
    if (!data) return 'unknown';
    if (isOrderMessage(data)) return 'order';
    if (isTypingStatus(data)) return 'typing';
    if (isSystemMessage(data)) return 'system';
    if (isChatMessage(data)) return 'chat';
    return 'unknown';
  }

  // ==================== 聊天消息构建 ====================

  function buildChatMessage(options) {
    const {
      senderId, senderName, senderUserType, clientIp,
      receiverId, sessionId, itemId,
      content, contentType, timestamp, createAt,
      messageId, platform, appVersion, direction,
      imageUrl
    } = options;

    return {
      type: 'chat',
      senderId: senderId || '',
      senderName: senderName || '',
      senderUserType: senderUserType || '0',
      clientIp: clientIp || '',
      receiverId: receiverId || '',
      sessionId: sessionId || '',
      itemId: itemId || '',
      content: content || '',
      contentType: contentType || 101,
      timestamp: timestamp || new Date().toLocaleString(),
      createAt: createAt || Date.now(),
      messageId: messageId || '',
      platform: platform || '',
      appVersion: appVersion || '',
      direction: direction || 'in',
      imageUrl: imageUrl || null
    };
  }

  // ==================== 消息处理 ====================

  function handleObjectDataItem(dataItem, index) {
    try {
      let decodedData = safeJSONParse(atob(dataItem.data));
      if (!decodedData) return null;

      const msgType = getMessageType(decodedData);

      if (isOrderMessage(decodedData)) {
        const orderStatus = decodedData['3']['redReminder'];
        const userId = decodedData['1'] ? decodedData['1'].split('@')[0] : '';
        var orderEvent = { type: 'order', orderStatus, userId, data: decodedData };
        // 发出订单消息事件
        if (window.EventBus) {
          window.EventBus.emit(window.ChatEventType.ORDER, {
            message: orderEvent,
            raw: dataItem,
            timestamp: Date.now(),
            source: 'websocket'
          });
        }
        return orderEvent;
      } else if (isTypingStatus(decodedData)) {
        var typingEvent = { type: 'typing', data: decodedData };
        // 发出输入状态事件
        if (window.EventBus) {
          window.EventBus.emit(window.ChatEventType.TYPING, {
            message: typingEvent,
            raw: dataItem,
            timestamp: Date.now(),
            source: 'websocket'
          });
        }
        return typingEvent;
      } else if (isSystemMessage(decodedData)) {
        var systemEvent = { type: 'system', data: decodedData };
        // 发出系统消息事件
        if (window.EventBus) {
          window.EventBus.emit(window.ChatEventType.SYSTEM, {
            message: systemEvent,
            raw: dataItem,
            timestamp: Date.now(),
            source: 'websocket'
          });
        }
        return systemEvent;
      } else if (isChatMessage(decodedData)) {
        const chatInfo = decodedData['1']['10'];
        var chatMessage = buildChatMessage({
          senderId: chatInfo.senderUserId || '',
          senderName: chatInfo.reminderTitle || '',
          senderUserType: chatInfo.senderUserType || '0',
          clientIp: chatInfo.clientIp || '',
          receiverId: decodedData['1']?.['2']?.split('@')[0] || '',
          sessionId: chatInfo.reminderUrl ? extractSessionId(chatInfo.reminderUrl) : decodedData['1']?.['2'] || '',
          itemId: chatInfo.reminderUrl ? extractItemId(chatInfo.reminderUrl) : '',
          content: chatInfo.reminderContent || '',
          contentType: 101,
          timestamp: decodedData['1']['5'] ? new Date(decodedData['1']['5']).toLocaleString() : '',
          createAt: decodedData['1']['5'] || Date.now(),
          messageId: decodedData['1']['3'] || '',
          platform: chatInfo._platform || '',
          appVersion: chatInfo._appVersion || '',
          direction: 'in'
        });
        // 发出聊天消息事件
        if (window.EventBus) {
          window.EventBus.emit(window.ChatEventType.MESSAGE, {
            message: chatMessage,
            raw: dataItem,
            timestamp: Date.now(),
            source: 'websocket'
          });
        }
        return chatMessage;
      }

      return { type: 'unknown', data: decodedData };
    } catch (decodeError) {
      return null;
    }
  }

  function handleStringDataItem(base64Data, index) {
    const decodedData = decodeChatData(base64Data);
    if (!decodedData) return null;

    const msgType = getMessageType(decodedData);

    if (decodedData["1"] && decodedData["1"]["10"] && decodedData["1"]["10"]["reminderContent"]) {
      const chatData = decodedData["1"];
      const contentData = chatData["10"];
      const messageData = chatData["6"] || {};

      let messageText = '';
      let messageContentType = 101;

      if (messageData["3"] && messageData["3"]["5"]) {
        try {
          const contentJson = JSON.parse(messageData["3"]["5"]);
          if (contentJson.text && contentJson.text.text) {
            messageText = contentJson.text.text;
          }
          // 检查是否为图片消息 (contentType 2)
          if (contentJson.contentType === 2 || contentJson.type === 2) {
            messageContentType = 2;
            messageText = '[图片]';
          } else {
            messageContentType = contentJson.contentType || 101;
          }
        } catch (e) {
          messageText = messageData["3"]["5"] || contentData.reminderContent || '';
        }
      } else {
        messageText = contentData.reminderContent || '';
      }

      // 提取图片数据（如果是图片消息）
      let imageUrl = '';
      if (messageContentType === 2) {
        // 优先从 messageData["3"]["5"] 解析JSON获取图片URL
        if (messageData["3"] && messageData["3"]["5"]) {
          try {
            const contentJson = JSON.parse(messageData["3"]["5"]);
            // 新的图片格式: image.pics[0].url
            if (contentJson.image && contentJson.image.pics && contentJson.image.pics.length > 0) {
              imageUrl = contentJson.image.pics[0].url;
            }
            // 备用格式: 直接从字段获取
            else if (contentJson.url) {
              imageUrl = contentJson.url;
            }
            else if (contentJson.imgUrl) {
              imageUrl = contentJson.imgUrl;
            }
            else if (contentJson.imageUrl) {
              imageUrl = contentJson.imageUrl;
            }
          } catch (e) {
            // JSON解析失败，可能是直接的URL
            const rawData = messageData["3"]["5"];
            if (rawData.startsWith('http')) {
              imageUrl = rawData;
            }
          }
        }
        // 备选: 从 custom.data 提取
        if (!imageUrl && contentData.custom && contentData.custom.data) {
          const rawData = contentData.custom.data;
          if (rawData.startsWith('http')) {
            imageUrl = rawData;
          }
          else if (rawData.startsWith('data:image')) {
            imageUrl = rawData;
          }
          else {
            try {
              const decoded = decodeURIComponent(escape(atob(rawData)));
              const parsed = JSON.parse(decoded);
              if (parsed.image && parsed.image.pics && parsed.image.pics.length > 0) {
                imageUrl = parsed.image.pics[0].url;
              } else {
                imageUrl = parsed.url || parsed.imgUrl || parsed.imageUrl || '';
              }
            } catch (e) {
              // 解析失败，忽略
            }
          }
        }
      }

      const sessionId = extractSessionId(contentData.reminderUrl);
      const itemId = extractItemId(contentData.reminderUrl);
      const peerUserId = extractReceiverId(contentData.reminderUrl);

      var chatMessage = buildChatMessage({
        senderId: contentData.senderUserId || chatData["1"]?.["1"]?.split('@')[0] || peerUserId || '',
        senderName: contentData.reminderTitle || '',
        senderUserType: contentData.senderUserType || '0',
        clientIp: contentData.clientIp || '',
        receiverId: chatData["2"]?.split('@')[0] || '',
        sessionId: sessionId || chatData["2"] || '',
        itemId: itemId || '',
        content: messageText,
        contentType: messageContentType,
        imageUrl: imageUrl,
        timestamp: chatData["5"] ? new Date(chatData["5"]).toLocaleString() : new Date().toLocaleString(),
        createAt: chatData["5"] || Date.now(),
        messageId: chatData["3"] || '',
        platform: contentData._platform || '',
        appVersion: contentData._appVersion || '',
        direction: 'in'
      });
      
      // 发出聊天消息事件
      if (window.EventBus) {
        window.EventBus.emit(window.ChatEventType.MESSAGE, {
          message: chatMessage,
          raw: base64Data,
          timestamp: Date.now(),
          source: 'websocket'
        });
      }
      
      return chatMessage;
    }

    return { type: 'unknown', data: decodedData };
  }

  function handleSyncData(syncData, rawData) {
    if (!Array.isArray(syncData)) return [];

    const results = [];
    syncData.forEach((dataItem, index) => {
      try {
        if (typeof dataItem.data === 'object' && dataItem.data) {
          const result = handleObjectDataItem(dataItem, index);
          if (result) results.push(result);
        } else if (typeof dataItem.data === 'string') {
          const result = handleStringDataItem(dataItem.data, index);
          if (result) results.push(result);
        }
      } catch (decodeError) {
        // 忽略处理错误
      }
    });

    // 发出同步消息事件
    if (results.length > 0 && window.EventBus) {
      window.EventBus.emit(window.ChatEventType.SYNC, {
        messages: results,
        raw: rawData,
        timestamp: Date.now(),
        source: 'websocket'
      });
    }

    return results;
  }

  function handleWebSocketMessage(eventData) {
    try {
      const parsed = JSON.parse(eventData);

      // 同步包消息
      if (parsed.body && parsed.body.syncPushPackage && parsed.body.syncPushPackage.data) {
        const syncData = parsed.body.syncPushPackage.data;
        const messages = handleSyncData(syncData, parsed);
        return { type: 'sync', messages: messages, raw: parsed };
      }

      // 普通消息体
      if (parsed.body) {
        const body = parsed.body;
        if (body.content || body.extension) {
          const ext = body.extension || {};
          const content = body.content || {};

          let messageText = '';
          let messageContentType = 101;
          let imageUrl = '';

          if (content.custom && content.custom.data) {
            try {
              const decodedData = atob(content.custom.data);
              const contentJson = JSON.parse(decodedData);
              if (contentJson.text && contentJson.text.text) {
                messageText = contentJson.text.text;
              }
              // 检查是否为图片消息
              if (contentJson.contentType === 2 || contentJson.type === 2) {
                messageContentType = 2;
                messageText = '[图片]';
                // 提取图片URL - 优先使用新的格式 image.pics[0].url
                if (contentJson.image && contentJson.image.pics && contentJson.image.pics.length > 0) {
                  imageUrl = contentJson.image.pics[0].url;
                }
                // 备用格式
                else {
                  imageUrl = contentJson.url || contentJson.imgUrl || contentJson.imageUrl || '';
                }
              }
            } catch (e) {
              messageText = content.custom.summary || '';
            }
          }

          var chatMessage = buildChatMessage({
            senderId: ext.senderUserId || '',
            senderName: ext.reminderTitle || '',
            senderUserType: ext.senderUserType || '0',
            clientIp: ext.clientIp || '',
            receiverId: extractReceiverId(ext.reminderUrl) || '',
            sessionId: extractSessionId(ext.reminderUrl) || '',
            itemId: extractItemId(ext.reminderUrl) || '',
            content: messageText || content.custom?.summary || '',
            contentType: messageContentType,
            imageUrl: imageUrl,
            timestamp: body.createAt ? new Date(body.createAt).toLocaleString() : new Date().toLocaleString(),
            createAt: body.createAt || Date.now(),
            messageId: body.messageId || '',
            platform: ext._platform || '',
            appVersion: ext._appVersion || '',
            direction: 'in'
          });
          
          // 发出聊天消息事件
          if (window.EventBus) {
            window.EventBus.emit(window.ChatEventType.MESSAGE, {
              message: chatMessage,
              raw: parsed,
              timestamp: Date.now(),
              source: 'websocket'
            });
          }
          
          return { type: 'message', message: chatMessage, raw: parsed };
        }
      }

      return { type: 'unknown', raw: parsed };
    } catch (e) {
      return { type: 'error', error: e.message };
    }
  }

  // ==================== 导出接口 ====================
  return {
    handleWebSocketMessage: handleWebSocketMessage,
    handleSyncData: handleSyncData,
    buildChatMessage: buildChatMessage,
    getMessageType: getMessageType,
    decodeChatData: decodeChatData
  };

})();

console.log('[ChatParser] 聊天消息解析模块已加载');
