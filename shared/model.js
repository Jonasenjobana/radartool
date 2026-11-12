import { aisAtTime, balancedSample, createAisIndex } from './alignment.js';
import { inBounds, polarToEnu, wgs84ToEnu } from './geo.js';
import { InputError, MAX_RADAR_RANGE_M } from './data.js';
import { selectRefinementObservations } from './refinement.js';

export const MODEL_VERSION = 'extended-hull-gaussian-background-em-v1';
export const SAMPLING_VERSION = 'track-time-balanced-chronological-v1';
export const REFINEMENT_SAMPLING_VERSION = 'ais-guided-track-time-balanced-chronological-v1';
const RAD = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  return sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
export function normalCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

export function makeShipModel(point, timeMs, rangeM, options) {
  const seconds = Math.abs(timeMs - point.timeMs) / 1000;
  const timeSigma = seconds * (point.sogKnots == null ? 5 : point.sogKnots * 0.514444);
  const sigma2 = options.rangeSigmaM ** 2 + (rangeM * options.angleSigmaDeg * RAD) ** 2 + Math.max(options.aisSigmaM, point.accuracyM ?? 0) ** 2 + timeSigma ** 2;
  const dims = point.dimensions;
  const validDimensions = dims && Date.parse(dims.observedAt) <= timeMs && Date.parse(dims.validFrom) <= timeMs && timeMs < Date.parse(dims.validTo);
  if (validDimensions && point.headingDeg != null) {
    const angle = point.headingDeg * RAD;
    return { ...point, kind: 'hull', sigma: Math.sqrt(sigma2), sin: Math.sin(angle), cos: Math.cos(angle), dimensions: dims, qualityWeight: 1, degradation: null };
  }
  // 无船艏向时不使用 COG 代替；采用有界、归一化的各向同性退化密度。
  const hullSigma = validDimensions ? Math.min(80, Math.hypot(dims.bow + dims.stern, dims.port + dims.starboard) / 4) : options.fallbackSigmaM;
  return { ...point, kind: 'gaussian', sigma: Math.sqrt(sigma2 + hullSigma ** 2), qualityWeight: validDimensions ? 0.6 : 0.4, degradation: validDimensions ? '缺真船艏向：无方向退化模型' : '缺有效尺寸：有界点模型' };
}

export function shipDensity(position, ship) {
  const east = position.east - ship.east;
  const north = position.north - ship.north;
  if (ship.kind === 'hull') {
    const forward = east * ship.sin + north * ship.cos;
    const side = east * ship.cos - north * ship.sin;
    const d = ship.dimensions;
    const longitudinal = Math.max(0, normalCdf((forward + d.stern) / ship.sigma) - normalCdf((forward - d.bow) / ship.sigma)) / (d.bow + d.stern);
    const transverse = Math.max(0, normalCdf((side + d.port) / ship.sigma) - normalCdf((side - d.starboard) / ship.sigma)) / (d.port + d.starboard);
    return Math.max(1e-300, longitudinal * transverse);
  }
  return Math.max(1e-300, Math.exp(-(east * east + north * north) / (2 * ship.sigma ** 2)) / (TWO_PI * ship.sigma ** 2));
}

export function envelopeDistance(position, ship) {
  const east = position.east - ship.east;
  const north = position.north - ship.north;
  if (ship.kind !== 'hull') return Math.hypot(east, north);
  const forward = east * ship.sin + north * ship.cos;
  const side = east * ship.cos - north * ship.sin;
  const d = ship.dimensions;
  return Math.hypot(Math.max(-d.stern - forward, 0, forward - d.bow), Math.max(-d.port - side, 0, side - d.starboard));
}

