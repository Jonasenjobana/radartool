import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FIT_OPTIONS, fitOptionsSchema, normalizeDataset, parseInput } from '../shared/data.js';
import { enuToWgs84 } from '../shared/geo.js';

const start = Date.parse('2026-11-10T00:00:00Z');
const reference = { lng: 122.12, lat: 30.12 };
const initial = { ...reference, bearingOffsetDeg: 0 };
const iso = offset => new Date(start + offset).toISOString();

function fixture({ times = [0, 4000, 8000, 12000, 16000, 20000, 24000, 28000, 32000, 36000], radarAt, aisAt, end = 40000 } = {}) {
  const radar = []; const ais = [];
  for (const offset of times) {
    const location = { east: 100 + offset / 1000, north: 500 };
    const targets = radarAt?.(offset, location) ?? [{ trackId: 'tracked', ...location }];
    for (const [index, point] of targets.entries()) radar.push({
      id: `radar-${offset}-${index}`, sourceId: 'radar', deviceId: 'radar', trackId: point.trackId,
      eventTime: iso(offset), rangeM: Math.hypot(point.east, point.north),
      azimuthDeg: Math.atan2(point.east, point.north) * 180 / Math.PI,
      mappingVersion: 'fixture', quality: [], raw: {},
    });
    const ships = aisAt?.(offset, location) ?? [{ mmsi: '123456789', ...location }];
    for (const [index, ship] of ships.entries()) ais.push({
      id: `ais-${offset}-${index}`, sourceIds: ['ais'], mmsi: ship.mmsi,
      eventTime: iso(offset), messageType: '1', position: enuToWgs84(ship, reference),
      headingDeg: ship.headingDeg ?? null, cogDeg: ship.cogDeg ?? null,
      dimensions: ship.dimensions ?? null, mappingVersion: 'fixture', quality: [], raw: {},
    });
  }
  return normalizeDataset({ schemaVersion: 1, name: '精调筛选夹具', projectId: 'test', radarId: 'radar', reference, baseline: initial,
    timeRange: { start: iso(0), end: iso(end) }, timeSemantics: 'event-time', unitsVerified: true, alignmentVerified: true,
    radar, ais, provenance: {}, warnings: [],
  }).dataset;
}

function refinementOptions(refinement = {}, other = {}) {
  return parseInput(fitOptionsSchema, { ...DEFAULT_FIT_OPTIONS, maxGapMs: 0, ...other, refinement: { initial, maxDistanceM: 40, ...refinement } });
}

test('精调选项保留冻结初值并补齐工程门限，旧设置保持关闭精调', () => {
  const initial = { lng: 122.12, lat: 30.12, bearingOffsetDeg: 359 };
  const options = parseInput(fitOptionsSchema, { ...DEFAULT_FIT_OPTIONS, refinement: { initial } });
  assert.deepEqual(options.refinement, {
    initial, maxDistanceM: 200, maxPositionShiftM: 100, maxBearingShiftDeg: 5,
    minTrackPoints: 4, minTrackDurationMs: 12000, motionToleranceM: 75,
    radarExclusion: null, associationIds: null,
  });
  assert.equal(parseInput(fitOptionsSchema, DEFAULT_FIT_OPTIONS).refinement, null);
});

test('先剔除不靠近船舶的雷达，稳定关联和检查摘要只使用训练时段', async () => {
  const { selectRefinementObservations } = await import('../shared/refinement.js');
  const dataset = fixture({ radarAt: (offset, location) => [
    { trackId: 'tracked', ...location },
    ...Array.from({ length: 80 }, (_, index) => ({ trackId: `noise-${index}`, east: 2000 + offset / 1000, north: index * 100 })),
  ] });
  const before = structuredClone(dataset);
  const selected = selectRefinementObservations(dataset, refinementOptions());
  assert.deepEqual(selected.associations.map(({ id, points, start: first, end }) => ({ id, points, first, end })), [
    { id: '["radar","tracked","123456789"]', points: 7, first: start, end: start + 24000 },
  ]);
  assert.equal(selected.splitTime, start + 28000);
  assert.equal(selected.training.length, 7); assert.equal(selected.validation.length, 3);
  assert.ok([...selected.training, ...selected.validation].every(row => row.observation.trackId === 'tracked' && row.ship.mmsi === '123456789'));
  assert.equal(selected.exclusions.notNearbyPoints, 800);
  assert.deepEqual(dataset, before);
});

