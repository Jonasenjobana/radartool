import { angleDifference, enuToWgs84, inBounds, normalizeAngle, wgs84ToEnu } from '../shared/geo.js';
import { fitOptionsSchema, InputError, parseInput } from '../shared/data.js';
import { expectedLogLikelihood, likelihood, measureCandidate, MODEL_VERSION, prepareFit, REFINEMENT_SAMPLING_VERSION, SAMPLING_VERSION } from '../shared/model.js';
import { refinementBounds } from '../shared/refinement.js';

function axisValues(min, max, step) {
  const count = Math.ceil((max - min) / step);
  return Array.from({ length: count + 1 }, (_, i) => min + (max - min) * i / count);
}

function diverseCandidates(scored, maximum, positionSeparation, angleSeparation) {
  const selected = [];
  for (const point of scored.sort((a, b) => b.score - a.score)) {
    if (selected.every((other) => Math.hypot(point.east - other.east, point.north - other.north) >= positionSeparation || Math.abs(angleDifference(point.bearingOffsetDeg, other.bearingOffsetDeg)) >= angleSeparation)) selected.push(point);
    if (selected.length >= maximum) break;
  }
  return selected;
}

function onBoundary(point, bounds, tolerance = 2) {
  return Math.min(point.east - bounds.minEast, bounds.maxEast - point.east, point.north - bounds.minNorth, bounds.maxNorth - point.north) < tolerance;
}

