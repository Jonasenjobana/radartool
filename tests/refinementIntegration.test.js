import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../server/app.js';
import { DEFAULT_FIT_OPTIONS, DEFAULT_REFINEMENT_OPTIONS } from '../shared/data.js';
import { angleDifference, enuToWgs84, wgs84ToEnu } from '../shared/geo.js';
import { selectRefinementObservations } from '../shared/refinement.js';
import { DEMO_REFERENCE, DEMO_TRUTH } from './fixtures/demo.js';
import { fixtureAppOptions, queryDemo, temporaryDirectory, waitForTask } from './helpers.js';

test('人工检查后的精调完成真实任务并在重启后保留结果、导出与版本证据', async t => {
  let app;
  t.after(async () => app?.close());
  const dataDir = await temporaryDirectory(t);
  app = await buildApp({ dataDir, serveClient: false, ...fixtureAppOptions() });
  const snapshot = await queryDemo(app);
  const originalDataset = structuredClone(snapshot.dataset);
  // 当前人工粗调已靠近已知合成真值，快照仍保留查询时较远的参考参数。
  const initial = { ...enuToWgs84({ east: 58, north: -15 }, DEMO_REFERENCE), bearingOffsetDeg: 348.2 };
  const options = {
    ...DEFAULT_FIT_OPTIONS,
    bounds: { minEast: -250, maxEast: 250, minNorth: -250, maxNorth: 250 },
    positionStepM: 20, angleStepDeg: 1,
    maxFitPoints: 120, maxValidationPoints: 60, maxIterations: 8, keepCandidates: 2,
    refinement: { ...DEFAULT_REFINEMENT_OPTIONS, initial, maxPositionShiftM: 40, maxBearingShiftDeg: 2 },
  };
  const preview = selectRefinementObservations(snapshot.dataset, options);
  assert.ok(preview.associations.some(row => row.id === '["radar-demo-01","T1-0-b","413000101"]'));
  assert.ok(preview.associations.some(row => row.mmsi === '413000303'));
  options.refinement.associationIds = preview.associations.filter(row => row.mmsi !== '413000303').map(row => row.id);
  const selected = selectRefinementObservations(snapshot.dataset, options);
  assert.ok(selected.exclusions.notNearbyPoints > 0);
  assert.ok(selected.exclusions.manuallyExcludedPoints > 0);
  assert.ok(selected.training.length > options.maxFitPoints);
  assert.ok(selected.validation.length > options.maxValidationPoints);
  assert.ok([...selected.training, ...selected.validation].every(row => row.ship.mmsi !== '413000303'));
  assert.deepEqual(snapshot.dataset, originalDataset);
  const submittedOptions = structuredClone(options);

  const created = await app.inject({ method: 'POST', url: '/api/tasks', payload: { snapshotId: snapshot.id, options } });
  assert.equal(created.statusCode, 202, created.body);
  const task = await waitForTask(app, created.json().id);
  assert.equal(task.status, 'completed', task.error);
  assert.equal(task.snapshotHash, snapshot.hash);
  assert.equal(task.result.samplingVersion, 'ais-guided-track-time-balanced-chronological-v1');
  assert.deepEqual(task.options, submittedOptions);
  assert.equal(task.result.splitTime, '2026-11-10T02:07:00.000Z');
  for (const [key, value] of Object.entries(selected.exclusions)) assert.equal(task.result.exclusions[key], value, key);
  assert.equal(task.result.exclusions.totalRadarPoints, 1200);
  assert.equal(task.result.initialMetrics.training.points, 120);
  assert.equal(task.result.initialMetrics.validation.points, 60);
  assert.ok(Math.abs(task.result.options.bounds.minEast - 18) < 1e-6);
  assert.ok(Math.abs(task.result.options.bounds.maxEast - 98) < 1e-6);
  assert.ok(Math.abs(task.result.options.bounds.minNorth + 55) < 1e-6);
  assert.ok(Math.abs(task.result.options.bounds.maxNorth - 25) < 1e-6);
  assert.equal(task.result.exclusions.trainUnsampled, selected.training.length - 120);
  assert.equal(task.result.exclusions.validationUnsampled, selected.validation.length - 60);
  assert.ok(task.result.candidates.length > 0);
  const truth = wgs84ToEnu(DEMO_TRUTH, DEMO_REFERENCE);
  const best = task.result.candidates[0];
  assert.ok(Math.hypot(best.east - truth.east, best.north - truth.north) < 12, JSON.stringify(best.parameters));
  assert.ok(Math.abs(angleDifference(best.parameters.bearingOffsetDeg, DEMO_TRUTH.bearingOffsetDeg)) < 0.5);
  assert.ok(best.training.score > task.result.initialMetrics.training.score);
  for (const candidate of task.result.candidates) {
    assert.equal(candidate.training.points, 120);
    assert.equal(candidate.validation.points, 60);
    assert.ok(Math.abs(candidate.east - 58) <= 40.000001 && Math.abs(candidate.north + 15) <= 40.000001);
    assert.ok(Math.abs(angleDifference(candidate.parameters.bearingOffsetDeg, initial.bearingOffsetDeg)) <= 2.000001);
  }
  assert.deepEqual(options, submittedOptions);
  const unchanged = await app.inject(`/api/snapshots/${snapshot.id}/export`);
  assert.equal(unchanged.statusCode, 200, unchanged.body);
  assert.equal(unchanged.json().hash, snapshot.hash);
  assert.deepEqual(unchanged.json().dataset, originalDataset);
  assert.deepEqual((await app.inject('/api/versions')).json(), []);

  await app.close();
  app = await buildApp({ dataDir, serveClient: false, ...fixtureAppOptions() });
  const restoredResponse = await app.inject(`/api/tasks/${task.id}`);
  assert.equal(restoredResponse.statusCode, 200, restoredResponse.body);
  const restored = restoredResponse.json();
  assert.equal(restored.status, 'completed');
  assert.deepEqual(restored.options, submittedOptions);
  assert.deepEqual(restored.result.options.bounds, task.result.options.bounds);
  assert.deepEqual(restored.result.initialMetrics, task.result.initialMetrics);
  assert.deepEqual(restored.result.candidates, task.result.candidates);
  assert.deepEqual(restored.result.exclusions, task.result.exclusions);
  const exported = await app.inject(`/api/tasks/${task.id}/export`);
  assert.equal(exported.statusCode, 200, exported.body);
  assert.deepEqual(exported.json().options, submittedOptions);
  assert.deepEqual(exported.json().result.options.bounds, task.result.options.bounds);
  assert.deepEqual(exported.json().result.initialMetrics, task.result.initialMetrics);
  assert.deepEqual(exported.json().result.candidates, task.result.candidates);

  const saved = await app.inject({ method: 'POST', url: '/api/versions', payload: {
    snapshotId: snapshot.id, source: 'task', taskId: task.id, candidateIndex: 0,
    name: '已检查关联的精调候选', parameters: best.parameters,
  } });
  assert.equal(saved.statusCode, 201, saved.body);
  const version = saved.json();
  assert.equal(version.taskId, task.id);
  assert.equal(version.snapshotHash, snapshot.hash);
  assert.deepEqual(version.parameters, best.parameters);
  assert.deepEqual(version.evidence.options, submittedOptions);
  assert.deepEqual(version.evidence.initialMetrics, task.result.initialMetrics);
  assert.equal(version.effectiveFrom, null);

  await app.close();
  app = await buildApp({ dataDir, serveClient: false, ...fixtureAppOptions() });
  const versions = (await app.inject('/api/versions')).json();
  assert.equal(versions.length, 1);
  assert.equal(versions[0].id, version.id);
  assert.equal(versions[0].taskId, task.id);
  assert.deepEqual(versions[0].parameters, best.parameters);
  assert.equal(versions[0].evidence.modelVersion, task.result.modelVersion);
  // 版本目录仅返回摘要；完整初值证据仍通过关联任务接口和导出读取。
  assert.equal(versions[0].evidence.initialMetrics, undefined);
  const versionTask = (await app.inject(`/api/tasks/${versions[0].taskId}`)).json();
  assert.deepEqual(versionTask.result.initialMetrics, task.result.initialMetrics);
});
