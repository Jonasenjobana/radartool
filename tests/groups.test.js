import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../server/app.js';
import { normalizeDataset } from '../shared/data.js';
import { mergeAisObservations, selectCachedGroup } from '../shared/session.js';
import { api, post } from '../client/api.ts';
import { createDemoDataset } from './fixtures/demo.js';
import { DEMO_QUERY, fixtureAppOptions, temporaryDirectory } from './helpers.js';

function options() {
  const value = fixtureAppOptions();
  value.projectConfigs[0].radars.push({ id: 'radar-2', name: '测试雷达 2', baseline: { ...value.projectConfigs[0].radars[0].baseline, bearingOffsetDeg: 23 } });
  value.readGroupDatasets = async (project, query, evidence) => query.radarIds.map((radarId) => {
    const data = createDemoDataset({ start: Date.parse(query.start), end: Date.parse(query.end), sourceIds: query.aisSourceIds });
    data.projectId = project.id; data.radarId = radarId; data.baseline = structuredClone(project.radars.find((radar) => radar.id === radarId).baseline);
    data.radar = data.radar.map((point) => ({ ...point, deviceId: radarId }));
    data.provenance = { ...data.provenance, ...evidence, query: { radarId, aisSourceIds: query.aisSourceIds, start: query.start, end: query.end } };
    return normalizeDataset(data);
  });
  return value;
}
const range = { start: DEMO_QUERY.start, end: '2026-11-10T02:00:08.000Z' };

test('前端请求可以创建和删除本地组，无请求体时不发送 JSON 类型', async (t) => {
  const dataDir = await temporaryDirectory(t); const app = await buildApp({ ...options(), dataDir, serveClient: false });
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const response = await app.inject({ method: init.method ?? 'GET', url: String(url), headers: Object.fromEntries(new Headers(init.headers)), payload: init.body });
    return new Response(response.body, { status: response.statusCode });
  });
  try {
    const before = await api('/groups');
    const group = await post('/groups', { projectId: 'demo', name: '前端组', radarIds: ['radar-demo-01'], aisSourceIds: ['ais-east'] });
    assert.deepEqual(await api(`/groups/${group.id}`, { method: 'DELETE' }), { removed: true });
    assert.equal((await api('/groups')).length, before.length);
  } finally { await app.close(); }
});

test('前端登记和匹配组为本地多对多实体，保存后重开不丢失', async (t) => {
  const dataDir = await temporaryDirectory(t); const settings = options();
  const app = await buildApp({ ...settings, dataDir, serveClient: false });
  let group;
  try {
    const initial = (await app.inject('/api/groups')).json();
    assert.deepEqual(initial[0].radarIds, ['radar-demo-01', 'radar-2']);
    const source = await app.inject({ method: 'POST', url: '/api/registry/demo/aisSources', payload: { id: 'ais-third', name: 'AIS C' } });
    assert.equal(source.statusCode, 201, source.body);
    const body = { projectId: 'demo', name: '多源组', radarIds: ['radar-demo-01', 'radar-2'], aisSourceIds: ['ais-east', 'ais-third'] };
    const created = await app.inject({ method: 'POST', url: '/api/groups', payload: body });
    assert.equal(created.statusCode, 201, created.body); group = created.json();
    const second = await app.inject({ method: 'POST', url: '/api/groups', payload: { ...body, name: '共享雷达组', radarIds: ['radar-2'], aisSourceIds: ['ais-third'] } });
    assert.equal(second.statusCode, 201);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/registry/demo/aisSources/ais-third' })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: '/api/groups', payload: { ...body, radarIds: ['unknown'] } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/groups', payload: { ...body, aisSourceIds: ['ais-east', 'ais-east'] } })).statusCode, 400);
    const update = await app.inject({ method: 'PUT', url: `/api/groups/${group.id}`, payload: { ...body, name: '修订组' } });
    assert.equal(update.json().revision, 2);
  } finally { await app.close(); }
  const reopened = await buildApp({ ...settings, dataDir, serveClient: false });
  try {
    const persisted = (await reopened.inject('/api/groups')).json().find((value) => value.id === group.id);
    assert.equal(persisted.name, '修订组'); assert.equal(persisted.revision, 2);
    assert.ok((await reopened.inject('/api/projects')).json()[0].aisSources.some((value) => value.id === 'ais-third'));
  } finally { await reopened.close(); }
});

