import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodePlayback } from '../shared/playback.js';
import { normalizeDataset } from '../shared/data.js';
import { buildApp } from '../server/app.js';
import { fixtureAppOptions, testApp, waitForTask } from './helpers.js';
import { createDemoDataset, DEMO_START } from './fixtures/demo.js';
import { DEFAULT_FIT_OPTIONS } from '../shared/data.js';

const range = { start: new Date(DEMO_START).toISOString(), end: new Date(DEMO_START + 120000).toISOString() };
function settings() {
  const options = fixtureAppOptions(); options.projectConfigs[0].timeSemantics = 'event-time'; const state = { calls: 0, delta: 0, gate: null, rawByRadar: false };
  options.projectConfigs[0].radars.push({ id: 'radar-2', name: '第二台', baseline: { ...options.projectConfigs[0].radars[0].baseline, bearingOffsetDeg: 23 } });
  options.readGroupDatasets = async (project, query, evidence, signal) => {
    state.calls++;
    if (state.gate) await state.gate(signal);
    return query.radarIds.map(radarId => {
      const data = createDemoDataset({ start: Date.parse(query.start), end: Date.parse(query.end), sourceIds: query.aisSourceIds });
      data.projectId = project.id; data.radarId = radarId;
      data.baseline = { ...project.radars.find(value => value.id === radarId).baseline };
      data.radar = data.radar.map(point => ({ ...point, deviceId: radarId, rangeM: point.rangeM + state.delta }));
      if (state.rawByRadar) data.ais = data.ais.map(point => ({ ...point, raw: { ...point.raw, contextRadar: radarId } }));
      data.provenance = { ...data.provenance, configVersion: project.configVersion, aisSourceNames: Object.fromEntries(project.aisSources.map(value => [value.id, value.name])), radarConfiguration: project.radars.find(value => value.id === radarId), ...evidence, query: { radarId, aisSourceIds: query.aisSourceIds, ...range, queryArea: query.queryArea ?? null } };
      return normalizeDataset(data);
    });
  };
  return { options, state };
}
async function query(app, body = range, suffix = '') {
  const group = (await app.inject('/api/groups')).json()[0];
  const response = await app.inject({ method: 'POST', url: `/api/groups/${group.id}/query${suffix}`, payload: body });
  assert.equal(response.statusCode, 200, response.body.slice(0, 400));
  return { wire: response.json(), bundle: decodePlayback(response.json()), response, group };
}

test('普通查询仅保存结构化目录，回放使用共享 AIS 与独立原始详情，内存命中不重新查询', async t => {
  const { options, state } = settings(); const app = await testApp(t, options);
  state.rawByRadar = true;
  const { wire, bundle, response, group } = await query(app);
  assert.equal(wire.schemaVersion, 2); assert.equal(wire.aisSets.length, 1); assert.equal(bundle.snapshots.length, 2);
  assert.strictEqual(bundle.snapshots[0].dataset.ais, bundle.snapshots[1].dataset.ais);
  assert.equal(app.store.hasTable('records'), false); assert.equal(app.store.hasTable('settings'), false);
  for (const { name } of app.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    assert.equal(app.store.db.prepare(`PRAGMA table_info(${name})`).all().some(column => /payload|json/i.test(column.name)), false, name);
  }
  const record = app.store.worksets.get(bundle.snapshots[0].id);
  assert.equal(bundle.snapshots[0].dataset.radar.length, record.dataset.radar.length);
  assert.equal(bundle.snapshots[0].dataset.ais.length, record.dataset.ais.length);
  const publicPoint = ({ raw, ...point }) => point;
  const original = record.dataset.ais[0]; const displayed = bundle.snapshots[0].dataset.ais[0];
  assert.equal(displayed.headingDeg, original.headingDeg); assert.deepEqual(displayed.dimensions, original.dimensions);
  assert.equal(displayed.eventTime, original.eventTime); assert.deepEqual(displayed.position, original.position);
  const raw = await app.inject(`/api/snapshots/${record.id}/observations/ais/${encodeURIComponent(original.id)}`);
  assert.deepEqual(raw.json().raw, original.raw);
  assert.equal(displayed.raw.evidenceRef.snapshotIds.length, 2);
  const otherRaw = await app.inject(`/api/snapshots/${bundle.snapshots[1].id}/observations/ais/${encodeURIComponent(original.id)}`);
  const otherOriginal = app.store.worksets.get(bundle.snapshots[1].id).dataset.ais.find(point => point.id === original.id);
  assert.deepEqual(otherRaw.json().raw, otherOriginal.raw);
  assert.equal(JSON.stringify(otherRaw.json().raw).includes('radar-2'), true); assert.equal(JSON.stringify(raw.json().raw).includes('radar-demo-01'), true);
  assert.equal(response.body.includes('rawAisReports'), false); assert.ok(response.body.length < JSON.stringify(record).length * 2);
  const second = await app.inject({ method: 'POST', url: `/api/groups/${group.id}/query`, payload: range });
  assert.equal(second.statusCode, 200, second.body); assert.equal(state.calls, 1); assert.equal(second.json().session.id, bundle.session.id);
  assert.deepEqual(publicPoint(displayed).sourceIds, original.sourceIds);
});

