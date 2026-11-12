import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as vue from 'vue';
import ts from 'typescript';
import { normalizeDataset } from '../shared/data.js';
import { aisAtTime, createAisIndex } from '../shared/alignment.js';
import { enuToWgs84, moveParameters, normalizeAngle, parameterDifference, polarToEnu, wgs84ToEnu } from '../shared/geo.js';
import { createDemoDataset, DEMO_START } from './fixtures/demo.js';

const compile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const workbenchUrl = new URL('../client/useWorkbench.ts', import.meta.url);
const requireWorkbench = createRequire(workbenchUrl);
const workbenchExports = {};
let apiRead = async () => [];
let apiPost = async () => { throw new Error('未配置的测试请求'); };
// 使用实际 composable 和 Vue 响应式状态，跳过需要页面挂载的初始化与定时器。
runInNewContext(compile(readFileSync(workbenchUrl, 'utf8')), {
  exports: workbenchExports,
  require: (name) => name === 'vue' ? { ...vue, onMounted() {}, onUnmounted() {} } : name === './api' ? { api: (...args) => apiRead(...args), post: (...args) => apiPost(...args), toInputTime: (time) => new Date(time).toISOString() } : requireWorkbench(name),
  setTimeout,
});

function loadFunctions(file, names, context) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8').split('<script setup lang="ts">').at(-1).split('</script>')[0];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(functions.length, names.length, '交互函数必须来自当前组件源码');
  return runInNewContext(compile(`${functions.map((node) => node.getText(ast)).join('\n')}\nconst handlers = { ${names.join(', ')} };`) + '\nhandlers;', context);
}

class Element {
  constructor(selectors = []) { this.selectors = new Set(selectors); }
  closest(selector) { return selector.split(',').some((value) => this.selectors.has(value.trim())) ? this : null; }
}
function keyboardEvent(key, options = {}) {
  return { key, target: new Element(), preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...options };
}
function workbench() {
  const state = workbenchExports.useWorkbench();
  state.snapshots.value = [
    { id: 'first', summary: { start: 0, end: 5001 }, dataset: { radar: [{ timeMs: 1000 }, { timeMs: 2000 }], ais: [{ timeMs: 1500 }, { timeMs: 2000 }], aisStatic: [{ timeMs: 2500 }] } },
    { id: 'second', summary: { start: 0, end: 5001 }, dataset: { radar: [{ timeMs: 1500 }, { timeMs: 2000 }], ais: [] } },
  ];
  state.snapshot.value = state.snapshots.value[0];
  return vue.reactive(state);
}
function appHandlers(w = workbench()) {
  const context = { w, HTMLElement: Element, Event, document: {}, page: vue.ref('debug') };
  for (const name of ['targetsOpen', 'sourceOpen', 'historyOpen', 'advancedOpen', 'versionOpen', 'evidenceOpen']) context[name] = vue.ref(false);
  return { ...context, ...loadFunctions('../client/App.vue', ['togglePlayback', 'playbackKeydown', 'adjustBearing'], context) };
}

test('逐帧按组内真实观测时刻去重，包含 AIS 静态报告，前后切换均暂停且不越界', () => {
  const w = workbench();
  for (const time of [1000, 1500, 2000, 2500, 5000, 5000]) {
    w.playing = true; w.stepFrame(1);
    assert.equal(w.cursor, time); assert.equal(w.playing, false);
  }
  for (const time of [2500, 2000, 1500, 1000, 0, 0]) { w.stepFrame(-1); assert.equal(w.cursor, time); }
  w.cursor = 1750.5; w.stepFrame(-1); assert.equal(w.cursor, 1500);
  w.cursor = 1750.5; w.stepFrame(1); assert.equal(w.cursor, 2000);
  w.busy = true; w.stepFrame(1); assert.equal(w.cursor, 2000);
  w.busy = false; w.snapshot = null; w.stepFrame(-1); assert.equal(w.cursor, 2000);
});

test('换数据后帧时刻重建，空观测保留请求首尾边界', () => {
  const w = workbench(); w.stepFrame(1);
  const value = { id: 'replacement', summary: { start: 0, end: 4001 }, dataset: { radar: [{ timeMs: 3000 }], ais: [] } };
  w.snapshots = [value]; w.snapshot = value; w.stepFrame(1); assert.equal(w.cursor, 3000);
  w.snapshots = [{ ...value, dataset: { radar: [], ais: [] } }];
  w.stepFrame(1); assert.equal(w.cursor, 4000);
  w.stepFrame(-1); assert.equal(w.cursor, 0);
});

function interpolationWorkbench() {
  const raw = createDemoDataset({ end: DEMO_START + 4000, sourceIds: ['ais-east'] });
  raw.baseline = { ...raw.reference, bearingOffsetDeg: 0 }; raw.timeRange.end = new Date(DEMO_START + 120001).toISOString();
  const radar = raw.radar[0]; const ship = raw.ais[0];
  const from = raw.reference; const to = enuToWgs84({ east: 120, north: 60 }, raw.reference);
  const dimensions = (offset, bow) => ({ bow, stern: 10, port: 4, starboard: 5, observedAt: new Date(DEMO_START + offset).toISOString(), validFrom: new Date(DEMO_START + offset).toISOString(), validTo: raw.timeRange.end, sourceId: 'ais-east' });
  raw.radar = [{ ...radar, id: 'start', rangeM: 100, azimuthDeg: 359, storedPosition: from }, { ...radar, id: 'end', eventTime: new Date(DEMO_START + 60000).toISOString(), rangeM: 100, azimuthDeg: 1, storedPosition: to }];
  raw.ais = [{ ...ship, id: 'start', position: from, headingDeg: 0, dimensions: null }, { ...ship, id: 'end', eventTime: new Date(DEMO_START + 60000).toISOString(), position: to, headingDeg: 217, dimensions: dimensions(60000, 180) }];
  raw.aisStatic = [{ id: 'size', mmsi: ship.mmsi, sourceIds: ['ais-east'], eventTime: new Date(DEMO_START + 30000).toISOString(), messageType: '5', mappingVersion: 'test', raw: {}, dimensions: dimensions(30000, 80) }];
  const { dataset, summary } = normalizeDataset(raw);
  const snapshot = { id: 'interpolation', dataset, summary };
  const state = workbenchExports.useWorkbench();
  state.snapshots.value = [snapshot]; state.snapshot.value = snapshot; state.radarId.value = dataset.radarId;
  state.visibleRadarIds.value = [dataset.radarId]; state.parameters.value = { ...dataset.baseline };
  state.cursor.value = DEMO_START + 30000;
  return { w: vue.reactive(state), dataset };
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.001, `${actual} 应接近 ${expected}`);

