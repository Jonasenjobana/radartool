import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as vue from 'vue';
import ts from 'typescript';
import { decodePlayback } from '../shared/playback.js';
import { DEFAULT_FIT_OPTIONS, normalizeDataset, InputError } from '../shared/data.js';
import { createDemoDataset, DEMO_START, DEMO_TRUTH } from './fixtures/demo.js';
import { fixtureAppOptions, testApp, waitForTask } from './helpers.js';
import { SqliteStore } from '../server/storage.js';

const start = DEMO_START; const end = start + 3 * 3600000;
const range = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
const times = [0, 30000, 600000, 1800000, 3599000, 3600000, 5400000, 9000000, 10700000];
const iso = value => new Date(value).toISOString();

function fullDataset(project, radarId, dense = false) {
  const data = createDemoDataset({ start, end: start + (dense ? 600000 : 60000) }); const radarSeeds = data.radar.slice(0, 2);
  const aisSeeds = [...new Map(data.ais.map(point => [point.mmsi, point])).values()].slice(0, 2); const sourceId = project.aisSources[0].id;
  const dimensions = (index, newer) => ({ bow: newer ? 95 : 65, stern: 15, port: 4, starboard: 6, sourceId, observedAt: iso(newer ? start + 600000 : start), validFrom: iso(newer ? start + 600000 : start), validTo: iso(newer ? end : start + 600000) });
  Object.assign(data, { projectId: project.id, radarId, name: radarId, baseline: project.radars.find(value => value.id === radarId).baseline, timeRange: range, timeSemantics: 'event-time', unitsVerified: true, alignmentVerified: true });
  data.provenance = { kind: 'synthetic', configVersion: project.configVersion, parserVersion: project.ais.parserVersion, radarConfiguration: project.radars.find(value => value.id === radarId) };
  if (dense) {
    // 保持三小时请求范围，把真实对应的四秒观测移到训练/验证分界附近，供生命周期用例完成稳定关联检查。
    const shifted = value => value == null ? value : iso(Date.parse(value) + 119 * 60000);
    data.radar = data.radar.map(point => ({ ...point, deviceId: radarId, eventTime: shifted(point.eventTime), receiveTime: shifted(point.receiveTime) }));
    data.ais = data.ais.map(point => ({ ...point, eventTime: shifted(point.eventTime), receiveTime: shifted(point.receiveTime), dimensions: { ...point.dimensions, observedAt: shifted(point.dimensions.observedAt), validFrom: shifted(point.dimensions.validFrom), validTo: shifted(point.dimensions.validTo) } }));
    return normalizeDataset(data);
  }
  data.radar = times.flatMap(offset => radarSeeds.map((seed, index) => ({ ...seed, id: `radar-${radarId}-${offset}-${index}`, sourceId: 'window-radar', deviceId: radarId, trackId: `track-${index}`, eventTime: iso(start + offset), rangeM: seed.rangeM + offset / 10000, raw: { offset, radarId, index } })));
  data.ais = times.flatMap(offset => aisSeeds.map((seed, index) => ({ ...seed, id: `ais-${offset}-${index}`, sourceIds: [sourceId], mmsi: seed.mmsi, eventTime: iso(start + offset), position: { lng: seed.position.lng + offset / 1e10, lat: seed.position.lat }, headingDeg: index ? 90 : 0, dimensions: dimensions(index, offset >= 600000), raw: { offset, index } })));
  data.aisStatic = [false, true].flatMap(newer => aisSeeds.map((seed, index) => ({ id: `static-${newer}-${index}`, mmsi: seed.mmsi, sourceIds: [sourceId], messageType: '24', eventTime: iso(newer ? start + 600000 : start), mappingVersion: 'fixture', dimensions: dimensions(index, newer), raw: { newer, index }, quality: [] })));
  return normalizeDataset(data);
}
function withNeighbors(points, from, to, identity) {
  const groups = new Map(); for (const point of points) { const id = identity(point); const group = groups.get(id) ?? []; group.push(point); groups.set(id, group); }
  return [...groups.values()].flatMap(group => [group.filter(point => point.timeMs < from).at(-1), ...group.filter(point => point.timeMs >= from && point.timeMs < to), group.find(point => point.timeMs >= to)].filter(Boolean));
}
async function setup(t, raw = false, dense = false) {
  const options = fixtureAppOptions(); const project = options.projectConfigs[0];
  Object.assign(project, { timeSemantics: 'event-time', unitsVerified: true, alignmentVerified: true, defaultRange: range }); project.ais.parserVersion = 'window-fixture';
  if (raw) project.mode = 'clickhouse-raw';
  project.radars.push({ ...structuredClone(project.radars[0]), id: 'radar-2', name: '第二台' });
  const state = { windows: [], full: [], gate: null, fullGate: null, fullFail: false, fail: false, started: null, maximumRange: Infinity };
  options.readWindowDatasets = async (frozen, query, _evidence, signal) => {
    state.windows.push(structuredClone(query)); state.started?.();
    if (Date.parse(query.end) - Date.parse(query.start) > state.maximumRange) throw new InputError('窗口超过资源预算', 413);
    if (state.gate) await state.gate(signal);
    if (state.fail) throw new InputError('窗口来源读取失败', 502);
    return query.radarIds.map(radarId => {
      const value = fullDataset(frozen, radarId, dense); const from = Date.parse(query.start); const to = Date.parse(query.end);
      value.dataset.radar = withNeighbors(value.dataset.radar, from, to, point => point.trackId);
      value.dataset.ais = withNeighbors(value.dataset.ais, from, to, point => point.mmsi);
      value.dataset.aisStatic = withNeighbors(value.dataset.aisStatic, from, to, point => point.mmsi);
      return normalizeDataset(value.dataset);
    });
  };
  options.readDataset = async (frozen, query, signal) => { state.full.push(query); if (state.fullGate) await state.fullGate(signal); if (state.fullFail) throw new InputError('完整时段读取失败', 502); return fullDataset(frozen, query.radarId, dense); };
  options.readGroupDatasets = async (frozen, query, _evidence, signal) => { state.full.push(query); if (state.fullGate) await state.fullGate(signal); if (state.fullFail) throw new InputError('完整时段读取失败', 502); return query.radarIds.map(radarId => fullDataset(frozen, radarId, dense)); };
  options.readPlaybackFrameTime = async (frozen, query, time, direction) => { const data = fullDataset(frozen, query.radarIds[0], dense).dataset; const values = [...data.radar, ...data.ais, ...data.aisStatic].map(point => point.timeMs).filter(value => direction > 0 ? value > time : value < time); return values.length ? direction > 0 ? Math.min(...values) : Math.max(...values) : null; };
  options.readAisDimensions = async (_project, query) => ({ ...query, projectId: project.id, queriedAt: iso(end), report: { mmsi: query.mmsi, sourceId: query.aisSourceIds[0], messageType: '24', eventTime: iso(end), dimensions: { bow: 140, stern: 20, port: 7, starboard: 8 }, lengthM: 160, widthM: 15, parserVersion: 'window-fixture' } });
  const app = await testApp(t, options); const group = (await app.inject('/api/groups')).json()[0];
  return { app, group, project, state };
}
async function open(app, group) {
  const response = await app.inject({ method: 'POST', url: `/api/groups/${group.id}/playback`, payload: { ...range, revision: group.revision } }); assert.equal(response.statusCode, 201, response.body); return response.json();
}
async function window(app, session, at, requestId = 'window-test') {
  const response = await app.inject({ method: 'POST', url: `/api/playbacks/${session.id}/windows`, payload: { at, trailSeconds: 60, requestId } });
  assert.equal(response.statusCode, 200, response.body.slice(0, 400)); return decodePlayback(response.json());
}
async function until(predicate) { const deadline = Date.now() + 12000; while (!predicate()) { assert.ok(Date.now() < deadline, '等待回放状态超时'); await new Promise(resolve => setTimeout(resolve, 10)); } }

