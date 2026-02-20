# AI 人工介入暂停功能 - 使用指南

## 📋 功能概述

当 AI 自动回复功能启用时，如果检测到来自**非 Web 端**（如手机 APP）的人工回复消息，AI 将自动暂停回复，避免与人工客服产生冲突。

## 🎯 核心逻辑

1. **检测机制**：通过 WebSocket 消息中的 `platform` 字段判断消息来源
   - `platform: 'web'` - Web 端消息
   - `platform: 'ios'/'android'` - 手机 APP 端消息（人工）
   - 其他非 web 平台 - 视为人工操作

2. **暂停策略**：
   - 首次检测到非 Web 端消息 → AI 暂停 5 分钟
   - 暂停期间再次检测到非 Web 端消息 → 重新计时 5 分钟
   - 暂停时间结束 → AI 自动恢复

3. **配置灵活**：
   - 可自定义暂停时长（60 秒 - 60 分钟）
   - 可启用/禁用此功能
   - 实时查看 AI 暂停状态

## 🔧 配置方法

### 1. 打开配置页面

在 Chrome 扩展管理页面 → FishOps → 选项

### 2. 进入"AI 人工介入配置"

点击自动回复面板中的 **"AI 人工介入配置"** 折叠区域

### 3. 配置参数

- **启用人工优先**：开关是否启用此功能
- **暂停时长**：设置每次检测到人工消息后的暂停时长（毫秒）
  - 最小值：60000 毫秒（1 分钟）
  - 最大值：3600000 毫秒（60 分钟）
  - 默认值：300000 毫秒（5 分钟）

### 4. 状态监控

- **状态显示**：实时显示 AI 当前状态
  - `正常运行`（绿色）- AI 正常工作
  - `暂停中 (X 分 X 秒)`（橙色）- AI 暂停中，显示剩余时间
- **刷新状态**：手动刷新状态显示

## 📊 工作原理

```
用户收到消息
    ↓
解析 platform 字段
    ↓
是否为 non-web？
    ├─ 是 → 触发 AI 暂停 → 设置 pausedUntil = now + duration
    └─ 否 → 继续检查
              ↓
         AI 是否暂停中？
              ├─ 是 → 跳过不回复
              └─ 否 → 正常处理（关键词/AI 回复）
```

## 🧪 测试验证

### 方式 1：使用测试脚本

在闲鱼聊天页面控制台执行：

```javascript
// 加载测试脚本
var script = document.createElement('script');
script.src = chrome.runtime.getURL('test/test-ai-pause.js');
document.head.appendChild(script);
```

测试脚本会自动执行以下场景：
1. ✅ 检查初始状态
2. ✅ 模拟 iOS 端消息触发暂停
3. ✅ 验证暂停期间 AI 不工作
4. ✅ 模拟 Android 端消息重置计时器
5. ✅ 手动恢复 AI
6. ✅ 验证处理器状态同步

### 方式 2：实际操作测试

1. 打开手机闲鱼 APP
2. 向任意联系人发送消息
3. 观察浏览器控制台日志：
   ```
   [自动回复] 📱 检测到非 Web 端消息，平台：ios, 准备触发 AI 暂停
   [自动回复] ✅ AI 暂停已设置，直到：14:30:00
   [Background] ⏸️ AI 已暂停，时长：5 分钟，原因：manual_reply
   ```
4. 在配置页面查看状态变化
5. 等待 5 分钟后，观察 AI 自动恢复

## 🔍 调试日志

### 正常日志

```javascript
// 检测到非 Web 端消息
[自动回复] 📱 检测到非 Web 端消息，平台：ios, 准备触发 AI 暂停

// AI 暂停设置成功
[自动回复] ✅ AI 暂停已设置，直到：14:30:00

// Background 确认
[Background] ⏸️ AI 已暂停，时长：5 分钟，原因：manual_reply

// 暂停期间收到消息
[自动回复] ⏸️ AI 暂停中，跳过处理，剩余：240 秒

// 自动恢复
[自动回复] ✅ AI 暂停结束，已恢复
```