function refinementWorkbench() {
  const raw = createDemoDataset({ end: DEMO_START + 4000, sourceIds: ['ais-east'] });
  raw.baseline = { ...raw.reference, bearingOffsetDeg: 0 };
  raw.timeRange.end = new Date(DEMO_START + 40000).toISOString();
  const radar = raw.radar[0]; const ship = raw.ais[0];
  raw.radar = Array.from({ length: 10 }, (_, index) => ({ ...radar, id: `radar-${index}`, trackId: 'kept', eventTime: new Date(DEMO_START + index * 4000).toISOString(), rangeM: 100 + index * 10, azimuthDeg: 90 }));
  raw.ais = raw.radar.map((point, index) => ({ ...ship, id: `ais-${index}`, eventTime: point.eventTime, position: enuToWgs84({ east: 100 + index * 10, north: 0 }, raw.reference), dimensions: null }));
  raw.aisStatic = [];
  const { dataset, summary } = normalizeDataset(raw);
  const state = workbenchExports.useWorkbench(); const snapshot = { id: 'refinement', hash: 'refinement-hash', dataset, summary };
  state.snapshots.value = [snapshot]; state.snapshot.value = snapshot; state.radarId.value = dataset.radarId;
  state.visibleRadarIds.value = [dataset.radarId]; state.parameters.value = { ...dataset.baseline };
  state.cursor.value = DEMO_START + 16000;
  return { w: vue.reactive(state), dataset };
}

test('精调任务必须先检查并保留关联，提交检查时冻结的初值和关联标识', async (t) => {
  const { w, dataset } = refinementWorkbench(); const before = structuredClone(dataset); const requests = [];
  apiPost = async (path, body) => { requests.push({ path, body }); return { id: 'fit', snapshotId: body.snapshotId, status: 'running', options: body.options }; };
  t.after(() => { apiPost = async () => { throw new Error('未配置的测试请求'); }; });
  await w.startFit(); assert.equal(requests.length, 0);
  await w.checkRefinement();
  assert.equal(w.refinementPreview.associations.length, 1);
  assert.equal(w.refinementValid, true); assert.equal(w.canStartFit, true);
  const retained = [...w.selectedAssociationIds];
  assert.equal(retained[0], JSON.stringify([dataset.radarId, 'kept', dataset.ais[0].mmsi]));
  w.selectedAssociationIds = []; await w.startFit(); assert.equal(requests.length, 0);
  w.selectedAssociationIds = retained; await w.startFit();
  assert.equal(requests.length, 1); assert.equal(requests[0].path, '/tasks');
  assert.equal(requests[0].body.snapshotId, 'refinement');
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].body.options.refinement.initial)), dataset.baseline);
  assert.deepEqual(Array.from(requests[0].body.options.refinement.associationIds), retained);
  assert.deepEqual(dataset, before);
});

test('参数和表单直接赋值使关联检查永久失效，改回原值也须重新筛选', async () => {
  const { w } = refinementWorkbench();
  const changes = [
    () => { const original = { ...w.parameters }; w.parameters = { ...original, bearingOffsetDeg: 1 }; w.parameters = original; },
    () => { w.parameters.lng += 0.0001; w.parameters.lng -= 0.0001; },
    () => { w.fitOptions.roi = { minEast: 0, maxEast: 500, minNorth: -100, maxNorth: 100 }; w.fitOptions.roi = null; },
    () => { w.fitOptions.refinement.radarExclusion = { minEast: -100, maxEast: -50, minNorth: -100, maxNorth: 100 }; w.fitOptions.refinement.radarExclusion = null; },
    () => { w.fitOptions.refinement.maxDistanceM++; w.fitOptions.refinement.maxDistanceM--; },
    () => { w.fitOptions.refinement.minTrackPoints++; w.fitOptions.refinement.minTrackPoints--; },
    () => { w.fitOptions.refinement.maxPositionShiftM++; w.fitOptions.refinement.maxPositionShiftM--; },
    () => { w.fitOptions.refinement.maxBearingShiftDeg++; w.fitOptions.refinement.maxBearingShiftDeg--; },
    () => { w.fitOptions.maxGapMs++; w.fitOptions.maxGapMs--; },
    () => { w.queryStart = 'changed'; w.queryStart = ''; },
    () => { w.radarId = 'other'; w.radarId = w.dataset.radarId; },
  ];
  for (const change of changes) {
    await w.checkRefinement(); assert.equal(w.refinementValid, true);
    change(); assert.equal(w.refinementValid, false); assert.equal(w.refinementPreview, null); assert.equal(w.canStartFit, false);
  }
  await w.checkRefinement(); w.cursor += 1000; w.playing = true; w.showTiles = false;
  assert.equal(w.refinementValid, true);
});

test('筛选期间输入变更后即使改回原值，迟到结果也不恢复检查', async () => {
  const { w } = refinementWorkbench();
  const pending = w.checkRefinement();
  w.parameters.bearingOffsetDeg = 1; w.parameters.bearingOffsetDeg = 0;
  await pending;
  assert.equal(w.refinementPreview, null); assert.equal(w.refinementValid, false);
  await w.checkRefinement(); assert.equal(w.refinementValid, true);
});

