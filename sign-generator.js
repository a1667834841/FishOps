/**
 * SignGenerator - 签名生成器
 * 为了向后兼容，保留此文件作为 XianyuAPI 的别名
 *
 * @deprecated 请直接使用 XianyuAPI 模块
 * @see xianyu-api.js
 */

(function() {
  'use strict';

  // 等待 XianyuAPI 加载完成
  function initSignGenerator() {
    if (window.XianyuAPI) {
      // 创建 SignGenerator 作为 XianyuAPI 的别名
      window.SignGenerator = window.XianyuAPI;

      // 额外保留旧版本特有的方法（如果有）
      window.SignGenerator.showTokenInfo = function() {
        const token = this.getToken();
        const fullToken = this.getFullToken();
        console.log('[SignGenerator] ========== Token 信息 ==========');
        console.log('[SignGenerator] 完整 Cookie _m_h5_tk:', fullToken);
        console.log('[SignGenerator] 提取的 Token:', token);
        console.log('[SignGenerator] ================================');
      };

      // 旧版本的 buildNextPage 方法（兼容）
      window.SignGenerator.buildNextPage = function(formDataStr) {
        // 解析 form data
        const params = new URLSearchParams(formDataStr);
        const dataValue = params.get('data');

        if (!dataValue) {
          console.error('[SignGenerator] 无法从 form data 中解析 data 参数');
          return null;
        }

        // 解析 JSON 数据
        let data;
        try {
          data = JSON.parse(decodeURIComponent(dataValue));
        } catch (e) {
          console.error('[SignGenerator] JSON 解析失败:', e);
          return null;
        }

        const currentPage = data.pageNumber;
        const nextPage = currentPage + 1;

        console.log('[SignGenerator] 当前页码:', currentPage);
        console.log('[SignGenerator] 下一页码:', nextPage);

        // 修改页码
        data.pageNumber = nextPage;

        // 生成新签名
        const signResult = this.generate(data);

        // 构造新的 form data
        const newFormData = 'data=' + encodeURIComponent(JSON.stringify(data));

        return {
          ...signResult,
          pageNumber: nextPage,
          formData: newFormData,
          dataObject: data
        };
      };

      // 旧版本的 verify 方法（兼容）
      window.SignGenerator.verify = function(expectedSign, data, options = {}) {
        const result = this.generate(data, options);
        const isMatch = result.sign === expectedSign;

        console.log('[SignGenerator] 验证结果:', isMatch ? '✅ 匹配' : '❌ 不匹配');
        console.log('[SignGenerator] 预期签名:', expectedSign);
        console.log('[SignGenerator] 计算签名:', result.sign);

        return isMatch;
      };

      console.log('[SignGenerator] 已初始化（兼容模式，基于 XianyuAPI）');
    } else {
      // 如果 XianyuAPI 还未加载，稍后重试
      setTimeout(initSignGenerator, 50);
    }
  }

  // 启动初始化
  initSignGenerator();

})();
