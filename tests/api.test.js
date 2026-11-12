import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../server/app.js';
import { SqliteStore } from '../server/storage.js';
import { DEFAULT_FIT_OPTIONS, MAX_IMPORT_POINTS } from '../shared/data.js';
import { createDemoDataset } from './fixtures/demo.js';
import { DEMO_QUERY, fixtureAppOptions, queryDemo, temporaryDirectory, testApp, waitForTask } from './helpers.js';

test('查询半开时间范围和可选 AIS 来源，导出内容可重新导入', async (t) => {
  const app = await testApp(t);
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  const response = await app.inject({ method: 'POST', url: '/api/query?format=full', payload: { ...DEMO_QUERY, end: '2026-11-10T02:00:04.000Z', aisSourceIds: ['ais-west'] } });
  assert.equal(response.statusCode, 200);
  const snapshot = response.json();
  assert.equal(snapshot.summary.radarPoints, 8); assert.equal(snapshot.summary.aisPoints, 3);
  assert.ok(snapshot.dataset.ais.every((p) => p.sourceIds.join() === 'ais-west'));
  assert.ok(snapshot.dataset.radar.every((p) => p.eventTime === DEMO_QUERY.start));
  const exported = await app.inject(`/api/snapshots/${snapshot.id}/export`);
  assert.match(exported.headers['content-disposition'], /attachment/);
  const imported = await app.inject({ method: 'POST', url: '/api/snapshots/import?format=full', payload: exported.json() });
  assert.equal(imported.statusCode, 200);
  assert.equal(imported.json().hash, snapshot.hash);
  assert.equal((await app.inject('/api/snapshots')).json().length, 2);
});

test('独立静态尺寸随快照保存、导出和重新导入，保持摘要及原始证据', async (t) => {
  const app = await testApp(t);
  const raw = createDemoDataset({ end: Date.parse(DEMO_QUERY.start) + 4000, sourceIds: ['ais-east'] });
  const point = raw.ais[0];
  raw.aisStatic = [{ id: 'static-report', sourceIds: ['ais-east'], mmsi: point.mmsi, eventTime: point.eventTime, messageType: '5', mappingVersion: 'test-static-v1', raw: { message: 'static-evidence' }, dimensions: { ...point.dimensions, sourceId: 'ais-east' } }];
  const created = await app.inject({ method: 'POST', url: '/api/snapshots/import?format=full', payload: raw });
  assert.equal(created.statusCode, 200, created.body);
  const snapshot = created.json();
  const exported = (await app.inject(`/api/snapshots/${snapshot.id}/export`)).json();
  assert.equal(exported.dataset.aisStatic[0].raw.message, 'static-evidence');
  const imported = await app.inject({ method: 'POST', url: '/api/snapshots/import?format=full', payload: exported });
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(imported.json().hash, snapshot.hash);
  assert.deepEqual(imported.json().dataset.aisStatic, snapshot.dataset.aisStatic);
});

test('数据隔离和输入错误通过接口明确暴露', async (t) => {
  const app = await testApp(t);
  for (const change of [{ radarId: 'unknown' }, { projectId: 'unknown' }, { aisSourceIds: ['unknown'] }, { start: '2026-11-10 02:00:00' }, { end: DEMO_QUERY.start }, { end: '2026-11-09T02:00:00.000Z' }]) {
    const response = await app.inject({ method: 'POST', url: '/api/query?format=full', payload: { ...DEMO_QUERY, ...change } });
    assert.ok(response.statusCode >= 400 && response.statusCode < 500, response.body);
    assert.equal(typeof response.json().error, 'string');
  }
  assert.equal((await app.inject('/api/snapshots/invalid')).statusCode, 400);
  assert.equal((await app.inject('/api/not-a-route')).statusCode, 404);
  const raw = createDemoDataset(); raw.unitsVerified = false;
  const snapshot = (await app.inject({ method: 'POST', url: '/api/snapshots/import?format=full', payload: raw })).json();
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks', payload: { snapshotId: snapshot.id, options: DEFAULT_FIT_OPTIONS } })).statusCode, 400);
  const oversized = await app.inject({ method: 'POST', url: '/api/snapshots/import?format=full', payload: { radar: Array(MAX_IMPORT_POINTS + 1).fill(null), ais: [] } });
  assert.equal(oversized.statusCode, 400);
  assert.match(oversized.json().error, /导入总观测数/);
  const staticOversized = await app.inject({ method: 'POST', url: '/api/snapshots/import?format=full', payload: { radar: [], ais: [], aisStatic: Array(MAX_IMPORT_POINTS + 1).fill(null) } });
  assert.equal(staticOversized.statusCode, 400);
  assert.match(staticOversized.json().error, /导入总观测数/);
});

test('自动任务实际完成、证据可导出、保存版本使用服务器候选', async (t) => {
  const app = await testApp(t);
  const snapshot = await queryDemo(app);
  const response = await app.inject({ method: 'POST', url: '/api/tasks', payload: { snapshotId: snapshot.id, options: DEFAULT_FIT_OPTIONS } });
  assert.equal(response.statusCode, 202, response.body);
  const task = await waitForTask(app, response.json().id);
  assert.equal(task.status, 'completed', task.error);
  assert.equal(task.result.snapshotHash, snapshot.hash);
  assert.equal(task.progress.fraction, 1);
  const exported = await app.inject(`/api/tasks/${task.id}/export`);
  assert.equal(exported.json().result.modelVersion, task.result.modelVersion);
  const version = await app.inject({ method: 'POST', url: '/api/versions', payload: { snapshotId: snapshot.id, name: '自动恢复', source: 'task', taskId: task.id, candidateIndex: 0, parameters: { lng: 0, lat: 0, bearingOffsetDeg: 0 }, effectiveFrom: DEMO_QUERY.start } });
  assert.equal(version.statusCode, 201, version.body);
  assert.deepEqual(version.json().parameters, task.result.candidates[0].parameters);
  assert.equal(version.json().snapshotHash, snapshot.hash);
  assert.deepEqual((await app.inject(`/api/snapshots/${snapshot.id}?format=full`)).json().dataset.baseline, snapshot.dataset.baseline);
  assert.equal((await app.inject('/api/versions?projectId=other')).json().length, 0);
});

