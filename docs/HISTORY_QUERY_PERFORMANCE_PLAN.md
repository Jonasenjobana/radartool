# 历史查询、尺寸渲染与低磁盘占用

## 1. 当前目标与实现状态

本工具用于雷达与 AIS 历史比对、回放和标定。用户需要读取报文中的船长、船宽和 A/B/C/D 渲染船形，同时减少本地解析量和磁盘占用。目标是让原始历史继续留在远程数据源，按用户指定的时间、设备、来源及 AIS 区域获取；当前会话的轨迹与业务观测临时放在内存中，不默认保存全量原始报文和解析结果。

SQLite 使用结构化业务表：设备与匹配组、查询条件、标定参数和结果摘要按字段保存，成员、人工关联选择与候选结果拆成关联表；已有尺寸版本表保留，新历史与点击尺寸均不读写。新存储不使用 JSON 正文列，也不把序列化对象改存为压缩文本或 BLOB。完整快照由用户明确选择保存或导出，SQLite 只登记归档位置和摘要。

当前普通加载按匹配组和完整时段一次读取业务输入，全部成员成功后整体发布并传给前端；播放、跳转、插值和尾迹使用已加载数据。SQLite 只保存结构化目录、参数和摘要，轨迹与原文留在当前工作集，离线保留通过显式归档完成。旧分窗历史可按固定条件完整恢复，旧服务端窗口接口保留兼容。点击 AIS 按来源、MMSI 和回放时间补查后续 48 小时内的第一份有效静态尺寸，只在当前会话显示，契约见 [README](../README.md#点击获取后续静态尺寸)。

当前工作台在完整输入上完成人工粗调、AIS 引导稳定关联筛选与人工检查，再固定关联进行局部精调；初值、筛选设置、人工选择及初值对照指标均作为任务证据保存。筛选只改变精调输入，原始观测与回放不变。字段和行为见[当前精调规格](../.scratch/ais-guided-calibration/spec.md)。

约束：

- 保留现有 SQLite、Fastify、Vue 结构，优先使用已有依赖和 Node 22 的能力。
- SQLite 持久化字段使用明确列与关联表；对象、数组及扩展资料不通过 `payload`、`metadata_json` 或其他序列化列保存。现有 HTTP JSON 和显式导入导出格式在交换层组装，不作为数据库行格式。
- 当前画面使用已完整取得的所选时段数据；标定使用显式准备的完整真实业务输入，显示数据单独生成。原始报文不要求每次查询都在本地留存。
- 已有完整快照继续使用原 SHA-256 验证；临时会话保存查询来源与业务数据指纹，不能把这些小型描述冒充完整证据。完整离线复现由用户明确保存的归档提供。
- 保留组窗口及完整查询各自的原子提交、失败回滚、来源隔离、真实时间和半开区间语义。
- 历史缓存与静态尺寸均围绕用户加载的历史记录工作，不引入设备实时采集、定时扫描生产库或实时静态资料同步服务。
- 插值、船艏向、COG 与点击尺寸保持独立展示语义；精调在采样前筛选并冻结关联，沿用既有船体/背景概率模型。地图显示配额不改变任务快照。

启动、现有接口和数据契约见 [README](../README.md)；上游查询、时间、单位和标定限制见 [查询与标定约束](RADAR_AIS_QUERY_AND_CALIBRATION.md)。

## 2. 优化前的性能基准

### 2.1 用户截图

观察日期：2026-11-10。截图记录的是浏览器请求总耗时，尚无各请求的排队、首字节、传输及前端处理分项。

| 请求 | 响应大小 | 截图耗时 |
| --- | ---: | ---: |
| `GET /api/projects` | 1.0 kB | 5.90 秒 |
| `GET /api/groups` | 0.4 kB | 5.90 秒 |
| `GET /api/snapshots` | 69.8 kB | 13.47 秒 |
| `GET /api/tasks` | 0.2 kB | 13.50 秒 |
| `GET /api/sessions` | 7.4 kB | 26.60 秒 |
| UUID 详情请求 | 168,231 kB | 7.75 秒 |
| `GET /api/versions?...` | 0.2 kB | 24 毫秒 |

截图中的 UUID `2695258e-65e5-46c5-81d9-2c6bdb8308ac` 对应本地旧 `records.kind='sessions'` 的记录。当时客户端通过 `/api/sessions/:id` 恢复会话；截图本身没有显示该行的完整 URL。

这些列表和恢复接口读取本地数据，不调用 ClickHouse，也不重新执行 AIS 协议解析。不能用它们的耗时推断远程数据库或 Java 解析器的速度。

### 2.2 本地数据规模与只读基准

环境为项目指定的 Node 22.22.3。使用 `DatabaseSync(..., {readOnly: true})` 打开当时的数据库，在独立 Node 进程中调用优化前 `SqliteStore` 的读取和校验实现；该次基准没有启动 Fastify、执行迁移、修改数据或访问生产库。

当次数据库样本：

| 类型 | 数量 | JSON 总字节数 |
| --- | ---: | ---: |
| 快照 | 36 | 421,860,503 |
| 会话 | 11 | 7,240 |
| 任务 | 1 | 14,011 |

单份最大快照为 97,689,607 字节。截图对应会话含两份快照，分别为 97,689,607 和 70,540,751 字节，合计 **168,230,358 字节**。

| 操作 | 单次耗时 | 同进程零延时计时器实际等待 |
| --- | ---: | ---: |
| 索引查询 36 条快照 ID、创建时间 | 约 1 毫秒 | 约 1 毫秒 |
| 旧 `store.list('snapshots')` | 13,864 毫秒 | 13,865 毫秒 |
| 按旧会话列表方式读取 11 个会话关联的 22 份快照 | 13,649 毫秒 | 13,649 毫秒 |
| 读取并校验截图会话的两份完整快照 | 5,686 毫秒 | 5,687 毫秒 |

ID 查询仅作为轻量读取的对照，不是现有列表接口的完整替代实现。会话关联基准按序读取相同快照，未包含路由可见性筛选、HTTP 序列化或网络传输。以上均为单次本地测量，不是 p95，也不能直接作为浏览器网络耗时的分解。

对同一会话做临时响应投影估算：

| 内容 | JSON 字节数 |
| --- | ---: |
| 两份原始快照 | 168,230,358 |
| 去掉观测 `raw` 和 `provenance.rawAisReports`，仍按两份快照返回 | 81,469,291 |
| 再共享相同的 AIS 动态及静态数组 | 53,872,226 |

两份快照分别有 46,924、9,904 个雷达点，共享的 AIS 动态点有 34,383 个、静态报告有 13,410 个。临时投影确认两份 AIS 数组相同；这不代表其他项目或其他适配模式也能直接共享。

因此，单独删掉响应中的 `raw` 还不够，回放接口还需要字段投影和数据共享。该估算没有改动已有接口或快照。

### 2.3 优化前的处理开销

优化前已确认：

1. 旧 `SqliteStore.list()` 先取所有记录的完整 `payload`，再逐条 `JSON.parse`；快照额外执行递归规范化 JSON 和 SHA-256。
2. `/api/snapshots` 在这些处理完成后才丢弃 `dataset`，所以响应只有几十 kB，处理时却遍历数百 MB。
3. `/api/sessions` 为检查关联快照的可见性再次读取并校验全部快照。任务、任务进度和版本相关接口也存在为检查关联对象而读取完整快照的路径。
4. 这些同步计算发生在 Fastify 主线程；`async` 包装和 `Promise.all` 不会把同步 SQLite、JSON 或哈希计算移到其他线程。
5. 会话详情返回每台雷达的完整快照，包含重复 AIS、动态观测中的尺寸信息、静态报告以及原始报文证据。
6. 前端初始化会并行刷新快照、任务、会话列表，并等待全部完成后恢复会话，使首屏依赖这些重操作。
7. 旧 `writeRecord()` 对整份业务对象执行 `JSON.stringify`；设备登记也整体读写 `settings.payload`。旧表结构只有记录类型、ID、创建时间和正文，缺少可直接筛选的项目、雷达、时段、状态与参数列。旧 `TaskManager.init()` 还会读取全部任务正文并保留在内存中。

据此判断：截图里小响应也等待数秒，与大记录处理阻塞事件循环、其他请求排队相符。具体每个浏览器请求的排队占比仍待按接口计时验证。

仍待测量：HTTP 序列化和传输、浏览器 JSON 解析及索引建立、内存峰值与 GC、新时间段的 ClickHouse 查询、Java AIS 解析、本地写入的分段耗时。本次不开展浏览器调试；实施验证使用本地旧数据，远程库只核对表结构。

### 2.4 旧样本中的尺寸与船艏向缺失

对最近一份本地快照 `f97f0c31-48b1-41c5-832a-9ee82e42be8f` 的 34,383 条 AIS 动态记录做只读统计，结果如下。计数单位是记录，不是船舶；尺寸按当前解析与关联规则判定。

| 情况 | 记录数 | 已确认事实 |
| --- | ---: | --- |
| 动态记录已关联有效尺寸 | 12,395 | 已有 A/B/C/D 对象，总长宽由四边相加得到 |
| 动态记录未关联尺寸 | 21,988 | 其中 21,574 条在同来源、同 MMSI 的整个查询窗口内都没有有效静态尺寸；414 条只有同刻或更晚的静态报告 |
| 此前已有有效静态报告、动态记录却未关联尺寸 | 0 | 本次未发现这一种丢失，不代表已验证所有时间段和全部解码路径 |
| 缺有效真船艏向 | 21,227 | 其中 20,961 条仍有有效 COG；两者含义不同，不能合并为同一字段 |

该旧样本没有消息 5，有效静态结果主要来自 19、24，仍保留当时取得的尺寸与证据。当前新历史查询仅取 1/2/3/18，船体尺寸改为点击基准时刻后续 48 小时内的第一份有效尺寸，只用于显示，不作为历史标定输入。增加本地存储不能补出源报文没有提供的字段，点击补查也可能无有效结果。

真船艏向来自动态报告，不可用值（如 511）或未提供字段保持缺失，尺寸补查不补船艏向。地图显示优先使用真船艏向，缺失时用有效 COG 表示运动方向，以便取得 A/B/C/D 后绘制船体；该显示回退不改写原字段，标定继续使用真实船艏向及其缺失退化规则。

后续质量信息应区分未取得静态初值、窗口内无有效尺寸、静态报告尚未到达、报文未提供/不可用和组包未完成；取得长宽后，还需结合显示朝向（真船艏向优先，缺失时用有效 COG）及定位参考点是否已知，判断能否绘制有方向的船形。

## 3. 参考项目如何处理

参考源码为 `G:\Work\seaoil`，本次观察 HEAD 为 `c659070bc`。以下是源码行为，不是线上延迟验收。

### 3.1 数据库与表的分工

当前开发、测试和生产配置文件中的 JDBC 数据库名分别为 MySQL `sea-pasture` 与 ClickHouse `default`；运行时是否被外部配置覆盖尚未核实。雷达与 AIS 均同时使用业务数据库和历史数据库，不能按设备类型简单分成“雷达用 MySQL、AIS 用 ClickHouse”。

| 数据库 | 表 | 已确认的用途 |
| --- | --- | --- |
| ClickHouse `default` | `radar_data_combine_all` | 雷达历史，按时间、设备或轨迹筛选；相关读取分支获取经纬度、速度，`RadarUtil` 分支还取距离、方位 |
| ClickHouse `default` | `stationtest_datagram` | 参考雷达/AIS融合接口读取的原始 AIS 历史，查询后用现有 AIS 库解码 |
| ClickHouse `default` | `wp_position` | 已结构化的 AIS 位置历史，包含位置、速度、COG、船艏向等；AIS 轨迹接口直接查询 |
| ClickHouse `default` | `stationtest_position` | 通行记录辅助查询中，按 MMSI 和时段补取最新速度、COG；该调用本身不是完整轨迹查询 |
| ClickHouse `default` | `stationtest_shipborne_repeater_datagram` | 在已追踪的参考源码中仅见于 `RadarUtil` 注释的联合查询；是当前 `radar-tool` 实际配置的船载转发 AIS 原始表，两者需区分 |
| MySQL `sea-pasture` | `tbl_radarposition` | 雷达/AIS综合业务位置，`fromType=0/1` 区分来源类型；接收任务按目标 ID 删除旧状态、写入新状态，不应视为全量轨迹档案 |
| MySQL `sea-pasture` | `tbl_aisposition` | AIS 业务位置，入库分支按 MMSI 合并并替换旧记录，供列表和详情联查 |
| MySQL `sea-pasture` | `tbl_radardata`、`tbl_radaraisdata` | 存在按时间读取雷达/AIS数据的 Mapper 与接口；持续写入和历史覆盖未验证，不能以读取方法存在证明数据完整 |
| MySQL `sea-pasture` | `tbl_aisship`、`tbl_radarship` | 最新船舶静态资料，业务模型保存总长宽等字段 |
| MySQL `sea-pasture` | `tbl_shipname` | 第三方补充的名称、类型和总长宽 |

`ChUtil.insertToPosition` 明确写入 `default.wp_position`；`ChUtil.getSqlList` 和 `AisUtil2.getHbaseList` 均使用 ClickHouse JDBC。后者虽然保留了 `getHbaseList` 名称，当前实现不是 HBase 访问。源码另有写 `default.wp_datagram` 的函数，但 `insertChmodel` 中调用已注释，不能据此认定该原始表持续写入。

### 3.2 实际轨迹接口的调用路径

1. **雷达/AIS融合列表**：前端 `AisRadarService.getAisAndRadarList` 请求 `POST /api/radarposition/getList`，明确带 `ifPage:false`。后端调用 `RadarUtil.getPositionMap`：`fromType=0` 读 ClickHouse 雷达历史；`fromType=1` 读 `stationtest_datagram` 并解码。结果按目标分组，当前点取各组末点，轨迹从该批记录构造。若同一接口带 `ifPage:true`，则走 MyBatis 的 MySQL 业务列表分支；两者数据源不同。
2. **雷达/AIS单目标历史**：`POST /api/radarposition/getHistoryList → getSingleShipTrack → getShipTrack`。`fromType=0` 查询 `radar_data_combine_all`，`fromType=1` 查询 `stationtest_datagram` 后解码；`dealTrackList` 保留 `date/lng/lat/course/speed/mmsi`、按目标分组并按时间去重，返回目标轨迹，可选再查对侧目标做旧匹配。
3. **AIS结构化历史**：前端 `MapShipTrackbackService` 请求 `POST /api/Aisposition/getHistoryList → AisUtil2.getHistoryList → getHbaseList`，实际读取 ClickHouse `wp_position`，按 MMSI、时间排序得到位置/运动字段，补充船名、船型后返回轨迹。该路径不重新解码 NMEA；默认 `ifSimple=true` 时会调用 `averageAssign`，不能直接作为完整标定数据接口。

参考历史 SQL 的站点/设备筛选和字段裁剪需单独核对：`getShipTrack` 的雷达设备条件写死为 `202601001/202601002`，AIS来源也有固定列表；时间边界和秒级去重与本工具契约不同。`RadarUtil` 取到的距离/方位不代表历史轨迹接口也完整返回这些字段。

对低磁盘占用方案的意义：可优先核实 `wp_position` 等已结构化位置来源，再将报文解码集中到缺失字段和历史 A/B/C/D。但目前未查库确认这些位置表是否覆盖当前 `202606002` 船载转发来源、是否保留足够来源列及正确时间/单位，不能直接切换输入。

### 3.3 可借鉴的读写方式

| 参考实现 | 可借鉴部分 | 本工具需要保留的区别 |
| --- | --- | --- |
| `ChUtil.dealAismessage` 将动态字段转换为结构化位置记录 | 解析与常规读取分开，避免每次页面读取都带上报文解码与原文 | 当前数据源是否完整写入结构化表、是否保留来源和单位，必须另行核实 |
| `AisUtil2.getHistoryList` 查询 `wp_position` 的位置、速度、方向等字段 | 按 MMSI、时间和必要字段查询结构化历史 | 现有模型不足以证明具有所需来源及 A/B/C/D，暂不能直接替换当前输入 |
| `Radarposition.getShipTrack` 的另一条分支仍从原始报文解析历史 | 参考项目也有查询时解析，不能把所有入口都视作预解析缓存 | 保留现有解析库及组包完整性检查 |
| `dealTrackList` 输出 `date/lng/lat/course/speed/mmsi` 等轨迹字段 | 页面响应采用专用视图，不携带全部证据 | 不照搬秒级去重、抽样、固定站点或删除雷达原始极坐标；完整数据仍用于标定 |
| `tbl_aisship`、`tbl_radarship` 与内存船舶资料按 MMSI 关联 | 动态和静态分别保存、按身份关联 | 参考表保存最新总长宽，本工具需要带历史时间、来源的 A/B/C/D 版本 |
| `Shipname.getShipDetailsByMmsi` 向 Shipfinder、Chinaports 补充资料，写入 `tbl_shipname` | 按 MMSI 先读缓存，缺失时获取外部船名、类型和总长宽并保存 | 现有接入没有读取 A/B/C/D 或历史尺寸版本；本次未验证外部接口当前可用性 |

应借鉴的是结构化索引、按需读取和精简响应。无需照搬实时接收、每 5 秒写库或每分钟刷新缓存的运行方式。

第三方资料链路位于 `Shipname.getShipDetailsByMmsi`：先 POST `https://www.shipfinder.com/ship/GetShip`，使用 MMSI 获取名称、类型、总长和总宽，参考代码将长宽除以 10；再 POST `https://ship.chinaports.com/ShipInit/shipInfo` 补充中英文名称。成功后按 MMSI 对 `tbl_shipname` 执行 upsert，并更新内存缓存。通行记录和图库通过 `ShippassageService.batchGetShipInfo` 调用该链路；其缓存命中条件是英文船名和类型非空，不能据此保证尺寸已经完整或最新。

若后续采用这类外部补充资料，记录来源、抓取时间和实际返回字段；本地 `sysUpdated` 是写入时间，不能视为历史尺寸生效时间。总长宽不能凭空拆成 A/B/C/D。示例查询中 Shipfinder 返回 HTTP 200、业务状态 401，Chinaports 返回 HTTP 403，未取得有效船舶数据，尚未确认接口原始响应是否包含四边距离。本方案暂未将第三方接入列入实施阶段。`AisRpc` 中另有 `/ais007/staticData` 示例，但对应 `shipStatic` 函数已注释，不计为当前可用的静态资料调用链。

## 4. 当前存储与加载方式

### 4.1 SQLite 结构化表

新增业务数据按列和关联行保存，SQLite 不写 JSON 正文、序列化数组或压缩对象 BLOB。普通查询只增加小型目录、参数和结果摘要；动态轨迹和原始报文保留在远程数据源及当前内存工作集中，不默认拆成逐点表落盘。沿用 `node:sqlite`，未引入 ORM。

| 表 | 用途 |
| --- | --- |
| `app_state`、`schema_migrations`、`registry_projects` | 登记修订、迁移阶段/游标、项目初始化状态 |
| `radars`、`ais_sources` | 设备编号、名称、雷达参考经纬度/朝向及设备字段 |
| `match_groups`、`match_group_radars`、`match_group_ais_sources` | 匹配组及按行保存的成员、顺序、修订 |
| `window_playbacks`、`window_playback_radars`、`window_playback_sources`、`window_playback_reads` | 分窗描述、冻结的成员/参考配置/契约版本、实际读取范围/时间和窗口业务指纹；不保存窗口观测或原文 |
| `query_sessions`、`query_session_radars`、`query_session_ais_sources` | 查询条件、组/登记修订、区域、业务指纹、固定成员及快照引用；新查询保留来源名称 |
| `snapshot_metadata` | 每台雷达的目录、原 SHA-256、业务指纹、时间/单位声明、固定 ENU 原点、参考参数、版本、数量和存储类型 |
| `snapshot_sources`、`snapshot_mapping_versions`、`snapshot_warnings` | 来源及已保存的名称、映射版本、质量说明 |
| `calibration_tasks`、`task_options` | 任务状态/进度、输入和验证范围、设置指纹、算法版本；搜索区、ROI、噪声等各自成列 |
| `task_refinements`、`task_refinement_associations` | 冻结的人工初值、距离/位置/朝向与稳定门限、雷达排除区、关联检查状态和按原顺序保存的人工关联标识 |
| `task_candidates`、`task_metrics`、`task_metric_groups`、`task_reasons`、`task_exclusions`、`task_validation_refs` | 候选参数、训练/验证指标、分组统计、原因、排除数量、复用验证关系；`rank = -1` 保存人工初值指标，自动候选从 0 开始 |
| `parameter_versions`、`version_mapping_versions` | 经纬度/朝向、生效时间、任务和输入关联、固定证据字段 |
| `ais_dimension_versions` | 既有来源/MMSI 尺寸版本表，保留旧记录；新历史加载及点击补查均不读写 |
| `archives`、`task_archives` | 归档位置、大小、格式、摘要及完整任务证据的归档关联 |
| `legacy_entries` | 旧数据库记录或文件的定位信息，不复制正文 |

时间按 UTC Unix 毫秒保存，坐标、角度、距离和指标使用业务数值，ID/MMSI/摘要使用文本；缺失与有效零值分开。A/B/C/D 各存一列，总长=A+B、总宽=C+D，在业务组装时计算。历史成员、名称和参考参数独立于当前登记；旧记录没有保存的名称保持未知。

`task_refinements` 的检查标志区分未检查的 `associationIds: null` 与人工清空的 `[]`；新任务提交接口都拒绝这两种精调输入。旧任务无精调记录时读取为 `refinement: null`，省略和显式 null 沿用同一旧设置摘要。精调设置摘要把人工标识视为集合，顺序或重复项不产生新的验证设置；保存的人工输入仍保留原顺序。

列表默认每页 50 条，支持项目、雷达、组会话或任务状态筛选，按创建时间与 ID 使用稳定游标，响应以 `X-Next-Cursor` 提供后续页。本页成员和来源按 ID 批量读取；索引覆盖全局、项目、项目/雷达、组及创建时间，还有参数生效时间、尺寸身份/报告时间。列表、进度和版本可见性检查不读取正文、不解包 JSON、不计算完整快照哈希。

### 4.2 临时工作集与查询生命周期

1. 页面启动或切换组只读取目录和查询条件；旧正文、归档及远程观测在显式加载时读取。
2. 普通加载调用 `POST /api/groups/:id/query?async=1`，202 返回准备编号。后台按完整时段、成员修订、参考参数、AIS 来源和查询区域读取数据，全部成员成功后保存完整会话，再返回共享 AIS 的回放 v2。当前雷达可在加载前选择，发布后保留有效选择。
3. 前端通过准备接口显示阶段、取得结果和取消。重新加载期间暂停旧回放并保留已有画面；失败或取消不会替换为部分数据。远程读取仍只读、串行，失败原因明确保留。
4. 完整输入到达后，播放、拖动预览与本地跳转、逐帧、插值和 0—300 秒尾迹均使用本地业务数组。组内原始 AIS 共用，HTTP 来源保留各雷达上下文。时间轴覆盖请求的完整半开时段，包含首尾空白区间。
5. 旧分窗目录保存原条件。前端打开时调用 `/api/playbacks/:id/prepare?async=1` 准备全组，再取得生成的完整会话，原目录保留。旧服务端窗口、相邻报告和缓存接口继续支持已有调用方；前端普通回放使用完整加载。
6. 自动精调通过 `POST /api/tasks` 提交 `{snapshotId, options}`，其中 `refinement` 冻结当前人工初值、门限、雷达排除区及非空人工关联标识，ROI 等原有设置随 `options` 保存。后台共用前端的稳定关联筛选，在均衡采样前固定观测和船舶，再于初值局部范围计算。前端只跟踪任务进度，关闭页面或释放回放不取消计算。兼容的 `{playbackId, radarId, options}` 提交先准备完整输入；`refinement: null` 继续使用旧算法。核实开关、取消、失败记录和重启中断语义保持一致。
7. 手动保存版本、导出和归档复用已加载完整输入；规范化、校验、指纹和回放编码在数据工作线程执行。当前工作集更换或释放后，旧完整历史通过 `/api/sessions/:id/load`、`/api/snapshots/:id/load` 或归档恢复，回源建立新 ID 并比较业务指纹。

原 SHA-256 校验完整原始数据，业务指纹比较重取的业务输入；小型目录不能作为完整离线证据。

精调的原始总量、筛选训练/验证保留、排除框、未靠近、不稳定、人工剔除、无法区分和竞争数量保存在 `task_exclusions`，均衡采样未使用的数量另行记录。50,000 上限约束粗搜索的位置/角度参数网格，不限制原始雷达观测数。初值 `initialMetrics.training/validation` 与候选共用同样样本和模型，持久化的分组指标保留空残差与有效零值；重启后的任务详情及导出可取得这些结构化结果，热力图等过程证据仍以可用内存或归档范围为准。任务原提交设置和结果实际局部边界分别保留，原始快照不变。

精调背景研究区域以实际局部位置范围和雷达业务契约 100000 m 距离上限预先固定，训练模型不借验证段或已筛掉观测估计支持域；该契约上限不代表设备真实覆盖。旧 `refinement: null` 仍按原始观测最大距离确定区域。

参数版本保存响应的完整任务证据包含冻结设置和 `initialMetrics`；版本目录为摘要，不重复读取全部任务指标，完整证据通过其关联任务详情或导出读取。精调不自动保存或采用参数，证据不足的候选只能保存为无生效时间的版本。完整观测跨重启复现仍依赖回源或显式归档，不能把任务结果摘要当作原始输入。

### 4.3 精简回放与原始详情

默认回放为 `schemaVersion: 2`：业务字段按列传输，重复来源、质量和映射值用字典，尺寸独立引用，相同 AIS 业务数组在组内共享。时间相对起点编码后恢复真实毫秒，坐标和运动值不舍入、不抽样、不截断。原始证据引用保留各雷达的快照上下文，即使业务值共享，也可读取对应上下文的原文。

前端在展示入口解码，之后沿用原业务类型、插值、船形和关联逻辑。视图标记 `provenance.representation=playback-v2`，不能作为完整归档导入。窗口响应还带 `window`、核心/实际读取范围、指纹与变化标记；其数量仅代表该次已取得的数据及上下文。前端按会话/雷达维护稳定展示身份，原文引用保留实际窗口快照 ID。原始详情通过 `GET /api/snapshots/:id/observations/:kind/:pointId` 按需读取，窗口另带 `?playbackId=…`，被淘汰后返回 410，需重新加载对应时间。完整快照的 `GET /api/snapshots/:id/metadata` 只返回目录。

显式 `format=full` 和 `/api/snapshots/:id/export` 返回完整原始业务数据，序列化在工作线程执行。外部正文读取时校验原 SHA-256，并与目录核对，不能用修改后的自签摘要替换旧输入。

### 4.4 点击尺寸与历史输入

当前表没有完整的速度、COG、真船艏向列，继续由 DMA 库解码 1/2/3/18。普通加载、分窗、相邻位置、冷跳转、逐帧及完整输入准备使用同一类型范围；原始 AIS 新输入不含静态尺寸，标定缺尺寸时采用现有退化模型。

点击补查按来源、MMSI 和点击基准时刻 `positionTime` 查询 `[positionTime, positionTime + 48 小时)`，正序返回第一份有效 5、19 或 24B 尺寸。基准为点击瞬间的回放时间，包含插值位置及保持显示的末点；现实时间仅记录为 `queriedAt`。正序每批 20 条，完整读取同刻边界，跨页和跨窗分片不越界；缺片报错，查完无有效尺寸返回空结果。

结果作为同会话显示覆盖，保留真实报告时间、来源和类型，换窗及回退继续使用，新有效结果替换该船旧覆盖，更换会话清空。结果不修改真实位置、船艏向、历史快照或标定输入，不保存补查原文或写 SQLite。

历史加载不读写既有 `ais_dimension_versions`，不自动回溯或恢复静态状态。旧尺寸表、快照及归档按原记录保留；导入及结构化 HTTP 输入中已有的尺寸继续按报告时刻和有效期使用。

### 4.5 显式归档

数据菜单提供“完整归档到指定目录”。用户填写服务器绝对目录，例如 `G:/radar-archives`；服务端以新 UUID 文件名保存 gzip JSON，SQLite 只登记位置、大小、格式及 SHA-256。不会覆盖已有文件，也不自动归档到当前磁盘。写入失败清理本次新建文件，元数据提交失败不登记半份归档。

分窗回放触发归档时，先显式准备全组整个所选时段，不能只归档已经播放的窗口。归档包含完整工作集、已取得的原文及关联任务可取得的证据；只有摘要的任务保留摘要标记，运行中的任务不以未完成状态覆盖后来完成的结果。归档可跨重启恢复，文件和快照摘要均需校验；文件丢失或修改明确报错。

接口为 `POST /api/sessions/:id/archive` 或 `POST /api/snapshots/:id/archive`，请求为 `{ "directory": "G:/radar-archives" }`。完整导出和原有 JSON 导入继续支持，上传导入保留 32 MB、120,000 条业务观测边界；服务器已登记的大归档从目录恢复，不经过上传入口。

## 5. 迁移与完整性

- 初始化执行一次结构化目录迁移，逐条校验旧快照，按事务保存目录和游标；失败可恢复，已完成记录不会被旧文件覆盖。旧 ID、摘要及任务/版本关联保留。
- 旧 `records/settings` 和 JSON 文件只作兼容读取，不复制完整轨迹到新表；旧表有停止写入的触发器。当前登记、会话、任务及参数仅写结构化表，新历史查询与点击补查均不读写既有尺寸表。
- 本地 36 份快照、11 个会话已完成目录迁移；原 `records` 各类数量及正文总字节数保持一致，外键检查无错误。未进入摘要的旧字段仍可从原正文读取，不把摘要标为完整证据。
- 旧数据删除、搬到其他磁盘及数据库文件收缩均未自动执行。释放旧空间前先明确保留范围和目录，检查归档、任务、参数与原摘要；删除行和文件缩小分别验收，不自动复制整库或重建。
- 回源、导入和归档使用明确格式和可用状态。源数据不可用、配置/指纹变化或原文缺失时，不制造原输入已经恢复的假象；解析器升级产生新输入，保留旧证据。

## 6. 验证结果与验收范围

优化前基准见第 2 节。2026-11-11 使用同一本地库，通过 Fastify 注入请求测量，各接口预热后执行 20 次。结果不代表浏览器网络或生产负载验收。

| 接口 | p95 | 响应字节数 |
| --- | ---: | ---: |
| `/api/projects` | 1.86 ms | 874 |
| `/api/groups` | 0.33 ms | 281 |
| `/api/snapshots` | 6.27 ms | 36,490 |
| `/api/sessions` | 2.61 ms | 9,016 |
| `/api/tasks` | 1.71 ms | 2 |
| `/api/versions` | 0.63 ms | 2 |

截图会话的正文约 168 MB，精简回放约 13 MB，减少约 92%，共享一份 AIS。逐条核对 56,828 个雷达观测，以及两份快照各自的 34,383 个 AIS 动态观测、13,410 个静态观测，位置、运动、尺寸、时间、来源和质量保持一致。该样本是旧输入，原有静态记录按原记录保留。

本次旧正文首次恢复以 202 返回准备记录约 7.37 ms，含校验与编码的准备总耗时约 15.5 秒；同时 399 次健康请求的 p95 为 0.79 ms、最大 7.27 ms。旧大正文仍有首次准备成本，当前工作集可复用，不能声称冷恢复已降到毫秒级。一次性目录迁移约 22.7 秒，没有访问远程业务数据。

以下旧分窗接口性能样本来自 2026-11-11 在临时空 SQLite 目录中的实际只读查询：3 小时范围、两台雷达及一个 AIS 来源，取得首个和相邻 120 秒窗口。该样本包含自动取得的静态报告及历史初值；当前仅 1/2/3/18、点击补查尺寸模式的真实查询性能尚未重测。表内为当时单次 Fastify 注入的源读取、解析及编码总耗时，不包含浏览器处理。

| 操作 | 总耗时 | 响应字节数 |
| --- | ---: | ---: |
| 建立分窗描述 | 16 ms | 轻量描述 |
| 首个 120 秒窗口 | 45,877 ms | 251,424 |
| 相邻 120 秒窗口，含 60 秒尾迹 | 28,198 ms | 327,188 |
| 重取已缓存首窗 | 2 ms | 251,424 |

首窗取得两台雷达各 748、106 条观测，共享 468 条 AIS 动态观测、222 条静态观测，计数包含必要边界上下文。470 次同时健康请求的 p95 为 0.99 ms、最大 1.60 ms；两窗服务端保留估算量为 39,836,538 字节，低于 64 MiB 预算。该估算包含为静态初值取得的业务原文，不能用网络包大小直接代表缓存内存。真实冷读取仍有几十秒成本，定向相邻报告和历史尺寸也需要远程查询及解析；本次未分解各阶段、未测 JVM/进程峰值，不能声称分窗已使未缓存跳转即时完成。与旧 168 MB 会话的输入范围和上下文不完全相同，不能将两者作为严格同比。

项目回归覆盖目录迁移、正文隔离、准备与取消、原始详情、回源、指纹、归档及任务输入生命周期；数据链路覆盖 1/2/3/18、旧尺寸缓存隔离、点击后续 48 小时及多片完整性。当前前端通过真实 Fastify 接口和 Node 中运行的 Vue 工作台状态，验证完整加载、本地播放与跳转、失败或取消保留画面、旧分窗历史完整恢复、参数与点击尺寸覆盖，以及后台任务复用完整输入和结果预览。精调端到端回归使用测试合成数据和真实 Fastify/worker，核对人工初值附近的候选筛选、人工关联标识提交、任务完成、初值同样本指标、筛选统计、原始快照不变，以及重启后的任务详情、导出和版本证据；不以直接读取数据库或伪造完成任务代替这条链路。旧窗口接口继续验证缓存预算、取消、相邻报告及分片语义。测试和构建不构成浏览器、真实完整查询性能或现场标定精度验收；这些项目待实际环境验证。

列表目标维持为控制接口 p95 ≤200 ms、历史每页最多 50 条时 p95 ≤500 ms 且响应 ≤100 kB；完整回放目标为同一样本 ≤20 MB。分窗以有限缓存和减少不必要的提前读取为约束，仍需对其他真实时段、高倍速、冷跳转和内存峰值独立评估，不能用目录或缓存命中性能代替。

完成结构迁移后，可用 Node 22 模块以只读方式测目录；此例不初始化、不迁移、不读正文或生产库：

```js
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from './server/storage.js';
const db = new DatabaseSync('data/radar-tool.sqlite', { readOnly: true });
const store = new SqliteStore('data');
store.db = db;
const started = performance.now();
const rows = store.list('snapshots');
console.log({ count: rows.length, milliseconds: performance.now() - started });
db.close();
```

## 7. 仍需外部条件确认的事项

1. 结构化 AIS 来源是否覆盖当前站点，并完整提供运动字段、时间和单位；确认后才可减少相应动态解码。
2. 点击后续 48 小时的查询扫描成本和完整时段内存峰值是否适合现场资源；旧尺寸缓存预算不作为当前点击尺寸或标定的有效期。
3. 归档磁盘、旧历史保留范围和空间回收方式；旧正文保持只读，未自动删除。
4. 浏览器、现场精度、时间链路和单位验收未完成，自动拟合继续受原有核实状态约束。


## 8. 源码核对入口

| 文件 | 相关位置与用途 |
| --- | --- |
| [server/storage-schema.js](../server/storage-schema.js)、[server/sqlite-store.js](../server/sqlite-store.js) | 结构化表、索引、旧目录迁移/只读保护、事务、分页、工作集、归档登记和尺寸缓存 |
| [server/registry.js](../server/registry.js) | 设备登记和组修订；通过结构化存储读写成员关系 |
| [server/window-playbacks.js](../server/window-playbacks.js)、[server/window-sources.js](../server/window-sources.js) | 旧分窗目录与接口兼容、完整输入准备、相邻报告及多片补齐 |
| [server/tasks.js](../server/tasks.js)、[server/task-storage.js](../server/task-storage.js) | 运行输入生命周期、重启中断、候选/结果摘要、版本和复用验证关系 |
| [shared/refinement.js](../shared/refinement.js)、[server/fitter.js](../server/fitter.js)、[shared/model.js](../shared/model.js) | 共用稳定关联筛选、训练/验证隔离、固定关联采样、局部精调与初值同样本指标 |
| [server/app.js](../server/app.js)、[server/preparations.js](../server/preparations.js) | 目录与回放接口、历史回源、异步准备/取消、原文详情、显式归档和可见性检查 |
| [server/data-jobs.js](../server/data-jobs.js)、[server/data-worker.js](../server/data-worker.js) | 复用数据工作线程，执行规范化、完整性校验、回放编码、导出和归档 |
| [shared/playback.js](../shared/playback.js)、[client/api.ts](../client/api.ts) | 回放 v2 编解码、AIS 共享、无损业务数值和原始详情引用 |
| [client/useWorkbench.ts](../client/useWorkbench.ts) | 目录分页、显式加载、准备进度、工作集释放和归档操作 |
| [server/sources.js](../server/sources.js) | 1/2/3/18 动态读取、组内 AIS 共用、HTTP 上下文与点击后续尺寸补查 |
| [shared/data.js](../shared/data.js) | 业务观测和静态信息校验、`canonicalJson` 及原摘要兼容 |
| [AisUtil2.kt](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/util/AisUtil2.kt:93) | 结构化 `wp_position` 历史查询；部分调用包含抽样，不能用于证明全量拟合输入 |
| [Aisposition.kt](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/auto/Aisposition.kt:449) | AIS历史入口转入 `AisUtil2`；137 行附近业务列表读取 MySQL `tbl_aisposition` 并关联静态资料 |
| [RadarUtil.kt](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/util/RadarUtil.kt:12) | 融合列表读取 ClickHouse 雷达历史；89 行起读取并解析 `stationtest_datagram` |
| [Radarposition.kt](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/auto/Radarposition.kt:835) | 原始报文历史查询与解析；882 行起轨迹字段裁剪和按时间去重 |
| [ChUtil.kt](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/util/ChUtil.kt:166) | 结构化位置转换；553 行起静态船舶资料保存 |
| [RadarTask.kt](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/task/RadarTask.kt:82) | 最新静态资料写库；98 行起刷新读取缓存，用于区分实时资料与历史版本 |
| [Shipname.kt](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/auto/Shipname.kt:48) | Shipfinder 与 Chinaports 请求；129 行起 `tbl_shipname` upsert；所取字段为名称、类型、总长宽 |
| [Shippassage.kt](G:/Work/seaoil/src/main/kotlin/com/shenlan/seaoil/auto/Shippassage.kt:136) | 先查船舶资料缓存、缺失时异步补充；通行记录及图库的调用入口 |
