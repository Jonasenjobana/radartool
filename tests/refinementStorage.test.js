import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app.js';
import { DEFAULT_FIT_OPTIONS, DEFAULT_REFINEMENT_OPTIONS } from '../shared/data.js';
import { DEMO_TRUTH } from './fixtures/demo.js';
import { DEMO_QUERY, fixtureAppOptions, queryDemo, temporaryDirectory, testApp, waitForTask } from './helpers.js';

test('精调任务未完成关联检查时由提交接口明确拒绝', async t => {
  const app = await testApp(t);
  const snapshot = await queryDemo(app);
  for (const associationIds of [null, [], undefined]) {
    const response = await app.inject({ method: 'POST', url: '/api/tasks', payload: {
      snapshotId: snapshot.id,
      options: { ...DEFAULT_FIT_OPTIONS, refinement: { ...DEFAULT_REFINEMENT_OPTIONS, initial: snapshot.dataset.baseline, associationIds } },
    } });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().error, /关联检查/);
  }
  assert.equal((await app.inject('/api/tasks')).json().length, 0);
});

test('精调任务关闭服务后按原样恢复冻结初值、门限、排除区与人工保留关联', async t => {
  const dataDir = await temporaryDirectory(t);
  const app = await buildApp({ dataDir, serveClient: false, ...fixtureAppOptions() });
  const snapshot = await queryDemo(app);
  const options = {
    ...DEFAULT_FIT_OPTIONS,
    refinement: {
      initial: { lng: 122.123, lat: 30.121, bearingOffsetDeg: 359.5 },
      maxDistanceM: 350, maxPositionShiftM: 80, maxBearingShiftDeg: 3.5,
      minTrackPoints: 6, minTrackDurationMs: 18000, motionToleranceM: 45,
      radarExclusion: { minEast: -20, maxEast: 35, minNorth: 10, maxNorth: 60 },
      associationIds: ['["radar-demo-01","track-b","413000102"]', '["radar-demo-01","track-a","413000101"]'],
    },
  };
  let task;
  try {
    const response = await app.inject({ method: 'POST', url: '/api/tasks', payload: { snapshotId: snapshot.id, options } });
    assert.equal(response.statusCode, 202, response.body);
    task = response.json();
    const cancelled = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/cancel`, payload: {} });
    assert.equal(cancelled.json().status, 'cancelled');
  } finally { await app.close(); }
  const reopened = await buildApp({ dataDir, serveClient: false, ...fixtureAppOptions() });
  try {
    const restored = await reopened.inject(`/api/tasks/${task.id}`);
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json().options, options);
    assert.equal(restored.json().status, 'cancelled');
  } finally { await reopened.close(); }
});

test('重启中断保留关联未检查、人工清空与旧模式三种不同输入状态', async t => {
  const dataDir = await temporaryDirectory(t);
  const app = await buildApp({ dataDir, serveClient: false, ...fixtureAppOptions() });
  const snapshot = await queryDemo(app);
  const tasks = [null, { ...DEFAULT_REFINEMENT_OPTIONS, initial: snapshot.dataset.baseline }, { ...DEFAULT_REFINEMENT_OPTIONS, initial: snapshot.dataset.baseline, associationIds: [] }].map(refinement => ({
    id: randomUUID(), snapshotId: snapshot.id, createdAt: DEMO_QUERY.start,
    status: 'running', options: { ...DEFAULT_FIT_OPTIONS, refinement },
  }));
  try { for (const task of tasks) await app.store.write('tasks', task); } finally { await app.close(); }
  const reopened = await buildApp({ dataDir, serveClient: false, ...fixtureAppOptions() });
  try {
    for (const task of tasks) {
      const response = await reopened.inject(`/api/tasks/${task.id}`);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().status, 'interrupted');
      assert.deepEqual(response.json().options, task.options);
    }
  } finally { await reopened.close(); }
});

test('精调初值的训练和验证完整指标在重启后可读并可导出', async t => {
  const dataDir = await temporaryDirectory(t);
  const app = await buildApp({ dataDir, serveClient: false, ...fixtureAppOptions() });
  const snapshot = await queryDemo(app);
  const options = { ...DEFAULT_FIT_OPTIONS, refinement: { ...DEFAULT_REFINEMENT_OPTIONS, initial: snapshot.dataset.baseline, associationIds: ['["radar-demo-01","track-a","413000101"]'] } };
  const initialMetrics = {
    training: {
      points: 90, alignedPoints: 87, matchedPoints: 70, ships: 2, tracks: 3,
      support: 0.8, background: 0.2, score: -620.5, residualP50: 12, residualP90: 28, residualP95: 34,
      groups: [
        { dimension: 'ship', key: '413000101', points: 50, matched: 40, background: 0.2, p90: 25 },
        { dimension: 'track', key: 'track-a', points: 40, matched: 30, background: 0.25, p90: 31 },
      ],
    },
    validation: {
      points: 30, alignedPoints: 28, matchedPoints: 0, ships: 2, tracks: 2,
      support: 0, background: 1, score: -310.25, residualP50: null, residualP90: null, residualP95: null,
      groups: [{ dimension: 'ship', key: '413000101', points: 30, matched: 0, background: 1, p90: null }],
    },
  };
  const task = {
    id: randomUUID(), snapshotId: snapshot.id, snapshotHash: snapshot.hash, createdAt: DEMO_QUERY.start,
    status: 'completed', options,
    result: {
      assessment: 'insufficient', reasons: ['独立保留时段无稳定支持'], candidates: [], initialMetrics,
      splitTime: '2026-11-10T02:07:00.000Z', evaluations: 15, studyRegion: options.bounds, options,
      exclusions: { radarExclusion: 2, notNear: 8 }, heatmap: [], angleProfile: [],
      modelVersion: 'body-background-v1', samplingVersion: 'balanced-v1', snapshotHash: snapshot.hash,
    },
  };
  try { await app.store.write('tasks', task); } finally { await app.close(); }
  const reopened = await buildApp({ dataDir, serveClient: false, ...fixtureAppOptions() });
  try {
    const restored = await reopened.inject(`/api/tasks/${task.id}`);
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json().result.initialMetrics, initialMetrics);
    const exported = await reopened.inject(`/api/tasks/${task.id}/export`);
    assert.equal(exported.statusCode, 200, exported.body);
    assert.deepEqual(exported.json().result.initialMetrics, initialMetrics);
    const candidate = { parameters: options.refinement.initial, east: 0, north: 0, onBoundary: false, iterations: 3, training: { ...initialMetrics.training, score: -450 }, validation: { ...initialMetrics.validation, score: -280 } };
    await reopened.store.write('tasks', { ...task, result: { ...task.result, candidates: [candidate] } });
    const version = await reopened.inject({ method: 'POST', url: '/api/versions', payload: { snapshotId: snapshot.id, name: '精调证据', source: 'task', taskId: task.id, candidateIndex: 0, parameters: candidate.parameters } });
    assert.equal(version.statusCode, 201, version.body);
    assert.deepEqual(version.json().evidence.initialMetrics, initialMetrics);
    const saved = await reopened.store.read('versions', version.json().id);
    assert.deepEqual(saved.evidence.initialMetrics, initialMetrics);
    assert.deepEqual(saved.evidence.options, options);
  } finally { await reopened.close(); }
});

test('旧任务未启用精调时省略 refinement 与显式 null 不构成不同验证设置', async t => {
  const app = await testApp(t);
  const snapshot = await queryDemo(app);
  const { refinement, ...legacyOptions } = DEFAULT_FIT_OPTIONS;
  await app.store.write('tasks', {
    id: randomUUID(), snapshotId: snapshot.id, createdAt: DEMO_QUERY.start,
    status: 'completed', options: legacyOptions,
    dataRange: { start: snapshot.summary.start, end: snapshot.summary.end },
  });
  const response = await app.inject({ method: 'POST', url: '/api/tasks', payload: { snapshotId: snapshot.id, options: DEFAULT_FIT_OPTIONS } });
  assert.equal(response.statusCode, 202, response.body);
  const task = await waitForTask(app, response.json().id);
  assert.equal(task.status, 'completed', task.error);
  assert.deepEqual(task.validationPreviousTasks, []);
  assert.equal(task.result.validationReused, false);
});

test('人工保留关联的顺序与重复项不改变精调验证设置', async t => {
  const app = await testApp(t);
  const snapshot = await queryDemo(app);
  const first = '["radar-demo-01","T1-0-b","413000101"]';
  const second = '["radar-demo-01","T2-0-b","413000202"]';
  const options = { ...DEFAULT_FIT_OPTIONS, maxFitPoints: 60, maxValidationPoints: 30, maxIterations: 3, keepCandidates: 2, refinement: { ...DEFAULT_REFINEMENT_OPTIONS, initial: DEMO_TRUTH, associationIds: [first, second] } };
  await app.store.write('tasks', {
    id: randomUUID(), snapshotId: snapshot.id, createdAt: DEMO_QUERY.start,
    status: 'completed', options, dataRange: { start: snapshot.summary.start, end: snapshot.summary.end },
  });
  const response = await app.inject({ method: 'POST', url: '/api/tasks', payload: { snapshotId: snapshot.id, options: { ...options, refinement: { ...options.refinement, associationIds: [second, first, first] } } } });
  assert.equal(response.statusCode, 202, response.body);
  const task = await waitForTask(app, response.json().id);
  assert.equal(task.status, 'completed', task.error);
  assert.deepEqual(task.validationPreviousTasks, []);
  assert.equal(task.result.validationReused, false);
});
