# 议题跟踪：本地 Markdown

本项目的需求规格与任务保存在 `.scratch/`。

## 文件约定

- 每个功能一个目录：`.scratch/<feature>/`。
- 需求规格：`.scratch/<feature>/spec.md`。
- 实现任务：`.scratch/<feature>/issues/NN-<slug>.md`，
  从 `01` 编号，每个任务单独一个文件。
- 分诊状态记录在任务文件顶部附近的 `Status:` 行；
  状态值见 `triage-labels.md`。
- 评论与讨论追加到文件末尾的 `## Comments` 下。

## 技能操作

- “发布到议题跟踪器”：按上述约定创建规格或任务文件，
  按需创建所在目录。
- “读取相关任务”：读取引用路径；仅提供编号时，
  在对应功能目录定位任务文件。

## Wayfinder 操作

- 工作地图：`.scratch/<effort>/map.md`，保存笔记、
  已确认决策与待解问题。
- 子任务：`.scratch/<effort>/issues/NN-<slug>.md`，
  从 `01` 编号，正文写明待解问题。
- 类型：`Type:` 行使用 `research`、`prototype`、
  `grilling` 或 `task`。
- 此流程的 `Status:` 表示探索进度，
  使用 `open`、`claimed`、`resolved`。
- 依赖：顶部附近使用 `Blocked by: NN, NN`；
  所有依赖均为 `resolved` 后才能开始。
- 领取：按编号选择状态为 `open` 且无未解决依赖的任务，
  开工前先保存 `Status: claimed`。
- 完成：在 `## Answer` 下写入答案，设为 `resolved`，
  并将结论摘要及任务链接加入地图的已确认决策中。
