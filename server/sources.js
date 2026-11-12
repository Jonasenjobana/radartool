import { createHash } from 'node:crypto';
import { InputError } from '../shared/data.js';
import { dataJob } from './data-jobs.js';
import { inGeographicBounds, normalizeAngle } from '../shared/geo.js';
import { AIS_PARSER_VERSION, assertAisParserReady, parseAisRows } from './ais-parser.js';
import { clientFor, envValue, parameterTime, queryFailure, quote, timeType, withLiveRead } from './clickhouse.js';

const AIS_STATIC_BATCH_SIZE = 20;

export function radarQuery(project, query = {}) {
  const { database, table, columns: c, radarIdType } = project.clickhouse;
  return `SELECT toUnixTimestamp64Milli(toDateTime64(${quote(c.time)}, 3, 'UTC')) AS time_ms,
    toString(${quote(c.radarId)}) AS radar_id, toString(${quote(c.trackId)}) AS track_id,
    ${quote(c.range)} AS source_range, ${quote(c.azimuth)} AS source_azimuth
    ${c.storedLng && c.storedLat ? `, ${quote(c.storedLng)} AS stored_lng, ${quote(c.storedLat)} AS stored_lat` : ''}
    ${c.deviceTime ? `, toUnixTimestamp64Milli(toDateTime64(${quote(c.deviceTime)}, 3, 'UTC')) AS device_time_ms` : ''}
    ${c.targetTime ? `, ${quote(c.targetTime)} AS source_target_time` : ''}
    ${c.sequence ? `, ${quote(c.sequence)} AS source_sequence` : ''}
    FROM ${quote(database)}.${quote(table)}
    WHERE ${quote(c.radarId)} = {radar_id:${radarIdType}}
      AND ${quote(c.time)} >= {start:${timeType(project.clickhouse)}}
      AND ${quote(c.time)} < {end:${timeType(project.clickhouse)}}
      ${query.trackIds ? `AND toString(${quote(c.trackId)}) IN {tracks:Array(String)}` : ''}
      ${query.contextTimes?.length ? `AND ${quote(c.time)} IN (${query.contextTimes.map((_, index) => `{context_${index}:${timeType(project.clickhouse)}}`).join(',')})` : ''}
    ORDER BY ${quote(c.time)} ${query.neighbor === 'before' ? 'DESC' : 'ASC'}, ${quote(c.trackId)}, ${quote(c.range)}, ${quote(c.azimuth)}
    ${query.neighbor ? `LIMIT 1 BY ${quote(c.trackId)} ${query.trackIds ? `LIMIT ${query.trackIds.length}` : ''}` : ''}`;
}

export async function loadRadar(project, query, signal) {
  const client = clientFor(project);
  try {
    const response = await client.query({ query: radarQuery(project, query), format: 'JSONEachRow', query_params: { radar_id: query.radarId, start: parameterTime(query.start, project.clickhouse), end: parameterTime(query.end, project.clickhouse), ...(query.trackIds ? { tracks: query.trackIds } : {}), ...Object.fromEntries((query.contextTimes ?? []).map((time, index) => [`context_${index}`, parameterTime(new Date(time).toISOString(), project.clickhouse)])) }, abort_signal: signal });
    const rows = await response.json();
    const mapping = project.clickhouse.mapping;
    return rows.map((row, index) => {
      if (row.time_ms == null || row.source_range == null || row.source_azimuth == null || row.track_id == null) throw new InputError('雷达必需字段存在空值，请核实实际列映射', 502);
      const timeMs = Number(row.time_ms);
      if (!Number.isFinite(timeMs) || !Number.isFinite(Number(row.source_range)) || !Number.isFinite(Number(row.source_azimuth))) throw new InputError('雷达时间、距离或方位不是有效数值', 502);
      if (String(row.radar_id) !== query.radarId || timeMs < Date.parse(query.start) || timeMs >= Date.parse(query.end)) throw new InputError('雷达返回值超出请求设备或半开时间范围', 502);
      return { id: createHash('sha256').update(JSON.stringify([project.id, row, index])).digest('hex').slice(0, 32), sourceId: `${project.id}:clickhouse`, deviceId: String(row.radar_id), trackId: String(row.track_id), eventTime: new Date(timeMs).toISOString(), ...(project.timeSemantics === 'receive-time' ? { receiveTime: new Date(timeMs).toISOString() } : {}), rangeM: Number(row.source_range) * mapping.rangeScaleToM, azimuthDeg: normalizeAngle(Number(row.source_azimuth) * mapping.azimuthScaleToDeg * mapping.azimuthSign + mapping.azimuthZeroDeg), storedPosition: row.stored_lng != null && row.stored_lat != null ? { lng: Number(row.stored_lng), lat: Number(row.stored_lat) } : null, raw: row, mappingVersion: mapping.version, quality: project.timeSemantics === 'receive-time' ? ['使用 date 接收时间，设备时间另存于原始字段'] : [] };
    });
  } catch (error) {
    throw queryFailure(error, 'ClickHouse 雷达查询');
  } finally { await client.close(); }
}