test('标定任务立即返回编号，后台准备固定雷达的完整时段，释放分窗回放后仍能完成', async t => {
  const { app, group, state } = await setup(t); const session = await open(app, group);
  let release; state.fullGate = () => new Promise(resolve => { release = resolve; });
  try {
    const payload = { playbackId: session.id, radarId: session.radarIds[1], options: DEFAULT_FIT_OPTIONS };
    const response = await app.inject({ method: 'POST', url: '/api/tasks', payload });
    assert.equal(response.statusCode, 202, response.body); const accepted = response.json();
    assert.equal(accepted.status, 'running'); assert.equal(accepted.sessionId, session.id); assert.equal(accepted.radarId, session.radarIds[1]);
    assert.deepEqual(accepted.dataRange, { start, end }); assert.ok(!accepted.snapshotHash);
    await until(() => !!release);
    assert.equal(state.windows.length, 0); assert.equal(state.full.length, 1);
    assert.equal(state.full[0].start, range.start); assert.equal(state.full[0].end, range.end);
    assert.deepEqual(state.full[0].aisSourceIds, session.aisSourceIds); assert.equal(state.full[0].radarId, session.radarIds[1]);
    assert.equal((await app.inject(`/api/tasks/${accepted.id}`)).statusCode, 200);
    assert.ok((await app.inject('/api/tasks')).json().some(task => task.id === accepted.id));
    assert.ok(app.store.list('tasks', { includeSynthetic: false }).some(task => task.id === accepted.id));
    assert.equal((await app.inject({ method: 'POST', url: '/api/tasks', payload })).statusCode, 409);
    await app.inject({ method: 'DELETE', url: `/api/playbacks/${session.id}` });
    release(); const task = await waitForTask(app, accepted.id);
    assert.equal(task.status, 'completed', task.error); assert.equal(task.snapshotId, accepted.snapshotId); assert.ok(task.snapshotHash);
    assert.equal(task.result.snapshotHash, task.snapshotHash);
    const metadata = (await app.inject(`/api/snapshots/${task.snapshotId}/metadata`)).json();
    assert.equal(metadata.summary.start, start); assert.equal(metadata.summary.end, end); assert.equal(metadata.radarId, session.radarIds[1]);
  } finally { release?.(); }
});