test('匹配组生成同一时段的独立雷达快照，后续配置变更不改写历史', async (t) => {
  const dataDir = await temporaryDirectory(t); const app = await buildApp({ ...options(), dataDir, serveClient: false });
  try {
    const group = (await app.inject('/api/groups')).json()[0];
    const response = await app.inject({ method: 'POST', url: `/api/groups/${group.id}/query?format=full`, payload: { ...range, revision: group.revision } });
    assert.equal(response.statusCode, 200, response.body);
    const bundle = response.json();
    assert.equal(bundle.snapshots.length, 2); assert.equal(bundle.session.snapshotIds.length, 2);
    assert.notEqual(bundle.snapshots[0].hash, bundle.snapshots[1].hash);
    for (const snapshot of bundle.snapshots) {
      assert.equal(snapshot.sessionId, bundle.session.id); assert.equal(snapshot.dataset.provenance.group.id, group.id);
      assert.ok(snapshot.dataset.radar.every((point) => point.deviceId === snapshot.dataset.radarId));
      assert.deepEqual(snapshot.dataset.timeRange, range);
    }
    const update = await app.inject({ method: 'PUT', url: `/api/groups/${group.id}`, payload: { projectId: 'demo', name: '后续关联', radarIds: ['radar-2'], aisSourceIds: ['ais-west'] } });
    assert.equal(update.statusCode, 200);
    const old = await app.inject(`/api/sessions/${bundle.session.id}?format=full`);
    assert.deepEqual(old.json().session.aisSourceIds, ['ais-east', 'ais-west']);
    assert.equal(old.json().snapshots[0].hash, bundle.snapshots[0].hash);
    const stale = await app.inject({ method: 'POST', url: `/api/groups/${group.id}/query?format=full`, payload: { ...range, revision: 1 } });
    assert.equal(stale.statusCode, 409);
    await app.inject({ method: 'DELETE', url: `/api/groups/${group.id}` });
    assert.equal((await app.inject(`/api/sessions/${bundle.session.id}?format=full`)).statusCode, 200);
  } finally { await app.close(); }
});

test('组内任一查询或本地保存失败都不发布不完整会话', async (t) => {
  const dataDir = await temporaryDirectory(t); const settings = options(); const successful = settings.readGroupDatasets;
  let fail = true; settings.readGroupDatasets = async (...args) => { if (fail) throw new Error('某台雷达读取失败'); return successful(...args); };
  const app = await buildApp({ ...settings, dataDir, serveClient: false });
  try {
    const group = (await app.inject('/api/groups')).json()[0];
    const request = { method: 'POST', url: `/api/groups/${group.id}/query?format=full`, payload: range };
    assert.equal((await app.inject(request)).statusCode, 500);
    assert.equal((await app.inject('/api/snapshots')).json().length, 0);
    fail = false;
    app.store.db.exec("CREATE TEMP TRIGGER fail_second_snapshot BEFORE INSERT ON snapshot_metadata WHEN (SELECT count(*) FROM snapshot_metadata) = 1 BEGIN SELECT RAISE(ABORT, '模拟数据库写入失败'); END");
    assert.equal((await app.inject(request)).statusCode, 500);
    app.store.db.exec('DROP TRIGGER fail_second_snapshot');
    assert.equal((await app.inject('/api/sessions')).json().length, 0);
    assert.equal((await app.inject('/api/snapshots')).json().length, 0);
  } finally { await app.close(); }
});

test('产品不注册 Mock 项目，也不导入或展示旧 Mock 数据', async (t) => {
  const dataDir = await temporaryDirectory(t); const app = await buildApp({ dataDir, configPath: null, serveClient: false });
  try {
    assert.deepEqual((await app.inject('/api/projects')).json(), []);
    const data = createDemoDataset();
    assert.equal((await app.inject({ method: 'POST', url: '/api/snapshots/import?format=full', payload: data })).statusCode, 400);
    const old = await app.store.saveSnapshot(normalizeDataset(data));
    assert.deepEqual((await app.inject('/api/snapshots')).json(), []);
    assert.equal((await app.inject(`/api/snapshots/${old.id}?format=full`)).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/query?format=full', payload: DEMO_QUERY })).statusCode, 404);
  } finally { await app.close(); }
});

test('组回放按雷达身份分开，重复 AIS 去重，原始观测保持不变', () => {
  const data = normalizeDataset(createDemoDataset()).dataset;
  const a = { id: 'a', dataset: data }; const b = { id: 'b', dataset: structuredClone(data) }; b.dataset.radarId = 'radar-2';
  const copy = structuredClone([a, b]);
  const merged = mergeAisObservations([a, b]); assert.equal(merged.length, data.ais.length); assert.deepEqual([a, b], copy);
  const recent = [{ id: 'a', projectId: 'demo', radarId: 'radar-demo-01', aisSourceIds: ['ais-east'], summary: { start: 0, end: 10 } }, { id: 'b', projectId: 'demo', radarId: 'radar-2', aisSourceIds: ['ais-east'], summary: { start: 0, end: 10 } }, { id: 'wrong', projectId: 'demo', radarId: 'radar-2', aisSourceIds: ['ais-west'], summary: { start: 0, end: 10 } }];
  const group = { projectId: 'demo', radarIds: ['radar-demo-01', 'radar-2'], aisSourceIds: ['ais-east'] };
  assert.deepEqual(selectCachedGroup(group, recent).map((value) => value.id), ['a', 'b']);
  assert.deepEqual(selectCachedGroup(group, [{ ...recent[1], summary: { start: 1, end: 11 } }, recent[0]]), []);
  const queryArea = { west: 117, east: 118, south: 23, north: 24 };
  assert.deepEqual(selectCachedGroup(group, [{ ...recent[0], queryArea }, recent[1]]), []);
  assert.deepEqual(selectCachedGroup(group, recent.slice(0, 2).map((value) => ({ ...value, queryArea }))).map((value) => value.id), ['a', 'b']);
});
