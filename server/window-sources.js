import { createHash } from 'node:crypto';
import { canonicalJson, InputError } from '../shared/data.js';
import { clientFor, parameterTime, queryFailure, quote, timeType, withLiveRead } from './clickhouse.js';
import { assertAisParserReady, parseAisRows } from './ais-parser.js';
import { inGeographicBounds } from '../shared/geo.js';
import { datasetFromSources, loadAis, loadRadar, loadRawAis, readRawAisRows } from './sources.js';

const iso = value => new Date(value).toISOString();
const rowKey = row => canonicalJson(row);

function latestBefore(points, time, key) {
  const values = new Map();
  for (const point of points) if (point.timeMs < time) for (const id of key(point)) { const known = values.get(id); if (!known || point.timeMs > known[0].timeMs) values.set(id, [point]); else if (point.timeMs === known[0].timeMs) known.push(point); }
  return [...new Set([...values.values()].flat())];
}
function originalRows(point) {
  const reports = point.raw?.reports;
  return Array.isArray(reports) ? reports.flatMap(report => originalRows({ raw: report.raw })) : point.raw?.message ? [point.raw] : [];
}

async function radarContext(project, query, signal) {
  const nearest = await loadRadar(project, query, signal); const pairs = new Set(nearest.map(point => `${point.trackId}:${point.eventTime}`));
  const times = [...new Set(nearest.map(point => Date.parse(point.eventTime)))]; const result = [];
  for (let index = 0; index < times.length; index += 200) {
    const rows = await loadRadar(project, { ...query, neighbor: undefined, trackIds: [...new Set(nearest.map(point => point.trackId))], contextTimes: times.slice(index, index + 200) }, signal);
    for (const point of rows) if (pairs.has(`${point.trackId}:${point.eventTime}`)) result.push(point);
  }
  return result;
}
async function aisContext(project, query, signal) {
  const result = []; const pending = [await readRawAisRows(project, query, signal)];
  while (pending.length) {
    const candidates = pending.pop(); if (!candidates.length) continue;
    const pairs = new Map(candidates.map(row => [`${row.source_id}:${row.mmsi}:${row.time_ms}`, row]));
    const instants = new Set(candidates.map(row => `${row.mmsi}:${row.time_ms}`));
    const times = [...new Set(candidates.map(row => Number(row.time_ms)))]; const complete = [];
    for (let index = 0; index < times.length; index += 200) {
      const rows = await readRawAisRows(project, { ...query, neighbor: undefined, positionsOnly: true, positionShips: [...new Set(candidates.map(row => String(row.mmsi)))], contextTimes: times.slice(index, index + 200) }, signal);
      for (const row of rows) if (instants.has(`${row.mmsi}:${row.time_ms}`)) complete.push(row);
    }
    const parsed = complete.length ? await parseAisRows(complete, { end: query.playbackRange.end }, signal) : { observations: [] };
    const valid = new Set(parsed.observations.filter(point => !query.queryArea || inGeographicBounds(point.position, query.queryArea)).map(point => `${point.sourceIds[0]}:${point.mmsi}:${Date.parse(point.eventTime)}`));
    for (const row of complete) if (valid.has(`${row.source_id}:${row.mmsi}:${row.time_ms}`)) result.push(row);
    for (const [key, row] of pairs) if (!valid.has(key)) {
      // 元数据可指向协议中的不可用位置，继续找该来源/船舶真正有效的相邻报告。
      const next = { ...query, aisSourceIds: [row.source_id], positionShips: [String(row.mmsi)], start: query.neighbor === 'before' ? query.start : iso(Number(row.time_ms) + 1), end: query.neighbor === 'before' ? iso(Number(row.time_ms)) : query.end };
      if (Date.parse(next.start) < Date.parse(next.end)) pending.push(await readRawAisRows(project, next, signal));
    }
  }
  return result;
}

function incompletePackets(rows) {
  const pending = new Map(); const incomplete = [];
  for (const row of rows) for (const match of row.message.matchAll(/[!$]([A-Z]{2}VD[MO]),(\d+),(\d+),([^,]*),([^,]*),/g)) {
    const [, talker, total, part, sequence, channel] = match;
    if (Number(total) < 2) continue;
    const key = canonicalJson([row.source_id, talker, total, sequence, channel]);
    let packet = pending.get(key);
    if (part === '1' && packet?.parts.has(1)) { incomplete.push(packet); packet = null; }
    packet ??= { source: row.source_id, talker, total: Number(total), sequence, channel, parts: new Set(), first: Number(row.time_ms), last: Number(row.time_ms) };
    packet.parts.add(Number(part)); packet.last = Number(row.time_ms);
    if (packet.parts.size === packet.total) pending.delete(key); else pending.set(key, packet);
  }
  return [...incomplete, ...pending.values()];
}

