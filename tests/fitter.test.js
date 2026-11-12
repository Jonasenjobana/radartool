import test from 'node:test';
import assert from 'node:assert/strict';
import { runFit } from '../server/fitter.js';
import { createDemoDataset, DEMO_REFERENCE, DEMO_START, DEMO_TRUTH } from './fixtures/demo.js';
import { DEFAULT_FIT_OPTIONS, DEFAULT_REFINEMENT_OPTIONS, normalizeDataset } from '../shared/data.js';
import { angleDifference, enuToWgs84, normalizeAngle, polarToEnu, wgs84ToEnu } from '../shared/geo.js';
import { selectRefinementObservations } from '../shared/refinement.js';

function repolarize(angle) {
  const dataset = normalizeDataset(createDemoDataset()).dataset;
  const newOrigin = { east: -54, north: 86 };
  for (const point of dataset.radar) {
    const actual = polarToEnu(point, DEMO_TRUTH, DEMO_REFERENCE);
    point.rangeM = Math.hypot(actual.east - newOrigin.east, actual.north - newOrigin.north);
    point.azimuthDeg = normalizeAngle(Math.atan2(actual.east - newOrigin.east, actual.north - newOrigin.north) * 180 / Math.PI - angle);
  }
  dataset.baseline = { ...enuToWgs84({ east: 12000, north: -8000 }, DEMO_REFERENCE), bearingOffsetDeg: angle + 140 };
  dataset.provenance.truth = { lng: 0, lat: 0, bearingOffsetDeg: 0 };
  return dataset;
}

function checkedRefinement(dataset, initial, refinement = {}, options = {}) {
  const result = { ...DEFAULT_FIT_OPTIONS, ...options, refinement: { ...DEFAULT_REFINEMENT_OPTIONS, initial, ...refinement } };
  result.refinement.associationIds = selectRefinementObservations(dataset, result).associations.map(row => row.id);
  return result;
}

function exactRefinementDataset() {
  const raw = createDemoDataset({ end: DEMO_START + 120000, sourceIds: ['ais-east'] });
  const templates = ['413000101', '413000202', '413000303'].map(mmsi => raw.ais.find(point => point.mmsi === mmsi));
  const radarTemplate = raw.radar[0];
  raw.radar = []; raw.ais = [];
  const initial = { ...enuToWgs84({ east: 17, north: -23 }, DEMO_REFERENCE), bearingOffsetDeg: 359.41 };
  for (let t = 0; t < 120; t += 4) for (const [index, [east, north, ve, vn]] of [[350, -1500, 0.7, 4.1], [-1200, 780, 3.5, -0.65], [1400, 1000, -2.7, -2.3]].entries()) {
    const position = { east: east + ve * t, north: north + vn * t };
    const eventTime = new Date(DEMO_START + t * 1000).toISOString();
    raw.ais.push({ ...templates[index], id: `exact-ais-${index}-${t}`, eventTime, position: enuToWgs84(position, DEMO_REFERENCE), dimensions: null });
    raw.radar.push({ ...radarTemplate, id: `exact-radar-${index}-${t}`, trackId: `exact-${index}`, eventTime,
      rangeM: Math.hypot(position.east - 17, position.north + 23),
      azimuthDeg: normalizeAngle(Math.atan2(position.east - 17, position.north + 23) * 180 / Math.PI - initial.bearingOffsetDeg) });
  }
  return { dataset: normalizeDataset(raw).dataset, initial };
}

test('未知安装位置和跨 360° 朝向恢复；同船多点、断报及背景保留', () => {
  const dataset = normalizeDataset(createDemoDataset()).dataset;
  const original = JSON.stringify(dataset);
  const progress = [];
  const result = runFit(dataset, DEFAULT_FIT_OPTIONS, (p) => progress.push(p));
  const best = result.candidates[0];
  const truth = wgs84ToEnu(DEMO_TRUTH, DEMO_REFERENCE);
  assert.ok(Math.hypot(best.east - truth.east, best.north - truth.north) < 5);
  assert.ok(Math.abs(angleDifference(best.parameters.bearingOffsetDeg, DEMO_TRUTH.bearingOffsetDeg)) < 0.2);
  assert.equal(result.assessment, 'recommended');
  assert.ok(best.training.background > 0.1); assert.ok(best.validation.background > 0.1);
  assert.equal(result.heatmap.length, 81); assert.equal(result.angleProfile.length, 72);
  assert.equal(result.samplingVersion, 'track-time-balanced-chronological-v1');
  assert.equal(result.initialMetrics, undefined);
  assert.equal(progress.at(-1).fraction, 1);
  assert.equal(JSON.stringify(dataset), original);
});

