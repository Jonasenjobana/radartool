# Git 提交规范

仓库默认分支为 `master`，初始项目基线使用附注标签 `v1.0`。

## 提交格式

采用 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/zh-hans/v1.0.0/)：

```text
<type>[(<scope>)][!]: <摘要>

[可选正文]

[可选页脚]
```

类型与范围使用小写英文，摘要使用简体中文，技术名称可保留英文。范围可省略；填写时使用小写字母、数字和连字符，表示本次改动涉及的模块，例如 `playback`、`calibration`、`storage`、`sources`、`git`。冒号后保留一个半角空格，并填写非空摘要。

| 类型 | 用途 |
| --- | --- |
| `feat` | 新增功能 |
| `fix` | 修复缺陷 |
| `docs` | 修改文档 |
| `refactor` | 保持行为的代码重构 |
| `perf` | 性能优化 |
| `test` | 新增或调整测试 |
| `build` | 构建、依赖或打包配置 |
| `ci` | 持续集成配置 |
| `chore` | 开发工具或其他维护工作 |
| `style` | 格式调整 |
| `revert` | 回退已有提交 |

一次提交围绕一个完整问题。正文与标题之间空一行，按需说明原因、约束和验证结果。破坏性变更在冒号前加 `!`，或在页脚使用 `BREAKING CHANGE: <影响与迁移方式>`。

```text
feat(calibration): 增加关联检查
fix(playback): 修复时间轴跳转后目标位置
docs: 更新本地启动说明
feat(api)!: 调整回放响应结构
```

## 本地校验

克隆仓库后运行 `npm ci`，`prepare` 会为当前仓库设置 `core.hooksPath=.githooks`。已有依赖时运行 `npm run prepare` 即可启用。

`commit-msg` 钩子调用 `scripts/check-commit-message.js`，校验提交标题的类型、可选范围、破坏性标记与非空摘要；正文及摘要语言由提交者核对。校验失败时修改消息后重新提交。可独立检查消息文件：

```powershell
node scripts/check-commit-message.js .git/COMMIT_EDITMSG
```

## 版本标签

版本标签指向准备发布的提交，使用附注标签。发布前执行项目所需验证，再推送分支及该标签。例如发布 `v1.0.1`：

```powershell
git tag -a v1.0.1 -m "v1.0.1"
git push origin master
git push origin v1.0.1
```

`v1.0` 保留初始项目快照；后续版本使用新标签，已发布标签保持指向原提交。