function assignWeights(rows) {
  if (!rows.length) return;
  const first = rows[0].timeMs;
  const duration = Math.max(1, rows.at(-1).timeMs - first);
  const counts = new Map();
  const bins = new Map();
  for (const row of rows) {
    const key = `${row.deviceId}:${row.trackId}`;
    const bin = Math.min(9, Math.floor((row.timeMs - first) / duration * 10));
    row.weightKey = key; row.weightBin = bin;
    counts.set(key, (counts.get(key) ?? 0) + 1); bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  let sum = 0;
  for (const row of rows) { row.weight = row.trackQuality / Math.sqrt(counts.get(row.weightKey) * bins.get(row.weightBin)); sum += row.weight; }
  for (const row of rows) row.weight *= rows.length / sum;
}

export function prepareFit(dataset, options) {
  if (options.refinement && !options.refinement.associationIds?.length) throw new InputError('请先完成关联检查并至少保留一个关联');
  if (!dataset.unitsVerified || !dataset.alignmentVerified || dataset.timeSemantics === 'unverified') throw new InputError('请先核实距离、角度及时间语义，并在数据契约中确认对齐规则');
  if (dataset.radar.length < 6 || !dataset.ais.length) throw new InputError('至少需要 6 条雷达观测和可用 AIS 数据');
  const localAis = dataset.ais.filter((point) => {
    const local = wgs84ToEnu(point.position, dataset.reference);
    return Math.hypot(local.east, local.north) <= 30000;
  });
  if (!localAis.length) throw new InputError('固定参考点 30 km 内没有可用于标定的 AIS 观测');
  const selection = options.refinement ? selectRefinementObservations(dataset, options) : null;
  const selectedRows = selection ? new Map([...selection.training, ...selection.validation].map(row => [row.observation.id, row])) : null;
  const index = selection ? null : createAisIndex({ ...dataset, ais: localAis });
  if (dataset.radar[0].timeMs === dataset.radar.at(-1).timeMs) throw new InputError('雷达观测需要覆盖多个真实时刻');
  const first = dataset.timeRange ? Date.parse(dataset.timeRange.start) : dataset.radar[0].timeMs;
  const last = dataset.timeRange ? Date.parse(dataset.timeRange.end) : dataset.radar.at(-1).timeMs + 1;
  const splitTime = selection?.splitTime ?? first + (last - first) * (1 - options.validationFraction);
  const trainingPoints = selection ? selection.training.map(row => row.observation) : dataset.radar.filter((p) => p.timeMs < splitTime);
  const validationPoints = selection ? selection.validation.map(row => row.observation) : dataset.radar.filter((p) => p.timeMs >= splitTime);
  const trackSpans = new Map();
  for (const point of selection ? trainingPoints : dataset.radar) {
    const key = `${point.deviceId}:${point.trackId}`;
    const span = trackSpans.get(key) ?? { count: 0, start: point.timeMs, end: point.timeMs };
    span.count++; span.start = Math.min(span.start, point.timeMs); span.end = Math.max(span.end, point.timeMs); trackSpans.set(key, span);
  }
  const exclusions = { outsideLocalAisPoints: dataset.ais.length - localAis.length, conflictingAis: dataset.ais.filter((p) => p.quality.includes('同时间位置冲突')).length, trainUnsampled: 0, validationUnsampled: 0, noAlignedAis: 0, degradedShipStates: 0, outsideRoiShipStates: 0, shortTrackRows: 0, ...selection?.exclusions };
  const buildRows = (points, maximum) => {
    const sampled = balancedSample(points, maximum);
    const rows = sampled.map((point) => {
      // 人工检查后的船舶身份固定，采样和后续参数候选都不重新引入其他船。
      let ships = selectedRows ? [selectedRows.get(point.id).ship] : aisAtTime(index, point.timeMs, options.maxGapMs);
      if (!selectedRows && options.roi) {
        const before = ships.length;
        ships = ships.filter((ship) => inBounds(ship, options.roi));
        exclusions.outsideRoiShipStates += before - ships.length;
      }
      ships = ships.map((ship) => makeShipModel(ship, point.timeMs, point.rangeM, options));
      if (!ships.length) exclusions.noAlignedAis++;
      exclusions.degradedShipStates += ships.filter((ship) => ship.degradation).length;
      // 每个时刻为船舶分配相等的基础先验；退化质量的剩余概率交给背景。
      const priors = ships.map((ship) => (1 - options.backgroundPrior) * ship.qualityWeight / ships.length);
      const backgroundPrior = 1 - priors.reduce((sum, value) => sum + value, 0);
      const span = trackSpans.get(`${point.deviceId}:${point.trackId}`);
      const trackQuality = Math.max(0.1, Math.min(1, span.count / 4, (span.end - span.start) / 12000));
      if (trackQuality < 1) exclusions.shortTrackRows++;
      return { ...point, ships, priors, backgroundPrior, weight: 1, trackQuality };
    });
    assignWeights(rows);
    return rows;
  };
  const training = buildRows(trainingPoints, options.maxFitPoints);
  const validation = buildRows(validationPoints, options.maxValidationPoints);
  exclusions.trainUnsampled = trainingPoints.length - training.length;
  exclusions.validationUnsampled = validationPoints.length - validation.length;
  if (!training.some((row) => row.ships.length)) throw new InputError('拟合时段没有可按已确认时间窗口对齐的 AIS 观测');
  // 精调以业务输入上限固定有限背景支持域，避免验证观测改变训练密度；这不是设备真实覆盖范围。
  const maxRange = selection ? MAX_RADAR_RANGE_M : dataset.radar.reduce((maximum, point) => Math.max(maximum, point.rangeM), 0);
  const studyRegion = { minEast: options.bounds.minEast - maxRange - 1, maxEast: options.bounds.maxEast + maxRange + 1, minNorth: options.bounds.minNorth - maxRange - 1, maxNorth: options.bounds.maxNorth + maxRange + 1 };
  const backgroundDensity = 1 / ((studyRegion.maxEast - studyRegion.minEast) * (studyRegion.maxNorth - studyRegion.minNorth));
  return { training, validation, splitTime, exclusions, studyRegion, backgroundDensity };
}

export function likelihood(rows, parameters, backgroundDensity, responsibilities = false) {
  let score = 0;
  const posterior = [];
  for (const row of rows) {
    const position = polarToEnu(row, parameters);
    const background = row.backgroundPrior * backgroundDensity;
    const terms = row.ships.map((ship, i) => row.priors[i] * shipDensity(position, ship));
    const total = background + terms.reduce((sum, value) => sum + value, 0);
    score += row.weight * Math.log(total);
    if (responsibilities) posterior.push({ background: background / total, ships: terms.map((value) => value / total), position });
  }
  return { score: score / Math.max(1, rows.length), posterior };
}

export function expectedLogLikelihood(rows, parameters, posterior) {
  let score = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const position = polarToEnu(row, parameters);
    for (let j = 0; j < row.ships.length; j++) {
      const probability = posterior[i].ships[j];
      if (probability > 1e-12) score += row.weight * probability * Math.log(shipDensity(position, row.ships[j]));
    }
  }
  return score / Math.max(1, rows.length);
}