test('完整输入准备期间可取消标定，迟到的读取不发布快照或启动计算', async t => {
  const { app, group, state } = await setup(t); const session = await open(app, group);
  let release; let cancelled = false;
  state.fullGate = signal => new Promise(resolve => { release = resolve; signal.addEventListener('abort', () => { cancelled = true; }, { once: true }); });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/tasks', payload: { playbackId: session.id, radarId: session.radarIds[0], options: DEFAULT_FIT_OPTIONS } });
    assert.equal(response.statusCode, 202, response.body); const accepted = response.json(); await until(() => !!release);
    const result = await app.inject({ method: 'POST', url: `/api/tasks/${accepted.id}/cancel`, payload: {} });
    assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().status, 'cancelled'); assert.equal(cancelled, true);
    state.fullGate = null; release();
    let retry; const deadline = Date.now() + 12000;
    do {
      retry = await app.inject({ method: 'POST', url: '/api/tasks', payload: { playbackId: session.id, radarId: session.radarIds[0], options: DEFAULT_FIT_OPTIONS } });
      if (retry.statusCode === 202) break;
      assert.equal(retry.statusCode, 409, retry.body); assert.ok(Date.now() < deadline, '取消后任务槽未释放');
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (true);
    await app.inject({ method: 'POST', url: `/api/tasks/${retry.json().id}/cancel`, payload: {} });
    assert.equal((await app.inject(`/api/tasks/${accepted.id}`)).json().status, 'cancelled');
    assert.equal(app.store.snapshotMeta(accepted.snapshotId), null); assert.equal((await app.store.read('tasks', accepted.id)).status, 'cancelled');
  } finally { release?.(); }
});