for (const angle of [0.2, 90.7, 174.2, 270.4]) test(`全角度搜索恢复 ${angle}°，不依赖已有坐标或伪真值`, () => {
  const result = runFit(repolarize(angle), DEFAULT_FIT_OPTIONS);
  const best = result.candidates[0];
  assert.ok(Math.hypot(best.east + 54, best.north - 86) < 6, JSON.stringify(best.parameters));
  assert.ok(Math.abs(angleDifference(best.parameters.bearingOffsetDeg, angle)) < 0.2);
});

test('单船支持不能生成唯一推荐', () => {
  const raw = createDemoDataset();
  raw.ais = raw.ais.filter((p) => p.mmsi === '413000101');
  raw.radar = raw.radar.filter((p) => p.id.startsWith('radar-0-'));
  const result = runFit(normalizeDataset(raw).dataset, DEFAULT_FIT_OPTIONS);
  assert.equal(result.assessment, 'insufficient');
});

test('短轨迹占主导时降低支持并返回证据不足', () => {
  const dataset = normalizeDataset(createDemoDataset()).dataset;
  for (const point of dataset.radar) point.trackId = point.id;
  const result = runFit(dataset, DEFAULT_FIT_OPTIONS);
  assert.equal(result.assessment, 'insufficient');
  assert.equal(result.exclusions.shortTrackRows, result.candidates[0].training.points + result.candidates[0].validation.points);
  assert.ok(result.reasons.some((reason) => reason.includes('短轨迹')));
});

test('最佳位置停在安装搜索区边界时保留不确定状态', () => {
  const result = runFit(normalizeDataset(createDemoDataset()).dataset, { ...DEFAULT_FIT_OPTIONS, bounds: { minEast: -100, maxEast: 42, minNorth: -100, maxNorth: 100 }, positionStepM: 30 });
  assert.ok(result.candidates[0].onBoundary);
  assert.equal(result.assessment, 'insufficient');
});

test('对称数据保留相互竞争的安装朝向，不强制唯一解', () => {
  const template = createDemoDataset({ end: DEMO_START + 4000, sourceIds: ['ais-east'] });
  template.timeRange.end = new Date(DEMO_START + 124000).toISOString();
  template.radar = []; template.ais = [];
  const original = createDemoDataset({ end: DEMO_START + 4000, sourceIds: ['ais-east'] });
  for (let t = 0; t <= 120; t += 4) for (let ship = 0; ship < 3; ship++) {
    const angle = ship * 120;
    const r = 700 + t;
    const time = new Date(DEMO_START + t * 1000).toISOString();
    const local = { east: r * Math.sin(angle * Math.PI / 180), north: r * Math.cos(angle * Math.PI / 180) };
    template.radar.push({ ...original.radar[ship], id: `r-${t}-${ship}`, trackId: `T${ship}`, eventTime: time, rangeM: r, azimuthDeg: angle });
    template.ais.push({ ...original.ais[ship], id: `a-${t}-${ship}`, eventTime: time, position: enuToWgs84(local, DEMO_REFERENCE), sogKnots: 2, cogDeg: angle, headingDeg: angle, dimensions: { ...original.ais[ship].dimensions, bow: 20, stern: 20, port: 8, starboard: 8 } });
  }
  const result = runFit(normalizeDataset(template).dataset, { ...DEFAULT_FIT_OPTIONS, bounds: { minEast: -80, maxEast: 80, minNorth: -80, maxNorth: 80 }, positionStepM: 40, angleStepDeg: 10 });
  assert.equal(result.assessment, 'ambiguous', JSON.stringify(result.reasons));
  assert.ok(result.candidates.length >= 3);
  assert.ok(result.candidates.some((c) => Math.abs(angleDifference(c.parameters.bearingOffsetDeg, result.candidates[0].parameters.bearingOffsetDeg)) > 100));
});

