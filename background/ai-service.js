/**
 * ai-service.js - AI 聊天补全服务
 * 在 background Service Worker 中运行
 * 调用 OpenAI 兼容 API 完成聊天补全
 */

/**
 * 调用 AI 聊天补全接口
 * @param {Object} config - AI 配置
 * @param {string} config.apiKey - API Key
 * @param {string} config.baseUrl - API Base URL
 * @param {string} config.model - 模型名称
 * @param {number} [config.timeout] - 超时时间（毫秒）
 * @param {Array} messages - OpenAI 格式的 messages 数组
 * @returns {Promise<Object>} { success, content, error, usage }
 */
async function callChatCompletion(config, messages) {
    var LOG_PREFIX = '[AI-Service]';

    if (!config.apiKey) {
        console.error(LOG_PREFIX, '❌ API Key 未配置');
        return { success: false, error: 'API Key 未配置' };
    }

    if (!messages || messages.length === 0) {
        console.error(LOG_PREFIX, '❌ messages 不能为空');
        return { success: false, error: 'messages 不能为空' };
    }

    var baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    var model = config.model || 'gpt-4o-mini';
    var timeout = config.timeout || 30000;
    var url = baseUrl + '/chat/completions';

    console.log(LOG_PREFIX, '📤 发起 AI 请求:', {
        url: url,
        model: model,
        messageCount: messages.length,
        timeout: timeout
    });

    // 构建请求体
    var requestBody = {
        model: model,
        messages: messages,
        temperature: 0.7,
        max_tokens: 500,
        stream: false
    };

    // 千问 qwen3 等思考模型：非流式调用需要显式关闭 thinking
    var isDashScope = baseUrl.indexOf('dashscope') !== -1;
    var isThinkingModel = /qwen3|qwq/i.test(model);
    if (isDashScope || isThinkingModel) {
        requestBody.enable_thinking = false;
        console.log(LOG_PREFIX, '🔧 检测到思考模型，已关闭 enable_thinking');
    }

    // 超时控制
    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
        controller.abort();
    }, timeout);

    try {
        var response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + config.apiKey
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            var errorText = '';
            try {
                var errorData = await response.json();
                errorText = (errorData.error && errorData.error.message) || response.statusText;
            } catch (e) {
                errorText = response.statusText;
            }
            console.error(LOG_PREFIX, '❌ API 返回错误:', response.status, errorText);
            return {
                success: false,
                error: 'API 错误 (' + response.status + '): ' + errorText
            };
        }

        var data = await response.json();

        if (!data.choices || data.choices.length === 0) {
            console.error(LOG_PREFIX, '❌ 无有效回复');
            return { success: false, error: '无有效回复' };
        }

        var content = data.choices[0].message && data.choices[0].message.content;
        if (!content) {
            console.error(LOG_PREFIX, '❌ 回复内容为空');
            return { success: false, error: '回复内容为空' };
        }

        console.log(LOG_PREFIX, '✅ AI 回复成功, 字数:', content.length);

        return {
            success: true,
            content: content.trim(),
            usage: data.usage || null,
            model: data.model || model
        };

    } catch (error) {
        clearTimeout(timeoutId);

        if (error.name === 'AbortError') {
            console.error(LOG_PREFIX, '❌ 请求超时 (' + timeout + 'ms)');
            return { success: false, error: '请求超时 (' + timeout + 'ms)' };
        }

        console.error(LOG_PREFIX, '❌ 网络异常:', error.message);
        return { success: false, error: '网络异常: ' + error.message };
    }
}

console.log('[AI-Service] AI 聊天补全服务已加载');