export function rawAisQuery(project, query = {}) {
  const { database, table, columns: c } = project.ais;
  if (!c.messageType) throw new InputError('AIS 历史轨迹查询需要配置消息类型列映射', 503);
  if (query.queryArea && (!c.lng || !c.lat || !c.messageType)) throw new InputError('AIS 区域查询需要配置经纬度和消息类型列映射', 503);
  return `SELECT toUnixTimestamp64Milli(toDateTime64(${quote(c.time)}, 3, 'UTC')) AS time_ms,
    toString(${quote(c.sourceId)}) AS source_id, ${quote(c.message)} AS message
    ${c.eventTime ? `, toUnixTimestamp64Milli(toDateTime64(${quote(c.eventTime)}, 3, 'UTC')) AS source_event_time_ms` : ''}
    ${['mmsi', 'messageType', 'hash', 'status'].filter((key) => c[key]).map((key) => `, ${quote(c[key])} AS ${quote(key)}`).join(' ')}
    FROM ${quote(database)}.${quote(table)}
    PREWHERE ${quote(c.time)} >= {start:${timeType(project.ais)}}
      AND ${quote(c.time)} < {end:${timeType(project.ais)}}
    WHERE ${quote(c.sourceId)} IN {sources:Array(String)}
    AND toString(${quote(c.messageType)}) IN ('1', '2', '3', '18')
    ${query.neighbor || query.positionsOnly ? `AND length(toString(${quote(c.mmsi)})) = 9 AND ${quote(c.lng)} BETWEEN -180 AND 180 AND ${quote(c.lat)} BETWEEN -90 AND 90` : ''}
    ${query.positionShips ? `AND toString(${quote(c.mmsi)}) IN {position_ships:Array(String)}` : ''}
    ${query.fragmentHeader ? `AND position(${quote(c.message)}, {fragment_header:String}) > 0` : ''}
    ${query.contextTimes?.length ? `AND ${quote(c.time)} IN (${query.contextTimes.map((_, index) => `{context_${index}:${timeType(project.ais)}}`).join(',')})` : ''}
    ${query.queryArea ? `AND ${quote(c.lng)} >= {west:Float64} AND ${quote(c.lng)} <= {east:Float64} AND ${quote(c.lat)} >= {south:Float64} AND ${quote(c.lat)} <= {north:Float64}` : ''}
    ORDER BY ${quote(c.time)} ${query.neighbor === 'before' || query.fragmentDirection === 'before' ? 'DESC' : 'ASC'}, ${quote(c.sourceId)}
    ${query.neighbor ? `LIMIT 1 BY ${quote(c.sourceId)}, ${quote(c.mmsi)} ${query.positionShips ? `LIMIT ${query.positionShips.length * query.aisSourceIds.length}` : ''}` : query.fragmentHeader ? 'LIMIT 1' : ''}`;
}

