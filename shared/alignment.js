import { wgs84ToEnu } from './geo.js';

export function createAisIndex(dataset) {
  const tracks = new Map();
  for (const point of dataset.ais) {
    if (point.quality.includes('同时间位置冲突')) continue;
    const track = tracks.get(point.mmsi) ?? [];
    track.push({ ...point, ...wgs84ToEnu(point.position, dataset.reference) });
    tracks.set(point.mmsi, track);
  }
  for (const track of tracks.values()) track.sort((a, b) => a.timeMs - b.timeMs || qualityRank(b) - qualityRank(a) || a.id.localeCompare(b.id));
  return tracks;
}

function qualityRank(point) {
  return Number(point.headingDeg != null) * 4 + Number(point.dimensions != null) * 2 + Number(point.accuracyM != null);
}

export function aisAtTime(index, timeMs, maxGapMs) {
  const points = [];
  for (const track of index.values()) {
    let lo = 0;
    let hi = track.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (track[mid].timeMs < timeMs) lo = mid + 1;
      else hi = mid;
    }
    let previous = lo - 1;
    while (previous > 0 && track[previous - 1].timeMs === track[previous].timeMs) previous--;
    const candidates = [track[lo], track[previous]].filter(Boolean);
    candidates.sort((a, b) => Math.abs(a.timeMs - timeMs) - Math.abs(b.timeMs - timeMs) || qualityRank(b) - qualityRank(a) || a.id.localeCompare(b.id));
    const point = candidates[0];
    if (point && Math.abs(point.timeMs - timeMs) <= maxGapMs) points.push({ ...point, deltaMs: timeMs - point.timeMs });
  }
  return points;
}

export function createAisStaticIndex(reports) {
  const tracks = new Map();
  for (const report of reports) {
    const key = `${report.dimensions.sourceId}:${report.mmsi}`;
    const track = tracks.get(key) ?? [];
    track.push(report); tracks.set(key, track);
  }
  for (const track of tracks.values()) track.sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
  return tracks;
}

function dimensionsAtTime(dimensions, timeMs) {
  return dimensions && Date.parse(dimensions.observedAt) <= timeMs && Date.parse(dimensions.validFrom) <= timeMs && timeMs < Date.parse(dimensions.validTo) ? dimensions : null;
}

export function latestAisAtTime(index, timeMs, staticIndex = new Map()) {
  const points = [];
  for (const track of index.values()) {
    let lo = 0;
    let hi = track.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (track[mid].timeMs <= timeMs) lo = mid + 1;
      else hi = mid;
    }
    let position = lo - 1;
    if (position < 0) continue;
    // 同时刻报告已按质量排序，回到该时刻的首条；显示缓存只取过去位置。
    while (position > 0 && track[position - 1].timeMs === track[position].timeMs) position--;
    const point = track[position];
    let dimensions = dimensionsAtTime(point.dimensions, timeMs);
    for (const sourceId of point.sourceIds) {
      const reports = staticIndex.get(`${sourceId}:${point.mmsi}`) ?? [];
      let left = 0; let right = reports.length;
      while (left < right) {
        const mid = (left + right) >>> 1;
        if (reports[mid].timeMs <= timeMs) left = mid + 1; else right = mid;
      }
      const candidate = dimensionsAtTime(reports[left - 1]?.dimensions, timeMs);
      if (candidate && (!dimensions || Date.parse(candidate.observedAt) >= Date.parse(dimensions.observedAt))) dimensions = candidate;
    }
    // 静态尺寸按回放时刻更新，位置及其时间仍保留最后一条真实动态观测。
    points.push({ ...point, dimensions, deltaMs: timeMs - point.timeMs });
  }
  return points;
}

export function balancedSample(points, limit) {
  if (points.length <= limit) return [...points];
  const tracks = new Map();
  for (const point of points) {
    const key = `${point.deviceId}:${point.trackId}`;
    const list = tracks.get(key) ?? [];
    list.push(point); tracks.set(key, list);
  }
  const lists = [...tracks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, list]) => list.sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id)));
  const selected = [];
  const quotas = lists.map(() => 0);
  while (selected.length < limit) {
    let added = false;
    for (let i = 0; i < lists.length && selected.length < limit; i++) {
      if (quotas[i] < lists[i].length) { quotas[i]++; selected.push(null); added = true; }
    }
    if (!added) break;
  }
  return lists.flatMap((list, index) => Array.from({ length: quotas[index] }, (_, i) => list[Math.min(list.length - 1, Math.floor((i + 0.5) * list.length / quotas[index]))])).sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
}
