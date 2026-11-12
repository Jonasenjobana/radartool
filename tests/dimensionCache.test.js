import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { buildApp } from '../server/app.js';
import { testApp, temporaryDirectory } from './helpers.js';

const iso = value => new Date(value).toISOString();
const project = { id: 'raw-project', mode: 'clickhouse-raw', configVersion: 'config-v1', ais: { parserVersion: 'parser-v1' } };
const report = (time, bow = 40, sourceId = 'source', mmsi = '258315000') => ({ mmsi, messageType: '5', eventTime: iso(time), dimensions: { bow, stern: 10, port: 4, starboard: 5, sourceId, observedAt: iso(time), validFrom: iso(time), validTo: iso(10000) } });

test('尺寸缓存按字段保存、合并连续重复，时间回退、变化与覆盖缺口均保持真实语义', async t => {
  const app = await testApp(t); const store = app.store;
  store.saveDimensions(project, [report(1000), report(1500)], 0, 5000);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM ais_dimension_versions').get().n, 1);
  assert.equal(store.db.prepare('SELECT confirmed_at_ms FROM ais_dimension_versions').get().confirmed_at_ms, 1500);
  assert.equal(store.dimensionAt(project, 'source', '258315000', 999), null);
  assert.equal(store.dimensionAt(project, 'source', '258315000', 2000).dimensions.bow, 40);
  store.saveDimensions(project, [report(3000, 80)], 2000, 6000);
  assert.equal(store.dimensionAt(project, 'source', '258315000', 2999).dimensions.bow, 40);
  assert.equal(store.dimensionAt(project, 'source', '258315000', 3000).dimensions.bow, 80);
  store.saveDimensions(project, [report(1000), report(3000, 80), report(7000)], 0, 8000);
  assert.equal(store.dimensionAt(project, 'source', '258315000', 6500).dimensions.bow, 80);
  assert.equal(store.dimensionAt(project, 'source', '258315000', 7500).dimensions.bow, 40);
  assert.equal(store.dimensionAt(project, 'source', '258315000', 8000), null);
  store.saveDimensions(project, [report(9000)], 8500, 10000);
  assert.equal(store.dimensionAt(project, 'source', '258315000', 8501), null);
  assert.equal(store.dimensionAt(project, 'other', '258315000', 9500), null);
  assert.equal(store.dimensionAt({ ...project, configVersion: 'config-v2' }, 'source', '258315000', 9500), null);
  assert.equal(store.dimensionAt({ ...project, ais: { parserVersion: 'parser-v2' } }, 'source', '258315000', 9500), null);
});

test('尺寸缓存容量可控，航标不进入船舶缓存，配置异常明确报错', async t => {
  const app = await testApp(t); const previous = process.env.AIS_DIMENSION_CACHE_MAX_ROWS;
  try {
    process.env.AIS_DIMENSION_CACHE_MAX_ROWS = '2';
    app.store.saveDimensions(project, [report(1000), report(1000, 60, 'two'), report(1000, 70, 'three'), { ...report(1000, 90, 'aid'), messageType: '21' }], 0, 4000);
    assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM ais_dimension_versions').get().n, 2);
    assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM ais_dimension_versions WHERE source_id='aid'").get().n, 0);
    process.env.AIS_DIMENSION_CACHE_MAX_ROWS = '-1';
    assert.throws(() => app.store.saveDimensions(project, [report(2000)], 0, 4000), /非负整数/);
  } finally { if (previous === undefined) delete process.env.AIS_DIMENSION_CACHE_MAX_ROWS; else process.env.AIS_DIMENSION_CACHE_MAX_ROWS = previous; }
});

test('历史轨迹不补查或复用尺寸缓存，强制远程读取也不修改已有尺寸缓存', async t => {
  const config = JSON.parse(await readFile(new URL('../config/projects.raw.example.json', import.meta.url), 'utf8'));
  const configured = config.projects[0];
  Object.assign(configured.clickhouse, { urlEnv: 'DIM_TEST_URL', usernameEnv: 'DIM_TEST_USER', passwordEnv: 'DIM_TEST_PASSWORD' });
  const start = Date.parse('2026-11-10T01:45:30.000Z'); const sourceId = '202606002';
  const position = '!AIVDM,1,1,,A,13nFBv002c1Qra`E46I<@9n@059l,0*4F';
  const calls = []; const server = http.createServer(async (request, response) => {
    const params = new URL(request.url, 'http://localhost').searchParams; const sql = Buffer.concat(await Array.fromAsync(request)).toString('utf8'); calls.push({ params, sql });
    let rows;
    if (sql.includes('AS source_range')) rows = [{ time_ms: start, radar_id: params.get('param_radar_id'), track_id: 'track', source_range: 100, source_azimuth: 10 }];
    else {
      assert.match(sql, /IN \('1', '2', '3', '18'\)/);
      assert.equal(params.has('param_ships'), false);
      rows = [{ time_ms: start, source_id: sourceId, mmsi: '258315000', messageType: '1', message: position }];
    }
    response.end(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const environment = { DIM_TEST_URL: `http://127.0.0.1:${server.address().port}`, DIM_TEST_USER: 'test', DIM_TEST_PASSWORD: 'test', AIS_STATIC_LOOKBACK_HOURS: '24' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
  const directory = await temporaryDirectory(t); const app = await buildApp({ dataDir: directory, projectConfigs: [configured], serveClient: false });
  try {
    const cachedReport = report(start - 1000, 40, sourceId); cachedReport.dimensions.validTo = iso(start + 1000);
    app.store.saveDimensions(configured, [cachedReport], start - 1000, start + 1000);
    const payload = { projectId: configured.id, radarId: configured.radars[0].id, aisSourceIds: [sourceId], start: iso(start), end: iso(start + 1000) };
    const result = await app.inject({ method: 'POST', url: '/api/query?format=full', payload });
    assert.equal(result.statusCode, 200, result.body.slice(0, 400));
    const point = result.json().dataset.ais[0]; assert.equal(point.dimensions, null); assert.equal(point.eventTime, iso(start)); assert.equal(point.headingDeg, 315);
    assert.equal(result.json().dataset.aisStatic.length, 0);
    assert.equal(calls.length, 2);
    const cached = await app.inject({ method: 'POST', url: '/api/query?format=full', payload }); assert.equal(cached.statusCode, 200, cached.body.slice(0, 400));
    assert.equal(cached.json().dataset.ais[0].dimensions, null);
    assert.equal(calls.filter(call => call.params.has('param_ships')).length, 0);
    assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM ais_dimension_versions').get().n, 1);
    const forced = await app.inject({ method: 'POST', url: '/api/query?format=full', payload: { ...payload, forceReload: true } }); assert.equal(forced.statusCode, 200, forced.body.slice(0, 400));
    assert.equal(forced.json().dataset.ais[0].dimensions, null);
    assert.equal(calls.filter(call => call.params.has('param_ships')).length, 0);
    assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM ais_dimension_versions').get().n, 1);
  } finally { await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
