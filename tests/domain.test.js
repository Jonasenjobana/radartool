import test from 'node:test';
import assert from 'node:assert/strict';
import { angleDifference, enuToWgs84, geographicBounds, inGeographicBounds, moveParameters, parameterDifference, polarToEnu, toEcef, wgs84ToEnu } from '../shared/geo.js';
import { canonicalJson, DEFAULT_FIT_OPTIONS, normalizeDataset } from '../shared/data.js';
import { aisAtTime, balancedSample, createAisIndex, createAisStaticIndex, latestAisAtTime } from '../shared/alignment.js';
import { likelihood, makeShipModel, prepareFit, shipDensity } from '../shared/model.js';
import { createDemoDataset, DEMO_REFERENCE, DEMO_START } from './fixtures/demo.js';

const close = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} 与 ${b} 相差超过 ${tolerance}`);

test('地图正向、反向拖框得到相同经纬度范围，包含边界位置', () => {
  const a = { lng: 117.1, lat: 23.4 }; const b = { lng: 117.3, lat: 23.2 };
  const bounds = { west: 117.1, east: 117.3, south: 23.2, north: 23.4 };
  assert.deepEqual(geographicBounds(a, b), bounds);
  assert.deepEqual(geographicBounds(b, a), bounds);
  assert.equal(inGeographicBounds(a, bounds), true);
  assert.equal(inGeographicBounds(b, bounds), true);
  assert.equal(inGeographicBounds({ lng: 117.2, lat: 23.3 }, bounds), true);
  assert.equal(inGeographicBounds({ lng: 117.31, lat: 23.3 }, bounds), false);
});

test('WGS84 原点、已知轴向和固定 ENU 正反算', () => {
  const zero = toEcef({ lng: 0, lat: 0 });
  close(zero[0], 6378137); close(zero[1], 0); close(zero[2], 0);
  for (const reference of [{ lng: 0, lat: 0 }, DEMO_REFERENCE, { lng: -78, lat: -42 }, { lng: 179.99, lat: 70 }]) {
    for (const position of [{ east: 0, north: 0 }, { east: 1000, north: -2000 }, { east: -22000, north: 18000 }]) {
      const restored = wgs84ToEnu(enuToWgs84(position, reference), reference);
      close(restored.east, position.east, 1e-6); close(restored.north, position.north, 1e-6);
    }
  }
  const north = polarToEnu({ rangeM: 100, azimuthDeg: 0 }, { east: 20, north: 30, bearingOffsetDeg: 0 });
  close(north.east, 20); close(north.north, 130);
  const east = polarToEnu({ rangeM: 100, azimuthDeg: 0 }, { east: 20, north: 30, bearingOffsetDeg: 90 });
  close(east.east, 120); close(east.north, 30);
  close(angleDifference(0.1, 359.9), 0.2);
});

test('手动米制移动后重新投影，暂停数据与原始观测保持不变', () => {
  const observation = { rangeM: 1300, azimuthDeg: 23 };
  const parameters = { ...DEMO_REFERENCE, bearingOffsetDeg: 174 };
  const before = polarToEnu(observation, parameters, DEMO_REFERENCE);
  const moved = moveParameters(parameters, 5, -8, DEMO_REFERENCE);
  const after = polarToEnu(observation, moved, DEMO_REFERENCE);
  close(after.east - before.east, 5); close(after.north - before.north, -8);
  assert.deepEqual(observation, { rangeM: 1300, azimuthDeg: 23 });
});

test('候选减当前使用固定 ENU 位移和最短角差，跨北向与日期变更线仍为局部差值', () => {
  const current = { ...enuToWgs84({ east: 10, north: -25 }, DEMO_REFERENCE), bearingOffsetDeg: 359.8 };
  const candidate = { ...enuToWgs84({ east: 13, north: -21 }, DEMO_REFERENCE), bearingOffsetDeg: 0.2 };
  const before = structuredClone({ current, candidate });
  const delta = parameterDifference(current, candidate, DEMO_REFERENCE);
  close(delta.eastM, 3); close(delta.northM, 4); close(delta.distanceM, 5); close(delta.bearingDeg, 0.4);
  close(delta.lngDeg, candidate.lng - current.lng); close(delta.latDeg, candidate.lat - current.lat);
  const reverse = parameterDifference(candidate, current, DEMO_REFERENCE);
  close(reverse.eastM, -3); close(reverse.northM, -4); close(reverse.bearingDeg, -0.4);
  assert.deepEqual({ current, candidate }, before);
  const west = { lng: 179.999, lat: 0, bearingOffsetDeg: 1 }; const east = { lng: -179.999, lat: 0, bearingOffsetDeg: 359 };
  const crossing = parameterDifference(west, east, west);
  close(crossing.lngDeg, 0.002); close(crossing.bearingDeg, -2);
  close(crossing.eastM, 222.639, 0.001); close(crossing.northM, 0);
  assert.deepEqual(parameterDifference(current, current, DEMO_REFERENCE), { lngDeg: 0, latDeg: 0, bearingDeg: 0, eastM: 0, northM: 0, distanceM: 0 });
});

test('多站同报告去重保留原始接收证据与真实毫秒', () => {
  const raw = createDemoDataset({ end: DEMO_START + 4000 });
  raw.ais[0].eventTime = '2026-11-10T02:00:00.123Z';
  raw.ais[1].eventTime = '2026-11-10T10:00:00.123+08:00';
  const copy = structuredClone(raw);
  const { dataset, summary } = normalizeDataset(raw);
  assert.equal(summary.deduplicated, 3);
  const point = dataset.ais.find((p) => p.mmsi === '413000101');
  assert.equal(point.timeMs, DEMO_START + 123);
  assert.deepEqual(point.sourceIds, ['ais-east', 'ais-west']);
  assert.deepEqual(point.raw.reports[0].sourceIds, ['ais-east']);
  assert.equal(point.raw.reports[0].receiveTime, raw.ais[0].receiveTime);
  assert.equal(point.raw.reports[1].receiveTime, raw.ais[1].receiveTime);
  assert.deepEqual(raw, copy);
});

test('同 MMSI 同时刻不同消息类型保留，冲突位置排除而不删除证据', () => {
  const raw = createDemoDataset({ end: DEMO_START + 4000, sourceIds: ['ais-east'] });
  const differentType = { ...structuredClone(raw.ais[0]), id: 'type-18', messageType: '18' };
  raw.ais.push(differentType);
  assert.equal(normalizeDataset(raw).dataset.ais.filter((p) => p.mmsi === differentType.mmsi).length, 2);
  raw.ais.push({ ...structuredClone(raw.ais[0]), id: 'conflict', position: { lng: raw.ais[0].position.lng + 0.005, lat: raw.ais[0].position.lat } });
  const { dataset, summary } = normalizeDataset(raw);
  assert.equal(summary.conflicts, 3);
  assert.equal(dataset.ais.length, 5);
  assert.equal(aisAtTime(createAisIndex(dataset), DEMO_START, 2000).some((p) => p.mmsi === differentType.mmsi), false);
});

test('COG 按参考项目直接保留换算值，不拦截超过 360 的值或改写 360', () => {
  const raw = createDemoDataset({ end: DEMO_START + 4000, sourceIds: ['ais-east'] });
  raw.ais = [360, 360.1, 409.5].map((cogDeg, index) => ({ ...raw.ais[0], id: `cog-${index}`, cogDeg }));
  const before = structuredClone(raw);
  const { dataset } = normalizeDataset(raw);
  assert.deepEqual(dataset.ais.map((point) => point.cogDeg), [360, 360.1, 409.5]);
  assert.deepEqual(raw, before);
});

test('合法零坐标和零速度保留，协议不可用值与缺失尺寸分开处理', () => {
  const raw = createDemoDataset({ end: DEMO_START + 4000, sourceIds: ['ais-east'] });
  raw.ais[0].position = { lng: 0, lat: 0 }; raw.ais[0].sogKnots = 0;
  raw.ais[0].headingDeg = 511; raw.ais[0].cogDeg = 360;
  Object.assign(raw.ais[0].dimensions, { bow: 0, stern: 0, port: 0, starboard: 0 });
  raw.ais[1].sogKnots = 102.3;
  const normalized = normalizeDataset(raw).dataset;
  const point = normalized.ais.find((p) => p.id === raw.ais[0].id);
  assert.deepEqual(point.position, { lng: 0, lat: 0 }); assert.equal(point.sogKnots, 0);
  assert.equal(point.headingDeg, null); assert.equal(point.cogDeg, 360); assert.equal(point.dimensions, null);
  assert.equal(point.raw.unavailableValues.headingDeg, 511);
  assert.equal(point.raw.unavailableValues.dimensions.bow, 0);
  assert.equal(normalized.ais.find((p) => p.id === raw.ais[1].id).sogKnots, null);
});

test('拒绝无时区时间、负距离、跨雷达混入和重复观测 ID', () => {
  for (const mutate of [
    (data) => { data.radar[0].eventTime = '2026-11-10T02:00:00'; },
    (data) => { data.radar[0].rangeM = -1; },
    (data) => { data.radar[0].deviceId = 'other'; },
    (data) => { data.radar[1].id = data.radar[0].id; },
  ]) {
    const raw = createDemoDataset({ end: DEMO_START + 4000 }); mutate(raw);
    assert.throws(() => normalizeDataset(raw));
  }
});

test('时间对齐使用真实时刻，小窗口以外不插值或外推', () => {
  const dataset = normalizeDataset(createDemoDataset()).dataset;
  const index = createAisIndex(dataset);
  assert.equal(aisAtTime(index, DEMO_START + 2000, 2000).length, 3);
  assert.equal(aisAtTime(index, DEMO_START - 2001, 2000).length, 0);
  assert.equal(aisAtTime(index, DEMO_START + 260000, 2000).length, 2);
  assert.equal(aisAtTime(index, DEMO_START + 260000, 500).every((p) => Math.abs(p.deltaMs) <= 500), true);
});

test('AIS 显示按 MMSI 长期保留最后位置，新报告更新，跳转回退不使用未来位置', () => {
  const base = normalizeDataset(createDemoDataset({ end: DEMO_START + 4000, sourceIds: ['ais-east'] })).dataset.ais[0];
  const report = (id, mmsi, offset, position) => ({ ...base, id, mmsi, eventTime: new Date(DEMO_START + offset).toISOString(), timeMs: DEMO_START + offset, position });
  const first = report('a-first', '123456789', 0, { lng: 117.1, lat: 23.3 });
  const next = report('a-next', '123456789', 60000, { lng: 117.11, lat: 23.31 });
  const other = report('b-first', '234567890', 15000, { lng: 117.12, lat: 23.32 });
  const lowerQuality = { ...next, id: 'a-low-quality', headingDeg: null, dimensions: null, accuracyM: null };
  const dataset = { reference: DEMO_REFERENCE, ais: [next, other, lowerQuality, first] };
  const before = structuredClone(dataset);
  const index = createAisIndex(dataset);
  assert.equal(latestAisAtTime(index, DEMO_START - 1).length, 0);
  const paused = latestAisAtTime(index, DEMO_START + 59000);
  assert.equal(paused.length, 2);
  assert.equal(paused.find((point) => point.mmsi === first.mmsi).id, first.id);
  assert.equal(paused.find((point) => point.mmsi === first.mmsi).deltaMs, 59000);
  const updated = latestAisAtTime(index, DEMO_START + 60000);
  assert.equal(updated.find((point) => point.mmsi === first.mmsi).id, next.id);
  assert.deepEqual(updated.find((point) => point.mmsi === first.mmsi).position, next.position);
  const later = latestAisAtTime(index, DEMO_START + 1800000);
  assert.equal(later.length, 2);
  assert.deepEqual(later.find((point) => point.mmsi === first.mmsi).position, next.position);
  const rewound = latestAisAtTime(index, DEMO_START + 5000);
  assert.equal(rewound.length, 1); assert.equal(rewound[0].id, first.id);
  assert.equal(aisAtTime(index, DEMO_START + 45000, 2000).length, 0);
  assert.deepEqual(dataset, before);
});

test('后到静态尺寸立即更新已有船位，更新、过期和回退均按回放时间恢复', () => {
  const raw = createDemoDataset({ end: DEMO_START + 5000, sourceIds: ['ais-east'] });
  const point = { ...raw.ais[0], dimensions: null }; raw.ais = [point];
  const report = (id, offset, bow, sourceId = 'ais-east', mmsi = point.mmsi) => {
    const eventTime = new Date(DEMO_START + offset).toISOString();
    return { id, sourceIds: [sourceId], mmsi, eventTime, messageType: '5', mappingVersion: 'test-static-v1', raw: { id }, dimensions: { bow, stern: 10, port: 4, starboard: 5, observedAt: eventTime, validFrom: eventTime, validTo: raw.timeRange.end, sourceId } };
  };
  raw.aisStatic = [report('new-size', 3000, 80), report('first-size', 1000, 40), report('other-source', 2000, 200, 'ais-west'), report('other-ship', 2000, 300, 'ais-east', '123456789')];
  const before = structuredClone(raw);
  const { dataset, summary } = normalizeDataset(raw);
  const index = createAisIndex(dataset); const staticIndex = createAisStaticIndex(dataset.aisStatic);
  const stateAt = (offset) => latestAisAtTime(index, DEMO_START + offset, staticIndex)[0];
  assert.equal(summary.aisPoints, 1);
  assert.equal(stateAt(999).dimensions, null);
  const updated = stateAt(1000);
  assert.equal(updated.dimensions.bow, 40);
  assert.equal(updated.id, point.id); assert.equal(updated.timeMs, DEMO_START);
  assert.equal(updated.eventTime, point.eventTime); assert.equal(updated.deltaMs, 1000);
  assert.deepEqual(updated.position, point.position);
  assert.equal(stateAt(2500).dimensions.bow, 40);
  assert.equal(stateAt(3000).dimensions.bow, 80);
  assert.equal(stateAt(5000).dimensions, null);
  assert.equal(stateAt(1500).dimensions.bow, 40);
  assert.equal(stateAt(500).dimensions, null);
  assert.equal(latestAisAtTime(index, DEMO_START + 2500, staticIndex).length, 1);
  assert.equal(aisAtTime(index, DEMO_START + 1000, 2000)[0].dimensions, null);
  assert.equal(latestAisAtTime(createAisIndex({ ...dataset, ais: [] }), DEMO_START + 3000, staticIndex).length, 0);
  assert.deepEqual(raw, before); assert.equal(dataset.ais[0].dimensions, null);
});

test('静态尺寸记录参与时间范围和导入校验，旧数据缺省为空', () => {
  const raw = createDemoDataset({ end: DEMO_START + 4000, sourceIds: ['ais-east'] });
  assert.deepEqual(normalizeDataset(raw).dataset.aisStatic, []);
  const point = raw.ais[0];
  const report = { id: 'static', sourceIds: ['ais-east'], mmsi: point.mmsi, eventTime: point.eventTime, messageType: '5', mappingVersion: 'test-static-v1', dimensions: { ...point.dimensions, sourceId: 'ais-east' } };
  raw.aisStatic = [report];
  assert.equal(normalizeDataset(raw).dataset.aisStatic[0].timeMs, DEMO_START);
  raw.aisStatic = [report, report];
  assert.throws(() => normalizeDataset(raw), /静态观测 ID 重复/);
  raw.aisStatic = [{ ...report, eventTime: raw.timeRange.end }];
  assert.throws(() => normalizeDataset(raw), /半开时间范围/);
  raw.aisStatic = [{ ...report, dimensions: { ...report.dimensions, sourceId: 'another-source' } }];
  assert.throws(() => normalizeDataset(raw), /尺寸来源不一致/);
  raw.aisStatic = [{ ...report, dimensions: { ...report.dimensions, bow: 0, stern: 0 } }];
  assert.throws(() => normalizeDataset(raw), /尺寸不可用/);
});

test('完整请求时段保留首尾缺报与空数据覆盖，越界观测明确失败', () => {
  const raw = createDemoDataset();
  raw.timeRange = { start: new Date(DEMO_START - 60000).toISOString(), end: new Date(DEMO_START + 660000).toISOString() };
  const normalized = normalizeDataset(raw);
  assert.equal(normalized.summary.start, DEMO_START - 60000);
  assert.equal(normalized.summary.end, DEMO_START + 660000);
  assert.equal(normalized.summary.coverage[0].radar, 0);
  assert.equal(normalized.summary.coverage.at(-1).ais, 0);
  const empty = normalizeDataset({ ...raw, radar: [], ais: [] });
  assert.equal(empty.summary.start, DEMO_START - 60000);
  assert.equal(empty.summary.end, DEMO_START + 660000);
  assert.ok(empty.summary.coverage.every((bin) => bin.ais === 0 && bin.radar === 0));
  raw.timeRange.end = new Date(DEMO_START + 1000).toISOString();
  assert.throws(() => normalizeDataset(raw), /半开时间范围/);
});

test('采样控制高频轨迹贡献并覆盖时间，结果可复现', () => {
  const dense = Array.from({ length: 1000 }, (_, i) => ({ id: `a${i}`, deviceId: 'r', trackId: 'a', timeMs: i }));
  const sparse = Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, deviceId: 'r', trackId: 'b', timeMs: i * 50 }));
  const sample = balancedSample([...dense, ...sparse], 40);
  assert.equal(sample.filter((p) => p.trackId === 'b').length, 20);
  assert.equal(new Set(sample.map((p) => p.id)).size, 40);
  assert.deepEqual(sample, balancedSample([...sparse, ...dense], 40));
});

test('船体与高斯卷积密度归一化，缺船艏向不使用 COG', () => {
  const dataset = normalizeDataset(createDemoDataset()).dataset;
  const point = aisAtTime(createAisIndex(dataset), DEMO_START, 2000)[0];
  const ship = makeShipModel(point, DEMO_START, 1000, DEFAULT_FIT_OPTIONS);
  let integral = 0;
  for (let east = -220; east <= 220; east += 3) for (let north = -220; north <= 220; north += 3) integral += shipDensity({ east: ship.east + east, north: ship.north + north }, ship) * 9;
  close(integral, 1, 0.002);
  const fallback = makeShipModel({ ...point, headingDeg: null, cogDeg: 90 }, DEMO_START, 1000, DEFAULT_FIT_OPTIONS);
  assert.equal(fallback.kind, 'gaussian'); assert.ok(fallback.qualityWeight < 1);
  close(shipDensity({ east: fallback.east + 30, north: fallback.north }, fallback), shipDensity({ east: fallback.east, north: fallback.north + 30 }, fallback), 1e-12);
  const expired = makeShipModel({ ...point, dimensions: { ...point.dimensions, validTo: new Date(DEMO_START).toISOString() } }, DEMO_START, 1000, DEFAULT_FIT_OPTIONS);
  assert.equal(expired.kind, 'gaussian');
});

test('自动标定过滤超出 30 km 的 AIS 观测，关联输入不受远处目标影响且保留原始数据', () => {
  const dataset = normalizeDataset(createDemoDataset()).dataset;
  const expected = prepareFit(dataset, DEFAULT_FIT_OPTIONS);
  const far = dataset.ais.filter((point) => point.mmsi === dataset.ais[0].mmsi).map((point) => ({ ...point, id: `far-${point.id}`, mmsi: '413999999', position: enuToWgs84({ east: 40000, north: 0 }, dataset.reference) }));
  const mixed = { ...dataset, ais: [...dataset.ais, ...far] };
  const original = JSON.stringify(mixed);
  const actual = prepareFit(mixed, DEFAULT_FIT_OPTIONS);
  assert.deepEqual(actual.training, expected.training);
  assert.deepEqual(actual.validation, expected.validation);
  assert.equal(actual.exclusions.outsideLocalAisPoints, far.length);
  assert.equal(JSON.stringify(mixed), original);
});

test('30 km 范围按 AIS 观测逐点过滤，同船范围内的位置继续参与拟合', () => {
  const dataset = normalizeDataset(createDemoDataset()).dataset;
  const first = dataset.ais[0];
  dataset.ais[0] = { ...first, position: enuToWgs84({ east: 40000, north: 0 }, dataset.reference) };
  for (const [index, local] of [{ east: 29999.9, north: 0 }, { east: 0, north: -29999.9 }, { east: 30000.1, north: 0 }, { east: 22000, north: 22000 }].entries()) {
    dataset.ais.push({ ...first, id: `edge-${index}`, mmsi: `41399900${index}`, position: enuToWgs84(local, dataset.reference) });
  }
  const context = prepareFit(dataset, { ...DEFAULT_FIT_OPTIONS, maxFitPoints: 1000 });
  assert.equal(context.exclusions.outsideLocalAisPoints, 3);
  const firstRow = context.training.find((row) => row.timeMs === first.timeMs);
  assert.ok(firstRow.ships.some((ship) => ship.mmsi === '413999000'));
  assert.ok(firstRow.ships.some((ship) => ship.mmsi === '413999001'));
  assert.ok(!firstRow.ships.some((ship) => ship.mmsi === '413999002' || ship.mmsi === '413999003' || ship.mmsi === first.mmsi));
  assert.ok(context.training.some((row) => row.ships.some((ship) => ship.mmsi === first.mmsi)));
});

test('背景与船舶后验总和为一，候选使用同一观测和固定研究区域', () => {
  const dataset = normalizeDataset(createDemoDataset()).dataset;
  const context = prepareFit(dataset, DEFAULT_FIT_OPTIONS);
  const result = likelihood(context.training, { east: 42, north: -28, bearingOffsetDeg: 347.4 }, context.backgroundDensity, true);
  for (const point of result.posterior) close(point.background + point.ships.reduce((sum, v) => sum + v, 0), 1, 1e-12);
  assert.ok(context.training.every((p) => p.timeMs < context.splitTime));
  assert.ok(context.validation.every((p) => p.timeMs >= context.splitTime));
  assert.equal(context.training.length, 240); assert.equal(context.validation.length, 120);
  assert.ok(context.exclusions.noAlignedAis >= 0);
  assert.equal(canonicalJson({ b: 1, a: [2, 3] }), canonicalJson({ a: [2, 3], b: 1 }));
});