export function aisDimensionsQuery(project, boundary = false) {
  const { database, table, columns: c } = project.ais;
  return `SELECT toUnixTimestamp64Milli(toDateTime64(${quote(c.time)}, 3, 'UTC')) AS time_ms,
    toString(${quote(c.sourceId)}) AS source_id, ${quote(c.message)} AS message,
    toString(${quote(c.mmsi)}) AS mmsi, toString(${quote(c.messageType)}) AS messageType
    FROM ${quote(database)}.${quote(table)}
    PREWHERE ${quote(c.time)} >= {after:${timeType(project.ais)}}
      AND ${quote(c.time)} < {before:${timeType(project.ais)}}
      AND ${quote(c.mmsi)} = {mmsi:String}
    ${boundary ? `AND ${quote(c.time)} = {boundary:${timeType(project.ais)}}` : ''}
    WHERE ${quote(c.sourceId)} IN {sources:Array(String)}
      AND ${quote(c.messageType)} IN ('5', '19', '24')
    ORDER BY ${quote(c.time)} ASC
    ${boundary ? '' : `LIMIT ${AIS_STATIC_BATCH_SIZE}`}`;
}

function hasLeadingAisFragments(rows) {
  const pending = new Set();
  for (const row of rows) for (const match of row.message.matchAll(/[!$][A-Z]{2}VD[MO],(\d+),(\d+),([^,]*),([^,]*),/g)) {
    const [, total, number, sequence, channel] = match;
    if (Number(total) <= 1) continue;
    const key = JSON.stringify([row.source_id, sequence, channel]);
    if (number === '1') pending.add(key);
    else if (!pending.has(key)) return true;
    if (number === total) pending.delete(key);
  }
  return false;
}

export async function queryAisDimensions(project, query, signal = new AbortController().signal) {
  if (project.mode !== 'clickhouse-raw') throw new InputError('该项目未配置 ClickHouse 原始 AIS 静态报文查询', 503);
  if (!project.ais.columns.mmsi || !project.ais.columns.messageType) throw new InputError('静态报文查询需要配置 MMSI 和消息类型列映射', 503);
  if (project.ais.parserVersion !== AIS_PARSER_VERSION) throw new InputError('项目 AIS 解析版本与本地适配不一致', 503);
  assertAisParserReady();
  return withLiveRead(async () => {
    const queriedAt = new Date().toISOString();
    const positionTime = new Date(query.positionTime).toISOString();
    const client = clientFor(project);
    // 以点击时固定的回放时间为起点，最多查后续 48 小时。
    const latest = Date.parse(positionTime) + 48 * 60 * 60 * 1000;
    let after = Date.parse(positionTime);
    let windowMs = 60 * 60 * 1000;
    let before = Math.min(latest, after + windowMs);
    let fragments = [];
    const laterWindow = () => {
      if (before === latest) return false;
      after = before; windowMs *= 2;
      before = Math.min(latest, after + windowMs);
      return true;
    };
    try {
      const read = async (boundary) => {
        const rows = await (await client.query({ query: aisDimensionsQuery(project, boundary != null), query_params: { sources: query.aisSourceIds, mmsi: query.mmsi, after: parameterTime(new Date(after).toISOString(), project.ais), before: parameterTime(new Date(before).toISOString(), project.ais), ...(boundary != null ? { boundary: parameterTime(new Date(boundary).toISOString(), project.ais) } : {}) }, format: 'JSONEachRow', abort_signal: signal })).json();
        for (const row of rows) {
          const time = Number(row.time_ms);
          if (!Number.isFinite(time) || time < after || time >= before || !query.aisSourceIds.includes(row.source_id) || Number(row.mmsi) !== Number(query.mmsi) || !['5', '19', '24'].includes(String(row.messageType)) || typeof row.message !== 'string' || boundary != null && time !== boundary) throw new InputError('静态报文返回值超出请求身份、来源或时间范围', 502);
        }
        return rows;
      };
      while (true) {
        if (signal.aborted) throw new InputError('静态报文查询已取消', 499);
        let rows = await read();
        if (!rows.length) {
          if (laterWindow()) continue;
          if (fragments.length) throw new InputError('静态报文缺少完整分片，未更新船舶尺寸', 422);
          return { projectId: project.id, mmsi: query.mmsi, positionTime, queriedAt, report: null };
        }
        const newest = Math.max(...rows.map((row) => Number(row.time_ms)));
        const more = rows.length === AIS_STATIC_BATCH_SIZE;
        // 分页边界取完整的同刻报文，避免截断同一秒收到的多片消息。
        if (more) rows = [...rows.filter((row) => Number(row.time_ms) < newest), ...await read(newest)];
        rows.unshift(...fragments);
        rows.sort((a, b) => Number(a.time_ms) - Number(b.time_ms) || a.source_id.localeCompare(b.source_id) || a.message.localeCompare(b.message));
        // 只识别 NMEA 分片头以补齐跨页上下文，校验、组包和字段解码仍交给原库。
        if (hasLeadingAisFragments(rows)) throw new InputError('静态报文缺少完整分片，未更新船舶尺寸', 422);
        const parsed = await parseAisRows(rows, { end: new Date(latest).toISOString() }, signal);
        const report = parsed.staticObservations.filter((point) => point.mmsi === query.mmsi && query.aisSourceIds.includes(point.dimensions.sourceId) && ['5', '19', '24'].includes(point.messageType)).sort((a, b) => Date.parse(a.eventTime) - Date.parse(b.eventTime))[0];
        if (report) {
          const { bow, stern, port, starboard } = report.dimensions;
          return { projectId: project.id, mmsi: query.mmsi, positionTime, queriedAt, report: { mmsi: report.mmsi, sourceId: report.dimensions.sourceId, messageType: report.messageType, eventTime: report.eventTime, dimensions: { bow, stern, port, starboard }, lengthM: bow + stern, widthM: port + starboard, parserVersion: parsed.parserVersion } };
        }
        if (parsed.parseStats.discardedFragments) throw new InputError('静态报文缺少完整分片，未更新船舶尺寸', 422);
        fragments = parsed.parseStats.pendingFragments ? rows : [];
        if (more && newest + 1 < before) after = newest + 1;
        else if (!laterWindow()) {
          if (fragments.length) throw new InputError('静态报文缺少完整分片，未更新船舶尺寸', 422);
          return { projectId: project.id, mmsi: query.mmsi, positionTime, queriedAt, report: null };
        }
      }
    } catch (error) { throw queryFailure(error, 'ClickHouse AIS 静态报文查询'); }
    finally { await client.close(); }
  });
}