async function completePackets(project, query, rows, signal) {
  const ordered = rows.sort((a, b) => Number(a.time_ms) - Number(b.time_ms) || a.source_id.localeCompare(b.source_id));
  const existing = new Set(rows.map(rowKey));
  for (const packet of incompletePackets(ordered)) for (let part = 1; part <= packet.total; part++) {
    if (packet.parts.has(part)) continue;
    const before = part < Math.min(...packet.parts);
    const start = before ? Date.parse(query.playbackRange.start) : packet.last;
    const end = before ? Math.min(Date.parse(query.playbackRange.end), packet.first + 1) : Date.parse(query.playbackRange.end);
    if (start >= end) throw new InputError('回放窗口边界的 AIS 分片不完整，未发布窗口', 422);
    const found = await readRawAisRows(project, { ...query, queryArea: null, start: iso(start), end: iso(end), aisSourceIds: [packet.source], fragmentHeader: `${packet.talker},${packet.total},${part},${packet.sequence},${packet.channel},`, fragmentDirection: before ? 'before' : 'after' }, signal);
    if (!found.length) throw new InputError('所选完整时段内找不到窗口边界所需的 AIS 分片，未发布窗口', 422);
    for (const row of found) if (!existing.has(rowKey(row))) { existing.add(rowKey(row)); rows.push(row); }
  }
  return rows.sort((a, b) => Number(a.time_ms) - Number(b.time_ms) || a.source_id.localeCompare(b.source_id));
}

function stableIds(dataset) {
  for (const kind of ['radar', 'ais', 'aisStatic']) {
    const counts = new Map(); const reportOccurrences = new Map();
    for (const point of dataset[kind] ?? []) {
      const value = kind === 'radar' ? [point.sourceId, point.deviceId, point.trackId, point.eventTime, point.raw] : [point.sourceIds, point.mmsi, point.eventTime, point.messageType, point.position, point.sogKnots, point.cogDeg, point.headingDeg, kind === 'aisStatic' ? [point.dimensions.bow, point.dimensions.stern, point.dimensions.port, point.dimensions.starboard, point.dimensions.observedAt, point.dimensions.sourceId] : null];
      const key = canonicalJson([kind, value]); const ordinal = counts.get(key) ?? 0; counts.set(key, ordinal + 1);
      // 相同真实报告保留重数；标识不依赖本次窗口从哪一行开始读取。
      point.id = createHash('sha256').update(`${key}:${ordinal}`).digest('hex').slice(0, 32);
      if (kind === 'ais') {
        const reports = Array.isArray(point.raw?.reports) ? point.raw.reports : [{ raw: point.raw }];
        point.observationIds = reports.map(report => {
          const row = report.raw; const identity = canonicalJson([point.mmsi, point.eventTime, row?.source_id ?? report.sourceIds ?? point.sourceIds, row?.message ?? row, row?.hash]);
          const duplicate = reportOccurrences.get(identity) ?? 0; reportOccurrences.set(identity, duplicate + 1);
          const id = createHash('sha256').update(`${identity}:${duplicate}`).digest('hex').slice(0, 32);
          if (Array.isArray(point.raw?.reports)) report.id = id; return id;
        });
      } else if (kind === 'aisStatic') point.observationIds = [point.id];
    }
    dataset[kind]?.sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
  }
}

