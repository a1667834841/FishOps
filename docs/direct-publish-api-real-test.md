# 扩展后台直接发布 API：两种入口真实测试

日期：2026-10-04；ego-browser TaskSpace 152。

## 实现

- `extension/src/background/direct-publish-api.ts`：后台门面和独立 runtime 消息，严格限定扩展内页。
- `extension/src/background/direct-publish-page.ts`：自包含 MAIN world 注入函数，复用官方 SDK，不填 DOM 表单。
- `extension/src/background/index.ts`：注册独立消息监听，不改变既有发布中心。
- `extension/src/publish/test/direct-publish-api.test.ts`：后台 API mock 测试。
- 调用方在扩展内页执行 `chrome.runtime.sendMessage({kind:'fishops-direct-publish',method:'publish',request})`。
- 专用发布页由后台自动创建 `active:false`，调用方无需手动打开闲鱼页面；非激活标签页仍会在标签栏显示，不是真正无浏览器。

## 真实调用结果

源商品：1080308009509，DGX Spark，源售价 35000 元。

| 入口 | 请求摘要 | 真实结果 | 下架状态 |
| --- | --- | --- | --- |
| `source.itemId` | itemId 1080308009509、imageIndexes [0,2] | `published`，itemId **1087983250245** | 已点击下架、确认、刷新确认“已下架” |
| `source.product` | 完整描述、price "35000"、第1/3张图片、规格：型号 NVIDIA DGX Spark / 系统内存128GB / 存储4TB | `published`，itemId **1090104128936** | 已点击下架并确认；后续接管浏览器已确认详情页显示“已下架” |

两次均从本扩展 Workbench 页面通过真实 `chrome.runtime.sendMessage` 调用后台监听，后台执行自动标签页创建及 Chrome MAIN world injection。不是从网页直接调用旧 harness。

每件使用两张图片：原第2张说明书上有二维码，第4张标签难以确认，因此仅使用已检查的第1/3张；不遮盖或修改二维码图片。服务承诺全部关闭，不填虚构原价。卖家地址来自账号默认 POI，不继承源卖家地址。

## 幂等复验

- itemId 请求同 key再次调用 → `published/itemId:1087983250245/reused:true`。
- product 请求同 key再次调用 → `published/itemId:1090104128936/reused:true`。
- 同时发起两个复验，其中一项得到 `CONCURRENT_LOCK`；随后单独调用该项返回已有结果。
- 没有新建第三件商品。

## 分类与规格准确性风险

虽然API成功，平台自动推荐属性**并不准确**：DGX 商品被识别出显存 `8GB(不含)-16GB(含)`，product入口还出现品牌 `NVIDIA Quadro`。

源商品描述为128GB统一内存；用户提供 specifications 仅追加在描述中，不代表平台属性标签已校验或正确。不能把“发布成功”称作“商品参数准确”。加固版返回明确 warnings，生产使用前应增加类目/属性确认或显式override机制。本轮不修改已发布数据，只执行下架测试。

## 验证与版本边界

- 首轮实现：类型检查、build、187项发布测试通过，随后两种入口真实成功。
- 真实测试后审查加固：严格专用tab URL、损坏账本fail-closed、accountScope防漂移、网络/注入超时、规格/价格schema、结构化风控失败、推荐属性warnings。
- 加固后：`npm run build:extension` 通过；`npm run typecheck --workspace @fishops/extension` 通过；`npm run test:publish` **199项通过、0失败**（新后台模块37项）。
- 加固版本已构建到dist，尚未重新加载浏览器扩展；不额外创建商品重复测试。应完成当前滑块/下架确认后重载，再用已有幂等key做无新增商品复验。
- 本轮仅添加独立API模块、测试和文档，以及index安装接线；保留仓库其他用户未提交改动。没有git提交。

## 加固与日志版本真实复测

用户授权继续测试后，复用 TaskSpace 152：

- 已确认第二件 `1090104128936` 的详情页显示“已下架”，上轮清理闭环完成。
- 重载扩展（会关闭扩展内页，因此在同一空间重新打开 Workbench 调用页），使用已有请求 key 成功返回 `1087983250245/reused:true`，证明持久账本跨 Service Worker 重启有效。
- 新 key `dgx-itemid-logging-retest-20261004-02` 真实发布成功：**1087142931400**，售价35000元、两张已检查图片、原价未填、服务承诺关闭。
- 页面内捕获18条受控 API 日志，覆盖7个 prepare 请求及2个 publish 请求的开始与完成；每阶段 traceId 可关联后台。全部成功，本次没有观察到滑块。日志检查未发现Cookie/token/验证码URL。
- 新商品详情仍显示显存8–16GB的错误推荐属性，说明平台属性准确性问题没有被添加规格描述或后台封装解决。
- 已对新商品点击下架并确认，等待页面出现“已下架”成功；仅新建1件，无额外发布。
- 同一新key再次调用返回 `1087142931400/reused:true`。修正日志后重载扩展再次调用仍返回同一结果，没有创建重复商品。
- 发现并修复：请求开始日志的status原为success，现改为pending，避免把开始误判成已成功；补回归测试先失败后通过。
- 最终日志5项定向测试、全量发布测试204项通过；扩展typecheck/build通过。

日志只覆盖后台API自身请求；手动查看商品详情的官方请求不在API日志范围。验证码/超时路径本次没有真实复现，已有mock测试覆盖，不能以本次成功断言不会触发风控。没有绕过验证码，也没有对未知提交自动重试。
