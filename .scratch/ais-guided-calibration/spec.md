# AIS 引导筛选与自动精调规格

Status: resolved

## 目标与授权范围

用户已确认“人工粗调后自动精调”“先检查关联，再开始标定”，并要求排除框内雷达观测。本次实现完整流程；保留原始观测、历史回放和旧任务兼容，不发布生产参数，不进行浏览器调试。以下可调门限是工程初值，不代表现场精度结论。

## 参数

FitOptions 新增可空的 refinement，缺省 null；旧接口和历史继续采用原算法，新工作台使用精调并要求先检查关联。refinement 包含：

| 字段 | 默认值 | 约束与含义 |
| --- | --- | --- |
| initial | 当前粗调参数 | 冻结的 lng、lat、bearingOffsetDeg |
| maxDistanceM | 200 | 10—2000 m；AIS 定位点附近距离；当时有效且已知的船体尺寸可提供外包圆余量 |
| maxPositionShiftM | 100 | 1—2000 m；相对初值东西、南北各方向的修正上限 |
| maxBearingShiftDeg | 5 | 0.1—30°；相对初值的朝向修正上限，按周期角处理 |
| minTrackPoints | 4 | 2—100；稳定关联要求的不同真实时刻数 |
| minTrackDurationMs | 12000 | 1000—300000 ms；最短稳定关联持续时间 |
| motionToleranceM | 75 | 1—1000 m；雷达与 AIS 相对位移变化的容许尺度 |
| radarExclusion | null | ENU 矩形；按 initial 投影，排除框内及边界雷达观测 |
| associationIds | null | 人工检查后保留的关联标识；任务不得提交 null 或空列表 |

参数、初值、排除区域和人工取舍随任务冻结并结构化保存。未启用 refinement 时的旧设置摘要保持兼容。点击取得的后续船体尺寸仅用于显示。

## 筛选公共接口

shared/refinement.js 提供 selectRefinementObservations(dataset, options)，前端检查和后台拟合共用。返回 associations、training、validation、exclusions；training/validation 每项包含 observation、ship、associationId。

associations 每项包含 id、deviceId、trackId、mmsi、points、start、end、distanceP50M、motionErrorM；start/end 是毫秒，points 是训练时段内不同真实雷达时刻数。id 为 JSON.stringify([deviceId, trackId, mmsi])，不能用 UI 行号替代。

1. 先按完整数据范围的最后 validationFraction 划出验证时段。候选关联、稳定性和检查摘要只使用拟合时段，不根据验证误差选择关联。
2. 只使用固定参考点 30 km 内、符合既有时间窗口且无同刻位置冲突的真实 AIS 状态；拟合 AIS ROI 按同时刻状态过滤。不对标定位置插值或外推。
3. 在固定 initial 下先排除雷达区域，再找距离门限内的船舶候选。按 deviceId/trackId/MMSI 组织候选，要求足够真实时刻、持续时间及相对位移一致性。单次靠近不能纳入整条轨迹，超出门限的点不纳入。
4. 一船可对应多条雷达轨迹；同轨迹多个合格船舶候选须保留竞争信息供人工剔除，同一雷达观测不得重复采样。训练重叠点按冻结初值下的最近距离决定归属，等距点不强行归属并记录数量；验证身份沿用训练阶段确定的关联，不按验证分数或验证段近远重新选船。
5. associationIds 为 null 时返回可检查候选；指定列表时只保留选择项，未知标识明确报错。训练 AIS 索引截止 splitTime 之前，不能借验证段报告建立训练关联。验证时段仅应用冻结初值、门限和训练阶段选出的关联，不重选船或调参。
6. 先筛选后均衡采样；排除区、未靠近、不稳定和人工剔除数量保留证据。未关联不等于物理噪声。不得修改 dataset。允许复用同刻 AIS 缓存降低重复计算。

## 局部精调

沿用现有船体与背景概率模型，在已检查且固定的关联观测上均衡采样和局部 EM，不因候选参数变化重新引入其他观测或船舶。

精调的有限背景支持域由局部位置边界及雷达业务契约的 100000 m 距离上限预先确定，不从验证段或已筛掉的观测估计。该上限不是设备真实覆盖；refinement:null 保留原有研究区域算法。

位置边界为 initial 的固定 ENU 坐标各方向加减 maxPositionShiftM；角度只搜索 initial ± maxBearingShiftDeg。人工初值本身必须参与候选比较。refinement 为 null 的兼容任务保留原有全角度搜索。

任务保存原始提交的 options；结果 options.bounds 表示实际局部边界，重启读取及导出按相同固定参考点与初值恢复，不能被请求中的旧搜索框替换。

结果新增 initialMetrics: { training, validation }，与候选使用完全相同的样本和模型。仍展示支持、背景、残差、边界和多解。验证表现下降或未显示稳定改进时不得宣称优于人工，不自动应用参数。

## 工作台

- 自动标定表单提供附近距离、位置和角度修正范围；高级设置提供稳定关联门限并保留现有误差参数。
- 地图新增“雷达排除区域”拖框与清除，排除仅作用于精调输入。
- “筛选附近雷达”冻结当前粗调参数和设置，展示候选 AIS、轨迹、有效时刻数、持续时间、距离、运动一致性；默认选中合格候选，可逐项剔除。
- 地图能检查已保留轨迹与 AIS 关联，保留原始轨迹查看入口，不改变原始回放和插值。
- 参数、ROI、排除区、门限、时间或当前雷达变化时旧检查失效，须重新筛选；过期异步结果不得覆盖新草稿。
- 任务必须基于当前有效检查和非空选择，提交固定 initial、associationIds。历史恢复、候选应用遵守原草稿和快照身份规则。
- 证据展示初值与候选的同一保留时段指标，以及总观测、筛选保留和排除情况。

## 验证与交付

测试边界为筛选/拟合公共结果、Fastify 任务接口与重启恢复、Vue 工作台状态；不新增浏览器测试。覆盖噪声挤占配额、瞬时靠近、运动不一致、区域边界排除、多回波和竞争、初值冻结和跨北向局部恢复、未检查/空选择拒绝、检查失效、持久化、原始数据不变及验证隔离。

完成定向测试后运行 npm test 和 npm run build；不将其视为现场精度或浏览器验收。

## 实施方式

当前目录没有 Git 仓库或附加工作树，沿用当前目录，不初始化 Git 元数据。修改前快照位于 C:/Users/Administrator/AppData/Local/Temp/radar-guided-implementation-9e075829924b4fcd84474229b9c873d3，作为最终双轴审查基点。子代理使用全新上下文和明确文件职责，按 tdd 实施；独立集成检查后按 code-review 审查标准与规格，按本地 Markdown 约定关闭任务。