test('后台完整输入读取失败保留任务与失败原因，不发布半份快照', async t => {
  const { app, group, state } = await setup(t); const session = await open(app, group); state.fullFail = true;
  const response = await app.inject({ method: 'POST', url: '/api/tasks', payload: { playbackId: session.id, radarId: session.radarIds[0], options: DEFAULT_FIT_OPTIONS } });
  assert.equal(response.statusCode, 202, response.body); const accepted = response.json();
  const task = await waitForTask(app, accepted.id); assert.equal(task.status, 'failed'); assert.match(task.error, /完整时段读取失败/);
  assert.equal(app.store.snapshotMeta(task.snapshotId), null); assert.ok((await app.inject('/api/tasks')).json().some(value => value.id === task.id));
});

test('服务关闭中断准备中的标定任务，未取得完整快照时任务条件仍能恢复', async t => {
  const { app, group, state } = await setup(t); const session = await open(app, group);
  state.fullGate = signal => new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); });
  const response = await app.inject({ method: 'POST', url: '/api/tasks', payload: { playbackId: session.id, radarId: session.radarIds[0], options: DEFAULT_FIT_OPTIONS } });
  assert.equal(response.statusCode, 202, response.body); const accepted = response.json(); await until(() => state.full.length === 1);
  await app.close(); const restored = new SqliteStore(app.store.directory); await restored.init();
  try {
    const task = await restored.read('tasks', accepted.id);
    assert.equal(task.status, 'interrupted'); assert.equal(task.sessionId, session.id); assert.deepEqual(task.dataRange, { start, end });
    assert.deepEqual(task.options, DEFAULT_FIT_OPTIONS); assert.equal(restored.snapshotMeta(task.snapshotId), null);
    assert.ok(restored.list('tasks', { includeSynthetic: false }).some(value => value.id === task.id));
  } finally { restored.close(); }
});

test('会话建立不读整段数据，窗口缓存有界、原文独立可取，淘汰后明确失效', async t => {
  const { app, group, state } = await setup(t); const session = await open(app, group);
  assert.equal(state.windows.length, 0); assert.equal(state.full.length, 0); assert.equal((await app.inject('/api/snapshots')).json().length, 0);
  const first = await window(app, session, start); assert.equal(first.window.start, start); assert.equal(first.window.end, start + 120000); assert.equal(first.snapshots.length, 2);
  assert.strictEqual(first.snapshots[0].dataset.ais, first.snapshots[1].dataset.ais);
  const point = first.snapshots[0].dataset.radar[0]; const reference = point.raw.evidenceRef;
  const rawPath = `/api/snapshots/${reference.snapshotId}/observations/radar/${reference.id}?playbackId=${session.id}`;
  assert.equal((await app.inject(rawPath)).json().raw.offset, 0);
  await window(app, session, start + 30000); assert.equal(state.windows.length, 1);
  for (const offset of [600000, 1800000, 3600000, 5400000]) await window(app, session, start + offset);
  const status = (await app.inject(`/api/playbacks/${session.id}/status`)).json(); assert.ok(status.windowCount <= status.maxWindows); assert.ok(status.retainedBytes <= status.maxBytes);
  assert.ok(state.windows.every(query => Date.parse(query.end) - Date.parse(query.start) <= 180000));
  assert.equal((await app.inject(rawPath)).statusCode, 410); assert.equal((await app.inject('/api/snapshots')).json().length, 0);
  assert.equal((await app.inject('/api/playbacks')).json()[0].mode, 'windowed');
  await app.inject({ method: 'DELETE', url: `/api/playbacks/${session.id}` });
  assert.equal((await app.inject(`/api/playbacks/${session.id}/status`)).json().windowCount, 0);
  assert.equal((await app.inject({ method: 'POST', url: `/api/playbacks/${session.id}/windows`, payload: { at: start, requestId: 'released' } })).statusCode, 410);
});