test('创建任务的迟到响应不会覆盖另一台雷达的当前任务', async (t) => {
  const { w, dataset } = refinementWorkbench(); await w.checkRefinement();
  let finish;
  apiPost = (_path, body) => new Promise(resolve => { finish = () => resolve({ id: 'submitted-fit', snapshotId: body.snapshotId, options: body.options, status: 'running' }); });
  t.after(() => { apiPost = async () => { throw new Error('未配置的测试请求'); }; });
  const pending = w.startFit();
  const other = { ...w.snapshot, id: 'other-input', dataset: { ...dataset, radarId: 'other-radar' } };
  w.snapshots = [w.snapshot, other]; w.snapshot = other; w.radarId = 'other-radar';
  const otherTask = { id: 'other-task', snapshotId: other.id, status: 'completed' }; w.task = otherTask;
  finish(); await pending;
  assert.equal(w.task.id, 'other-task'); assert.equal(w.refinementValid, false);
});

test('历史任务的迟到读取不切回旧雷达，正常恢复和候选应用均须重新检查', async (t) => {
  const { w, dataset } = refinementWorkbench(); await w.checkRefinement();
  const first = w.snapshot; const options = JSON.parse(JSON.stringify(w.fitOptions));
  const previous = { id: 'previous', snapshotId: first.id, projectId: dataset.projectId, radarId: dataset.radarId, options, result: { candidates: [{ parameters: { ...w.parameters } }] } };
  let finish;
  apiRead = path => path === '/tasks/previous' ? new Promise(resolve => { finish = () => resolve(previous); }) : Promise.resolve([]);
  t.after(() => { apiRead = async () => []; });
  const pending = w.openTask('previous');
  const other = { ...first, id: 'other-input', dataset: { ...dataset, radarId: 'other-radar' } };
  w.snapshots = [first, other]; w.snapshot = other; w.radarId = 'other-radar';
  finish(); await pending;
  assert.equal(w.snapshot.id, other.id); assert.equal(w.radarId, 'other-radar'); assert.equal(w.task, null);
  apiRead = async path => path === '/tasks/previous' ? previous : [];
  await w.openTask('previous'); assert.equal(w.snapshot.id, first.id); assert.equal(w.refinementValid, false);
  await w.checkRefinement(); assert.equal(w.refinementValid, true);
  w.previewCandidate(0); w.applyCandidate(); assert.equal(w.refinementValid, false);
  await w.checkRefinement(); await w.activateRadar('other-radar'); await w.activateRadar(dataset.radarId);
  assert.equal(w.refinementValid, false); assert.equal(w.refinementPreview, null);
});

test('恢复仅摘要任务等待释放旧输入时，不清空后来切换的雷达', async (t) => {
  const { w, dataset } = refinementWorkbench();
  let finish; let notifyRelease;
  const releasing = new Promise(resolve => { notifyRelease = resolve; });
  const old = { id: 'summary-task', snapshotId: 'released-input', snapshotHash: 'old-hash', projectId: dataset.projectId, radarId: dataset.radarId, options: JSON.parse(JSON.stringify(w.fitOptions)) };
  apiRead = async path => path === '/tasks/summary-task' ? old : { availability: 'reload' };
  apiPost = () => new Promise(resolve => { finish = resolve; notifyRelease(); });
  t.after(() => { apiRead = async () => []; apiPost = async () => { throw new Error('未配置的测试请求'); }; });
  const pending = w.openTask('summary-task'); await releasing;
  const other = { ...w.snapshot, id: 'other-input', dataset: { ...dataset, radarId: 'other-radar' } };
  w.snapshots = [other]; w.snapshot = other; w.radarId = 'other-radar';
  finish({}); await pending;
  assert.equal(w.snapshot?.id, other.id); assert.equal(w.radarId, 'other-radar'); assert.equal(w.task, null);
});

test('检查地图只连接保留行冻结的船舶，剔除竞争关联后可查看原始回放', async () => {
  const { w, dataset } = refinementWorkbench(); const primary = dataset.ais[0].mmsi;
  const otherMmsi = '999999999';
  dataset.ais.push(...dataset.ais.map(point => ({ ...point, id: `other-${point.id}`, mmsi: otherMmsi, position: enuToWgs84({ east: wgs84ToEnu(point.position, dataset.reference).east + 20, north: 0 }, dataset.reference) })));
  const before = structuredClone(dataset);
  await w.checkRefinement(); assert.equal(w.refinementPreview.associations.length, 2);
  assert.ok(w.refinementMap.points.length > 0);
  assert.ok(w.refinementMap.points.every(point => point.mmsi === primary));
  w.selectedAssociationIds = w.refinementPreview.associations.filter(row => row.mmsi === otherMmsi).map(row => row.id);
  assert.ok(w.refinementMap.points.every(point => point.mmsi === otherMmsi));
  assert.equal(w.mapRadar.length, 0); assert.ok(w.radarDisplay.length > 0);
  const frozen = JSON.stringify(w.refinementMap.points); w.cursor += 1000;
  assert.equal(JSON.stringify(w.refinementMap.points), frozen);
  w.visibleRadarIds = []; assert.equal(w.refinementMap, null); assert.equal(w.refinementValid, true);
  w.visibleRadarIds = [dataset.radarId]; assert.ok(w.refinementMap.points.length > 0);
  w.showOriginalRadar = true;
  assert.equal(w.refinementMap, null); assert.equal(w.mapRadar.length, w.radarDisplay.length);
  assert.deepEqual(dataset, before);
});

test('雷达排除区域仅影响精调保留行，局部位置范围随人工初值移动', async () => {
  const { w, dataset } = refinementWorkbench(); const original = structuredClone(dataset);
  const origin = wgs84ToEnu(w.parameters, dataset.reference);
  close(w.refinementBounds.minEast, origin.east - 100); close(w.refinementBounds.maxNorth, origin.north + 100);
  w.setBounds({ minEast: 95, maxEast: 115, minNorth: -10, maxNorth: 10 }, 'exclusion');
  assert.equal(w.mapMode, 'view'); assert.equal(w.fitOptions.refinement.radarExclusion.maxEast, 115);
  await w.checkRefinement();
  assert.equal(w.refinementPreview.exclusions.radarExclusionPoints, 2);
  assert.ok(w.refinementMap.points.every(point => !['radar-0', 'radar-1'].includes(point.observationId)));
  assert.equal(w.radarDisplay.length, 1); assert.deepEqual(dataset, original);
  w.nudge(10, 20); close(w.refinementBounds.minEast, origin.east - 90); close(w.refinementBounds.maxNorth, origin.north + 120);
  assert.equal(w.refinementValid, false);
});