export async function readRawAisRows(project, query, signal) {
  const client = clientFor(project);
  let rows;
  try {
    rows = await (await client.query({ query: rawAisQuery(project, query), query_params: { start: parameterTime(query.start, project.ais), end: parameterTime(query.end, project.ais), sources: query.aisSourceIds, ...(query.queryArea ?? {}), ...(query.positionShips ? { position_ships: query.positionShips } : {}), ...(query.fragmentHeader ? { fragment_header: query.fragmentHeader } : {}), ...Object.fromEntries((query.contextTimes ?? []).map((time, index) => [`context_${index}`, parameterTime(new Date(time).toISOString(), project.ais)])) }, format: 'JSONEachRow', abort_signal: signal })).json();
    for (const row of rows) {
      const time = Number(row.time_ms);
      if (!Number.isFinite(time) || time < Date.parse(query.start) || time >= Date.parse(query.end) || !query.aisSourceIds.includes(row.source_id) || typeof row.message !== 'string' || !['1', '2', '3', '18'].includes(String(row.messageType))) throw new InputError('AIS 返回值超出请求来源、时间或动态类型范围', 502);
    }
  } catch (error) { throw queryFailure(error, 'ClickHouse AIS 查询'); }
  finally { await client.close(); }
  return rows;
}

export async function loadRawAis(project, query, signal) {
  if (project.ais.parserVersion !== AIS_PARSER_VERSION) throw new InputError('项目 AIS 解析版本与本地适配不一致', 503);
  const rows = query.rawRows ?? await readRawAisRows(project, query, signal);
  const parsed = rows.length ? await parseAisRows(rows, { end: query.playbackRange?.end ?? query.end }, signal) : { observations: [], staticObservations: [], parseStats: { rawReports: 0, decodedPackets: 0, failedReports: 0, pendingFragments: 0, discardedFragments: 0, invalidPositions: 0, nonPositionReports: 0 }, parserVersion: AIS_PARSER_VERSION, warnings: [] };
  return { ...parsed, rawReports: rows, coverageEnd: Math.min(Date.parse(query.end), Date.now()), warnings: [...parsed.warnings.filter(value => !value.startsWith('船体尺寸仅使用本查询内')), '历史轨迹仅使用 AIS 1/2/3/18；船体尺寸由点击补查提供，仅用于显示'] };
}

