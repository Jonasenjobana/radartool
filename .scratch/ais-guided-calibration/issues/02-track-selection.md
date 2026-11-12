# 实现固定关联与局部自动精调

Type: task
Status: resolved
Blocked by: 01

## 任务

依据[规格](../spec.md)：将筛选结果接入 prepareFit；围绕人工初值局部求解，保留初值比较、跨北向行为、initialMetrics 和旧模式兼容。

## 文件职责

shared/model.js、server/fitter.js、tests/fitter.test.js。未经协调不要修改其他任务的文件。

## Answer

`prepareFit` 在启用精调时要求已经人工检查且非空的 `associationIds`，通过公共筛选接口取得固定的 `{ observation, ship, associationId }`，再按轨迹/时间均衡采样。采样结果按 `observation.id` 回到冻结的单船关联；模型与 EM 不重新调用 AIS 对齐来增加其他船舶或观测。保留全部筛选排除统计，并补充未采样、退化船体与短轨迹证据。训练轨迹质量仅由筛选后的训练观测计算，验证数量与持续时间不参与训练权重。原始输入及选项保持不变；精调背景域使用业务契约距离上限预先固定，旧模式的最大原始距离改为迭代求值，支持完整工作集。

局部求解以冻结初值的固定 ENU 坐标为中心，东西、南北分别限定在 `maxPositionShiftM` 内；朝向使用周期角，只搜索 `initial ± maxBearingShiftDeg`。粗网格和 EM 步长由真实局部角度间距确定，M 步同时遵守位置与角度范围。实际局部边界同步用于背景研究区域、`result.options.bounds` 和位置/角度触边证据；米级范围的触边容差随范围缩小，保留 50,000 候选的粗网格上限。

人工初值明确参与候选比较，并返回使用同样采样观测与概率模型的 `initialMetrics.training/validation`。候选仍只按训练分数排名；保留时段分数或支持下降、训练与保留时段未显示稳定改进时返回 `insufficient` 及原因，不宣称优于人工。精调证据使用 `ais-guided-track-time-balanced-chronological-v1`，旧 `refinement: null` 的全角度算法、采样版本与结果字段保持兼容，模型密度版本继续沿用。

按已确认的 `runFit` 公共结果边界逐片 red → green。记录的真实失败包括：未检查选择未抛错、远处轨迹未产生筛选证据、旧搜索框使局部真值恢复失败、缺少初值指标、朝向触边未被标记、精调版本仍为旧值，以及米级范围内部候选被旧 2 m 容差误报触边；对应最小实现后均通过。新增回归还覆盖 300 条远处轨迹（1,200 点）不挤占 240 点采样配额、跨北向恢复、固定船舶与人工/区域剔除、初值和候选同样采样指标、验证退步及排名隔离、训练权重不借验证、局部粗网格上限与输入保护。

Node `v22.22.3` 下执行 `node --test --test-concurrency=1 tests/domain.test.js tests/refinement.test.js tests/fitter.test.js`，51/51 通过，其中拟合回归 20/20。未运行浏览器或访问真实数据库；完整 `npm test`、`npm run build` 与最终集成审查由主任务统一执行。上述恢复阈值与合成夹具不构成真实现场精度验收。