test('释放后通过固定的历史成员回源；一致与改变的数据分别标记，旧记录和参数始终保留', async t => {
  const { options, state } = settings(); const app = await testApp(t, options);
  const { bundle, group } = await query(app); const snapshot = bundle.snapshots[0];
  await app.inject({ method: 'PUT', url: `/api/groups/${group.id}`, payload: { projectId: 'demo', name: '后续配置', radarIds: ['radar-2'], aisSourceIds: ['ais-west'] } });
  await app.inject({ method: 'PUT', url: '/api/registry/demo/aisSources/ais-east', payload: { id: 'ais-east', name: '修改后的来源名称' } });
  await app.inject({ method: 'POST', url: `/api/sessions/${bundle.session.id}/release`, payload: {} });
  assert.equal((await app.inject(`/api/snapshots/${snapshot.id}`)).statusCode, 410);
  const version = await app.inject({ method: 'POST', url: '/api/versions', payload: { name: '保留参数', snapshotId: snapshot.id, source: 'manual', parameters: snapshot.dataset.baseline } });
  assert.equal(version.statusCode, 201, version.body);
  const restored = await app.inject({ method: 'POST', url: `/api/sessions/${bundle.session.id}/load`, payload: {} });
  assert.equal(restored.statusCode, 200, restored.body.slice(0, 300));
  assert.equal(restored.json().reloadedFrom.changed, false);
  assert.notEqual(restored.json().session.id, bundle.session.id); assert.deepEqual(restored.json().session.radarIds, bundle.session.radarIds);
  assert.equal(restored.json().session.aisSourceNames['ais-east'], bundle.session.aisSourceNames['ais-east']);
  assert.equal((await app.inject('/api/versions')).json().length, 1);
  assert.equal((await app.inject('/api/sessions')).json().length, 2);
  state.delta = 1;
  const changed = await app.inject({ method: 'POST', url: `/api/sessions/${bundle.session.id}/load`, payload: {} });
  assert.equal(changed.statusCode, 200, changed.body.slice(0, 300)); assert.equal(changed.json().reloadedFrom.changed, true);
  assert.equal((await app.store.read('sessions', bundle.session.id)).fingerprint, bundle.session.fingerprint);
});

test('异步准备快速返回状态，等待期间列表与健康可读；取消不发布数据且可继续加载', async t => {
  const { options, state } = settings(); const app = await testApp(t, options);
  state.gate = signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  const group = (await app.inject('/api/groups')).json()[0];
  const response = await app.inject({ method: 'POST', url: `/api/groups/${group.id}/query?async=1`, payload: range });
  assert.equal(response.statusCode, 202); const id = response.json().id;
  for (const url of ['/api/health', '/api/projects', '/api/groups', '/api/snapshots', '/api/sessions', '/api/tasks']) assert.equal((await app.inject(url)).statusCode, 200, url);
  assert.equal((await app.inject(`/api/preparations/${id}`)).json().status, 'preparing');
  assert.equal((await app.inject({ method: 'POST', url: `/api/preparations/${id}/cancel`, payload: {} })).json().status, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await app.inject('/api/sessions')).json().length, 0); assert.equal(app.store.worksets.size, 0);
  state.gate = null;
  const retry = await app.inject({ method: 'POST', url: `/api/groups/${group.id}/query?async=1`, payload: range }); assert.equal(retry.statusCode, 202);
  const next = retry.json().id;
  for (let index = 0; index < 200; index++) { const current = (await app.inject(`/api/preparations/${next}`)).json(); if (current.status === 'completed') break; assert.notEqual(current.status, 'failed', current.error); await new Promise(resolve => setTimeout(resolve, 10)); }
  const result = await app.inject(`/api/preparations/${next}/result`); assert.equal(result.statusCode, 200, result.body.slice(0, 400)); assert.equal(result.json().schemaVersion, 2);
  const sessionId = result.json().session.id;
  await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/release`, payload: {} });
  state.gate = signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  const loading = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/load?async=1`, payload: {} }); assert.equal(loading.statusCode, 202);
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  const concurrent = await app.inject({ method: 'POST', url: `/api/groups/${group.id}/query`, payload: range }); assert.equal(concurrent.statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `/api/preparations/${loading.json().id}/cancel`, payload: {} })).json().status, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await app.inject('/api/sessions')).json().length, 1); assert.equal(app.store.worksets.size, 0);
});

