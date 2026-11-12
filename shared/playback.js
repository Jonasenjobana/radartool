// 列表和回放只传业务字段；原始证据通过独立接口读取。
export function encodePlayback(snapshots, session = null) {
  const aisSets = [];
  const keys = new Map();
  const dictionary = []; const dictionaryIds = new Map();
  const intern = value => { const key = JSON.stringify(value); if (!dictionaryIds.has(key)) { dictionaryIds.set(key, dictionary.length); dictionary.push(value); } return dictionaryIds.get(key); };
  const items = snapshots.map(snapshot => {
    const data = snapshot.dataset;
    const { radar, ais, aisStatic = [], provenance, ...header } = data;
    const baseTime = snapshot.summary.start;
    const dimensions = []; const dimensionIds = new Map();
    const dim = value => {
      if (!value) return -1;
      const key = JSON.stringify(value);
      if (!dimensionIds.has(key)) { dimensionIds.set(key, dimensions.length); dimensions.push([value.bow, value.stern, value.port, value.starboard, Date.parse(value.observedAt), Date.parse(value.validFrom), Date.parse(value.validTo), intern(value.sourceId)]); }
      return dimensionIds.get(key);
    };
    const common = point => [point.id, point.mmsi, point.timeMs - baseTime, point.receiveTime ? Date.parse(point.receiveTime) - point.timeMs : null, point.messageType, intern(point.sourceIds), intern(point.mappingVersion), intern(point.quality), point.observationIds?.length === 1 && point.observationIds[0] === point.id ? null : point.observationIds];
    const encodedAis = ais.map(point => [...common(point), point.position.lng, point.position.lat, point.sogKnots ?? null, point.cogDeg ?? null, point.headingDeg ?? null, point.accuracyM ?? null, dim(point.dimensions)]);
    const encodedStatic = aisStatic.map(point => [...common(point), dim(point.dimensions)]);
    const aisValue = { observations: encodedAis, statics: encodedStatic, dimensions };
    // 相同业务字段共享传输数组，原始证据仍按各雷达的快照上下文读取。
    const key = JSON.stringify([baseTime, aisValue]);
    let aisSet = keys.get(key);
    if (aisSet == null) { aisSet = aisSets.length; keys.set(key, aisSet); aisSets.push({ ...aisValue, baseTime, snapshotId: snapshot.id, snapshotIds: [snapshot.id] }); }
    else aisSets[aisSet].snapshotIds.push(snapshot.id);
    const mappedProvenance = { ...Object.fromEntries(Object.entries(provenance ?? {}).filter(([key]) => !['rawAisReports', 'initialAisReports'].includes(key))), representation: 'playback-v2' };
    return { id: snapshot.id, createdAt: snapshot.createdAt, hash: snapshot.hash, fingerprint: snapshot.fingerprint, sessionId: snapshot.sessionId, storageKind: snapshot.storageKind, summary: snapshot.summary, dataset: { ...header, provenance: mappedProvenance }, aisSet, radar: radar.map(point => [point.id, point.trackId, point.timeMs - baseTime, point.receiveTime ? Date.parse(point.receiveTime) - point.timeMs : null, point.rangeM, point.azimuthDeg, point.storedPosition?.lng ?? null, point.storedPosition?.lat ?? null, intern(point.sourceId), intern(point.mappingVersion), intern(point.quality)]) };
  });
  return { schemaVersion: 2, session, snapshots: items, aisSets, dictionary };
}

export function decodePlayback(value) {
  if (value.schemaVersion !== 2) return value;
  const evidence = (snapshotId, kind, id) => ({ evidenceRef: { snapshotId, kind, id, ...(value.window ? { playbackId: value.window.playbackId } : {}) } });
  const sets = value.aisSets.map(set => {
    const dimensions = set.dimensions.map(row => ({ bow: row[0], stern: row[1], port: row[2], starboard: row[3], observedAt: new Date(row[4]).toISOString(), validFrom: new Date(row[5]).toISOString(), validTo: new Date(row[6]).toISOString(), sourceId: value.dictionary[row[7]] }));
    const common = (row, kind) => ({ id: row[0], mmsi: row[1], timeMs: row[2] + set.baseTime, eventTime: new Date(row[2] + set.baseTime).toISOString(), receiveTime: row[3] == null ? null : new Date(row[2] + set.baseTime + row[3]).toISOString(), messageType: row[4], sourceIds: value.dictionary[row[5]], mappingVersion: value.dictionary[row[6]], quality: value.dictionary[row[7]], observationIds: row[8] ?? [row[0]], raw: { evidenceRef: { snapshotId: set.snapshotId, snapshotIds: set.snapshotIds, kind, id: row[0], ...(value.window ? { playbackId: value.window.playbackId } : {}) } } });
    return { ais: set.observations.map(row => ({ ...common(row, 'ais'), position: { lng: row[9], lat: row[10] }, sogKnots: row[11], cogDeg: row[12], headingDeg: row[13], accuracyM: row[14], dimensions: dimensions[row[15]] ?? null })), aisStatic: set.statics.map(row => ({ ...common(row, 'aisStatic'), dimensions: dimensions[row[9]] })) };
  });
  const snapshots = value.snapshots.map(item => {
    const { radar, aisSet, ...snapshot } = item;
    return { ...snapshot, dataset: { ...item.dataset, ...sets[aisSet], radar: radar.map(row => ({ id: row[0], trackId: row[1], timeMs: row[2] + item.summary.start, eventTime: new Date(row[2] + item.summary.start).toISOString(), receiveTime: row[3] == null ? null : new Date(row[2] + item.summary.start + row[3]).toISOString(), rangeM: row[4], azimuthDeg: row[5], storedPosition: row[6] == null || row[7] == null ? null : { lng: row[6], lat: row[7] }, sourceId: value.dictionary[row[8]], mappingVersion: value.dictionary[row[9]], quality: value.dictionary[row[10]], deviceId: item.dataset.radarId, raw: evidence(item.id, 'radar', row[0]) })) } };
  });
  return { session: value.session, snapshots, ...(value.reloadedFrom ? { reloadedFrom: value.reloadedFrom } : {}), ...(value.window ? { window: value.window } : {}) };
}
