import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { buildApp } from '../server/app.js';
import { queryAisDimensions } from '../server/sources.js';
import { temporaryDirectory } from './helpers.js';

const parserReady = existsSync(new URL('../.runtime/ais-parser/classes/AisBridge.class', import.meta.url));
const mmsi = '258315000';
const source = '202606002';
const time = Date.parse('2026-11-01T02:00:00.000Z');
const first = '!AIVDM,2,1,9,B,53nFBv01SJ<thHp6220H4heHTf2222222222221?50:454o<`9QSlUDp,0*09';
const second = '!AIVDM,2,2,9,B,888888888888880,2*2E';
const row = (message, offset, messageType = '24') => ({ time_ms: time + offset, source_id: source, mmsi, messageType, message });

// 仅生成受控测试报文，生产字段解码仍由 DMA 库完成。
function sentence(type, dimensions = null, part = 1) {
  const bits = Array(type === 19 ? 312 : 168).fill('0');
  const put = (offset, length, value) => bits.splice(offset, length, ...value.toString(2).padStart(length, '0'));
  put(0, 6, type); put(8, 30, Number(mmsi));
  if (type === 24) put(38, 2, part);
  if (dimensions) {
    let offset = type === 19 ? 271 : 132;
    for (const [index, size] of [9, 9, 6, 6].entries()) { put(offset, size, dimensions[index]); offset += size; }
  }
  let payload = '';
  for (let index = 0; index < bits.length; index += 6) { const value = parseInt(bits.slice(index, index + 6).join(''), 2); payload += String.fromCharCode(value + (value < 40 ? 48 : 56)); }
  const body = `AIVDM,1,1,,A,${payload},0`;
  return `!${body}*${Array.from(body).reduce((sum, char) => sum ^ char.charCodeAt(0), 0).toString(16).toUpperCase().padStart(2, '0')}`;
}