test('窗口可取消且不发布半份数据，失败可重试，控制接口不等待来源', async t => {
  const { app, group, state } = await setup(t); const session = await open(app, group);
  let begun; const started = new Promise(resolve => { begun = resolve; }); state.started = begun;
  state.gate = signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new InputError('cancelled', 499)), { once: true }));
  const pending = app.inject({ method: 'POST', url: `/api/playbacks/${session.id}/windows`, payload: { at: start, requestId: 'cancel-me' } }); await started;
  for (const url of ['/api/health', '/api/projects', '/api/playbacks', '/api/sessions']) assert.equal((await app.inject(url)).statusCode, 200);
  await app.inject({ method: 'POST', url: `/api/playbacks/${session.id}/cancel`, payload: { requestId: 'cancel-me' } }); assert.equal((await pending).statusCode, 499);
  assert.equal((await app.inject(`/api/playbacks/${session.id}/status`)).json().windowCount, 0);
  state.gate = null; state.fail = true;
  const failed = await app.inject({ method: 'POST', url: `/api/playbacks/${session.id}/windows`, payload: { at: start, requestId: 'failed' } }); assert.equal(failed.statusCode, 502);
  state.fail = false; await window(app, session, start); assert.equal((await app.inject(`/api/playbacks/${session.id}/status`)).json().windowCount, 1);
});

test('逐帧跨越未缓存长间隔；完整标定准备不取决于播放过哪些窗口', async t => {
  const { app, group, state } = await setup(t); const session = await open(app, group);
  await window(app, session, start + 3600000);
  const frame = await app.inject({ method: 'POST', url: `/api/playbacks/${session.id}/frame`, payload: { at: start + 30000, direction: 1, trailSeconds: 60, requestId: 'frame' } }); assert.equal(frame.statusCode, 200, frame.body); assert.equal(frame.json().at, start + 600000);
  const prepared = await app.inject({ method: 'POST', url: `/api/playbacks/${session.id}/prepare`, payload: { radarId: session.radarIds[0] } }); assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json().snapshot.summary.start, start); assert.equal(prepared.json().snapshot.summary.end, end); assert.equal(state.full.length, 1);
  const exported = await app.inject(`/api/snapshots/${prepared.json().snapshotId}/export`); assert.equal(exported.statusCode, 200); assert.equal(exported.json().dataset.radar.length, times.length * 2);
  assert.equal((await app.inject(`/api/playbacks/${session.id}/status`)).json().active, true);
});