test('定位关联只检查该关联的保留观测，取消保留后恢复其余轨迹', async () => {
  const { w, dataset } = refinementWorkbench();
  dataset.radar.push(...dataset.radar.map(point => ({ ...point, id: `second-${point.id}`, trackId: 'second' })));
  await w.checkRefinement(); assert.equal(w.refinementPreview.associations.length, 2);
  const selected = w.refinementPreview.associations.find(row => row.trackId === 'second').id;
  w.focusRefinementAssociation(selected);
  assert.ok(w.refinementMap.points.length > 0); assert.ok(w.refinementMap.points.every(point => point.associationId === selected));
  w.selectedAssociationIds = w.selectedAssociationIds.filter(id => id !== selected);
  assert.ok(w.refinementMap.points.length > 0); assert.ok(w.refinementMap.points.every(point => point.trackId === 'kept'));
  assert.equal(w.refinementValid, true);
});

test('点击候选只开启对比并保留当前草稿，差值跟随手调，使用候选后才替换参数与设置', () => {
  const { w, dataset } = interpolationWorkbench();
  w.parameters.bearingOffsetDeg = 359;
  const current = { ...w.parameters }; const original = structuredClone(dataset); const options = JSON.stringify(w.fitOptions);
  const candidate = { ...moveParameters(current, 12, -5, dataset.reference), bearingOffsetDeg: 1 };
  const other = { ...moveParameters(current, -3, 4, dataset.reference), bearingOffsetDeg: 90 };
  const task = { id: 'compare-task', snapshotId: w.snapshot.id, status: 'completed', options: { ...JSON.parse(options), maxGapMs: 4321 }, result: { candidates: [{ parameters: candidate }, { parameters: other }] } };
  w.task = task; w.selection = { kind: 'radar', id: w.radarDisplay[0].key }; w.mapMode = 'search';
  w.previewCandidate(0);
  assert.equal(w.comparison.index, 0); assert.equal(w.candidateIndex, -1);
  assert.deepEqual({ ...w.parameters }, current); assert.equal(JSON.stringify(w.fitOptions), options);
  assert.equal(w.selection, null); assert.equal(w.mapMode, 'view');
  close(w.comparison.delta.eastM, 12); close(w.comparison.delta.northM, -5); close(w.comparison.delta.distanceM, 13); close(w.comparison.delta.bearingDeg, 2);
  const key = w.comparison.key;
  w.parameters.bearingOffsetDeg = 358;
  close(w.comparison.delta.bearingDeg, 3); assert.equal(w.comparison.key, key);
  w.previewCandidate(0); assert.notEqual(w.comparison.key, key);
  w.previewCandidate(1); assert.equal(w.comparison.index, 1); close(w.comparison.delta.eastM, -3);
  w.clearComparison(); assert.equal(w.comparison, null); assert.equal(w.parameters.bearingOffsetDeg, 358);
  w.previewCandidate(0); w.applyCandidate();
  assert.deepEqual({ ...w.parameters }, candidate); assert.equal(w.fitOptions.maxGapMs, 4321); assert.equal(w.comparison, null); assert.equal(w.candidateIndex, 0);
  w.parameters.lng += 0.001; w.fitOptions.maxGapMs = 1234;
  assert.deepEqual(task.result.candidates[0].parameters, candidate); assert.equal(task.options.maxGapMs, 4321);
  assert.deepEqual(dataset, original);
});

test('其他输入的任务和无效候选不能开启对比或应用，切换雷达清除对比', async () => {
  const { w, dataset } = interpolationWorkbench(); const current = { ...w.parameters };
  const task = { id: 'old-task', snapshotId: 'old-input', options: JSON.parse(JSON.stringify(w.fitOptions)), result: { candidates: [{ parameters: { ...current, bearingOffsetDeg: 90 } }] } };
  w.task = task; w.previewCandidate(0); w.applyCandidate();
  assert.equal(w.comparison, null); assert.match(w.notice, /恢复该任务的原始输入/); assert.deepEqual({ ...w.parameters }, current);
  w.task = { ...task, snapshotId: w.snapshot.id }; w.previewCandidate(2); assert.equal(w.comparison, null);
  w.previewCandidate(0); assert.ok(w.comparison);
  w.task = { ...task, id: 'replacement-task', snapshotId: w.snapshot.id }; assert.equal(w.comparison, null);
  w.previewCandidate(0);
  const other = { ...w.snapshot, id: 'other-input', dataset: { ...dataset, radarId: 'other-radar' } };
  w.snapshots = [...w.snapshots, other]; await w.activateRadar('other-radar');
  assert.equal(w.comparison, null); assert.equal(w.radarId, 'other-radar');
  await w.activateRadar(dataset.radarId); assert.equal(w.comparison, null); assert.deepEqual({ ...w.parameters }, current);
});

