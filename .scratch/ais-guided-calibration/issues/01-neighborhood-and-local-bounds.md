# 实现精调参数与 AIS 引导轨迹筛选

Type: task
Status: resolved

## 任务

依据[规格](../spec.md)：实现公共筛选接口，先筛选稳定船舶/雷达关联再采样。覆盖噪声配额、瞬时靠近、运动一致性、区域排除、竞争关联、独立验证和原始数据保护。

## 文件职责

shared/data.js、shared/types.ts、新增 shared/refinement.js、新增 tests/refinement.test.js。未经协调不要修改其他任务的文件。

## Answer

已实现可空 `FitOptions.refinement`、工程默认门限与输入校验；`DEFAULT_REFINEMENT_OPTIONS` 不包含初值，可供工作台复制初始化。旧设置缺省解析为 `refinement: null`。共享类型包含精调设置、关联摘要、固定观测选择和可选 `FitResult.initialMetrics`。

`selectRefinementObservations(dataset, options)` 返回 `associations`、`training`、`validation`、`exclusions` 和毫秒 `splitTime`。返回的观测尚未均衡采样，每项固定为 `{ observation, ship, associationId }`；同一雷达点至多返回一次。预览保留全部合格竞争摘要，指定 `associationIds` 后只返回选中项，未知标识明确抛错。训练重叠点按冻结初值下最近距离归属；米制距离相差不超过 `1e-6` 视为数值上无法区分，记录 `ambiguousPoints` 并排除，人工单选后可明确归属。

稳定性只使用训练时段的真实 AIS 和雷达状态，训练 AIS 索引截止 `splitTime` 之前。按轨迹连续片段要求不同真实时刻数、持续时间和运动一致性；不靠近、缺少对齐状态、相对位移突变或超过 `max(minTrackDurationMs, 2 × maxGapMs)` 的断报会分段。运动误差取相对偏移散布 RMS 与整段线性漂移长度的较大值，排除持续靠近但运动不一致的片段。验证身份按训练末尾合格片段的距离中位数固定，不按验证近远换船；训练末段中断及验证中的断报、门限失配或位移突变均不续接。

按冻结初值排除雷达矩形及边界，再执行固定参考点 30 km、拟合 AIS ROI、时间窗口、同刻位置冲突和附近距离门限。船体外包圆仅使用当时已知且有效的原始尺寸，包括来源匹配的已导入静态报告；未来静态报告不回填训练，COG 不改作船艏向。同刻 AIS 状态缓存复用，输入数据保持不变。完整时段数据按迭代求首尾，没有大数组参数展开。

排除证据字段为 `totalRadarPoints`、`outsideLocalAisPoints`、`conflictingAis`、`radarExclusionPoints`、`notNearbyPoints`、`unstablePoints`、`manuallyExcludedPoints`、`ambiguousPoints`、`competingPoints`、`retainedTrainingPoints`、`retainedValidationPoints`。未关联不代表物理噪声。

按已确认的筛选公共边界逐片 red → green：首个真实失败为 `node --test tests/refinement.test.js` 中精调选项被旧 schema 丢弃，实际 `undefined` 与要求的冻结初值及门限对象不符；加入 schema 后通过。后续船体余量、零散靠近、人工选择、等距竞争、验证身份和运动漂移均先记录断言失败，再加入相应实现。最终 `node --test tests/refinement.test.js` 12/12 通过；`node --test --test-concurrency=1 tests/domain.test.js tests/refinement.test.js` 31/31 通过。覆盖噪声挤占、瞬时/间歇靠近、长断报、轨迹重置、区域边界、多回波与竞争、未知手选、顺序无关、训练/验证隔离、静态尺寸时效和原始数据保护。

本任务未运行浏览器或访问真实数据库；完整 `npm test`、`npm run build` 及集成审查由主任务统一执行。上述工程门限和测试不构成现场精度验收。