function workbenchHarness(app, network = {}) {
  const file = new URL('../client/useWorkbench.ts', import.meta.url); const require = createRequire(file); const exports = {}; const mounted = []; const unmounted = []; const intervals = new Map(); let time = 0;
  const transport = async (path, body, signal, method = body === undefined ? 'GET' : 'POST') => {
    const id = path.match(/^\/playbacks\/([^/]+)\/windows/);
    const abort = () => { if (id) void app.inject({ method: 'POST', url: `/api/playbacks/${id[1]}/cancel`, payload: { requestId: body.requestId } }); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await app.inject({ method, url: `/api${path}`, ...(body === undefined ? {} : { payload: body }) });
      if (network.beforeDelivery) await network.beforeDelivery(path, body);
      if (signal?.aborted && !network.deliverCancelled) throw new DOMException('aborted', 'AbortError');
      const data = response.json(); if (response.statusCode >= 400) throw Object.assign(new Error(data.error), { status: response.statusCode });
      if (Array.isArray(data)) Object.defineProperty(data, 'nextCursor', { value: response.headers['x-next-cursor'] });
      if (data.schemaVersion !== 2) return data;
      const bundle = decodePlayback(data);
      return bundle.session || bundle.snapshots.length !== 1 ? bundle : { ...bundle.snapshots[0], ...(bundle.reloadedFrom ? { reloadedFrom: bundle.reloadedFrom } : {}) };
    } finally { signal?.removeEventListener('abort', abort); }
  };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, require: name => name === 'vue' ? { ...vue, onMounted: fn => mounted.push(fn), onUnmounted: fn => unmounted.push(fn) } : name === './api' ? { api: (path, options) => transport(path, undefined, options?.signal, options?.method), post: (path, body, signal) => transport(path, body, signal), toInputTime: value => new Date(Date.parse(typeof value === 'number' ? iso(value) : value) + 8 * 3600000).toISOString().slice(0, 23), fromInputTime: value => new Date(`${value}+08:00`).toISOString() } : require(name), performance: { now: () => time }, AbortController, DOMException, console, setTimeout, setInterval: (fn, delay) => { intervals.set(delay, fn); return delay; }, clearInterval: delay => intervals.delete(delay) });
  const w = vue.reactive(exports.useWorkbench());
  return { w, mount: () => mounted[0](), tick: elapsed => { time += elapsed; intervals.get(100)?.(); }, poll: () => intervals.get(800)?.(), close: async () => { await w.chooseGroup(''); for (const fn of unmounted) fn(); } };
}

test('匹配组一次取得完整时段，播放、拖动、逐帧和尾迹调整均使用本地数据', async t => {
  const { app, state } = await setup(t); const requests = [];
  const harness = workbenchHarness(app, { beforeDelivery: async path => { requests.push(path); } }); const { w } = harness;
  try {
    await harness.mount(); await w.runQuery();
    assert.equal(w.error, ''); assert.equal(state.full.length, 1); assert.equal(state.windows.length, 0);
    assert.equal(w.snapshots.length, 2); assert.equal(w.dataset.radar.length, times.length * 2);
    assert.equal(w.start, start); assert.equal(w.end, end - 1);
    const before = requests.length;
    w.playing = true; harness.tick(100); assert.equal(w.cursor, start + 1000);
    const target = start + 7200000; w.previewSeek(target); harness.tick(1000); assert.equal(w.cursor, start + 1000);
    await w.seekTo(target); assert.equal(w.cursor, target); assert.equal(w.playing, true);
    w.stepFrame(1); assert.equal(w.cursor, start + 9000000); assert.equal(w.playing, false);
    w.trailSeconds = 300; await vue.nextTick(); assert.equal(requests.length, before);
  } finally { await harness.close(); }
});

test('未加载时可选择组内雷达，完整加载保留选择、查询区域和各自参数', async t => {
  const { app, project, state } = await setup(t); const harness = workbenchHarness(app); const { w } = harness;
  try {
    await harness.mount(); const ids = project.radars.map(radar => radar.id);
    assert.equal(w.snapshots.length, 0); assert.deepEqual(Array.from(w.radarOptions, member => member.id), ids);
    await w.activateRadar(ids[1]); assert.equal(state.full.length, 0); assert.equal(state.windows.length, 0);
    w.queryArea = { west: 122, east: 122.3, south: 30, north: 30.3 };
    await w.runQuery(); assert.equal(w.error, ''); assert.equal(w.radarId, ids[1]); assert.equal(w.snapshots.length, 2);
    assert.equal(w.radarMembers[1].name, '第二台'); assert.equal(state.full[0].start, range.start); assert.equal(state.full[0].end, range.end);
    assert.deepEqual(state.full[0].queryArea, { west: 122, east: 122.3, south: 30, north: 30.3 });
    w.parameters = { ...w.parameters, bearingOffsetDeg: 27 };
    await w.activateRadar(ids[0]); await w.activateRadar(ids[1]); assert.equal(w.parameters.bearingOffsetDeg, 27);
  } finally { await harness.close(); }
});

