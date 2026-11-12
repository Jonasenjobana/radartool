import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { loadProjects } from '../server/config.js';
import { parseAisRows } from '../server/ais-parser.js';
import { parameterTime, queryFailure, withLiveRead } from '../server/clickhouse.js';
import { radarQuery, rawAisQuery } from '../server/sources.js';
import { normalizeDataset } from '../shared/data.js';
import { createAisIndex, createAisStaticIndex, latestAisAtTime } from '../shared/alignment.js';
import { createDemoDataset } from './fixtures/demo.js';
import { temporaryDirectory } from './helpers.js';

const parserReady = existsSync(new URL('../.runtime/ais-parser/classes/AisBridge.class', import.meta.url));
const sentence = '!AIVDM,1,1,,A,181:Jqh02c1Qra`E46I<@9n@059l,0*30';
const first = '!AIVDM,2,1,9,B,53nFBv01SJ<thHp6220H4heHTf2222222222221?50:454o<`9QSlUDp,0*09';
const second = '!AIVDM,2,2,9,B,888888888888880,2*2E';
const start = '2026-11-10T01:45:30.000Z';
const end = '2026-11-10T01:45:31.000Z';
const row = (message, source_id = '202606002') => ({ source_id, time_ms: Date.parse(start), message });

test('秒精度查询保留精确半开边界', () => {
  assert.equal(parameterTime('2026-11-10T01:45:30.123Z', { timeType: 'DateTime' }), '2026-11-10 01:45:31');
  assert.equal(parameterTime('2026-11-10T01:45:31.000Z', { timeType: 'DateTime' }), '2026-11-10 01:45:31');
  assert.equal(parameterTime('2026-11-10T01:45:30.123Z', { timeType: 'DateTime64' }), '2026-11-10 01:45:30.123');
});

test('源 DateTime 使用同类型查询参数以支持旧服务器的索引裁剪', async () => {
  const project = JSON.parse(await readFile(new URL('../config/projects.raw.example.json', import.meta.url), 'utf8')).projects[0];
  assert.ok(radarQuery(project).includes("{start:DateTime('UTC')}"));
  assert.ok(rawAisQuery(project).includes("`receiveTime` >= {start:DateTime('UTC')}"));
  assert.ok(rawAisQuery(project).includes('`stationMmsi` IN {sources:Array(String)}'));
  assert.match(rawAisQuery(project), /toString\(`messageId`\) IN \('1', '2', '3', '18'\)/);
  assert.throws(() => rawAisQuery({ ...project, ais: { ...project.ais, columns: { ...project.ais.columns, messageType: undefined } } }), /消息类型列映射/);
  assert.equal(rawAisQuery(project).includes('lng != 0'), false);
  assert.equal(rawAisQuery(project).includes("stationMmsi = '202606002'"), false);
  assert.doesNotMatch(radarQuery(project), /\bLIMIT\b/i);
  assert.doesNotMatch(rawAisQuery(project), /\bLIMIT\b/i);
});

test('南澳经纬度和朝向仅作参考配置，扫描参数不进入有效配置', async (t) => {
  const directory = await temporaryDirectory(t);
  const config = JSON.parse(await readFile(new URL('../config/projects.raw.example.json', import.meta.url), 'utf8'));
  const [firstRadar, secondRadar] = config.projects[0].radars;
  assert.deepEqual(firstRadar.baseline, { lng: 117.107758, lat: 23.388403, bearingOffsetDeg: 93 });
  assert.deepEqual(secondRadar.baseline, { lng: 117.309437, lat: 23.286064, bearingOffsetDeg: 303.4 });
  firstRadar.scanDistanceM = 6000; firstRadar.scanAngleDeg = 90;
  const file = path.join(directory, 'projects.json'); await writeFile(file, JSON.stringify(config), 'utf8');
  const loaded = (await loadProjects(file)).find((p) => p.id === 'radar-202607');
  assert.equal(loaded.radars[0].scanDistanceM, undefined);
  assert.equal(loaded.radars[0].scanAngleDeg, undefined);
  assert.deepEqual(loaded.aisSources.map((s) => s.id), ['202606002']);
  assert.equal(loaded.alignmentVerified, false);
});