test('未核实单位与时间、无可用对齐、过大搜索和局部范围无有效观测时明确失败', () => {
  const dataset = normalizeDataset(createDemoDataset()).dataset;
  assert.throws(() => runFit({ ...dataset, unitsVerified: false }, DEFAULT_FIT_OPTIONS), /核实/);
  assert.throws(() => runFit({ ...dataset, alignmentVerified: false }, DEFAULT_FIT_OPTIONS), /核实/);
  assert.throws(() => runFit({ ...dataset, ais: dataset.ais.map((p) => ({ ...p, timeMs: p.timeMs - 3600000 })) }, DEFAULT_FIT_OPTIONS), /对齐/);
  assert.throws(() => runFit(dataset, { ...DEFAULT_FIT_OPTIONS, bounds: { minEast: -1000, maxEast: 1000, minNorth: -1000, maxNorth: 1000 }, positionStepM: 10 }), /50,000/);
  assert.throws(() => runFit({ ...dataset, reference: { lng: 0, lat: 0 } }, DEFAULT_FIT_OPTIONS), /30 km 内没有可用于标定的 AIS 观测/);
});

test('自动精调拒绝未经关联检查或空的人工选择', () => {
  const dataset = normalizeDataset(createDemoDataset()).dataset;
  for (const associationIds of [null, []]) {
    assert.throws(() => runFit(dataset, {
      ...DEFAULT_FIT_OPTIONS,
      refinement: { ...DEFAULT_REFINEMENT_OPTIONS, initial: DEMO_TRUTH, associationIds },
    }), /关联检查.*至少.*关联/);
  }
});

test('附近筛选先于均衡配额，远离船舶的多轨迹不会挤占精调输入', () => {
  const dataset = normalizeDataset(createDemoDataset()).dataset;
  for (let track = 0; track < 300; track++) for (let frame = 0; frame < 4; frame++) {
    const point = dataset.radar[frame * 8];
    dataset.radar.push({ ...point, id: `far-${track}-${frame}`, trackId: `A-far-${track}`, rangeM: 15000 });
  }
  dataset.radar.sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
  const options = checkedRefinement(dataset, { ...DEMO_TRUTH, bearingOffsetDeg: 346.2 });
  const original = JSON.stringify({ dataset, options });
  const result = runFit(dataset, options);
  const best = result.candidates[0];
  const truth = wgs84ToEnu(DEMO_TRUTH, DEMO_REFERENCE);
  assert.ok(result.exclusions.notNearbyPoints >= 1200);
  assert.equal(result.samplingVersion, 'ais-guided-track-time-balanced-chronological-v1');
  assert.equal(best.training.points, 240);
  assert.equal(best.validation.points, 120);
  assert.ok(Math.hypot(best.east - truth.east, best.north - truth.north) < 5);
  assert.ok(Math.abs(angleDifference(best.parameters.bearingOffsetDeg, DEMO_TRUTH.bearingOffsetDeg)) < 0.2);
  assert.equal(JSON.stringify({ dataset, options }), original);
});

test('局部精调围绕冻结初值跨北向恢复，旧安装搜索框不限制精调', () => {
  const dataset = repolarize(0.2);
  const initial = { ...enuToWgs84({ east: -25, north: 65 }, DEMO_REFERENCE), bearingOffsetDeg: 358.5 };
  const options = checkedRefinement(dataset, initial, { maxPositionShiftM: 60, maxBearingShiftDeg: 3 }, {
    bounds: { minEast: 8000, maxEast: 8500, minNorth: 9000, maxNorth: 9500 },
    positionStepM: 30,
  });
  const original = JSON.stringify(options);
  const result = runFit(dataset, options);
  const best = result.candidates[0];
  assert.ok(Math.hypot(best.east + 54, best.north - 86) < 6);
  assert.ok(Math.abs(angleDifference(best.parameters.bearingOffsetDeg, 0.2)) < 0.2);
  assert.ok(Math.abs(result.options.bounds.minEast + 85) < 1e-6);
  assert.ok(Math.abs(result.options.bounds.maxEast - 35) < 1e-6);
  assert.ok(Math.abs(result.options.bounds.minNorth - 5) < 1e-6);
  assert.ok(Math.abs(result.options.bounds.maxNorth - 125) < 1e-6);
  assert.ok(result.candidates.every(candidate => Math.abs(candidate.east + 25) <= 60.000001 && Math.abs(candidate.north - 65) <= 60.000001 && Math.abs(angleDifference(candidate.parameters.bearingOffsetDeg, initial.bearingOffsetDeg)) <= 3.000001));
  assert.ok(result.angleProfile.every(row => Math.abs(angleDifference(row.angle, initial.bearingOffsetDeg)) <= 3.000001));
  assert.ok(result.angleProfile.some(row => row.angle < 5) && result.angleProfile.some(row => row.angle > 350));
  assert.ok(Math.abs(result.studyRegion.minEast + 100086) < 1e-6);
  assert.ok(Math.abs(result.studyRegion.maxEast - 100036) < 1e-6);
  assert.equal(JSON.stringify(options), original);
});