export function runFit(dataset, inputOptions, report = () => {}) {
  const options = parseInput(fitOptionsSchema, inputOptions);
  const refinement = options.refinement;
  const initial = refinement ? { ...wgs84ToEnu(refinement.initial, dataset.reference), bearingOffsetDeg: normalizeAngle(refinement.initial.bearingOffsetDeg) } : null;
  if (initial) options.bounds = refinementBounds(refinement, dataset.reference);
  const context = prepareFit(dataset, options);
  const eastValues = axisValues(options.bounds.minEast, options.bounds.maxEast, options.positionStepM);
  const northValues = axisValues(options.bounds.minNorth, options.bounds.maxNorth, options.positionStepM);
  const angleValues = initial
    ? axisValues(initial.bearingOffsetDeg - refinement.maxBearingShiftDeg, initial.bearingOffsetDeg + refinement.maxBearingShiftDeg, options.angleStepDeg).map(normalizeAngle)
    : Array.from({ length: Math.ceil(360 / options.angleStepDeg) }, (_, i) => i * 360 / Math.ceil(360 / options.angleStepDeg));
  const angleCount = angleValues.length;
  const angleSpacing = initial ? 2 * refinement.maxBearingShiftDeg / (angleCount - 1) : 360 / angleCount;
  const total = eastValues.length * northValues.length * angleCount;
  if (total > 50000) throw new InputError(initial ? '粗搜索超过 50,000 个候选；请缩小位置/朝向修正范围或增大空间/角度步长' : '粗搜索超过 50,000 个候选；请缩小安装搜索区或增大空间/角度步长');
  let evaluations = 0;
  const score = (point) => { evaluations++; return likelihood(context.training, point, context.backgroundDensity).score; };
  const candidates = [];
  const heatmap = [];
  const angleProfile = angleValues.map(angle => ({ angle, score: -Infinity }));
  let completed = 0;
  for (const east of eastValues) for (const north of northValues) {
    let maxScore = -Infinity;
    for (let i = 0; i < angleCount; i++) {
      const bearingOffsetDeg = angleValues[i];
      const point = { east, north, bearingOffsetDeg };
      const value = score(point);
      candidates.push({ ...point, score: value });
      maxScore = Math.max(maxScore, value);
      angleProfile[i].score = Math.max(angleProfile[i].score, value);
      completed++;
      if (completed % 128 === 0 || completed === total) report({ phase: initial ? '人工初值附近局部粗搜索' : '全域位置 / 360° 粗搜索', fraction: 0.62 * completed / total, completed, total, evaluations });
    }
    heatmap.push({ east, north, score: maxScore });
  }
  const initialCandidate = initial ? { ...initial, score: score(initial), iterations: 0 } : null;
  if (initialCandidate) candidates.push(initialCandidate);
  const starts = diverseCandidates(candidates, options.keepCandidates * 2, options.positionStepM * 0.8, angleSpacing * 1.5);
  const refined = initialCandidate ? [initialCandidate] : [];
  for (let k = 0; k < starts.length; k++) {
    let current = { ...starts[k] };
    let iterations = 0;
    for (let iteration = 0; iteration < options.maxIterations; iteration++) {
      const eStep = likelihood(context.training, current, context.backgroundDensity, true);
      evaluations++;
      const before = { ...current };
      let q = expectedLogLikelihood(context.training, current, eStep.posterior);
      evaluations++;
      let positionStep = options.positionStepM / 2;
      let angleStep = angleSpacing / 2;
      // 广义 M 步直接优化船体混合模型的 Q；不使用点对点闭式配准。
      for (let inner = 0; inner < 20; inner++) {
        let best = current;
        let bestQ = q;
        for (const [de, dn, da] of [[positionStep, 0, 0], [-positionStep, 0, 0], [0, positionStep, 0], [0, -positionStep, 0], [0, 0, angleStep], [0, 0, -angleStep]]) {
          const proposed = { east: current.east + de, north: current.north + dn, bearingOffsetDeg: normalizeAngle(current.bearingOffsetDeg + da) };
          if (!inBounds(proposed, options.bounds)) continue;
          if (initial && Math.abs(angleDifference(proposed.bearingOffsetDeg, initial.bearingOffsetDeg)) > refinement.maxBearingShiftDeg + 1e-9) continue;
          const proposedQ = expectedLogLikelihood(context.training, proposed, eStep.posterior);
          evaluations++;
          if (proposedQ > bestQ + 1e-10) { best = proposed; bestQ = proposedQ; }
        }
        if (best === current) { positionStep /= 2; angleStep /= 2; }
        else { current = { ...best }; q = bestQ; }
        if (positionStep < 0.15 && angleStep < 0.008) break;
      }
      const currentScore = score(current);
      if (currentScore < eStep.score - 1e-8) { current = before; break; }
      current.score = currentScore;
      iterations++;
      report({ phase: `EM 精化 ${k + 1} / ${starts.length}`, fraction: 0.62 + 0.33 * (k + (iteration + 1) / options.maxIterations) / starts.length, completed: iteration + 1, total: options.maxIterations, evaluations });
      if (currentScore - eStep.score < 1e-6 && Math.hypot(current.east - before.east, current.north - before.north) < 0.3 && Math.abs(angleDifference(current.bearingOffsetDeg, before.bearingOffsetDeg)) < 0.02) break;
    }
    refined.push({ ...current, score: score(current), iterations });
  }
  const peaks = diverseCandidates(refined, options.keepCandidates, 5, 0.3);
  report({ phase: '固定候选的时段验证', fraction: 0.96, completed: 0, total: peaks.length, evaluations });
  const results = peaks.map((point, index) => {
    const angleOnBoundary = initial && refinement.maxBearingShiftDeg - Math.abs(angleDifference(point.bearingOffsetDeg, initial.bearingOffsetDeg)) < Math.min(0.05, refinement.maxBearingShiftDeg / 10);
    const result = { parameters: { ...enuToWgs84(point, dataset.reference), bearingOffsetDeg: normalizeAngle(point.bearingOffsetDeg) }, east: point.east, north: point.north, training: measureCandidate(context.training, point, context.backgroundDensity), validation: measureCandidate(context.validation, point, context.backgroundDensity), onBoundary: onBoundary(point, options.bounds, refinement ? Math.min(2, refinement.maxPositionShiftM / 10) : 2) || Boolean(angleOnBoundary), iterations: point.iterations };
    report({ phase: '固定候选的时段验证', fraction: 0.96 + 0.04 * (index + 1) / peaks.length, completed: index + 1, total: peaks.length, evaluations });
    return result;
  });
  const best = results[0];
  const initialMetrics = initial ? { training: measureCandidate(context.training, initial, context.backgroundDensity), validation: measureCandidate(context.validation, initial, context.backgroundDensity) } : null;
  const reasons = [];
  let assessment = 'recommended';
  if (!best || best.training.matchedPoints < 20 || best.validation.matchedPoints < 10 || best.training.ships < 2 || best.validation.ships < 2 || best.training.tracks < 2 || best.training.support < 0.35 || best.validation.support < 0.25) { assessment = 'insufficient'; reasons.push('拟合或独立时段的关联支持不足，不能据此推荐安装参数'); }
  if (best?.onBoundary) { assessment = 'insufficient'; reasons.push(initial ? '最佳候选靠近局部位置或朝向修正边界，需要核查人工初值与修正范围' : '最佳候选靠近安装搜索区边界，需要扩大搜索区核查'); }
  if (best && best.validation.support < best.training.support * 0.55) { assessment = 'insufficient'; reasons.push('保留时段支持明显下降，参数尚不稳定'); }
  if (best && initialMetrics) {
    if (best.validation.score < initialMetrics.validation.score - 1e-8 || best.validation.support < initialMetrics.validation.support) {
      assessment = 'insufficient'; reasons.push('相对人工初值，保留时段分数或关联支持下降，不能认为自动精调优于人工');
    } else if (best.training.score - initialMetrics.training.score <= 1e-6 || best.validation.score - initialMetrics.validation.score <= 1e-6) {
      assessment = 'insufficient'; reasons.push('相对人工初值未显示训练与保留时段的稳定改进，保留人工参数');
    }
  }
  if (context.exclusions.shortTrackRows > (context.training.length + context.validation.length) / 2) { assessment = 'insufficient'; reasons.push('超过半数采样来自不足 4 点或 12 秒的短轨迹，需补充持续观测'); }
  const directions = [...new Map(context.training.flatMap((row) => row.ships.map((ship) => [ship.mmsi, ship]))).values()];
  const moving = directions.filter((ship) => (ship.sogKnots ?? 0) >= 0.5);
  if (moving.length < 2) { assessment = 'insufficient'; reasons.push('可用运动船舶不足，平移与朝向可能存在混淆'); }
  if (moving.length >= 2 && moving.every((ship) => ship.cogDeg != null) && moving.every((ship) => Math.abs(Math.sin(angleDifference(ship.cogDeg, moving[0].cogDeg) * Math.PI / 180)) < 0.2)) { assessment = 'insufficient'; reasons.push('运动方向接近平行，需增加不同航向和空间分布的观测'); }
  if (best && results.slice(1).some((candidate) => best.training.score - candidate.training.score < 0.1 && (Math.hypot(candidate.east - best.east, candidate.north - best.north) > 25 || Math.abs(angleDifference(candidate.parameters.bearingOffsetDeg, best.parameters.bearingOffsetDeg)) > 1))) {
    if (assessment === 'recommended') assessment = 'ambiguous';
    reasons.push('存在分数接近且安装参数不同的竞争候选');
  }
  if (!reasons.length) reasons.push('通过当前支持量与保留时段检查；仍需真实现场和更多时段验证');
  return { assessment, reasons, candidates: results, splitTime: new Date(context.splitTime).toISOString(), evaluations, studyRegion: context.studyRegion, options, exclusions: context.exclusions, heatmap, angleProfile, modelVersion: MODEL_VERSION, samplingVersion: refinement ? REFINEMENT_SAMPLING_VERSION : SAMPLING_VERSION, ...(initialMetrics ? { initialMetrics } : {}) };
}