test('AIS 与雷达在任意长的两点间按真实时间插值，雷达跨北向沿端点直线移动', () => {
  const { w, dataset } = interpolationWorkbench(); const before = structuredClone(dataset);
  const radar = w.radarDisplay[0]; const ship = w.aisCurrent[0];
  assert.equal(radar.interpolated, true); assert.equal(ship.interpolated, true);
  const a = polarToEnu(dataset.radar[0], dataset.baseline, dataset.reference); const b = polarToEnu(dataset.radar[1], dataset.baseline, dataset.reference);
  const radarPosition = wgs84ToEnu(radar.candidate, dataset.reference); close(radarPosition.east, (a.east + b.east) / 2); close(radarPosition.north, (a.north + b.north) / 2);
  const position = wgs84ToEnu(ship.displayPosition, dataset.reference); close(position.east, 60); close(position.north, 30);
  const stored = wgs84ToEnu(radar.stored, dataset.reference); close(stored.east, 60); close(stored.north, 30);
  assert.equal(radar.observation.timeMs, DEMO_START); assert.equal(ship.timeMs, DEMO_START); assert.deepEqual(ship.position, dataset.ais[0].position);
  assert.equal(aisAtTime(createAisIndex(dataset), w.cursor, 2000).length, 0);
  assert.deepEqual(dataset, before);
});

test('插值支持暂停重算、回退及首尾边界，静态尺寸和船艏向不提前使用未来报告', () => {
  const { w, dataset } = interpolationWorkbench();
  assert.equal(w.aisCurrent[0].dimensions.bow, 80); assert.equal(w.aisCurrent[0].headingDeg, 0);
  const original = wgs84ToEnu(w.radarDisplay[0].candidate, dataset.reference);
  w.parameters = moveParameters(w.parameters, 10, 20, dataset.reference);
  const moved = wgs84ToEnu(w.radarDisplay[0].candidate, dataset.reference); close(moved.east, original.east + 10); close(moved.north, original.north + 20);
  w.cursor = DEMO_START + 15000; const first = w.aisCurrent[0].displayPosition;
  close(wgs84ToEnu(first, dataset.reference).east, 30); assert.equal(w.aisCurrent[0].dimensions, null);
  w.cursor = DEMO_START + 45000; close(wgs84ToEnu(w.aisCurrent[0].displayPosition, dataset.reference).east, 90);
  w.cursor = DEMO_START + 15000; assert.deepEqual(w.aisCurrent[0].displayPosition, first);
  w.cursor = DEMO_START - 1; assert.equal(w.aisCurrent.length, 0); assert.equal(w.radarDisplay.length, 0);
  w.cursor = DEMO_START + 60000; assert.equal(w.aisCurrent[0].interpolated, false); assert.equal(w.radarDisplay[0].interpolated, false); assert.equal(w.aisCurrent[0].headingDeg, 217); assert.equal(w.aisCurrent[0].dimensions.bow, 180);
  w.cursor = DEMO_START + 70000; assert.deepEqual(w.aisCurrent[0].displayPosition, dataset.ais[1].position); assert.equal(w.radarDisplay.length, 0);
});

test('长间隔内尾迹裁剪到所选秒数，末端与两类目标的插值坐标一致', () => {
  const { w, dataset } = interpolationWorkbench(); w.trailSeconds = 10;
  const ais = w.aisTrails[0].points; const radar = w.trails[0];
  const head = wgs84ToEnu(ais[0], dataset.reference); close(head.east, 40); close(head.north, 20);
  assert.deepEqual(ais.at(-1), w.aisCurrent[0].displayPosition);
  assert.deepEqual(radar.candidate.at(-1), w.radarDisplay[0].candidate); assert.deepEqual(radar.stored.at(-1), w.radarDisplay[0].stored);
  w.cursor = DEMO_START + 15000; close(wgs84ToEnu(w.aisTrails[0].points[0], dataset.reference).east, 10);
});

test('左右键执行切帧并阻止地图平移，空格切换播放且长按不会反复切换', () => {
  const { w, playbackKeydown } = appHandlers();
  const right = keyboardEvent('ArrowRight'); playbackKeydown(right);
  assert.equal(w.cursor, 1000); assert.ok(right.defaultPrevented && right.stopped);
  playbackKeydown(keyboardEvent('ArrowLeft')); assert.equal(w.cursor, 0);
  playbackKeydown(keyboardEvent(' ')); assert.equal(w.playing, true);
  const repeat = keyboardEvent(' ', { repeat: true }); playbackKeydown(repeat);
  assert.equal(w.playing, true); assert.ok(repeat.defaultPrevented);
  playbackKeydown(keyboardEvent(' ')); assert.equal(w.playing, false);
  w.cursor = w.end; playbackKeydown(keyboardEvent(' '));
  assert.equal(w.cursor, w.start); assert.equal(w.playing, true);
  playbackKeydown(keyboardEvent('ArrowRight', { repeat: true }));
  assert.equal(w.cursor, 1000); assert.equal(w.playing, false);
});

test('快捷键保留输入、弹窗、其他页面及组合键行为，播放按钮获得焦点后仍可用空格', () => {
  const handlers = appHandlers(); const { w, playbackKeydown } = handlers;
  for (const selector of ['input', 'textarea', 'select', '[contenteditable]:not([contenteditable="false"])', '[role="slider"]', '[role="combobox"]', '[role="menu"]', '[role="dialog"]', '[role="tablist"]']) {
    for (const key of ['ArrowLeft', 'ArrowRight', ' ']) {
      const event = keyboardEvent(key, { target: new Element([selector]) }); playbackKeydown(event);
      assert.equal(event.defaultPrevented, undefined, selector);
    }
  }
  for (const option of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'isComposing', 'defaultPrevented']) {
    const event = keyboardEvent('ArrowRight', { [option]: true }); playbackKeydown(event); assert.equal(event.stopped, undefined);
  }
  for (const name of ['targetsOpen', 'sourceOpen', 'historyOpen', 'advancedOpen', 'versionOpen', 'evidenceOpen']) {
    handlers[name].value = true;
    const event = keyboardEvent('ArrowRight'); playbackKeydown(event); assert.equal(event.defaultPrevented, undefined);
    handlers[name].value = false;
  }
  handlers.page.value = 'registry'; playbackKeydown(keyboardEvent('ArrowRight')); assert.equal(w.cursor, 0);
  handlers.page.value = 'debug'; w.busy = true; playbackKeydown(keyboardEvent(' ')); assert.equal(w.playing, false);
  w.busy = false;
  const button = keyboardEvent(' ', { target: new Element(['button']) }); playbackKeydown(button); assert.equal(button.defaultPrevented, undefined);
  playbackKeydown(keyboardEvent(' ', { target: new Element(['button', '.timeline-actions']) })); assert.equal(w.playing, true);
});

