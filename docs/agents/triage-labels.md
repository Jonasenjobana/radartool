# 分诊标签

下表将工程技能的标准角色映射到本项目使用的状态值。

| 标准角色 | 本项目状态值 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 等待维护者评估 |
| `needs-info` | `needs-info` | 等待补充信息 |
| `ready-for-agent` | `ready-for-agent` | 需求明确，可交给代理执行 |
| `ready-for-human` | `ready-for-human` | 需要人工处理 |
| `wontfix` | `wontfix` | 决定不处理 |

分诊任务的 `Status:` 行使用第二列的值。
技能提及某个分诊角色时，使用本表对应值。
调整标签名称时，修改第二列。
