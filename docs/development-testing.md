# 开发测试入口

新 Agent API 使用 [自动测试流程](agent-api-testing.md)；旧工作台测试保存在 legacy，不作为 M1 验收证据。

- `npm run verify`：类型、单元与生产 host 进程集成。
- `npm run regression`：增加构建、产物与隔离安装检查。
- `npm run regression:full`：还要求真实 Chrome 验收；环境不具备返回 2，不伪装通过。
- `FISHOPS_LIVE_SMOKE=1 npm run test:lifecycle-observe`：只读观察在线、连接拒绝、恢复，并检查账号及已有事件游标保留。停止和唤醒动作需外部触发；可测试 SW 强制停止，不等同于自动关闭重开浏览器。未显式启用时退出 2，不读取安装配置。

协议、安全与生命周期断言以 [实施契约](agent-api-contract.md) 为准。报告位于 `.test-results/`，区分 passed、failed、blocked 和 not-covered。