test('朝向只有获得焦点才按滚轮方向微调，使用现有参数入口处理角度循环', () => {
  const { w, document, adjustBearing } = appHandlers();
  const committed = [];
  const input = { value: '0.000', dispatchEvent: (event) => { committed.push(event.type); assert.equal(event.bubbles, true); } };
  const event = { currentTarget: { querySelector: () => input }, deltaY: 100, preventDefault() { this.defaultPrevented = true; } };
  adjustBearing(event); assert.equal(w.parameters.bearingOffsetDeg, 0); assert.equal(event.defaultPrevented, undefined);
  document.activeElement = input;
  adjustBearing(event); assert.equal(w.parameters.bearingOffsetDeg, 359.9); assert.ok(event.defaultPrevented);
  input.value = '359.900'; adjustBearing({ ...event, deltaY: -100 }); assert.equal(w.parameters.bearingOffsetDeg, 0);
  input.value = '0.000'; adjustBearing({ ...event, deltaY: -1 }); assert.ok(Math.abs(w.parameters.bearingOffsetDeg - 0.1) < 1e-10);
  const bearing = w.parameters.bearingOffsetDeg;
  assert.deepEqual(committed, ['change', 'change', 'change']);
  for (const options of [{ deltaY: 0 }, { ctrlKey: true }, { metaKey: true }]) {
    adjustBearing({ ...event, ...options }); assert.equal(w.parameters.bearingOffsetDeg, bearing);
  }
  for (const value of ['', 'abc']) { input.value = value; adjustBearing(event); assert.equal(w.parameters.bearingOffsetDeg, bearing); }
});

function mapHandlers() {
  const pans = []; const events = []; const fits = [];
  let center = [0, 0];
  const context = {
    props: { selection: null, mode: 'view', radar: [], ais: [], showCandidate: true, showBaseline: true, showStored: true, extent: [{ lat: 23, lng: 117 }] },
    map: {
      panTo: (position, options) => { center = Array.from(position); pans.push({ position: center, options }); context.moveend?.(); },
      fitBounds: (...args) => fits.push(args),
      getSize: () => ({ divideBy: () => ({}) }),
      latLngToContainerPoint: (position) => ({ distanceTo: () => position.every((value, index) => value === center[index]) ? 0 : 10 }),
    },
    draggingStation: false, draggingRotation: false, latLng: ({ lat, lng }) => [lat, lng], emit: (...args) => events.push(args), L: { latLngBounds: (points) => points }, nextTick: vue.nextTick,
  };
  const handlers = loadFunctions('../client/components/CalibrationMap.vue', ['followSelection', 'fitAll'], context);
  context.moveend = handlers.followSelection;
  return { context, pans, events, fits, ...handlers };
}

function comparisonMap(value) {
  const layers = []; const fits = []; const vectors = {};
  const makeLayer = (kind, point, options) => ({ kind, point, options,
    addTo(target) { assert.equal(target, vectors); layers.push(this); return this; },
    bindTooltip(text, options) { this.tooltip = { text, options }; return this; },
    setLatLng(point) { this.point = point; return this; }, setContent(text) { this.text = text; return this; },
  });
  const context = {
    props: { comparison: value }, vectors, colors: { candidate: '#df7730', comparison: '#0c8ca0' }, label: text => text, latLng: ({ lat, lng }) => [lat, lng], normalizeAngle,
    signed: loadFunctions('../client/api.ts', ['signed'], { exports: {} }).signed,
    map: { getSize: () => ({ x: 800, y: 600 }), fitBounds: (...args) => fits.push(args), latLngToContainerPoint: ([lat, lng]) => ({ x: lng * 1000, y: -lat * 1000 }), containerPointToLatLng: ([x, y]) => ({ lng: x / 1000, lat: -y / 1000 }) },
    L: {
      circleMarker: (...args) => makeLayer('position', ...args), polyline: (...args) => makeLayer('line', ...args), marker: (...args) => makeLayer('arrow', ...args),
      divIcon: options => options, tooltip: options => makeLayer('difference', null, options), latLngBounds: points => points,
    },
  };
  return { context, layers, fits, ...loadFunctions('../client/components/CalibrationMap.vue', ['comparisonPoints', 'comparisonEnd', 'drawComparison', 'focusComparison'], context) };
}

test('地图对比同时绘制两处安装点、两支朝向箭头和位移标注，定位只包含当前与候选', () => {
  const current = { lng: 117, lat: 23, bearingOffsetDeg: 0 }; const candidate = { lng: 117.001, lat: 23.002, bearingOffsetDeg: 90 };
  const value = { index: 1, current, candidate, delta: parameterDifference(current, candidate, current) };
  const { layers, fits, drawComparison, focusComparison } = comparisonMap(value);
  drawComparison(); focusComparison();
  const positions = layers.filter(layer => layer.kind === 'position'); const arrows = layers.filter(layer => layer.kind === 'arrow');
  assert.equal(positions.length, 2); assert.notEqual(positions[0].options.color, positions[1].options.color);
  assert.match(positions[0].tooltip.text, /当前 · 0.000°/); assert.match(positions[1].tooltip.text, /候选 2 · 90.000°/);
  close(arrows[0].point.lng, current.lng); close(arrows[0].point.lat, current.lat + 0.08);
  close(arrows[1].point.lng, candidate.lng + 0.08); close(arrows[1].point.lat, candidate.lat);
  assert.match(arrows[1].options.icon.html, /rotate\(90 7 7\)/);
  const displacement = layers.find(layer => layer.kind === 'line' && layer.options.dashArray);
  assert.equal(displacement.point.length, 2); assert.deepEqual(Array.from(displacement.point[0]), [current.lat, current.lng]); close(displacement.point[1][1], candidate.lng);
  assert.match(layers.find(layer => layer.kind === 'difference').text, new RegExp(`位置差 ${value.delta.distanceM.toFixed(2)} m · 朝向差 \\+90.000°`));
  assert.equal(fits.length, 1); assert.equal(fits[0][0].length, 2); assert.equal(fits[0][1].maxZoom, 19); assert.equal(fits[0][1].animate, false);
});