### 异常排查

如果未检测到非 Web 端消息：
1. 检查 `chat-parser.js` 是否正确解析 `platform` 字段
2. 确认 WebSocket 消息包含 `_platform` 信息
3. 在控制台打印消息对象查看实际数据

## 📝 API 参考

### Background API

```javascript
// 获取 AI 暂停配置
chrome.runtime.sendMessage({ type: 'GET_AI_PAUSE_CONFIG' }, callback);

// 更新 AI 暂停配置
chrome.runtime.sendMessage({ 
  type: 'UPDATE_AI_PAUSE_CONFIG', 
  config: { enabled: true, pauseDuration: 300000 } 
}, callback);

// 获取 AI 暂停状态
chrome.runtime.sendMessage({ type: 'GET_AI_PAUSE_STATUS' }, callback);

// 手动控制 AI 暂停/恢复
chrome.runtime.sendMessage({ 
  type: 'SET_AI_PAUSE', 
  enabled: true/false, 
  duration: 300000, 
  reason: 'manual' 
}, callback);

// 报告非 Web 端消息（自动触发暂停）
chrome.runtime.sendMessage({ 
  type: 'REPORT_NON_WEB_MESSAGE', 
  platform: 'ios' 
}, callback);
```

### AutoReplyProcessor API

```javascript
// 获取处理器状态（包含 AI 暂停信息）
var status = window.AutoReplyProcessor.getStatus();
console.log(status.aiPaused);      // 是否暂停中
console.log(status.aiPausedUntil); // 暂停截止时间
```

## 💡 最佳实践

1. **合理设置暂停时长**
   - 短时间离线：2-3 分钟
   - 正常客服：5 分钟
   - 长时间会议：10-15 分钟

2. **配合规则优先级**
   - 高优先级规则（如欢迎语）不受 AI 暂停影响
   - AI 类型规则会被暂停

3. **实时监控状态**
   - 定期查看配置页面的状态显示
   - 注意控制台日志输出

4. **特殊情况处理**
   - 如需立即恢复 AI，可在配置页面关闭"启用人工优先"后保存
   - 或刷新页面重置状态

## ⚠️ 注意事项

1. **多端同步**：暂停状态会在所有打开的闲鱼页面间同步
2. **时间精度**：剩余时间显示为整数秒，实际精度更高
3. **网络延迟**：WebSocket 消息可能有延迟，属正常现象
4. **平台识别**：依赖闲鱼 WebSocket 协议中的 `_platform` 字段

## 🆘 故障排查

### 问题 1：AI 一直暂停不恢复

**检查**：
- 暂停时长配置是否过大
- 是否持续收到非 Web 端消息
- 控制台是否有错误日志

**解决**：
- 减小暂停时长配置
- 刷新页面重置状态
- 暂时关闭功能再开启

### 问题 2：检测不到非 Web 端消息

**检查**：
- WebSocket 消息是否包含 `platform` 字段
- `chat-parser.js` 解析逻辑是否正确

**解决**：
- 在控制台打印原始 WebSocket 消息
- 检查 `_platform` 字段的实际值

### 问题 3：配置无法保存

**检查**：
- Chrome storage 权限是否正常
- Background service worker 是否运行

**解决**：
- 重启 Chrome 扩展
- 检查 manifest.json 权限配置

## 📚 相关文件

- `background/index.js` - AI 暂停状态管理
- `inject/handlers/auto-reply-processor.js` - 自动回复处理器（含暂停检查）
- `inject/chat-parser.js` - 消息解析（含 platform 字段）
- `options/options.html` - 配置页面 UI
- `options/options.js` - 配置页面逻辑
- `test/test-ai-pause.js` - 自动化测试脚本

---

**版本**：v3.0  
**最后更新**：2026-02-20  
**作者**：FishOps Team