test('完整回放的长间隔插值、尾迹、参数和点击尺寸在本地跳转中保持，原始输入不变', async t => {
  const { app, state } = await setup(t, true); const harness = workbenchHarness(app); const { w } = harness;
  try {
    await harness.mount(); await w.runQuery(); assert.equal(w.error, '');
    const original = JSON.stringify(w.dataset); const mmsi = w.aisCurrent[0].mmsi;
    await w.selectTarget({ kind: 'ais', id: mmsi }); assert.equal(w.aisCurrent.find(point => point.mmsi === mmsi).dimensions.bow, 140);
    w.nudge(7, -3); const parameters = { ...w.parameters };
    await w.seekTo(start + 3630000); assert.ok(w.aisCurrent.some(point => point.mmsi === mmsi));
    assert.equal(w.aisCurrent.find(point => point.mmsi === mmsi).dimensions.bow, 140);
    await w.seekTo(start + 30000); assert.equal(w.aisCurrent.find(point => point.mmsi === mmsi).dimensions.bow, 140);
    assert.deepEqual({ ...w.parameters }, parameters); assert.equal(JSON.stringify(w.dataset), original);
    assert.equal(state.full.length, 1); assert.equal(state.windows.length, 0);
  } finally { await harness.close(); }
});

test('重新读取远程数据完整加载全组并建立新会话', async t => {
  const { app, state } = await setup(t); const harness = workbenchHarness(app); const { w } = harness;
  try {
    await harness.mount(); await w.runQuery(); const previous = w.session.id;
    await w.forceQuery(); assert.equal(w.error, ''); assert.notEqual(w.session.id, previous);
    assert.equal(state.full.length, 2); assert.equal(state.full[1].forceReload, true); assert.equal(state.windows.length, 0);
    assert.equal(w.snapshots.length, 2); assert.equal(w.end, end - 1);
  } finally { await harness.close(); }
});

test('完整加载期间显示准备状态并可取消，保留已加载画面和参数', async t => {
  const { app, state } = await setup(t); const harness = workbenchHarness(app); const { w } = harness;
  let release; let pending; let cancelled = false;
  try {
    await harness.mount(); await w.runQuery(); const previous = w.snapshot.id; w.nudge(5, 0); const parameters = { ...w.parameters };
    state.fullGate = signal => new Promise(resolve => { release = resolve; signal.addEventListener('abort', () => { cancelled = true; }, { once: true }); });
    w.playing = true; pending = w.forceQuery(); await until(() => !!w.preparationId && !!release);
    assert.equal(w.busy, true); assert.equal(w.playing, false); assert.equal(w.snapshot.id, previous);
    await w.cancelQuery(); assert.equal(cancelled, true); release(); await pending;
    assert.match(w.error, /取消/); assert.equal(w.preparationId, null); assert.equal(w.busy, false);
    assert.equal(w.snapshot.id, previous); assert.deepEqual({ ...w.parameters }, parameters);
  } finally { release?.(); await pending; await harness.close(); }
});

test('完整加载失败保留旧数据，明确报错后可重新完整加载', async t => {
  const { app, state } = await setup(t); const harness = workbenchHarness(app); const { w } = harness;
  try {
    await harness.mount(); await w.runQuery(); const previous = w.snapshot.id;
    state.fullFail = true; await w.forceQuery(); assert.match(w.error, /完整时段读取失败/);
    assert.equal(w.snapshot.id, previous); assert.equal(w.preparationId, null); assert.equal(w.busy, false);
    state.fullFail = false; await w.forceQuery(); assert.equal(w.error, ''); assert.notEqual(w.snapshot.id, previous);
  } finally { await harness.close(); }
});