test('运行任务可取消，重复启动受控，取消后不被迟到结果覆盖', async (t) => {
  const app = await testApp(t);
  const snapshot = await queryDemo(app);
  const payload = { snapshotId: snapshot.id, options: { ...DEFAULT_FIT_OPTIONS, maxFitPoints: 1000 } };
  const response = await app.inject({ method: 'POST', url: '/api/tasks', payload });
  const id = response.json().id;
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks', payload })).statusCode, 409);
  const cancelled = await app.inject({ method: 'POST', url: `/api/tasks/${id}/cancel`, payload: {} });
  assert.equal(cancelled.json().status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await app.inject(`/api/tasks/${id}`)).json().status, 'cancelled');
  assert.equal((await app.store.read('tasks', id)).status, 'cancelled');
});

test('失败任务返回原因；证据不足的自动候选不可设为生效版本', async (t) => {
  const app = await testApp(t);
  const raw = createDemoDataset();
  raw.ais = raw.ais.filter((p) => p.mmsi === '413000101');
  raw.radar = raw.radar.filter((p) => p.id.startsWith('radar-0-'));
  const snapshot = (await app.inject({ method: 'POST', url: '/api/snapshots/import?format=full', payload: raw })).json();
  const start = await app.inject({ method: 'POST', url: '/api/tasks', payload: { snapshotId: snapshot.id, options: DEFAULT_FIT_OPTIONS } });
  const task = await waitForTask(app, start.json().id);
  assert.equal(task.result.assessment, 'insufficient');
  const payload = { snapshotId: snapshot.id, name: '低支持候选', source: 'task', taskId: task.id, candidateIndex: 0, parameters: task.result.candidates[0].parameters };
  assert.equal((await app.inject({ method: 'POST', url: '/api/versions', payload: { ...payload, effectiveFrom: DEMO_QUERY.start } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/versions', payload })).statusCode, 201);
  const failureStart = await app.inject({ method: 'POST', url: '/api/tasks', payload: { snapshotId: snapshot.id, options: { ...DEFAULT_FIT_OPTIONS, maxGapMs: 0, roi: { minEast: -100, maxEast: 100, minNorth: -100, maxNorth: 100 } } } });
  const failed = await waitForTask(app, failureStart.json().id);
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /对齐/);
});

test('临时观测重启后需回源，参数版本保留，运行状态标记中断', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const app = await buildApp({ dataDir, serveClient: false, ...fixtureAppOptions() });
  const snapshot = await queryDemo(app);
  await app.inject({ method: 'POST', url: '/api/versions', payload: { snapshotId: snapshot.id, name: '手动候选', source: 'manual', parameters: snapshot.dataset.baseline } });
  await app.close();
  const store = new SqliteStore(dataDir);
  await store.init();
  const id = '00000000-0000-4000-8000-000000000001';
  await store.write('tasks', { id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'running', snapshotId: snapshot.id });
  store.close();
  const reopened = await buildApp({ dataDir, serveClient: false, ...fixtureAppOptions() });
  try {
    assert.equal((await reopened.inject(`/api/snapshots/${snapshot.id}?format=full`)).statusCode, 410);
    assert.equal((await reopened.inject('/api/versions')).json().length, 1);
    const task = (await reopened.inject(`/api/tasks/${id}`)).json();
    assert.equal(task.status, 'interrupted'); assert.match(task.error, /重启/);
  } finally { await reopened.close(); }
});

test('写入被修改的临时快照时拒绝不匹配的摘要', async (t) => {
  const app = await testApp(t);
  const snapshot = await queryDemo(app);
  snapshot.dataset.radar[0].rangeM += 100;
  await assert.rejects(app.store.write('snapshots', snapshot), /SHA-256/);
  const response = await app.inject(`/api/snapshots/${snapshot.id}?format=full`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().hash, snapshot.hash);
});

test('改动设置后复用已查看时段会标记证据不足，不冒充新独立验证', async (t) => {
  const app = await testApp(t);
  const snapshot = await queryDemo(app);
  const firstStart = await app.inject({ method: 'POST', url: '/api/tasks', payload: { snapshotId: snapshot.id, options: DEFAULT_FIT_OPTIONS } });
  const first = await waitForTask(app, firstStart.json().id);
  assert.equal(first.result.validationReused, false);
  const secondStart = await app.inject({ method: 'POST', url: '/api/tasks', payload: { snapshotId: snapshot.id, options: { ...DEFAULT_FIT_OPTIONS, backgroundPrior: 0.3 } } });
  const second = await waitForTask(app, secondStart.json().id);
  assert.equal(second.status, 'completed');
  assert.equal(second.result.validationReused, true);
  assert.equal(second.result.assessment, 'insufficient');
  assert.deepEqual(second.result.validationPreviousTasks, [first.id]);
});