test('雷达排除区域包含边界，船体余量只读取同时有效且已知的原始尺寸', async () => {
  const { selectRefinementObservations } = await import('../shared/refinement.js');
  const dimensions = { bow: 80, stern: 20, port: 10, starboard: 10, observedAt: iso(0), validFrom: iso(0), validTo: iso(40000), sourceId: 'ais' };
  const dataset = fixture({
    radarAt: () => [{ trackId: 'boundary', east: 0, north: 500 }, { trackId: 'hull', east: 200, north: 500 }],
    aisAt: () => [{ mmsi: '123456789', east: 100, north: 500, dimensions, cogDeg: 90 }],
  });
  const options = refinementOptions({ radarExclusion: { minEast: -10, maxEast: 0, minNorth: 450, maxNorth: 550 } });
  const selected = selectRefinementObservations(dataset, options);
  assert.equal(selected.exclusions.radarExclusionPoints, 10);
  assert.deepEqual(selected.associations.map(row => row.trackId), ['hull']);
  assert.ok(selected.training.every(row => row.ship.headingDeg === null && row.ship.cogDeg === 90));
  const future = structuredClone(dataset);
  for (const point of future.ais) point.dimensions.observedAt = iso(30000);
  assert.equal(selectRefinementObservations(future, options).associations.length, 0);
  const expired = structuredClone(dataset);
  for (const point of expired.ais) point.dimensions.validTo = iso(1000);
  assert.equal(selectRefinementObservations(expired, options).associations.length, 0);
});

test('瞬时靠近、零散靠近、长断报和同轨迹标识的位移突变不能拼成稳定关联', async () => {
  const { selectRefinementObservations } = await import('../shared/refinement.js');
  const cases = [
    fixture({ radarAt: (offset, location) => [{ trackId: 'tracked', ...location, east: location.east + (offset <= 4000 ? 0 : 500) }] }),
    fixture({ radarAt: (offset, location) => [{ trackId: 'tracked', ...location, east: location.east + (offset % 8000 === 0 ? 0 : 500) }] }),
    fixture({ times: [0, 4000, 100000, 104000], end: 160000 }),
    fixture({ times: [0, 4000, 8000, 12000], end: 24000, radarAt: (offset, location) => [{ trackId: 'tracked', ...location, east: location.east + (offset < 8000 ? -50 : 50) }] }),
  ];
  for (const dataset of cases) {
    const selected = selectRefinementObservations(dataset, refinementOptions({ maxDistanceM: 100 }));
    assert.deepEqual(selected.associations, []);
    assert.deepEqual(selected.training, []);
  }
});

test('多回波和同轨迹竞争保留摘要，人工选择后每条雷达观测只归属一次并拒绝未知关联', async () => {
  const { selectRefinementObservations } = await import('../shared/refinement.js');
  const dataset = fixture({
    radarAt: (_offset, location) => [{ trackId: 'tracked', ...location }, { trackId: 'echo', ...location }],
    aisAt: (_offset, location) => [{ mmsi: '123456789', ...location, east: location.east + 5 }, { mmsi: '987654321', ...location, east: location.east + 15 }],
  });
  const preview = selectRefinementObservations(dataset, refinementOptions());
  assert.equal(preview.associations.length, 4);
  assert.ok(preview.associations.every(row => row.points === 7));
  assert.equal(preview.training.length, 14); assert.equal(preview.validation.length, 6);
  assert.equal(new Set(preview.training.map(row => row.observation.id)).size, 14);
  assert.ok(preview.training.every(row => row.ship.mmsi === '123456789'));
  assert.equal(preview.exclusions.competingPoints, 20);
  const chosenId = '["radar","tracked","987654321"]';
  const chosen = selectRefinementObservations(dataset, refinementOptions({ associationIds: [chosenId] }));
  assert.equal(chosen.training.length, 7); assert.equal(chosen.validation.length, 3);
  assert.ok(chosen.training.every(row => row.ship.mmsi === '987654321' && row.associationId === chosenId));
  assert.equal(chosen.exclusions.manuallyExcludedPoints, 10);
  assert.throws(() => selectRefinementObservations(dataset, refinementOptions({ associationIds: ['unknown'] })), /未知.*关联/);
  assert.equal(selectRefinementObservations(dataset, refinementOptions({ associationIds: [] })).training.length, 0);
});