test('位置重合时两种标记仍可区分且朝向差仍显示，日期变更线使用相邻世界副本', () => {
  const current = { lng: 179.999, lat: 0, bearingOffsetDeg: 359 }; const candidate = { ...current, bearingOffsetDeg: 1 };
  const value = { index: 0, current, candidate, delta: parameterDifference(current, candidate, current) };
  const { context, layers, fits, drawComparison, focusComparison } = comparisonMap(value);
  drawComparison(); focusComparison();
  const positions = layers.filter(layer => layer.kind === 'position');
  assert.notEqual(positions[0].options.radius, positions[1].options.radius);
  assert.equal(layers.find(layer => layer.kind === 'difference').text, '位置差 0.00 m · 朝向差 +2.000°');
  assert.equal(fits[0][0][0][1], fits[0][0][1][1]);
  const east = { ...candidate, lng: -179.999 };
  context.props.comparison = { ...value, candidate: east, delta: parameterDifference(current, east, current) };
  focusComparison(); close(fits[1][0][1][1], 180.001); close(fits[1][0][1][1] - fits[1][0][0][1], 0.002);
});

test('雷达按设备及轨迹身份跟随重算坐标，可见图层切换后改用相应坐标', () => {
  const { context, pans, followSelection } = mapHandlers();
  const point = { key: 'radar-2:track', candidate: { lng: 117.2, lat: 23.2 }, baseline: { lng: 117.3, lat: 23.3 }, stored: { lng: 117.4, lat: 23.4 }, observation: { storedPosition: { lng: 117, lat: 23 } } };
  context.props.radar = [{ ...point, key: 'radar-1:track', candidate: { lng: 116, lat: 22 } }, point];
  context.props.selection = { kind: 'radar', id: point.key };
  followSelection(); assert.deepEqual(pans.at(-1).position, [23.2, 117.2]); assert.equal(pans.at(-1).options.animate, false);
  followSelection(); assert.equal(pans.length, 1);
  point.candidate = { lng: 117.25, lat: 23.25 }; followSelection(); assert.deepEqual(pans.at(-1).position, [23.25, 117.25]);
  context.props.showCandidate = false; followSelection(); assert.deepEqual(pans.at(-1).position, [23.3, 117.3]);
  context.props.showBaseline = false; followSelection(); assert.deepEqual(pans.at(-1).position, [23.4, 117.4]);
  context.props.showStored = false; followSelection(); assert.equal(pans.length, 4);
});

test('AIS 跟随插值位置和历史回退，缺报或圈选拖动时保留视野，结束后可以继续', () => {
  const { context, pans, followSelection } = mapHandlers();
  context.props.selection = { kind: 'ais', id: '123456789' };
  const ship = { mmsi: '123456789', position: { lng: 117, lat: 23 }, displayPosition: { lng: 117.1, lat: 23.1 } }; context.props.ais = [ship];
  followSelection(); assert.deepEqual(pans.at(-1).position, [23.1, 117.1]);
  ship.displayPosition = { lng: 117.2, lat: 23.2 }; followSelection(); assert.deepEqual(pans.at(-1).position, [23.2, 117.2]);
  ship.displayPosition = { lng: 117.1, lat: 23.1 }; followSelection(); assert.deepEqual(pans.at(-1).position, [23.1, 117.1]);
  context.props.ais = []; followSelection(); assert.equal(pans.length, 3);
  ship.displayPosition = { lng: 117.3, lat: 23.3 };
  context.props.ais = [ship]; context.props.mode = 'roi'; followSelection(); assert.equal(pans.length, 3);
  context.props.mode = 'view'; context.draggingStation = true; followSelection(); assert.equal(pans.length, 3);
  context.draggingStation = false; context.draggingRotation = true; followSelection(); assert.equal(pans.length, 3);
  context.draggingRotation = false; followSelection(); assert.equal(pans.length, 4);
  context.props.selection = null; followSelection(); assert.equal(pans.length, 4);
});

test('再次点击同一雷达或 AIS 目标取消跟踪，重新点击可恢复，其他目标可直接切换', async () => {
  const { w, dataset } = interpolationWorkbench();
  const radar = { kind: 'radar', id: w.radarDisplay[0].key }; const ais = { kind: 'ais', id: dataset.ais[0].mmsi };
  for (const target of [radar, ais]) {
    await w.selectTarget(target); assert.deepEqual(w.selection, target);
    await w.selectTarget({ ...target }); assert.equal(w.selection, null);
    await w.selectTarget({ ...target }); assert.deepEqual(w.selection, target);
    await w.selectTarget(null);
  }
  await w.selectTarget(radar); await w.selectTarget(ais); assert.deepEqual(w.selection, ais);
  await w.selectTarget(radar); assert.deepEqual(w.selection, radar);
  w.busy = true; await w.selectTarget({ ...radar }); assert.equal(w.selection, null);
});

test('全域通过现有选择入口取消跟踪，取消后不再居中', async () => {
  const { context, events, fits, fitAll } = mapHandlers();
  context.props.selection = { kind: 'ais', id: '123456789' }; await fitAll();
  assert.deepEqual(events[0], ['select', null]); assert.equal(fits.length, 1);
  const w = workbench(); w.selection = context.props.selection; w.busy = true; await w.selectTarget(null); assert.equal(w.selection, null);
});

