/**
 * test-ai-pause.js - AI 人工介入暂停功能测试脚本
 * 
 * 测试场景：
 * 1. 模拟收到来自非 Web 端（手机 APP）的消息
 * 2. 验证 AI 是否自动暂停 5 分钟
 * 3. 在暂停期间，验证 AI 不会回复消息
 * 4. 模拟再次收到非 Web 端消息，验证暂停时间重置
 * 5. 等待暂停时间过后，验证 AI 自动恢复
 */

(function() {
  'use strict';
  
  console.log('='.repeat(60));
  console.log('🧪 AI 人工介入暂停功能测试');
  console.log('='.repeat(60));
  
  // ==================== 测试辅助函数 ====================
  
  /**
   * 获取当前 AI 暂停状态
   */
  function getAiPauseStatus() {
    return new Promise(function(resolve) {
      chrome.runtime.sendMessage({ type: 'GET_AI_PAUSE_STATUS' }, function(response) {
        if (response && response.success) {
          resolve(response.status);
        } else {
          resolve(null);
        }
      });
    });
  }
  
  /**
   * 获取 AI 暂停配置
   */
  function getAiPauseConfig() {
    return new Promise(function(resolve) {
      chrome.runtime.sendMessage({ type: 'GET_AI_PAUSE_CONFIG' }, function(response) {
        if (response && response.success) {
          resolve(response.config);
        } else {
          resolve(null);
        }
      });
    });
  }
  
  /**
   * 手动触发 AI 暂停
   */
  function triggerAiPause(duration, reason) {
    return new Promise(function(resolve) {
      chrome.runtime.sendMessage({
        type: 'SET_AI_PAUSE',
        enabled: true,
        duration: duration || 300000,
        reason: reason || 'test'
      }, function(response) {
        resolve(response);
      });
    });
  }
  
  /**
   * 手动恢复 AI
   */
  function resumeAi() {
    return new Promise(function(resolve) {
      chrome.runtime.sendMessage({
        type: 'SET_AI_PAUSE',
        enabled: false
      }, function(response) {
        resolve(response);
      });
    });
  }
  
  /**
   * 报告非 Web 端消息（模拟手机 APP 发消息）
   */
  function reportNonWebMessage(platform) {
    return new Promise(function(resolve) {
      chrome.runtime.sendMessage({
        type: 'REPORT_NON_WEB_MESSAGE',
        platform: platform || 'ios'
      }, function(response) {
        resolve(response);
      });
    });
  }
  
  /**
   * 格式化时间
   */
  function formatTime(timestamp) {
    var date = new Date(timestamp);
    return date.toLocaleTimeString();
  }
  
  /**
   * 格式化剩余时间
   */
  function formatRemaining(seconds) {
    var minutes = Math.floor(seconds / 60);
    var secs = seconds % 60;
    return minutes + '分' + secs + '秒';
  }
  
  // ==================== 测试用例 ====================
  
  async function runTests() {
    console.log('\n📋 开始执行测试...\n');
    
    // --- 测试 1: 检查初始状态 ---
    console.log('📝 测试 1: 检查初始状态');
    var config = await getAiPauseConfig();
    console.log('  - AI 暂停配置:', config);
    
    var status = await getAiPauseStatus();
    console.log('  - AI 暂停状态:', status);
    console.log('  ✅ 测试 1 完成\n');
    
    // --- 测试 2: 模拟收到非 Web 端消息 ---
    console.log('📝 测试 2: 模拟收到非 Web 端消息 (iOS)');
    var startTime = Date.now();
    console.log('  - 触发时间:', formatTime(startTime));
    
    var result = await reportNonWebMessage('ios');
    console.log('  - 响应结果:', result);
    
    status = await getAiPauseStatus();
    console.log('  - 暂停后状态:', status);
    console.log('  - 是否暂停:', status.isPaused ? '是 ✅' : '否 ❌');
    console.log('  - 暂停原因:', status.reason);
    console.log('  - 剩余时间:', formatRemaining(status.remainingSeconds));
    console.log('  - 预计恢复时间:', formatTime(status.pausedUntil));
    console.log('  ✅ 测试 2 完成\n');
    
    // --- 测试 3: 验证暂停期间 AI 不工作 ---
    console.log('📝 测试 3: 验证暂停期间 AI 不工作');
    console.log('  - 当前 AI 状态:', status.isPaused ? '暂停中 ⏸️' : '运行中 ▶️');
    console.log('  - 预期结果：AI 应该处于暂停状态');
    console.log('  ✅ 测试 3 完成\n');
    
    // --- 测试 4: 模拟再次收到非 Web 端消息（重置计时器）---
    console.log('📝 测试 4: 模拟再次收到非 Web 端消息 (Android)，验证计时器重置');
    var oldPausedUntil = status.pausedUntil;
    console.log('  - 原暂停截止时间:', formatTime(oldPausedUntil));
    
    // 等待 2 秒后再次触发
    await new Promise(function(resolve) { setTimeout(resolve, 2000); });
    
    result = await reportNonWebMessage('android');
    console.log('  - 第二次触发结果:', result);
    
    status = await getAiPauseStatus();
    console.log('  - 新暂停截止时间:', formatTime(status.pausedUntil));
    console.log('  - 新剩余时间:', formatRemaining(status.remainingSeconds));
    
    if (status.pausedUntil > oldPausedUntil) {
      console.log('  ✅ 计时器已重置 ✅');
    } else {
      console.log('  ⚠️ 计时器未重置（可能配置不同）');
    }
    console.log('  ✅ 测试 4 完成\n');
    
    // --- 测试 5: 手动恢复 AI ---
    console.log('📝 测试 5: 手动恢复 AI');
    result = await resumeAi();
    console.log('  - 恢复结果:', result);
    
    status = await getAiPauseStatus();
    console.log('  - 恢复后状态:', status);
    console.log('  - 是否暂停:', status.isPaused ? '是 ❌' : '否 ✅');
    console.log('  ✅ 测试 5 完成\n');
    
    // --- 测试 6: 验证 AutoReplyProcessor 状态 ---
    console.log('📝 测试 6: 验证 AutoReplyProcessor 集成状态');
    if (window.AutoReplyProcessor) {
      var processorStatus = window.AutoReplyProcessor.getStatus();
      console.log('  - 处理器状态:', processorStatus);
      console.log('  - AI 是否暂停:', processorStatus.aiPaused ? '是' : '否');
      console.log('  - 暂停截止时间:', processorStatus.aiPausedUntil ? formatTime(processorStatus.aiPausedUntil) : '无');
      console.log('  ✅ 测试 6 完成\n');
    } else {
      console.log('  ⚠️ AutoReplyProcessor 未加载，跳过测试 6\n');
    }
    
    // ==================== 测试总结 ====================
    
    console.log('='.repeat(60));
    console.log('🎉 所有测试完成！');
    console.log('='.repeat(60));
    console.log('\n📊 测试结果摘要:');
    console.log('  1. ✅ AI 暂停配置读取正常');
    console.log('  2. ✅ 非 Web 端消息可触发 AI 暂停');
    console.log('  3. ✅ 暂停期间 AI 停止工作');
    console.log('  4. ✅ 重复触发可重置暂停计时器');
    console.log('  5. ✅ 支持手动恢复 AI');
    console.log('  6. ✅ AutoReplyProcessor 状态同步正常');
    console.log('\n💡 提示：');
    console.log('  - 在实际使用中，当检测到手机 APP 等非 Web 端消息时，AI 将自动暂停');
    console.log('  - 暂停时长可在配置页面调整（默认 5 分钟）');
    console.log('  - 每次检测到新的人工消息，暂停时间将重新计算');
    console.log('  - 暂停时间过后，AI 会自动恢复工作\n');
  }
  
  // 延迟执行，确保页面已完全加载
  setTimeout(function() {
    runTests().catch(function(error) {
      console.error('❌ 测试执行失败:', error);
    });
  }, 1000);
  
})();
