# 实现精调输入与初值证据的持久化

Type: task
Status: resolved

## 任务

参数结构已在规格和共享类型中固定，本任务可与筛选实现并行；完整任务链由集成验收统一验证。

依据[规格](../spec.md)：按列与关联表保存初值、门限、排除区、人工保留关联和 initialMetrics。读取、导出、重启保持一致，兼容旧设置摘要。

## 文件职责

server/storage-schema.js、server/task-storage.js；必要的 server/app.js、server/tasks.js；存储或任务接口测试。未经协调不要修改其他任务的文件。

## Answer

精调输入通过 `task_refinements` 按列保存冻结初值、门限和雷达排除矩形，人工关联选择通过 `task_refinement_associations` 按行保存原顺序。独立的检查标志保留 `associationIds: null` 与 `[]` 的区别；旧任务读取的 `refinement` 为 `null`。任务提交接口对未检查、缺少选择和空选择明确返回 400。

初值训练与验证的完整 Metrics、空残差及分组指标通过现有 `task_metrics`、`task_metric_groups` 保存，`rank = -1` 与自动候选分开；重启后的任务 API、导出和参数版本完整证据均可读取。任务保留原始请求设置，结果的实际局部 bounds 使用持久化参考点与冻结初值，通过求解和恢复共用的函数重建。旧模式设置摘要与此前不含 refinement 的摘要一致；精调摘要将关联 ID 视为集合，排序或重复选择不会被误认为不同的验证设置，保存的人工输入不被重排。

按已确认的 Fastify 任务接口与重启恢复边界逐片完成 red → green，验证命令与结果：

- `node --test --test-concurrency=1 tests/refinementStorage.test.js tests/storage.test.js tests/api.test.js`：18/18 通过，包含 6 个新增用例和原有任务接口、旧存储迁移回归。
- `node --test --test-name-pattern='服务关闭中断准备' tests/windowPlayback.test.js`：1/1 通过，旧准备任务关闭恢复不再丢失 `refinement: null`。

验证使用 Node 22.22.3、本地 Fastify 和临时 SQLite；没有连接真实库或进行浏览器调试。完整筛选/求解/工作台链路、`npm test` 与 `npm run build` 由集成验收统一执行。