test('无法区分的等距竞争不自动取第一条，输入顺序不改变检查和保留结果', async () => {
  const { selectRefinementObservations } = await import('../shared/refinement.js');
  const dataset = fixture({ aisAt: (_offset, location) => [
    { mmsi: '123456789', ...location, east: location.east - 10 },
    { mmsi: '987654321', ...location, east: location.east + 10 },
  ] });
  const preview = selectRefinementObservations(dataset, refinementOptions());
  assert.equal(preview.associations.length, 2);
  assert.equal(preview.training.length, 0); assert.equal(preview.validation.length, 0);
  assert.equal(preview.exclusions.ambiguousPoints, 10);
  const options = refinementOptions({ associationIds: ['["radar","tracked","987654321"]'] });
  const selected = selectRefinementObservations(dataset, options);
  assert.equal(selected.training.length, 7); assert.equal(selected.validation.length, 3);
  const reversed = { ...dataset, radar: [...dataset.radar].reverse(), ais: [...dataset.ais].reverse() };
  assert.deepEqual(selectRefinementObservations(reversed, options), selected);
});

test('验证段延用训练确定的身份，不按验证近远换船，也不跨中断或重置续接轨迹', async () => {
  const { selectRefinementObservations } = await import('../shared/refinement.js');
  const competing = fixture({ aisAt: (offset, location) => [
    { mmsi: '123456789', ...location, east: location.east + (offset < 28000 ? 5 : 25) },
    { mmsi: '987654321', ...location, east: location.east + (offset < 28000 ? 15 : 1) },
  ] });
  const selected = selectRefinementObservations(competing, refinementOptions());
  assert.equal(selected.validation.length, 3);
  assert.ok(selected.validation.every(row => row.ship.mmsi === '123456789'));
  const cases = [
    fixture({ radarAt: (offset, location) => [{ trackId: 'tracked', ...location, east: location.east + (offset === 24000 ? 500 : 0) }] }),
    fixture({ times: [0, 4000, 8000, 12000, 72000, 76000], end: 100000 }),
    fixture({ radarAt: (offset, location) => [{ trackId: 'tracked', ...location, east: location.east + (offset === 28000 ? 500 : 0) }] }),
    fixture({ radarAt: (offset, location) => [{ trackId: 'tracked', ...location, east: location.east + (offset < 28000 ? -50 : 50) }] }),
  ];
  for (const dataset of cases) {
    const result = selectRefinementObservations(dataset, refinementOptions({ maxDistanceM: 100 }));
    assert.equal(result.associations.length, 1);
    assert.equal(result.validation.length, 0);
  }
});

test('持续靠近但相对位移持续漂移的雷达轨迹不能通过运动一致性', async () => {
  const { selectRefinementObservations } = await import('../shared/refinement.js');
  const dataset = fixture({ aisAt: (offset, location) => [{ mmsi: '123456789', ...location, east: 100 + offset * 0.006 }] });
  const selected = selectRefinementObservations(dataset, refinementOptions({ maxDistanceM: 200 }));
  assert.deepEqual(selected.associations, []);
  assert.equal(selected.training.length, 0);
});