test('显式归档保存到指定文件，重启后恢复原始摘要、原文和任务完整证据，损坏归档会被拒绝', async t => {
  const { options, state } = settings(); const app = await testApp(t, options); const { bundle } = await query(app);
  const snapshot = bundle.snapshots[0];
  const started = await app.inject({ method: 'POST', url: '/api/tasks', payload: { snapshotId: snapshot.id, options: DEFAULT_FIT_OPTIONS } }); assert.equal(started.statusCode, 202, started.body);
  const task = await waitForTask(app, started.json().id); assert.equal(task.status, 'completed', task.error);
  const archived = await app.inject({ method: 'POST', url: `/api/sessions/${bundle.session.id}/archive`, payload: { directory: path.join(app.store.directory, 'chosen-archive') } }); assert.equal(archived.statusCode, 200, archived.body);
  const file = archived.json().filePath; const bytes = await readFile(file);
  assert.ok(file.endsWith('.json.gz')); assert.ok(bytes.byteLength > 0); const dataDir = app.store.directory;
  app.store.release(bundle.session.id);
  const cached = await query(app); assert.equal(cached.bundle.session.id, bundle.session.id); assert.equal(state.calls, 1);
  await app.close();
  const reopened = await buildApp({ ...options, dataDir, serveClient: false });
  try {
    const loaded = await reopened.inject(`/api/sessions/${bundle.session.id}`); assert.equal(loaded.statusCode, 200, loaded.body.slice(0, 300));
    const restored = decodePlayback(loaded.json()); assert.equal(restored.snapshots[0].hash, snapshot.hash);
    const result = await reopened.inject(`/api/tasks/${task.id}`); assert.equal(result.json().result.heatmap.length, task.result.heatmap.length);
    const evidence = await reopened.inject(`/api/snapshots/${snapshot.id}/export`); assert.equal(evidence.json().hash, snapshot.hash); assert.ok(evidence.json().dataset.ais[0].raw);
    await writeFile(file, Buffer.from('broken archive')); reopened.store.release(bundle.session.id);
    const corrupt = await reopened.inject(`/api/sessions/${bundle.session.id}`); assert.equal(corrupt.statusCode, 409, corrupt.body);
    await writeFile(file, bytes);
  } finally { await reopened.close(); }
});

test('列表只读元数据并稳定分页；历史数和大原文不会导致解包正文', async t => {
  const app = await testApp(t); const data = normalizeDataset(createDemoDataset({ end: DEMO_START + 4000 }));
  const record = app.store.snapshot(data);
  app.store.transaction(() => { for (let index = 0; index < 61; index++) app.store.writeSnapshotMeta({ ...record, id: randomUUID(), createdAt: '2026-11-10T02:00:00.000Z' }); });
  const all = new Set(); let cursor = null;
  t.mock.method(app.store, 'read', () => { throw new Error('列表不能读取正文'); });
  do {
    const response = await app.inject(`/api/snapshots?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(response.statusCode, 200, response.body); assert.ok(response.json().length <= 10);
    for (const item of response.json()) { assert.equal(all.has(item.id), false); all.add(item.id); assert.equal(Object.hasOwn(item, 'dataset'), false); }
    cursor = response.headers['x-next-cursor'] ?? null;
  } while (cursor);
  assert.equal(all.size, 61); assert.equal((await app.inject('/api/snapshots?cursor=broken')).statusCode, 400);
});

test('任务保留完整输入直到结束，切换工作集后进度与参数仍可读取', async t => {
  const { options } = settings(); const app = await testApp(t, options); const { bundle } = await query(app); const previous = bundle.snapshots[0];
  const result = await app.inject({ method: 'POST', url: '/api/tasks', payload: { snapshotId: previous.id, options: DEFAULT_FIT_OPTIONS } }); assert.equal(result.statusCode, 202, result.body);
  await query(app, { ...range, forceReload: true });
  assert.equal((await app.inject(`/api/snapshots/${previous.id}`)).statusCode, 410);
  const task = await waitForTask(app, result.json().id); assert.equal(task.status, 'completed', task.error); assert.equal(task.result.snapshotHash, previous.hash);
  const version = await app.inject({ method: 'POST', url: '/api/versions', payload: { name: '任务候选', source: 'task', snapshotId: previous.id, taskId: task.id, candidateIndex: 0, parameters: task.result.candidates[0].parameters } }); assert.equal(version.statusCode, 201, version.body);
  assert.equal((await app.inject('/api/tasks')).json().length, 1);
});