test('人工初值保留为候选并用相同样本评估；未稳定改进不推荐替换', () => {
  const { dataset, initial } = exactRefinementDataset();
  const options = checkedRefinement(dataset, initial, { maxPositionShiftM: 1, maxBearingShiftDeg: 0.1 }, { maxFitPoints: 30, maxValidationPoints: 15 });
  const result = runFit(dataset, options);
  const best = result.candidates[0];
  assert.ok(result.initialMetrics);
  assert.deepEqual(result.initialMetrics.training, best.training);
  assert.deepEqual(result.initialMetrics.validation, best.validation);
  assert.equal(result.initialMetrics.training.points, 30);
  assert.equal(result.initialMetrics.validation.points, 15);
  assert.equal(result.exclusions.trainUnsampled, 33);
  assert.equal(result.exclusions.validationUnsampled, 12);
  assert.ok(Math.abs(best.east - 17) < 1e-6 && Math.abs(best.north + 23) < 1e-6);
  assert.ok(Math.abs(angleDifference(best.parameters.bearingOffsetDeg, initial.bearingOffsetDeg)) < 1e-9);
  assert.equal(result.assessment, 'insufficient');
  assert.ok(result.reasons.some(reason => reason.includes('未') && reason.includes('改进')));
});

test('局部角度修正到达上限时保留边界证据，EM 不越过角度范围', () => {
  const dataset = repolarize(1.2);
  const initial = { ...enuToWgs84({ east: -54, north: 86 }, DEMO_REFERENCE), bearingOffsetDeg: 359.5 };
  const options = checkedRefinement(dataset, initial, { maxPositionShiftM: 100, maxBearingShiftDeg: 0.4 });
  const result = runFit(dataset, options);
  const best = result.candidates[0];
  const bounds = result.options.bounds;
  assert.ok(Math.min(best.east - bounds.minEast, bounds.maxEast - best.east, best.north - bounds.minNorth, bounds.maxNorth - best.north) > 2);
  assert.ok(result.candidates.every(candidate => Math.abs(angleDifference(candidate.parameters.bearingOffsetDeg, initial.bearingOffsetDeg)) <= 0.400001));
  assert.ok(best.onBoundary);
  assert.equal(result.assessment, 'insufficient');
  assert.ok(result.reasons.some(reason => reason.includes('朝向') && reason.includes('边界')));
});

test('验证时段不改变训练候选排名，优于训练却损害验证时段时不推荐', () => {
  const { dataset, initial: truth } = exactRefinementDataset();
  const initial = { ...truth, bearingOffsetDeg: 358.41 };
  const options = checkedRefinement(dataset, initial);
  const baseline = runFit(dataset, options);
  const changedValidation = structuredClone(dataset);
  const radar = new Map(dataset.radar.map(point => [point.id, point]));
  const splitTime = Date.parse(baseline.splitTime);
  for (const ship of changedValidation.ais) {
    if (ship.timeMs < splitTime) continue;
    const observation = radar.get(ship.id.replace('-ais-', '-radar-'));
    ship.position = enuToWgs84(polarToEnu(observation, initial, dataset.reference), dataset.reference);
  }
  const result = runFit(changedValidation, options);
  const ranking = value => value.candidates.map(candidate => ({ parameters: candidate.parameters, training: candidate.training }));
  assert.deepEqual(ranking(result), ranking(baseline));
  assert.deepEqual(result.initialMetrics.training, baseline.initialMetrics.training);
  assert.ok(result.candidates[0].training.score > result.initialMetrics.training.score);
  assert.ok(result.candidates[0].validation.score < result.initialMetrics.validation.score);
  assert.equal(result.assessment, 'insufficient');
  assert.ok(result.reasons.some(reason => reason.includes('人工初值') && reason.includes('下降')));
});