export async function loadAis(project, query, signal) {
  const endpoint = new URL(envValue(project.ais.urlEnv));
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new InputError('AIS 接口必须为不含凭据和查询参数的 HTTP(S) 地址', 503);
  const headers = { 'content-type': 'application/json' };
  if (project.ais.authorizationEnv) headers.authorization = envValue(project.ais.authorizationEnv);
  let response;
  try { response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ schemaVersion: 1, radarId: query.radarId, sourceIds: query.aisSourceIds, start: query.start, end: query.end, ...(query.queryArea ? { queryArea: query.queryArea } : {}), ...(query.playbackRange ? { playbackRange: query.playbackRange, includeNeighbors: true } : {}) }), signal }); }
  catch { throw new InputError('结构化 AIS 接口连接失败或超时，未生成部分数据快照', 502); }
  if (!response.ok) { await response.body?.cancel(); throw new InputError(`结构化 AIS 接口返回 HTTP ${response.status}，未生成部分数据快照`, 502); }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32 * 1024 * 1024) { await reader.cancel(); throw new InputError('AIS 返回数据超过 32 MB，请缩短查询范围', 413); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) { if (error instanceof InputError) throw error; throw new InputError('AIS 响应读取失败，未生成部分数据快照', 502); }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new InputError('AIS 接口未返回有效 JSON', 502); }
  if (payload.schemaVersion !== 1 || payload.complete !== true || !Array.isArray(payload.observations) || typeof payload.parserVersion !== 'string') throw new InputError('AIS 接口必须声明 schemaVersion=1、complete=true、parserVersion 并返回 observations', 502);
  if (query.playbackRange && payload.neighborsComplete !== true) throw new InputError('结构化 AIS 接口尚未声明相邻报告覆盖，不能用于分窗回放', 503);
  if (payload.staticObservations !== undefined && !Array.isArray(payload.staticObservations)) throw new InputError('AIS staticObservations 必须为数组', 502);
  if (!payload.parseStats || !Number.isInteger(payload.parseStats.failedReports) || payload.parseStats.failedReports < 0 || !Number.isInteger(payload.parseStats.pendingFragments) || payload.parseStats.pendingFragments < 0) throw new InputError('AIS 接口必须返回 parseStats.failedReports 和 pendingFragments，区分解析失败与未组包', 502);
  if (payload.parseStats.failedReports) throw new InputError(`AIS 有 ${payload.parseStats.failedReports} 条解析失败，未生成部分数据快照`, 502);
  if (payload.warnings !== undefined && (!Array.isArray(payload.warnings) || payload.warnings.some((warning) => typeof warning !== 'string' || warning.length > 500))) throw new InputError('AIS warnings 格式无效', 502);
  if (payload.parserVersion !== project.ais.parserVersion) throw new InputError('AIS 解析版本与项目配置不一致，请核实后更新配置', 502);
  for (const row of [...payload.observations, ...(payload.staticObservations ?? [])]) {
    const timeMs = Date.parse(row.eventTime);
    if (!Number.isFinite(timeMs) || timeMs < Date.parse(query.playbackRange?.start ?? query.start) || timeMs >= Date.parse(query.playbackRange?.end ?? query.end) || !Array.isArray(row.sourceIds) || !row.sourceIds.length || row.sourceIds.some((source) => !query.aisSourceIds.includes(source))) throw new InputError('AIS 返回记录超出请求来源或半开时间范围', 502);
  }
  return payload;
}