export function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = (sorted.length - 1) * p;
  return sorted[Math.floor(i)] + (sorted[Math.ceil(i)] - sorted[Math.floor(i)]) * (i % 1);
}

export function measureCandidate(rows, parameters, backgroundDensity) {
  const evaluation = likelihood(rows, parameters, backgroundDensity, true);
  const groups = new Map();
  const residuals = [];
  const shipSupport = new Map();
  const trackSupport = new Set();
  let matchedPoints = 0;
  let background = 0;
  let alignedPoints = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const post = evaluation.posterior[i];
    background += post.background;
    if (row.ships.length) alignedPoints++;
    let bestIndex = -1;
    for (let j = 0; j < post.ships.length; j++) {
      shipSupport.set(row.ships[j].mmsi, (shipSupport.get(row.ships[j].mmsi) ?? 0) + post.ships[j]);
      if (bestIndex < 0 || post.ships[j] > post.ships[bestIndex]) bestIndex = j;
    }
    const matched = bestIndex >= 0 && post.ships[bestIndex] >= 0.55;
    const residual = matched ? envelopeDistance(post.position, row.ships[bestIndex]) : null;
    if (matched) { matchedPoints++; residuals.push(residual); trackSupport.add(`${row.deviceId}:${row.trackId}`); }
    const keys = [['船舶', matched ? row.ships[bestIndex].mmsi : '未关联'], ['距离', `${Math.floor(row.rangeM / 1000)}–${Math.floor(row.rangeM / 1000) + 1} km`], ['方位', `${Math.floor(row.azimuthDeg / 90) * 90}–${(Math.floor(row.azimuthDeg / 90) + 1) * 90}°`], ['时段', new Date(Math.floor(row.timeMs / 60000) * 60000).toISOString()]];
    for (const [dimension, key] of keys) {
      const id = `${dimension}:${key}`;
      const group = groups.get(id) ?? { dimension, key, points: 0, matched: 0, background: 0, residuals: [] };
      group.points++; group.background += post.background;
      if (matched) { group.matched++; group.residuals.push(residual); }
      groups.set(id, group);
    }
  }
  return { points: rows.length, alignedPoints, matchedPoints, ships: [...shipSupport.values()].filter((sum) => sum >= 2).length, tracks: trackSupport.size, support: matchedPoints / Math.max(1, rows.length), background: background / Math.max(1, rows.length), score: evaluation.score, residualP50: quantile(residuals, 0.5), residualP90: quantile(residuals, 0.9), residualP95: quantile(residuals, 0.95), groups: [...groups.values()].map(({ residuals: values, ...group }) => ({ ...group, background: group.background / group.points, p90: quantile(values, 0.9) })) };
}

export function associateObservation(observation, aisStates, parameters, reference, options) {
  const ships = aisStates.map((p) => makeShipModel(p, observation.timeMs, observation.rangeM, options));
  const priors = ships.map((ship) => (1 - options.backgroundPrior) * ship.qualityWeight / ships.length);
  const position = polarToEnu(observation, parameters, reference);
  // 调用方提供固定研究区域的背景密度。
  const density = options.backgroundDensity;
  const bg = (1 - priors.reduce((s, v) => s + v, 0)) * density;
  const terms = ships.map((ship, i) => priors[i] * shipDensity(position, ship));
  const total = bg + terms.reduce((sum, term) => sum + term, 0);
  let best = -1;
  for (let i = 0; i < terms.length; i++) if (best < 0 || terms[i] > terms[best]) best = i;
  return { position, background: bg / total, ship: best < 0 ? null : ships[best], probability: best < 0 ? 0 : terms[best] / total, residual: best < 0 ? null : envelopeDistance(position, ships[best]) };
}
