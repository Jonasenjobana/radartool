import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { buildApp } from '../server/app.js';
import { loadProjects } from '../server/config.js';
import { radarQuery } from '../server/sources.js';
import { createDemoDataset, DEMO_START } from './fixtures/demo.js';
import { DEMO_QUERY, temporaryDirectory } from './helpers.js';

test('真实查询适配器参数绑定、单位映射、来源契约和全量失败语义', async (t) => {
  const directory = await temporaryDirectory(t);
  const configured = JSON.parse(await readFile(new URL('../config/projects.example.json', import.meta.url), 'utf8'));
  const project = configured.projects[0];
  project.verified = project.unitsVerified = project.alignmentVerified = true;
  project.timeSemantics = 'event-time';
  Object.assign(project.clickhouse, { urlEnv: 'RADAR_TEST_CH_URL', usernameEnv: 'RADAR_TEST_CH_USER', passwordEnv: 'RADAR_TEST_CH_PASSWORD' });
  Object.assign(project.ais, { urlEnv: 'RADAR_TEST_AIS_URL', authorizationEnv: 'RADAR_TEST_AIS_AUTH' });
  project.clickhouse.mapping.rangeScaleToM = 0.01;
  project.clickhouse.mapping.azimuthScaleToDeg = 0.0001;
  const calls = [];
  let fail = ''; let pendingFragments = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const body = Buffer.concat(await Array.fromAsync(request)).toString('utf8');
    calls.push({ path: url.pathname, params: url.searchParams, body });
    if (url.pathname === '/ais') {
      if (fail === 'ais-http') { response.writeHead(503).end('unavailable'); return; }
      const observation = structuredClone(createDemoDataset({ end: DEMO_START + 4000, sourceIds: ['ais-east'] }).ais[0]);
      observation.sourceIds = ['receiver-a'];
      if (fail === 'out-of-range') observation.eventTime = '2026-11-11T02:00:00.000Z';
      if (fail === 'unknown-source') observation.sourceIds = ['receiver-other'];
      const staticTime = new Date(DEMO_START + 1000).toISOString();
      const staticObservation = { id: 'http-static', sourceIds: ['receiver-a'], mmsi: observation.mmsi, eventTime: staticTime, messageType: '5', mappingVersion: project.ais.parserVersion, dimensions: { ...observation.dimensions, sourceId: 'receiver-a', observedAt: staticTime, validFrom: staticTime, validTo: '2026-11-10T02:00:30.000Z' } };
      if (fail === 'static-out-of-range') staticObservation.eventTime = '2026-11-11T02:00:00.000Z';
      if (fail === 'static-unknown-source') staticObservation.sourceIds = ['receiver-other'];
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ schemaVersion: 1, complete: fail !== 'incomplete', parserVersion: project.ais.parserVersion, parseStats: { failedReports: fail === 'parse-error' ? 1 : 0, pendingFragments }, observations: [observation], staticObservations: fail === 'static-shape' ? {} : [staticObservation] }));
    } else {
      if (fail === 'radar-http') { response.writeHead(500).end('query failed'); return; }
      let rows;
      if (body.includes('currentDatabase')) rows = [{ database: 'default', version: 'mock', timezone: 'UTC' }];
      else if (body.includes('DESCRIBE')) rows = [{ name: 'date', type: 'DateTime64(3)', default_expression: 'not-exported' }];
      else if (body.includes('system.tables')) rows = [{ engine: 'MergeTree', partition_key: 'toDate(date)', sorting_key: 'areaCode, date', primary_key: 'areaCode, date' }];
      else rows = [{ time_ms: String(DEMO_START), radar_id: url.searchParams.get('param_radar_id'), track_id: 'R1', source_range: 100000, source_azimuth: 900000, stored_lng: 0, stored_lat: 0 }];
      response.setHeader('content-type', 'application/x-ndjson');
      response.end(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const environment = { RADAR_TEST_CH_URL: origin, RADAR_TEST_CH_USER: 'readonly-test', RADAR_TEST_CH_PASSWORD: 'secret-test-password', RADAR_TEST_AIS_URL: `${origin}/ais`, RADAR_TEST_AIS_AUTH: 'Bearer secret-test-authorization' };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const configPath = path.join(directory, 'projects.json');
  await writeFile(configPath, JSON.stringify(configured), 'utf8');
  const app = await buildApp({ dataDir: directory, configPath, serveClient: false });
  try {
    const publicProjects = (await app.inject('/api/projects')).body;
    assert.equal(publicProjects.includes('secret-test'), false);
    assert.equal(publicProjects.includes(origin), false);
    const payload = { ...DEMO_QUERY, end: '2026-11-10T02:00:30.000Z', projectId: project.id, radarId: project.radars[0].id, aisSourceIds: ['receiver-a'] };
    const response = await app.inject({ method: 'POST', url: '/api/query?format=full', payload });
    assert.equal(response.statusCode, 200, response.body);
    const snapshot = response.json();
    assert.equal(snapshot.dataset.aisStatic.length, 1);
    assert.equal(snapshot.dataset.aisStatic[0].timeMs, DEMO_START + 1000);
    assert.equal(snapshot.dataset.aisStatic[0].dimensions.sourceId, 'receiver-a');
    assert.equal(snapshot.dataset.radar[0].rangeM, 1000);
    assert.equal(snapshot.dataset.radar[0].azimuthDeg, 90);
    assert.deepEqual(snapshot.dataset.radar[0].storedPosition, { lng: 0, lat: 0 });
    assert.equal(snapshot.dataset.radar[0].raw.source_range, 100000);
    const radarCall = calls.find((call) => call.body.includes('source_range'));
    assert.ok(radarCall.body.includes('{radar_id:String}'));
    assert.equal(radarCall.params.get('param_radar_id'), project.radars[0].id);
    assert.ok(!radarCall.body.includes(project.radars[0].id));
    const aisCall = calls.find((call) => call.path === '/ais');
    assert.deepEqual(JSON.parse(aisCall.body).sourceIds, ['receiver-a']);
    assert.equal(Object.hasOwn(JSON.parse(aisCall.body), 'limit'), false);
    assert.equal((await app.inject(`/api/snapshots/${snapshot.id}/export`)).body.includes('secret-test'), false);
    const inspect = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/inspect`, payload: {} });
    assert.equal(inspect.statusCode, 200, inspect.body);
    assert.equal(inspect.json().verified, false);
    assert.deepEqual(inspect.json().columns, [{ name: 'date', type: 'DateTime64(3)' }]);
    for (const mode of ['incomplete', 'ais-http', 'radar-http', 'out-of-range', 'unknown-source', 'parse-error', 'static-out-of-range', 'static-unknown-source', 'static-shape']) {
      fail = mode;
      const failed = await app.inject({ method: 'POST', url: '/api/query?format=full', payload });
      assert.equal(failed.statusCode, 502, failed.body);
      assert.equal((await app.inject('/api/snapshots')).json().length, 1);
      assert.equal(failed.body.includes('secret-test'), false);
    }
    fail = ''; pendingFragments = 3;
    const pending = (await app.inject({ method: 'POST', url: '/api/query?format=full', payload })).json();
    assert.ok(pending.summary.warnings.some((warning) => warning.includes('3 条未完成组包')));
    assert.equal(pending.dataset.provenance.parseStats.pendingFragments, 3);
    await app.inject({ method: 'POST', url: `/api/registry/${project.id}/radars`, payload: { id: 'second-radar', name: '第二台', baseline: project.radars[0].baseline } });
    const group = (await app.inject({ method: 'POST', url: '/api/groups', payload: { projectId: project.id, name: 'HTTP 上下文', radarIds: [project.radars[0].id, 'second-radar'], aisSourceIds: ['receiver-a'] } })).json();
    const before = calls.length;
    const grouped = await app.inject({ method: 'POST', url: `/api/groups/${group.id}/query?format=full`, payload: { start: payload.start, end: payload.end } });
    assert.equal(grouped.statusCode, 200, grouped.body);
    const aisQueries = calls.slice(before).filter((call) => call.path === '/ais');
    assert.deepEqual(aisQueries.map((call) => JSON.parse(call.body).radarId), [project.radars[0].id, 'second-radar']);
    const queryArea = { west: 117, east: 118, south: 23, north: 24 };
    const filtered = await app.inject({ method: 'POST', url: '/api/query?format=full', payload: { ...payload, queryArea } });
    assert.equal(filtered.statusCode, 200, filtered.body);
    assert.equal(filtered.json().dataset.ais.length, 0);
    assert.equal(filtered.json().dataset.radar.length, 1);
    assert.deepEqual(JSON.parse(calls.at(-1).body).queryArea, queryArea);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('受控配置拒绝 SQL 标识符注入，查询值保留参数占位', async (t) => {
  const directory = await temporaryDirectory(t);
  const config = JSON.parse(await readFile(new URL('../config/projects.example.json', import.meta.url), 'utf8'));
  assert.ok(radarQuery(config.projects[0]).includes('{start:DateTime64(3, \'UTC\')}'));
  config.projects[0].clickhouse.table = 'radar_data; DROP TABLE any';
  const configPath = path.join(directory, 'projects.json');
  await writeFile(configPath, JSON.stringify(config), 'utf8');
  await assert.rejects(loadProjects(configPath), /table/);
});