export async function queryWindowDatasets(project, query, evidence, signal) {
  if (project.mode === 'clickhouse-raw') {
    const columns = project.ais.columns;
    if (!columns.mmsi || !columns.messageType || !columns.lng || !columns.lat) throw new InputError('分窗回放需要已核实的 AIS 身份、消息类型和经纬度映射', 503);
    assertAisParserReady();
  }
  return withLiveRead(async () => {
    const full = query.playbackRange; const first = Date.parse(full.start); const last = Date.parse(full.end);
    const start = Date.parse(query.start); const end = Date.parse(query.end); const radarRows = [];
    for (const radarId of query.radarIds) {
      const current = await loadRadar(project, { ...query, radarId }, signal);
      const previous = query.previous?.snapshots.find(snapshot => snapshot.dataset.radarId === radarId);
      const before = start > first ? previous ? latestBefore(previous.dataset.radar, start, point => [point.trackId]) : await radarContext(project, { ...query, radarId, start: full.start, end: query.start, neighbor: 'before' }, signal) : [];
      const trackIds = [...new Set([...before, ...current].map(point => point.trackId))];
      const after = end < last && trackIds.length ? await radarContext(project, { ...query, radarId, start: query.end, end: full.end, neighbor: 'after', trackIds }, signal) : [];
      radarRows.push([...before, ...current, ...after]);
    }
    let shared = null;
    if (project.mode === 'clickhouse-raw') {
      const current = await readRawAisRows(project, query, signal);
      const previous = query.previous?.snapshots[0];
      let before = [];
      if (start > first) {
        if (previous) {
          const selected = latestBefore(previous.dataset.ais, start, point => point.sourceIds.map(sourceId => `${sourceId}:${point.mmsi}`));
          const instants = new Set(selected.map(point => `${point.mmsi}:${point.timeMs}`));
          before = previous.dataset.ais.filter(point => instants.has(`${point.mmsi}:${point.timeMs}`)).flatMap(originalRows);
        } else before = await aisContext(project, { ...query, start: full.start, end: query.start, neighbor: 'before' }, signal);
      }
      const positionShips = [...new Set([...before, ...current].map(row => String(row.mmsi)).filter(mmsi => /^\d{9}$/.test(mmsi)))];
      const after = end < last && positionShips.length ? await aisContext(project, { ...query, start: query.end, end: full.end, neighbor: 'after', positionShips }, signal) : [];
      const rawRows = await completePackets(project, query, [...before, ...current, ...after], signal);
      shared = await loadRawAis(project, { ...query, rawRows }, signal);
    }
    const normalized = [];
    for (let index = 0; index < query.radarIds.length; index++) {
      const radarId = query.radarIds[index];
      const ais = shared ?? await loadAis(project, { ...query, radarId }, signal);
      const value = await datasetFromSources(project, { ...query, radarId, start: full.start, end: full.end }, radarRows[index], ais, evidence);
      stableIds(value.dataset);
      value.dataset.provenance.windowRange = { start: query.start, end: query.end };
      normalized.push(value);
    }
    return normalized;
  });
}

export async function queryWindowFrameTime(project, query, time, direction, signal) {
  return withLiveRead(async () => {
    const times = [];
    const start = direction > 0 ? iso(Math.floor(time) + 1) : query.start;
    const end = direction < 0 ? iso(Math.ceil(time)) : query.end;
    if (Date.parse(start) >= Date.parse(end)) return null;
    const client = clientFor(project);
    try {
      for (const radarId of query.radarIds) {
        const config = project.clickhouse; const c = config.columns;
        const rows = await (await client.query({ query: `SELECT toUnixTimestamp64Milli(toDateTime64(${direction > 0 ? 'min' : 'max'}(${quote(c.time)}),3,'UTC')) AS time_ms FROM ${quote(config.database)}.${quote(config.table)} WHERE ${quote(c.radarId)}={radar_id:${config.radarIdType}} AND ${quote(c.time)}>={start:${timeType(config)}} AND ${quote(c.time)}<{end:${timeType(config)}} HAVING count()>0`, query_params: { radar_id: radarId, start: parameterTime(start, config), end: parameterTime(end, config) }, format: 'JSONEachRow', abort_signal: signal })).json();
        for (const row of rows) times.push(Number(row.time_ms));
      }
      if (project.mode !== 'clickhouse-raw') throw new InputError('结构化 AIS 接口尚未提供跨窗口逐帧时刻查询', 503);
      const config = project.ais; const c = config.columns;
      const rows = await (await client.query({ query: `SELECT toUnixTimestamp64Milli(toDateTime64(${direction > 0 ? 'min' : 'max'}(${quote(c.time)}),3,'UTC')) AS time_ms FROM ${quote(config.database)}.${quote(config.table)} WHERE ${quote(c.sourceId)} IN {sources:Array(String)} AND toString(${quote(c.messageType)}) IN ('1', '2', '3', '18') AND ${quote(c.time)}>={start:${timeType(config)}} AND ${quote(c.time)}<{end:${timeType(config)}} ${query.queryArea ? `AND ${quote(c.lng)}>={west:Float64} AND ${quote(c.lng)}<={east:Float64} AND ${quote(c.lat)}>={south:Float64} AND ${quote(c.lat)}<={north:Float64}` : ''} HAVING count()>0`, query_params: { sources: query.aisSourceIds, start: parameterTime(start, config), end: parameterTime(end, config), ...(query.queryArea ?? {}) }, format: 'JSONEachRow', abort_signal: signal })).json();
      for (const row of rows) times.push(Number(row.time_ms));
      if (times.some(value => !Number.isFinite(value) || value < Date.parse(start) || value >= Date.parse(end))) throw new InputError('逐帧查询返回越界时刻', 502);
      return times.length ? (direction > 0 ? Math.min(...times) : Math.max(...times)) : null;
    } catch (error) { throw queryFailure(error, '回放相邻时刻查询'); }
    finally { await client.close(); }
  });
}