test('已导入的静态尺寸仅从真实报告到达后参与筛选，不把后续尺寸带回训练时段', async () => {
  const { selectRefinementObservations } = await import('../shared/refinement.js');
  const dataset = fixture({ radarAt: (_offset, location) => [{ trackId: 'tracked', ...location, east: location.east + 100 }] });
  const dimensions = { bow: 80, stern: 20, port: 10, starboard: 10, observedAt: iso(0), validFrom: iso(0), validTo: iso(40000), sourceId: 'ais' };
  const report = { id: 'static', sourceIds: ['ais'], observationIds: ['static'], mmsi: '123456789', messageType: '5', eventTime: iso(0), timeMs: start,
    dimensions, raw: {}, mappingVersion: 'fixture', quality: [] };
  dataset.aisStatic = [report];
  const selected = selectRefinementObservations(dataset, refinementOptions());
  assert.equal(selected.associations.length, 1);
  assert.deepEqual(selected.training[0].ship.dimensions, dimensions);
  assert.equal(dataset.ais[0].dimensions, null);
  dataset.aisStatic = [{ ...report, eventTime: iso(16000), timeMs: start + 16000 }];
  assert.equal(selectRefinementObservations(dataset, refinementOptions()).associations.length, 0);
  dataset.aisStatic = [{ ...report, sourceIds: ['other'], dimensions: { ...dimensions, sourceId: 'other' } }];
  assert.equal(selectRefinementObservations(dataset, refinementOptions()).associations.length, 0);
});

test('训练关联不借用验证段真实报告，修改验证数据不改变训练摘要和固定样本', async () => {
  const { selectRefinementObservations } = await import('../shared/refinement.js');
  const dataset = fixture({ times: [0, 4000, 8000, 12000, 13500, 16000], end: 20000, aisAt: (offset, location) => offset === 13500 ? [] : [{ mmsi: '123456789', ...location }] });
  const future = { ...dataset.ais.at(-1), id: 'future', eventTime: iso(14000), timeMs: start + 14000,
    position: enuToWgs84({ east: 113.5, north: 500 }, reference) };
  dataset.ais.push(future);
  const options = refinementOptions({}, { maxGapMs: 1000 });
  const selected = selectRefinementObservations(dataset, options);
  assert.equal(selected.associations[0].points, 4);
  assert.equal(selected.training.length, 4);
  assert.ok(selected.training.every(row => row.ship.timeMs < start + 14000));
  const changed = structuredClone(dataset);
  for (const point of changed.ais) if (point.timeMs >= start + 14000) point.position = enuToWgs84({ east: 25000, north: 500 }, reference);
  const after = selectRefinementObservations(changed, options);
  assert.deepEqual(after.associations, selected.associations);
  assert.deepEqual(after.training, selected.training);
});

test('固定参考范围、拟合 AIS 区域和同刻位置冲突继续约束精调真实状态', async () => {
  const { selectRefinementObservations } = await import('../shared/refinement.js');
  const outside = fixture({ radarAt: () => [{ trackId: 'tracked', east: 31000, north: 500 }], aisAt: () => [{ mmsi: '123456789', east: 31000, north: 500 }] });
  const local = selectRefinementObservations(outside, refinementOptions());
  assert.equal(local.associations.length, 0); assert.equal(local.exclusions.outsideLocalAisPoints, 10);
  const roi = selectRefinementObservations(fixture(), refinementOptions({}, { roi: { minEast: -10, maxEast: 50, minNorth: 0, maxNorth: 1000 } }));
  assert.equal(roi.associations.length, 0);
  const conflict = fixture({ aisAt: (_offset, location) => [{ mmsi: '123456789', ...location }, { mmsi: '123456789', ...location, east: location.east + 10 }] });
  const selected = selectRefinementObservations(conflict, refinementOptions());
  assert.equal(selected.associations.length, 0); assert.equal(selected.exclusions.conflictingAis, 20);
});

test('精调参数在公共输入边界拒绝越界门限和退化排除区域', () => {
  for (const refinement of [
    { maxDistanceM: 9 }, { maxDistanceM: 2001 }, { maxPositionShiftM: 0 },
    { maxBearingShiftDeg: 0.09 }, { maxBearingShiftDeg: 31 }, { minTrackPoints: 3.5 },
    { minTrackDurationMs: 999 }, { motionToleranceM: 1001 },
    { radarExclusion: { minEast: 0, maxEast: 0, minNorth: 0, maxNorth: 10 } },
  ]) assert.throws(() => refinementOptions(refinement));
});