function staticResponse(w, dimensions = { bow: 90, stern: 10, port: 4, starboard: 6 }) {
  const ship = w.aisCurrent[0];
  w.projects = [{ id: w.dataset.projectId, mode: 'clickhouse-raw' }]; w.projectId = w.dataset.projectId;
  return { projectId: w.projectId, mmsi: ship.mmsi, positionTime: new Date(w.cursor).toISOString(), queriedAt: new Date(DEMO_START + 3600000).toISOString(), report: { mmsi: ship.mmsi, sourceId: ship.sourceIds[0], eventTime: new Date(DEMO_START + 3500000).toISOString(), messageType: '24', dimensions, lengthM: dimensions.bow + dimensions.stern, widthM: dimensions.port + dimensions.starboard, parserVersion: 'test' } };
}

test('点击 AIS 以回放时间请求后续尺寸并立即更新显示，保留历史位置、方向和标定快照', async (t) => {
  const { w, dataset } = interpolationWorkbench(); const response = staticResponse(w);
  const before = structuredClone(dataset); const displayed = w.aisCurrent[0]; const requests = [];
  apiPost = async (...args) => { requests.push(args); return response; };
  t.after(() => { apiPost = async () => { throw new Error('未配置的测试请求'); }; });
  let redraws = 0; const stop = vue.watch(() => w.aisCurrent, () => redraws++, { flush: 'sync' }); t.after(stop);
  await w.selectTarget({ kind: 'ais', id: displayed.mmsi });
  assert.equal(requests.length, 1); assert.equal(requests[0][0], `/projects/${dataset.projectId}/ais/dimensions`);
  assert.equal(JSON.stringify(requests[0][1]), JSON.stringify({ mmsi: displayed.mmsi, aisSourceIds: displayed.sourceIds, positionTime: new Date(w.cursor).toISOString() }));
  assert.ok(redraws > 0);
  const current = w.aisCurrent[0];
  assert.equal(current.dimensions.bow, 90); assert.equal(current.dimensions.starboard, 6);
  assert.equal(current.dimensionReport.eventTime, response.report.eventTime);
  assert.equal(current.headingDeg, displayed.headingDeg); assert.equal(current.timeMs, displayed.timeMs);
  assert.deepEqual(current.position, displayed.position); assert.deepEqual(current.displayPosition, displayed.displayPosition);
  w.cursor = DEMO_START; assert.equal(w.aisCurrent[0].dimensions.bow, 90);
  assert.deepEqual(dataset, before);
});

test('尺寸请求固定点击时的回放游标，等待响应时继续播放不会改用真实上报时间', async (t) => {
  const { w, dataset } = interpolationWorkbench(); const response = staticResponse(w);
  const before = structuredClone(dataset); const clickedAt = w.cursor; const displayed = w.aisCurrent[0];
  assert.notEqual(clickedAt, displayed.timeMs);
  let finish; let payload;
  apiPost = (_path, input) => { payload = input; return new Promise(resolve => { finish = resolve; }); };
  t.after(() => { apiPost = async () => { throw new Error('未配置的测试请求'); }; });
  const pending = w.selectTarget({ kind: 'ais', id: displayed.mmsi });
  w.cursor = clickedAt + 1000; finish(response); await pending;
  assert.equal(payload.positionTime, new Date(clickedAt).toISOString());
  assert.equal(w.aisCurrent[0].dimensions.bow, 90);
  assert.deepEqual(dataset, before);
});

test('静态补查空结果及失败保留原尺寸，来源改变后不复用其他来源的尺寸', async (t) => {
  const { w, dataset } = interpolationWorkbench(); const response = staticResponse(w); const selected = { kind: 'ais', id: response.mmsi };
  apiPost = async () => ({ ...response, report: null });
  t.after(() => { apiPost = async () => { throw new Error('未配置的测试请求'); }; });
  await w.selectTarget(selected); assert.equal(w.aisCurrent[0].dimensions.bow, 80); assert.match(w.notice, /48 小时内未找到/);
  await w.selectTarget(null); apiPost = async () => { throw new Error('静态报文查询失败'); };
  await w.selectTarget(selected); assert.equal(w.aisCurrent[0].dimensions.bow, 80); assert.match(w.error, /静态报文查询失败/);
  await w.selectTarget(null); apiPost = async () => response; await w.selectTarget(selected);
  assert.equal(w.aisCurrent[0].dimensions.bow, 90);
  const other = structuredClone(dataset); other.ais = other.ais.map((point) => ({ ...point, sourceIds: ['ais-west'], dimensions: null })); other.aisStatic = [];
  w.snapshots = [{ ...w.snapshots[0], dataset: other }]; w.snapshot = w.snapshots[0];
  assert.equal(w.aisCurrent[0].dimensionReport, undefined); assert.equal(w.aisCurrent[0].dimensions, null);
});

test('取消选择或更换数据后忽略迟到尺寸，加载新快照清空当前显示覆盖', async (t) => {
  const { w, dataset } = interpolationWorkbench(); const response = staticResponse(w); const selected = { kind: 'ais', id: response.mmsi };
  let finish;
  apiPost = () => new Promise((resolve) => { finish = resolve; });
  t.after(() => { apiRead = async () => []; apiPost = async () => { throw new Error('未配置的测试请求'); }; });
  const pending = w.selectTarget(selected); await w.selectTarget(null); finish(response); await pending;
  assert.equal(w.selection, null); assert.equal(w.aisCurrent[0].dimensions.bow, 80);
  apiPost = async () => response; await w.selectTarget(selected); assert.equal(w.aisCurrent[0].dimensions.bow, 90);
  const replacement = { ...w.snapshots[0], id: 'replacement', dataset: structuredClone(dataset) };
  const requests = []; w.session = { id: 'previous-session' };
  apiRead = async path => path === '/preparations/load-replacement' ? { status: 'completed' } : path === '/preparations/load-replacement/result' ? replacement : [];
  apiPost = async path => { requests.push(path); return path === '/snapshots/replacement/load?async=1' ? { id: 'load-replacement' } : {}; };
  await w.openSnapshot('replacement');
  assert.equal(w.error, ''); assert.equal(w.aisCurrent[0].dimensionReport, undefined);
  assert.equal(w.aisCurrent[0].dimensions, null);
  assert.equal(requests.some(path => path.endsWith('/release')), false);
});