export async function datasetFromSources(project, query, radar, ais, evidence = {}) {
  const radarConfiguration = project.radars.find((r) => r.id === query.radarId);
  const observations = query.queryArea ? ais.observations.filter((point) => inGeographicBounds(point.position, query.queryArea)) : ais.observations;
  return dataJob('normalize', { schemaVersion: 1, name: `${radarConfiguration.name} · ${query.start}`, projectId: project.id, radarId: query.radarId, reference: project.reference, baseline: radarConfiguration.baseline, timeRange: { start: query.start, end: query.end }, timeSemantics: project.timeSemantics, unitsVerified: project.verified && project.unitsVerified, alignmentVerified: project.verified && project.alignmentVerified, radar, ais: observations, aisStatic: ais.staticObservations ?? [], provenance: { kind: 'live-query', aisSourceNames: Object.fromEntries(project.aisSources.filter(source => query.aisSourceIds.includes(source.id)).map(source => [source.id, source.name])), configVersion: project.configVersion, registryRevision: project.registryRevision, radarConfiguration, ...evidence, mappingVersion: project.clickhouse.mapping.version, parserVersion: ais.parserVersion, parseStats: ais.parseStats, aisCoverageEnd: ais.coverageEnd == null ? query.end : new Date(ais.coverageEnd).toISOString(), evidenceScope: 'complete-query', ...(project.mode === 'clickhouse-raw' ? { aisDimensions: 'click-only' } : {}), ...(ais.rawReports ? { rawAisReports: ais.rawReports } : {}), queryVersion: 'readonly-bound-clickhouse-history-v7', query: { radarId: query.radarId, aisSourceIds: query.aisSourceIds, start: query.start, end: query.end, queryArea: query.queryArea ?? null } }, warnings: [...(project.warnings ?? []), ...(ais.warnings ?? []), ...(ais.parseStats.pendingFragments ? [`AIS 有 ${ais.parseStats.pendingFragments} 条未完成组包片段，保留为覆盖限制`] : []), ...(!observations.length ? [`指定 AIS 来源 ${query.aisSourceIds.join('、')} 在所选时段和查询区域没有有效动态位置`] : [])] });
}

export async function queryDataset(project, query, signal = new AbortController().signal) {
  if (project.mode === 'clickhouse-raw') assertAisParserReady();
  return withLiveRead(async () => {
    // 真实数据库始终串行读取；任一步失败立即停止，不继续另一来源或保存部分快照。
    const radar = await loadRadar(project, query, signal);
    const ais = project.mode === 'clickhouse-raw' ? await loadRawAis(project, query, signal) : await loadAis(project, query, signal);
    return datasetFromSources(project, query, radar, ais);
  });
}

export async function queryGroupDatasets(project, query, evidence, signal = new AbortController().signal) {
  if (project.mode === 'clickhouse-raw') assertAisParserReady();
  return withLiveRead(async () => {
    const radarRows = [];
    for (const radarId of query.radarIds) radarRows.push(await loadRadar(project, { ...query, radarId }, signal));
    const sharedAis = project.mode === 'clickhouse-raw' ? await loadRawAis(project, { ...query, radarId: query.radarIds[0] }, signal) : null;
    const normalized = [];
    for (let i = 0; i < query.radarIds.length; i++) {
      const radarQuery = { ...query, radarId: query.radarIds[i] };
      // 旧 HTTP 契约含 radarId，保留其上下文，不擅自跨雷达复用返回值。
      const ais = sharedAis ?? await loadAis(project, radarQuery, signal);
      normalized.push(await datasetFromSources(project, radarQuery, radarRows[i], ais, evidence));
    }
    return normalized;
  });
}

export async function inspectSource(project) {
  return withLiveRead(async () => {
  const client = clientFor(project);
  const table = `${quote(project.clickhouse.database)}.${quote(project.clickhouse.table)}`;
  try {
    const environment = await (await client.query({ query: 'SELECT currentDatabase() AS database, version() AS version, timezone() AS timezone', format: 'JSONEachRow' })).json();
    const columns = await (await client.query({ query: `DESCRIBE TABLE ${table}`, format: 'JSONEachRow' })).json();
    const definition = await (await client.query({ query: 'SELECT engine, partition_key, sorting_key, primary_key FROM system.tables WHERE database = {database:String} AND name = {table:String}', query_params: { database: project.clickhouse.database, table: project.clickhouse.table }, format: 'JSONEachRow' })).json();
    const aisColumns = project.mode === 'clickhouse-raw' ? await (await client.query({ query: `DESCRIBE TABLE ${quote(project.ais.database)}.${quote(project.ais.table)}`, format: 'JSONEachRow' })).json() : null;
    return { environment, columns: columns.map(({ name, type }) => ({ name, type })), ...(aisColumns ? { aisColumns: aisColumns.map(({ name, type }) => ({ name, type })) } : {}), definition, verified: false, message: '只读结构检查不会自动确认单位、时间或 AIS 完整性' };
  } catch (error) { throw queryFailure(error, '只读表结构检查'); }
  finally { await client.close(); }
  });
}
