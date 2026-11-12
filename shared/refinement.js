import { aisAtTime, createAisIndex, createAisStaticIndex } from './alignment.js';
import { InputError } from './data.js';
import { inBounds, polarToEnu, wgs84ToEnu } from './geo.js';

export function refinementBounds(refinement, reference) {
  const initial = wgs84ToEnu(refinement.initial, reference);
  const shift = refinement.maxPositionShiftM;
  return { minEast: initial.east - shift, maxEast: initial.east + shift, minNorth: initial.north - shift, maxNorth: initial.north + shift };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = (sorted.length - 1) / 2;
  return (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2;
}

function medianOffset(rows) {
  return { east: median(rows.map(row => row.position.east - row.ship.east)), north: median(rows.map(row => row.position.north - row.ship.north)) };
}

function validDimensions(dimensions, timeMs) {
  return dimensions && Date.parse(dimensions.observedAt) <= timeMs && Date.parse(dimensions.validFrom) <= timeMs && timeMs < Date.parse(dimensions.validTo) ? dimensions : null;
}

function dimensionsAtTime(ship, timeMs, staticIndex) {
  let dimensions = validDimensions(ship.dimensions, timeMs);
  for (const sourceId of ship.sourceIds) {
    const reports = staticIndex.get(`${sourceId}:${ship.mmsi}`) ?? [];
    let lo = 0; let hi = reports.length;
    while (lo < hi) {
      const middle = (lo + hi) >>> 1;
      if (reports[middle].timeMs <= timeMs) lo = middle + 1; else hi = middle;
    }
    const candidate = validDimensions(reports[lo - 1]?.dimensions, timeMs);
    if (candidate && (!dimensions || Date.parse(candidate.observedAt) >= Date.parse(dimensions.observedAt))) dimensions = candidate;
  }
  return dimensions;
}

function hullRadius(ship, timeMs) {
  const dimensions = validDimensions(ship.dimensions, timeMs);
  if (!dimensions) return 0;
  return Math.hypot(Math.max(dimensions.bow, dimensions.stern), Math.max(dimensions.port, dimensions.starboard));
}

function summarize(rows) {
  const times = new Map();
  for (const row of rows) {
    const values = times.get(row.observation.timeMs) ?? [];
    values.push(row); times.set(row.observation.timeMs, values);
  }
  const offsets = [...times].map(([time, values]) => ({ time, ...medianOffset(values) }));
  const center = { east: median(offsets.map(value => value.east)), north: median(offsets.map(value => value.north)) };
  const start = offsets.reduce((value, row) => Math.min(value, row.time), Infinity);
  const end = offsets.reduce((value, row) => Math.max(value, row.time), -Infinity);
  const normalizedTimes = offsets.map(value => (value.time - start) / Math.max(1, end - start));
  const meanTime = normalizedTimes.reduce((sum, value) => sum + value, 0) / offsets.length;
  const variance = normalizedTimes.reduce((sum, value) => sum + (value - meanTime) ** 2, 0);
  const driftEast = offsets.reduce((sum, value, index) => sum + (normalizedTimes[index] - meanTime) * value.east, 0) / (variance || 1);
  const driftNorth = offsets.reduce((sum, value, index) => sum + (normalizedTimes[index] - meanTime) * value.north, 0) / (variance || 1);
  const scatter = Math.sqrt(offsets.reduce((sum, value) => sum + (value.east - center.east) ** 2 + (value.north - center.north) ** 2, 0) / offsets.length);
  return {
    points: times.size, start, end,
    distanceP50M: median(rows.map(row => row.distance)),
    // 同时检查散布与整段相对位移趋势，避免缓慢反向运动因局部步长较小而过关。
    motionErrorM: Math.max(scatter, Math.hypot(driftEast, driftNorth)),
  };
}

const trackKey = observation => JSON.stringify([observation.deviceId, observation.trackId]);

function stableRuns(rows, ordinals, refinement, maximumGap) {
  const frames = new Map();
  for (const row of rows) {
    const frame = frames.get(row.observation.timeMs) ?? [];
    frame.push(row); frames.set(row.observation.timeMs, frame);
  }
  const runs = []; let run = []; let previous = null;
  const finish = () => {
    if (!run.length) return;
    const summary = summarize(run);
    if (summary.points >= refinement.minTrackPoints && summary.end - summary.start >= refinement.minTrackDurationMs && summary.motionErrorM <= refinement.motionToleranceM) runs.push(run);
  };
  for (const [time, frame] of [...frames].sort(([a], [b]) => a - b)) {
    const offset = medianOffset(frame);
    if (previous && (ordinals.get(time) !== ordinals.get(previous.time) + 1 || time - previous.time > maximumGap || Math.hypot(offset.east - previous.east, offset.north - previous.north) > refinement.motionToleranceM)) {
      finish(); run = [];
    }
    run.push(...frame); previous = { ...offset, time };
  }
  finish();
  return runs;
}

function continueValidation(radar, candidates, tails, selected, splitTime, refinement, maximumGap) {
  const tracks = new Map();
  for (const observation of radar) {
    if (observation.timeMs < splitTime) continue;
    const key = trackKey(observation);
    const frames = tracks.get(key) ?? new Map();
    const frame = frames.get(observation.timeMs) ?? [];
    frame.push(observation); frames.set(observation.timeMs, frame); tracks.set(key, frames);
  }
  const retained = new Map(); const ambiguous = new Set();
  for (const [key, frames] of tracks) {
    const choices = (tails.get(key) ?? []).filter(tail => selected.has(tail.id))
      .sort((a, b) => a.distanceP50M - b.distanceP50M || a.id.localeCompare(b.id));
    if (!choices.length) continue;
    if (choices.length > 1 && Math.abs(choices[0].distanceP50M - choices[1].distanceP50M) <= 1e-6) { ambiguous.add(key); continue; }
    const tail = choices[0];
    let previous = tail.rows.filter(row => row.observation.timeMs === tail.end);
    let previousTime = tail.end;
    let previousOffset = medianOffset(previous);
    for (const [time, observations] of [...frames].sort(([a], [b]) => a - b)) {
      const rows = observations.flatMap(observation => candidates.get(observation.id) ?? []).filter(row => row.associationId === tail.id);
      if (!rows.length || time - previousTime > maximumGap) break;
      const offset = medianOffset(rows);
      if (Math.hypot(offset.east - previousOffset.east, offset.north - previousOffset.north) > refinement.motionToleranceM) break;
      for (const row of rows) retained.set(row.observation.id, row);
      previousTime = time; previousOffset = offset;
    }
  }
  return { retained, ambiguous };
}

export function selectRefinementObservations(dataset, options) {
  const refinement = options.refinement;
  if (!refinement) throw new InputError('请提供精调初值和筛选设置');
  const first = dataset.timeRange ? Date.parse(dataset.timeRange.start) : dataset.radar[0]?.timeMs ?? 0;
  const last = dataset.timeRange ? Date.parse(dataset.timeRange.end) : (dataset.radar.at(-1)?.timeMs ?? first) + 1;
  const splitTime = first + (last - first) * (1 - options.validationFraction);
  const localAis = dataset.ais.filter(point => {
    const position = wgs84ToEnu(point.position, dataset.reference);
    return Math.hypot(position.east, position.north) <= 30000;
  });
  const trainingIndex = createAisIndex({ ...dataset, ais: localAis.filter(point => point.timeMs < splitTime) });
  const validationIndex = createAisIndex({ ...dataset, ais: localAis });
  const staticIndex = createAisStaticIndex(dataset.aisStatic ?? []);
  const states = new Map();
  const exclusions = {
    totalRadarPoints: dataset.radar.length,
    outsideLocalAisPoints: dataset.ais.length - localAis.length,
    conflictingAis: dataset.ais.filter(point => point.quality.includes('同时间位置冲突')).length,
    radarExclusionPoints: 0, notNearbyPoints: 0, unstablePoints: 0,
    manuallyExcludedPoints: 0, ambiguousPoints: 0, competingPoints: 0,
    retainedTrainingPoints: 0, retainedValidationPoints: 0,
  };
  const aligned = time => {
    if (!states.has(time)) {
      const index = time < splitTime ? trainingIndex : validationIndex;
      let ships = aisAtTime(index, time, options.maxGapMs).map(ship => ({ ...ship, dimensions: dimensionsAtTime(ship, time, staticIndex) }));
      if (options.roi) ships = ships.filter(ship => inBounds(ship, options.roi));
      states.set(time, ships);
    }
    return states.get(time);
  };
  const groups = new Map(); const candidates = new Map(); const trackTimes = new Map();
  for (const observation of dataset.radar) {
    if (observation.timeMs >= splitTime) continue;
    const times = trackTimes.get(trackKey(observation)) ?? new Set();
    times.add(observation.timeMs); trackTimes.set(trackKey(observation), times);
  }
  const ordinals = new Map([...trackTimes].map(([key, times]) => [key, new Map([...times].sort((a, b) => a - b).map((time, index) => [time, index]))]));
  for (const observation of dataset.radar) {
    const position = polarToEnu(observation, refinement.initial, dataset.reference);
    if (refinement.radarExclusion && inBounds(position, refinement.radarExclusion)) { exclusions.radarExclusionPoints++; continue; }
    const nearby = aligned(observation.timeMs).map(ship => ({ ship, distance: Math.hypot(position.east - ship.east, position.north - ship.north) }))
      .filter(row => row.distance <= refinement.maxDistanceM + hullRadius(row.ship, observation.timeMs));
    if (!nearby.length) { exclusions.notNearbyPoints++; continue; }
    const rows = nearby.map(({ ship, distance }) => ({ observation, ship, position, distance, associationId: JSON.stringify([observation.deviceId, observation.trackId, ship.mmsi]) }));
    candidates.set(observation.id, rows);
    if (observation.timeMs >= splitTime) continue;
    for (const row of rows) {
      const group = groups.get(row.associationId) ?? [];
      group.push(row); groups.set(row.associationId, group);
    }
  }
  const associations = []; const stableRows = new Set(); const tails = new Map();
  // 超出稳定时长的断报不与旧轨迹续接；距离或相对位移中断后需重新满足稳定门限。
  const maximumGap = Math.max(refinement.minTrackDurationMs, options.maxGapMs * 2);
  for (const [id, rows] of groups) {
    const runs = stableRuns(rows, ordinals.get(trackKey(rows[0].observation)), refinement, maximumGap);
    const retained = runs.flat();
    if (!retained.length) continue;
    for (const row of retained) stableRows.add(row);
    const summary = summarize(retained);
    const { observation, ship } = rows[0];
    associations.push({ id, deviceId: observation.deviceId, trackId: observation.trackId, mmsi: ship.mmsi, ...summary });
    const key = trackKey(observation);
    const finalRun = runs.at(-1);
    const end = finalRun.at(-1).observation.timeMs;
    if (end === [...ordinals.get(key).keys()].at(-1)) {
      const choices = tails.get(key) ?? [];
      choices.push({ id, rows: finalRun, end, distanceP50M: median(finalRun.map(row => row.distance)) }); tails.set(key, choices);
    }
  }
  associations.sort((a, b) => a.id.localeCompare(b.id));
  const stable = new Set(associations.map(row => row.id));
  const selected = refinement.associationIds == null ? stable : new Set(refinement.associationIds);
  for (const id of selected) if (!stable.has(id)) throw new InputError(`未知的精调关联：${id}`);
  // 验证只延用训练末尾的连续身份，选择优先级完全由训练距离确定。
  const continuation = continueValidation(dataset.radar, candidates, tails, selected, splitTime, refinement, maximumGap);
  const training = []; const validation = [];
  for (const rows of candidates.values()) {
    const isTraining = rows[0].observation.timeMs < splitTime;
    const stableCandidates = rows.filter(row => isTraining ? stableRows.has(row) : stable.has(row.associationId));
    if (!stableCandidates.length) { exclusions.unstablePoints++; continue; }
    if (stableCandidates.length > 1) exclusions.competingPoints++;
    const eligible = stableCandidates.filter(row => selected.has(row.associationId)).sort((a, b) => a.distance - b.distance || a.associationId.localeCompare(b.associationId));
    if (!eligible.length) { exclusions.manuallyExcludedPoints++; continue; }
    let chosen;
    if (isTraining) {
      if (eligible.length > 1 && Math.abs(eligible[0].distance - eligible[1].distance) <= 1e-6) { exclusions.ambiguousPoints++; continue; }
      chosen = eligible[0];
    } else {
      if (continuation.ambiguous.has(trackKey(rows[0].observation))) { exclusions.ambiguousPoints++; continue; }
      chosen = continuation.retained.get(rows[0].observation.id);
      if (!chosen) { exclusions.unstablePoints++; continue; }
    }
    const { observation, ship, associationId } = chosen;
    (isTraining ? training : validation).push({ observation, ship, associationId });
  }
  const chronological = (a, b) => a.observation.timeMs - b.observation.timeMs || a.observation.id.localeCompare(b.observation.id);
  training.sort(chronological); validation.sort(chronological);
  exclusions.retainedTrainingPoints = training.length; exclusions.retainedValidationPoints = validation.length;
  return { associations: associations.filter(row => selected.has(row.id)), training, validation, exclusions, splitTime };
}
