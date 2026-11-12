import { canonicalJson } from './data.js';

export function sameIds(a, b) {
  return canonicalJson([...new Set(a)].sort()) === canonicalJson([...new Set(b)].sort());
}

export function selectCachedGroup(group, recent) {
  const eligible = recent.filter((item) => item.projectId === group.projectId && group.radarIds.includes(item.radarId) && sameIds(item.aisSourceIds ?? [], group.aisSourceIds));
  for (const anchor of eligible) {
    const peers = group.radarIds.map((radarId) => eligible.find((item) => item.radarId === radarId && item.summary.start === anchor.summary.start && item.summary.end === anchor.summary.end && canonicalJson(item.queryArea ?? null) === canonicalJson(anchor.queryArea ?? null)));
    if (peers.every(Boolean)) return peers;
  }
  return [];
}

export function mergeAisObservations(snapshots) {
  const reports = new Map();
  const positions = new Map();
  for (const snapshot of snapshots) for (const point of snapshot.dataset.ais) {
    const key = canonicalJson([point.mmsi, point.timeMs, point.messageType, point.position, point.sogKnots, point.cogDeg, point.headingDeg, point.accuracyM, point.dimensions]);
    const existing = reports.get(key);
    if (existing) {
      existing.sourceIds = [...new Set([...existing.sourceIds, ...point.sourceIds])].sort();
      existing.observationIds = [...new Set([...existing.observationIds, ...point.observationIds])];
      existing.quality = [...new Set([...existing.quality, ...point.quality])];
    } else reports.set(key, { ...point, sourceIds: [...point.sourceIds], observationIds: [...point.observationIds], quality: [...point.quality] });
    const time = `${point.mmsi}:${point.timeMs}`;
    const set = positions.get(time) ?? new Set(); set.add(canonicalJson(point.position)); positions.set(time, set);
  }
  return [...reports.values()].map((point) => positions.get(`${point.mmsi}:${point.timeMs}`).size > 1 ? { ...point, quality: [...new Set([...point.quality, '同时间位置冲突'])] } : point).sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
}