test('只读查询单并发且异常后释放查询槽，资源超限明确停止', async () => {
  let release;
  const active = withLiveRead(() => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(withLiveRead(async () => {}), /已有只读查询/);
  release(); await active;
  await assert.rejects(withLiveRead(async () => { throw new Error('模拟源失败'); }), /模拟源失败/);
  assert.equal(await withLiveRead(async () => 'released'), 'released');
  assert.equal(queryFailure({ code: '158' }, '查询').statusCode, 422);
  assert.match(queryFailure({ code: '158' }, '查询').message, /不会自动扩大范围/);
});

test('远程 ClickHouse 超限错误保留具体原因，不冒充工具的固定限额', () => {
  const rows = queryFailure({ code: '158' }, 'AIS 查询');
  assert.match(rows.message, /远程数据库扫描行数/);
  assert.match(rows.message, /索引块/);
  assert.doesNotMatch(rows.message, /200,000|时间或内存/);
  assert.match(queryFailure({ code: '159' }, 'AIS 查询').message, /远程数据库执行时间/);
  assert.match(queryFailure({ code: '160' }, 'AIS 查询').message, /读取速度/);
  assert.match(queryFailure({ code: '307' }, 'AIS 查询').message, /远程数据库读取量/);
  assert.match(queryFailure({ code: '158', message: 'Limit for rows or bytes to read exceeded, max bytes: 16.00 MiB, current bytes: 17.00 MiB' }, 'AIS 查询').message, /远程数据库读取量/);
  assert.match(queryFailure({ code: '241' }, 'AIS 查询').message, /远程数据库内存/);
  assert.match(queryFailure({ code: '202' }, 'AIS 查询').message, /并发/);
});

test('复用 AIS 库保留真实位置、速度和真船艏向，转换不修改原始报文', { skip: !parserReady }, async () => {
  const rows = [row(sentence)]; const copy = structuredClone(rows);
  const parsed = await parseAisRows(rows, { end });
  assert.equal(parsed.observations.length, 1);
  assert.equal(parsed.observations[0].mmsi, '538090215');
  assert.equal(parsed.observations[0].sogKnots, 17.1);
  assert.equal(parsed.observations[0].cogDeg, 313.6);
  assert.equal(parsed.observations[0].headingDeg, 315);
  assert.ok(Math.abs(parsed.observations[0].position.lng - 21.39016666666667) < 1e-10);
  assert.equal(parsed.observations[0].raw.message, sentence);
  assert.equal(parsed.observations[0].receiveTime, start);
  assert.deepEqual(rows, copy);
});

test('位置报告仅保留 1/2/3/18，19 不生成轨迹点', { skip: !parserReady }, async () => {
  const rows = [1, 2, 3, 18, 19].map(type => {
    const bits = Array(type === 19 ? 312 : 168).fill('0');
    const put = (offset, length, value) => bits.splice(offset, length, ...value.toString(2).padStart(length, '0'));
    put(0, 6, type); put(8, 30, 258315000);
    const longitudeOffset = type < 4 ? 61 : 57;
    put(longitudeOffset, 28, 117 * 600000); put(longitudeOffset + 28, 27, 23 * 600000);
    let payload = '';
    for (let offset = 0; offset < bits.length; offset += 6) { const value = parseInt(bits.slice(offset, offset + 6).join(''), 2); payload += String.fromCharCode(value + (value < 40 ? 48 : 56)); }
    const body = `AIVDM,1,1,,A,${payload},0`;
    return row(`!${body}*${[...body].reduce((checksum, char) => checksum ^ char.charCodeAt(0), 0).toString(16).toUpperCase().padStart(2, '0')}`);
  });
  const parsed = await parseAisRows(rows, { end });
  assert.deepEqual(parsed.observations.map(point => point.messageType), ['1', '2', '3', '18']);
  assert.ok(parsed.observations.every(point => point.position.lng === 117 && point.position.lat === 23));
  assert.equal(parsed.parseStats.failedReports, 0);
  assert.equal(parsed.parseStats.nonPositionReports, 1);
});

test('较大 AIS 数据集完整解析，沿用 JVM 资源设置', { skip: !parserReady }, async () => {
  for (const count of [40000, 120000]) {
    const parsed = await parseAisRows(Array.from({ length: count }, () => row(sentence)), { end });
    assert.equal(parsed.observations.length, count);
    assert.equal(parsed.parseStats.rawReports, count);
    assert.equal(parsed.parseStats.decodedPackets, count);
    assert.equal(parsed.parseStats.failedReports, 0);
    assert.notEqual(parsed.observations[0].id, parsed.observations.at(-1).id);
    assert.equal(parsed.observations.at(-1).raw.message, sentence);
  }
});

test('解析进程退出时返回真实 Java 异常，输入管道错误不覆盖根因', { skip: !parserReady }, async () => {
  const previous = process.env.JAVA_TOOL_OPTIONS;
  process.env.JAVA_TOOL_OPTIONS = `${previous ?? ''} -Xmx8m`.trim();
  try {
    await assert.rejects(parseAisRows(Array.from({ length: 20000 }, () => row(sentence)), { end }), (error) => {
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /退出码 1/);
      assert.match(error.message, /OutOfMemoryError/);
      assert.doesNotMatch(error.message, /Picked up JAVA_TOOL_OPTIONS|请检查 Java 与解析依赖/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.JAVA_TOOL_OPTIONS; else process.env.JAVA_TOOL_OPTIONS = previous;
  }
});

test('多片 AIS 沿同来源组包，拼接报文可复用库解析', { skip: !parserReady }, async () => {
  const joined = await parseAisRows([row(first + second)], { end });
  assert.equal(joined.parseStats.decodedPackets, 1);
  assert.equal(joined.parseStats.nonPositionReports, 1);
  assert.equal(joined.parseStats.pendingFragments, 0);
  const split = await parseAisRows([row(first), row(second)], { end });
  assert.equal(split.parseStats.decodedPackets, 1);
  assert.equal(split.parseStats.discardedFragments, 0);
  assert.equal(split.staticObservations.length, 1);
  assert.equal(split.staticObservations[0].mmsi, '258315000');
  assert.equal(split.staticObservations[0].dimensions.bow, 40);
  assert.equal(split.staticObservations[0].dimensions.stern, 10);
  assert.equal(split.staticObservations[0].dimensions.port, 4);
  assert.equal(split.staticObservations[0].dimensions.starboard, 5);
  assert.equal(split.staticObservations[0].raw.message, second);
});

test('真实库解析的后到静态报文可立即更新回放，保留动态位置时间及原始报文', { skip: !parserReady }, async () => {
  const staticTime = Date.parse(start) + 100;
  const position = '!AIVDM,1,1,,A,13nFBv002c1Qra`E46I<@9n@059l,0*4F';
  const rows = [row(position), { ...row(first), time_ms: staticTime }, { ...row(second), time_ms: staticTime }];
  const before = structuredClone(rows);
  const parsed = await parseAisRows(rows, { end });
  assert.equal(parsed.observations.length, 1); assert.equal(parsed.staticObservations.length, 1);
  assert.equal(parsed.observations[0].dimensions, null);
  const raw = createDemoDataset();
  Object.assign(raw, { radar: [], ais: parsed.observations, aisStatic: parsed.staticObservations, timeRange: { start, end } });
  const { dataset } = normalizeDataset(raw);
  const index = createAisIndex(dataset); const staticIndex = createAisStaticIndex(dataset.aisStatic);
  assert.equal(latestAisAtTime(index, staticTime - 1, staticIndex)[0].dimensions, null);
  const current = latestAisAtTime(index, staticTime, staticIndex)[0];
  assert.equal(current.mmsi, '258315000');
  assert.equal(current.dimensions.bow + current.dimensions.stern, 50);
  assert.equal(current.dimensions.port + current.dimensions.starboard, 9);
  assert.equal(current.eventTime, start); assert.equal(current.timeMs, Date.parse(start));
  assert.deepEqual(current.position, dataset.ais[0].position);
  assert.equal(latestAisAtTime(index, staticTime - 1, staticIndex)[0].dimensions, null);
  assert.deepEqual(rows, before);
});

test('未组包、被放弃片段与坏报文明确统计，来源上下文不混合', { skip: !parserReady }, async () => {
  const pending = await parseAisRows([row(first)], { end });
  assert.equal(pending.parseStats.pendingFragments, 1);
  const discarded = await parseAisRows([row(first), row(sentence)], { end });
  assert.equal(discarded.parseStats.discardedFragments, 1);
  await assert.rejects(parseAisRows([row(first, 'a'), row(second, 'b')], { end }), /解析失败/);
  await assert.rejects(parseAisRows([row(sentence.replace('*30', '*00'))], { end }), /解析失败/);
});

test('历史查询只读获取动态报告，保留站点和时间条件，不附加资源限额或截断结果', { skip: !parserReady }, async (t) => {
  const directory = await temporaryDirectory(t);
  const config = JSON.parse(await readFile(new URL('../config/projects.raw.example.json', import.meta.url), 'utf8'));
  const project = config.projects[0];
  Object.assign(project.clickhouse, { urlEnv: 'RAW_TEST_CH_URL', usernameEnv: 'RAW_TEST_CH_USER', passwordEnv: 'RAW_TEST_CH_PASSWORD' });
  const calls = []; let upstreamActive = 0; let peakActive = 0; let failSecondRadar = false; let failAisLimit = false; let radarReportCount = 1; let includeStatic = false;
  const server = http.createServer(async (request, response) => {
    upstreamActive++; peakActive = Math.max(peakActive, upstreamActive);
    const url = new URL(request.url, 'http://localhost');
    const body = Buffer.concat(await Array.fromAsync(request)).toString('utf8');
    calls.push({ body, parameters: url.searchParams });
    if (failSecondRadar && url.searchParams.get('param_radar_id') === '202607002') { response.writeHead(500).end('source unavailable'); upstreamActive--; return; }
    if (failAisLimit && body.includes('stationtest_shipborne_repeater_datagram')) {
      response.writeHead(500, { 'x-clickhouse-exception-code': '158' }).end('Code: 158. DB::Exception: Limit for rows or bytes to read exceeded. (TOO_MANY_ROWS)');
      upstreamActive--; return;
    }
    let records = body.includes(' AS source_range')
      ? Array.from({ length: radarReportCount }, (_, index) => ({ time_ms: String(Date.parse(start)), radar_id: url.searchParams.get('param_radar_id'), track_id: `R${index + 1}`, source_range: 123, source_azimuth: -15, stored_lng: 117.1, stored_lat: 23.38 }))
      : includeStatic ? [row(first), row(second), row(sentence)] : [row(sentence)];
    if (!body.includes(' AS source_range')) {
      assert.match(body, /IN \('1', '2', '3', '18'\)/);
      records = records.map(record => ({ ...record, messageType: record.message === sentence ? '1' : '5' })).filter(record => ['1', '2', '3', '18'].includes(record.messageType));
    }
    response.end(records.map((record) => JSON.stringify(record)).join('\n') + '\n'); upstreamActive--;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const values = { AIS_STATIC_LOOKBACK_HOURS: '0', RAW_TEST_CH_URL: `http://127.0.0.1:${server.address().port}`, RAW_TEST_CH_USER: 'test-reader', RAW_TEST_CH_PASSWORD: 'never-export-test-secret' };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  const file = path.join(directory, 'projects.json'); await writeFile(file, JSON.stringify(config), 'utf8');
  const app = await buildApp({ dataDir: directory, configPath: file, serveClient: false });
  try {
    const metadata = (await app.inject('/api/projects')).json()[0];
    assert.equal(Object.hasOwn(metadata, 'maxQuerySeconds'), false);
    const longEnd = '2026-11-12T01:45:30.000Z';
    const payload = { projectId: project.id, radarId: '202607001', aisSourceIds: ['202606002'], start, end: longEnd };
    const invalidRange = await app.inject({ method: 'POST', url: '/api/query?format=full', payload: { ...payload, end: start } });
    assert.equal(invalidRange.statusCode, 400); assert.equal(calls.length, 0);
    const result = await app.inject({ method: 'POST', url: '/api/query?format=full', payload });
    assert.equal(result.statusCode, 200, result.body);
    const snapshot = result.json();
    assert.equal(snapshot.dataset.provenance.kind, 'live-query');
    assert.equal(snapshot.dataset.provenance.rawAisReports.length, 1);
    assert.equal(snapshot.dataset.ais[0].sourceIds[0], '202606002');
    assert.equal(snapshot.dataset.alignmentVerified, false);
    assert.equal(result.body.includes('never-export-test-secret'), false);
    assert.equal(calls.length, 2); assert.equal(peakActive, 1);
    for (const call of calls) {
      assert.equal(call.parameters.get('readonly'), '1');
      for (const setting of ['max_rows_to_read', 'max_threads', 'max_execution_time', 'max_memory_usage', 'max_bytes_to_read', 'max_result_rows', 'read_overflow_mode', 'result_overflow_mode']) assert.equal(call.parameters.has(setting), false, setting);
      assert.doesNotMatch(call.body, /\bLIMIT\b/i);
    }
    assert.equal(calls[1].parameters.get('param_sources'), "['202606002']");
    assert.ok(calls[1].body.includes('stationtest_shipborne_repeater_datagram'));
    assert.equal(calls[1].parameters.get('param_start'), '2026-11-10 01:45:30');
    assert.equal(calls[1].parameters.get('param_end'), '2026-11-12 01:45:30');
    assert.deepEqual(snapshot.dataset.timeRange, { start, end: longEnd });
    radarReportCount = 10001;
    const larger = await app.inject({ method: 'POST', url: '/api/query?format=full', payload });
    assert.equal(larger.statusCode, 200, larger.body.slice(0, 200));
    assert.equal(larger.json().summary.radarPoints, radarReportCount);
    radarReportCount = 1;
    const group = (await app.inject('/api/groups')).json()[0]; const before = calls.length;
    const grouped = await app.inject({ method: 'POST', url: `/api/groups/${group.id}/query?format=full`, payload: { start, end: longEnd } });
    assert.equal(grouped.statusCode, 200, grouped.body);
    assert.equal(grouped.json().snapshots.length, 2);
    assert.equal(grouped.json().session.end, longEnd);
    const groupedCalls = calls.slice(before);
    assert.equal(groupedCalls.length, 3);
    assert.equal(groupedCalls.filter((call) => call.body.includes('stationtest_shipborne_repeater_datagram')).length, 1);
    assert.equal(peakActive, 1);
    failAisLimit = true; const limitStart = calls.length; const savedSnapshots = (await app.inject('/api/snapshots')).json().length;
    const limited = await app.inject({ method: 'POST', url: `/api/groups/${group.id}/query?format=full`, payload: { start, end } });
    assert.equal(limited.statusCode, 422); assert.match(limited.json().error, /远程数据库扫描行数/);
    assert.equal(calls.length - limitStart, 3);
    assert.equal((await app.inject('/api/snapshots')).json().length, savedSnapshots);
    assert.equal((await app.inject('/api/sessions')).json().length, 1);
    failSecondRadar = true; const failedStart = calls.length;
    const failed = await app.inject({ method: 'POST', url: `/api/groups/${group.id}/query?format=full`, payload: { start, end } });
    assert.equal(failed.statusCode, 502); assert.equal(calls.length - failedStart, 2);
    assert.equal((await app.inject('/api/sessions')).json().length, 1);
    failSecondRadar = false; failAisLimit = false; includeStatic = true;
    const position = snapshot.dataset.ais[0].position;
    const queryArea = { west: position.lng - 0.01, east: position.lng + 0.01, south: position.lat - 0.01, north: position.lat + 0.01 };
    const areaStart = calls.length;
    const areaResult = await app.inject({ method: 'POST', url: `/api/groups/${group.id}/query?format=full`, payload: { start, end, queryArea } });
    assert.equal(areaResult.statusCode, 200, areaResult.body);
    const bundle = areaResult.json();
    assert.deepEqual(bundle.session.queryArea, queryArea);
    for (const value of bundle.snapshots) {
      assert.equal(value.dataset.radar.length, 1);
      assert.equal(value.dataset.ais.length, 1);
      assert.equal(value.dataset.provenance.rawAisReports.length, 1);
      assert.equal(value.dataset.provenance.parseStats.nonPositionReports, 0);
      assert.equal(value.dataset.aisStatic.length, 0);
      assert.equal(value.dataset.ais[0].dimensions, null);
      assert.deepEqual(value.dataset.provenance.query.queryArea, queryArea);
    }
    const areaCalls = calls.slice(areaStart);
    assert.equal(areaCalls.length, 3);
    assert.doesNotMatch(areaCalls[0].body, /\{west:|\{south:/);
    assert.match(areaCalls[2].body, /`lng` >= \{west:Float64\}/);
    assert.match(areaCalls[2].body, /`lat` <= \{north:Float64\}/);
    assert.match(areaCalls[2].body, /IN \('1', '2', '3', '18'\)/);
    for (const [key, value] of Object.entries(queryArea)) assert.equal(Number(areaCalls[2].parameters.get(`param_${key}`)), value);
    const saved = (await app.inject(`/api/sessions/${bundle.session.id}?format=full`)).json();
    assert.deepEqual(saved.session.queryArea, queryArea);
    assert.deepEqual(saved.snapshots[0].dataset.aisStatic, bundle.snapshots[0].dataset.aisStatic);
    const outside = await app.inject({ method: 'POST', url: '/api/query?format=full', payload: { ...payload, queryArea: { west: 117, east: 118, south: 23, north: 24 } } });
    assert.equal(outside.statusCode, 200, outside.body);
    assert.equal(outside.json().dataset.ais.length, 0);
    assert.equal(outside.json().dataset.radar.length, 1);
    const invalidStart = calls.length;
    const invalidArea = await app.inject({ method: 'POST', url: '/api/query?format=full', payload: { ...payload, queryArea: { ...queryArea, west: queryArea.east } } });
    assert.equal(invalidArea.statusCode, 400);
    assert.equal(calls.length, invalidStart);
  } finally {
    await app.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