test('验证时段未保留的雷达距离不改变训练候选参数、顺序和分数', () => {
  const { dataset, initial: truth } = exactRefinementDataset();
  const initial = { ...truth, bearingOffsetDeg: 358.41 };
  dataset.radar.push({ ...dataset.radar[0], id: 'unselected-validation-noise', trackId: 'validation-noise', eventTime: new Date(DEMO_START + 100000).toISOString(), timeMs: DEMO_START + 100000, rangeM: 1000, azimuthDeg: 0 });
  dataset.radar.sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
  const options = checkedRefinement(dataset, initial);
  const selected = selectRefinementObservations(dataset, options);
  assert.ok(!selected.validation.some(row => row.observation.id === 'unselected-validation-noise'));
  const baseline = runFit(dataset, options);
  const changedValidation = structuredClone(dataset);
  changedValidation.radar.find(point => point.id === 'unselected-validation-noise').rangeM = 100000;
  const changedSelection = selectRefinementObservations(changedValidation, options);
  assert.deepEqual(changedSelection.training, selected.training);
  assert.deepEqual(changedSelection.validation, selected.validation);
  const result = runFit(changedValidation, options);
  const ranking = value => value.candidates.map(candidate => ({ parameters: candidate.parameters, training: candidate.training }));
  assert.deepEqual(ranking(result), ranking(baseline));
  assert.deepEqual(result.initialMetrics.training, baseline.initialMetrics.training);
});

test('排除区域和人工剔除保留统计，未选船舶不再参与已固定关联模型', () => {
  const { dataset, initial } = exactRefinementDataset();
  const options = checkedRefinement(dataset, initial, {
    radarExclusion: { minEast: 300, maxEast: 450, minNorth: -1600, maxNorth: -1000 },
    maxPositionShiftM: 10,
  });
  options.refinement.associationIds = [JSON.stringify(['radar-demo-01', 'exact-1', '413000202'])];
  const original = JSON.stringify({ dataset, options });
  const result = runFit(dataset, options);
  const isolated = runFit({ ...dataset, ais: dataset.ais.filter(ship => ship.mmsi === '413000202') }, options);
  assert.equal(result.exclusions.totalRadarPoints, 90);
  assert.equal(result.exclusions.radarExclusionPoints, 30);
  assert.equal(result.exclusions.manuallyExcludedPoints, 30);
  assert.equal(result.exclusions.retainedTrainingPoints, 21);
  assert.equal(result.exclusions.retainedValidationPoints, 9);
  assert.equal(result.exclusions.trainUnsampled, 0);
  assert.equal(result.exclusions.validationUnsampled, 0);
  assert.equal(result.candidates[0].training.ships, 1);
  assert.deepEqual(result.candidates, isolated.candidates);
  assert.deepEqual(result.initialMetrics, isolated.initialMetrics);
  assert.equal(JSON.stringify({ dataset, options }), original);
});

test('米级局部范围仍区分内部改进与触边候选', () => {
  const { dataset, initial: truth } = exactRefinementDataset();
  const initial = { ...enuToWgs84({ east: 16.5, north: -23 }, DEMO_REFERENCE), bearingOffsetDeg: truth.bearingOffsetDeg };
  const options = checkedRefinement(dataset, initial, { maxPositionShiftM: 1, maxBearingShiftDeg: 0.1 });
  const result = runFit(dataset, options);
  assert.ok(Math.abs(result.candidates[0].east - 17) < 0.1);
  assert.equal(result.candidates[0].onBoundary, false);
  assert.equal(result.assessment, 'recommended');
});

test('训练轨迹质量不借用验证观测数量或持续时间', () => {
  const { dataset, initial } = exactRefinementDataset();
  const splitTime = DEMO_START + 84000;
  const shortTraining = {
    ...dataset,
    radar: dataset.radar.filter(point => point.trackId !== 'exact-0' || point.timeMs === DEMO_START + 76000 || point.timeMs === DEMO_START + 80000),
  };
  const options = checkedRefinement(shortTraining, initial, { minTrackPoints: 2, minTrackDurationMs: 1000 });
  const baseline = runFit(shortTraining, options);
  const extended = {
    ...dataset,
    radar: dataset.radar.filter(point => point.trackId !== 'exact-0' || point.timeMs >= splitTime || point.timeMs === DEMO_START + 76000 || point.timeMs === DEMO_START + 80000),
  };
  const result = runFit(extended, options);
  assert.ok(result.candidates[0].validation.points > baseline.candidates[0].validation.points);
  assert.deepEqual(result.candidates.map(candidate => candidate.training), baseline.candidates.map(candidate => candidate.training));
  assert.deepEqual(result.initialMetrics.training, baseline.initialMetrics.training);
});

test('局部粗网格仍拒绝过大的候选数量', () => {
  const { dataset, initial } = exactRefinementDataset();
  const options = checkedRefinement(dataset, initial, { maxPositionShiftM: 2000, maxBearingShiftDeg: 30 }, { positionStepM: 10, angleStepDeg: 1 });
  assert.throws(() => runFit(dataset, options), /50,000/);
});