async function setup(t, reports) {
  const config = JSON.parse(await readFile(new URL('../config/projects.raw.example.json', import.meta.url), 'utf8'));
  const project = config.projects[0];
  Object.assign(project.clickhouse, { urlEnv: 'STATIC_TEST_CH_URL', usernameEnv: 'STATIC_TEST_CH_USER', passwordEnv: 'STATIC_TEST_CH_PASSWORD' });
  const state = { reports, calls: [], failure: false, invalidResponse: false };
  const server = http.createServer(async (request, response) => {
    const parameters = new URL(request.url, 'http://localhost').searchParams;
    const sql = Buffer.concat(await Array.fromAsync(request)).toString('utf8');
    state.calls.push({ parameters, sql });
    if (state.failure) { response.writeHead(500, { 'x-clickhouse-exception-code': '241' }).end('Code: 241. DB::Exception: memory limit exceeded. (MEMORY_LIMIT_EXCEEDED)'); return; }
    const bound = (key) => Date.parse(parameters.get(key).replace(' ', 'T') + 'Z');
    let rows = state.reports.filter((point) => Number(point.time_ms) >= bound('param_after') && Number(point.time_ms) < bound('param_before') && Number(point.mmsi) === Number(parameters.get('param_mmsi')) && parameters.get('param_sources').includes(point.source_id) && ['5', '19', '24'].includes(point.messageType));
    rows.sort((a, b) => a.time_ms - b.time_ms || a.source_id.localeCompare(b.source_id) || a.message.localeCompare(b.message));
    if (parameters.has('param_boundary')) rows = rows.filter((point) => point.time_ms === bound('param_boundary'));
    else rows = rows.slice(0, 20);
    if (state.invalidResponse) rows = [{ ...state.reports[0], source_id: 'unrequested-source' }];
    response.setHeader('content-type', 'application/x-ndjson');
    response.end(rows.map((point) => JSON.stringify(point)).join('\n') + (rows.length ? '\n' : ''));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const environment = { STATIC_TEST_CH_URL: `http://127.0.0.1:${server.address().port}`, STATIC_TEST_CH_USER: 'readonly-test', STATIC_TEST_CH_PASSWORD: 'test-password' };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  let app;
  t.after(async () => {
    await app?.close(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const directory = await temporaryDirectory(t);
  app = await buildApp({ dataDir: directory, serveClient: false, projectConfigs: [project] });
  const request = (payload = { mmsi, aisSourceIds: [source], positionTime: new Date(time).toISOString() }) => app.inject({ method: 'POST', url: `/api/projects/${project.id}/ais/dimensions`, payload });
  return { app, state, project, request };
}

test('点击查询返回后续第一份有效 19/24B 尺寸，跳过 24A 和无效尺寸且不写快照或缓存', { skip: !parserReady }, async (t) => {
  const { app, state, request } = await setup(t, [row(sentence(24, null, 0), 0), row(sentence(24, [0, 0, 0, 0]), 1000), row(sentence(19, [90, 10, 5, 6]), 2000, '19'), row(sentence(24, [70, 10, 4, 6]), 3000), row(first, 4000, '5'), row(second, 5000, '5'), { ...row(sentence(24, [200, 10, 5, 6]), 1000), source_id: 'other-source' }]);
  const response = await request();
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(result.report.messageType, '19');
  assert.deepEqual(result.report.dimensions, { bow: 90, stern: 10, port: 5, starboard: 6 });
  assert.equal(result.report.lengthM, 100); assert.equal(result.report.widthM, 11);
  assert.equal(result.report.eventTime, new Date(time + 2000).toISOString());
  assert.equal(result.positionTime, new Date(time).toISOString());
  assert.equal(result.report.sourceId, source);
  assert.equal(Object.hasOwn(result.report, 'raw'), false);
  assert.equal(Object.hasOwn(result.report, 'headingDeg'), false);
  assert.equal((await app.store.list('snapshots')).length, 0);
  assert.equal((await app.store.list('sessions')).length, 0);
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM ais_dimension_versions').get().n, 0);
  assert.ok(response.body.length < 1000);
  assert.match(state.calls[0].sql, /IN \('5', '19', '24'\)/);
  assert.match(state.calls[0].sql, /\{mmsi:String\}/);
  assert.match(state.calls[0].sql, /AND `mmsi` = \{mmsi:String\}/);
  assert.equal(state.calls[0].sql.includes(mmsi), false);
  assert.equal(state.calls[0].parameters.get('readonly'), '1');
  assert.match(state.calls[0].sql, /ORDER BY `receiveTime` ASC/);
  state.reports = [row(sentence(24, null, 0), 6000), row(sentence(24, [70, 10, 4, 6]), 3000)];
  assert.equal((await request()).json().report.lengthM, 80);
});

test('无尺寸明确返回空结果，只有 24A 不冒充尺寸，MMSI 与来源必须有效', { skip: !parserReady }, async (t) => {
  const { state, request } = await setup(t, [row(sentence(24, null, 0), 0)]);
  const empty = await request(); assert.equal(empty.statusCode, 200, empty.body); assert.equal(empty.json().report, null);
  state.reports = []; assert.equal((await request()).json().report, null);
  const before = state.calls.length;
  for (const invalid of [{ mmsi: "1' OR 1=1", aisSourceIds: [source] }, { mmsi, aisSourceIds: [] }, { mmsi, aisSourceIds: ['other-source'] }, { mmsi, aisSourceIds: [source], positionTime: 'invalid' }, { mmsi, aisSourceIds: [source], positionTime: undefined }]) assert.equal((await request({ positionTime: new Date(time).toISOString(), ...invalid })).statusCode, 400);
  assert.equal(state.calls.length, before);
});

test('尺寸补查固定为点击回放时间往后 48 小时，窗口外有报文或无数据均返回空结果', { skip: !parserReady }, async (t) => {
  const now = time + 7 * 24 * 3600000; const upper = time + 48 * 3600000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const { state, request } = await setup(t, [row(sentence(24, [70, 10, 4, 6]), -1000), row(sentence(24, [90, 10, 4, 6]), upper - time)]);
  for (const reports of [state.reports, []]) {
    state.reports = reports; state.calls.length = 0;
    const response = await request(); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().report, null);
    const bounds = state.calls.map(({ parameters }) => ['after', 'before'].map(key => Date.parse(parameters.get(`param_${key}`).replace(' ', 'T') + 'Z')));
    assert.equal(bounds[0][0], time); assert.equal(bounds.at(-1)[1], upper);
    assert.ok(bounds.every(([after, before]) => after >= time && before <= upper && after < before), '全部查询必须处于点击时间后的 48 小时内');
    for (let index = 1; index < bounds.length; index++) assert.equal(bounds[index][0], bounds[index - 1][1]);
  }
});

test('尺寸补查包含点击时刻与第二天的报告、排除 48 小时上界，跨上下界缺片不越界补查', { skip: !parserReady }, async (t) => {
  const upper = time + 48 * 3600000;
  const { state, request } = await setup(t, [row(sentence(24, [70, 10, 4, 6]), 0)]);
  const boundary = await request(); assert.equal(boundary.statusCode, 200, boundary.body);
  assert.equal(boundary.json().report.eventTime, new Date(time).toISOString());
  state.reports = [row(sentence(24, [90, 10, 5, 6]), 36 * 3600000), row(sentence(24, [120, 10, 5, 6]), 40 * 3600000)];
  const nextDay = await request(); assert.equal(nextDay.statusCode, 200, nextDay.body);
  assert.equal(nextDay.json().report?.eventTime, new Date(time + 36 * 3600000).toISOString()); assert.equal(nextDay.json().report.lengthM, 100);
  state.reports = [row(sentence(24, [90, 10, 5, 6]), upper - time)];
  const future = await request(); assert.equal(future.statusCode, 200, future.body); assert.equal(future.json().report, null);
  state.calls.length = 0; state.reports = [row(first, -1000, '5'), row(second, 0, '5')];
  const incomplete = await request(); assert.equal(incomplete.statusCode, 422, incomplete.body); assert.match(incomplete.json().error, /完整分片/);
  state.reports = [row(first, upper - time - 1000, '5'), row(second, upper - time, '5')];
  const missingTail = await request(); assert.equal(missingTail.statusCode, 422, missingTail.body);
  assert.ok(state.calls.every(({ parameters }) => Date.parse(parameters.get('param_after').replace(' ', 'T') + 'Z') >= time && Date.parse(parameters.get('param_before').replace(' ', 'T') + 'Z') <= upper));
});

test('按时间正序分页直到找到有效尺寸，20 条是批大小而非查找上限', { skip: !parserReady }, async (t) => {
  const reports = Array.from({ length: 20 }, (_, index) => row(sentence(24, null, 0), index * 1000));
  reports.push(row(sentence(24, [70, 10, 4, 6]), 20000));
  const { state, request } = await setup(t, reports);
  const response = await request(); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().report.lengthM, 80);
  assert.equal(state.calls.length, 3);
});

test('正序分页完整读取同刻分片，跨页保留此前片段再交给原库组包', { skip: !parserReady }, async (t) => {
  const reports = Array.from({ length: 19 }, (_, index) => row(sentence(24, null, 0), index * 1000));
  reports.push(row(first, 19000, '5'), row(second, 19000, '5'));
  const { state, request } = await setup(t, reports);
  let response = await request(); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().report.lengthM, 50); assert.equal(response.json().report.widthM, 9);
  state.reports = reports.map((point) => point.message === second ? { ...point, time_ms: time + 20000 } : point);
  response = await request(); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().report.messageType, '5');
  assert.equal(response.json().report.eventTime, new Date(time + 20000).toISOString());
});

test('起始时段没有有效尺寸时，按不重叠的时间窗口向后查找并衔接跨窗分片', { skip: !parserReady }, async (t) => {
  const { state, request } = await setup(t, [row(sentence(24, [70, 10, 4, 6]), 3 * 3600000)]);
  const response = await request(); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().report.lengthM, 80); assert.equal(state.calls.length, 3);
  for (let index = 1; index < state.calls.length; index++) assert.equal(state.calls[index].parameters.get('param_after'), state.calls[index - 1].parameters.get('param_before'));
  assert.match(state.calls[0].sql, /`receiveTime` >= \{after:DateTime\('UTC'\)\}/);
  const edge = time + 3600000;
  state.reports = [{ ...row(first, 0, '5'), time_ms: edge - 30000 }, { ...row(second, 0, '5'), time_ms: edge + 30000 }];
  const boundary = await request(); assert.equal(boundary.statusCode, 200, boundary.body);
  assert.equal(boundary.json().report.lengthM, 50);
});

test('缺片、上游错误、返回越界与不支持的来源明确报错，失败后仍可再查', { skip: !parserReady }, async (t) => {
  const { state, project, request } = await setup(t, [row(first, 0, '5')]);
  let response = await request(); assert.equal(response.statusCode, 422, response.body); assert.match(response.json().error, /完整分片/);
  state.failure = true; response = await request(); assert.equal(response.statusCode, 422, response.body); assert.match(response.json().error, /内存限制/);
  state.failure = false; state.invalidResponse = true; response = await request(); assert.equal(response.statusCode, 502, response.body);
  state.invalidResponse = false; state.reports = [row(first + second, 0, '5')];
  response = await request(); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().report.lengthM, 50);
  await assert.rejects(queryAisDimensions({ ...project, mode: 'clickhouse-http' }, { mmsi, aisSourceIds: [source] }), /未配置 ClickHouse/);
  await assert.rejects(queryAisDimensions({ ...project, ais: { ...project.ais, columns: { ...project.ais.columns, mmsi: undefined } } }, { mmsi, aisSourceIds: [source] }), /列映射/);
});