test('旧分窗历史按固定条件完整读取全组，打开后本地回放并保留原目录', async t => {
  const { app, group, state } = await setup(t); const old = await open(app, group); const harness = workbenchHarness(app); const { w } = harness;
  try {
    await harness.mount(); await w.openSession(old.id); assert.equal(w.error, '');
    assert.notEqual(w.session.id, old.id); assert.notEqual(w.session.mode, 'windowed'); assert.equal(w.snapshots.length, 2);
    assert.equal(w.dataset.radar.length, times.length * 2); assert.equal(w.start, start); assert.equal(w.end, end - 1);
    assert.equal(state.full.length, 1); assert.equal(state.windows.length, 0);
    await w.seekTo(start + 7200000); assert.equal(w.cursor, start + 7200000); assert.equal(state.full.length, 1);
    assert.ok((await app.inject('/api/playbacks')).json().some(value => value.id === old.id));
  } finally { await harness.close(); }
});

test('后台标定复用已加载完整输入，关闭页面和释放回放数据不取消计算', async t => {
  const { app, state } = await setup(t, false, true); const harness = workbenchHarness(app); const { w } = harness;
  try {
    await harness.mount(); await w.runQuery(); const snapshotId = w.snapshot.id; const hash = w.snapshot.hash;
    w.parameters = { ...DEMO_TRUTH }; await w.checkRefinement(); assert.equal(w.error, ''); assert.equal(w.canStartFit, true);
    w.playing = true; await w.startFit(); assert.equal(w.error, ''); assert.equal(w.task.snapshotId, snapshotId);
    assert.equal(w.preparationId, null); assert.equal(w.playing, true); assert.equal(state.full.length, 1);
    const id = w.task.id; await harness.close(); const completed = await waitForTask(app, id);
    assert.equal(completed.status, 'completed', completed.error); assert.equal(completed.snapshotHash, hash);
    assert.deepEqual(completed.dataRange, { start, end }); assert.equal(state.full.length, 1);
  } finally { await harness.close(); }
});

test('后台标定固定提交设置，轮询完成后可在完整回放中预览候选', async t => {
  const { app } = await setup(t, false, true); const harness = workbenchHarness(app); const { w } = harness;
  try {
    await harness.mount(); await w.runQuery(); const maxGapMs = w.fitOptions.maxGapMs;
    w.parameters = { ...DEMO_TRUTH }; await w.checkRefinement(); assert.equal(w.error, ''); assert.equal(w.canStartFit, true);
    await w.startFit(); const id = w.task.id; w.fitOptions.maxGapMs = 0;
    const completed = await waitForTask(app, id); assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.options.maxGapMs, maxGapMs); await harness.poll(); assert.equal(w.task.status, 'completed');
    const current = { ...w.parameters }; w.previewCandidate(0); assert.equal(w.comparison.index, 0); assert.deepEqual({ ...w.parameters }, current);
    w.applyCandidate(); assert.equal(w.candidateIndex, 0); assert.equal(w.fitOptions.maxGapMs, maxGapMs);
  } finally { await harness.close(); }
});

test('完整快照的标定任务仍可从历史打开并预览', async t => {
  const { app, group } = await setup(t); const old = await open(app, group);
  const prepared = await app.inject({ method: 'POST', url: `/api/playbacks/${old.id}/prepare`, payload: { radarId: old.radarIds[0] } });
  assert.equal(prepared.statusCode, 200, prepared.body);
  const accepted = await app.inject({ method: 'POST', url: '/api/tasks', payload: { snapshotId: prepared.json().snapshotId, options: DEFAULT_FIT_OPTIONS } });
  const task = await waitForTask(app, accepted.json().id); assert.equal(task.status, 'completed', task.error);
  const harness = workbenchHarness(app); const { w } = harness;
  try {
    await harness.mount(); await w.openTask(task.id); assert.equal(w.error, ''); assert.equal(w.snapshot.id, task.snapshotId);
    w.previewCandidate(0); assert.equal(w.comparison.index, 0); w.applyCandidate(); assert.equal(w.candidateIndex, 0);
  } finally { await harness.close(); }
});
