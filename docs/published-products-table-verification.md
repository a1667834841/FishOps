# 自己发布的商品库展示调整验收

## 改动范围

仅调整“自己发布的商品库”：移除商品详情补齐提示、单行发布按钮、卖家列及商品名称下面的 itemId 小字。表头显示“商品名称”，时间列与排序选项显示“发布时间”。飞书采集库保留原展示与操作。

真实详情接口的 `data.itemDO.gmtCreate` 是毫秒发布时间。后台保留该字段，前端展示该时间，自有商品按该时间排序；字段缺失显示“—”，不使用读取时间替代。兼容现有查询的 `captureTimeDesc` / `captureTimeAsc` 枚举，不改变飞书查询协议。

## 真实入口与修改前证据

在 ego-browser 测试空间 309，通过固定测试扩展的工作台进入商品库，再选择“自己发布的商品库”。真实列表包含 11 件商品，修改前显示卖家列、商品 ID 小字、发布按钮、采集时间与商品详情补齐提示。

只读查询其中一件商品详情确认：`gmtCreate` 为 `1791295827000`，`GMT_CREATE_DATE_KEY` 为 `2026-10-06 22:10:27`。没有保存完整响应，没有执行发布或发送操作。部署前确认采集与发布运行中任务均为 0。

## 自动检查与部署

工作目录：`/Users/wuwenjing/codes/extensions/FishOps-published-products`，分支：`fix/published-products-table`。

- 修改前新增的发布时间映射回归失败：实际 `0`，期望 `1700000000000`。
- `npm run test --workspace @fishops/workbench`：401 项通过。
- `npm run test:background`：156 项通过，包括发布时间透传、排序及缺失时间不使用读取时间替代。
- `npm run test:capture`：92 项通过。
- `npm run typecheck`：全部 workspace 通过。
- `npm run agent:setup`：退出码 0，完成实际构建，同步固定扩展目录，重载并导入配置，输出 `SETUP_COMPLETED`。
- `git diff --check`：通过。

日志位于本机 `/tmp/published-products-*.log`。自动测试使用 Mock，不等同真实最终验收。CI 结果尚未确认。

## 最终真实验收状态

待真实验收。部署脚本调用 `task.finish()` 交还测试空间后，ego-browser 明确报告空间已结束，禁止继续浏览器操作，必须取得用户“继续”授权后恢复。已停止浏览器操作，没有新建空间绕过限制。

待完成：确认最终资源来源；检查自有商品默认及紧凑行距、真实发布时间和时间排序、连续切换飞书库与自有商品库、切出再进入；保存最终真实截图。未返回发布时间的商品应显示“—”。没有最终截图，因此 PR 保持草稿。
