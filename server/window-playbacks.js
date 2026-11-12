import { createHash, randomUUID } from 'node:crypto';
import { InputError } from '../shared/data.js';
import { dataJob } from './data-jobs.js';

const iso = value => new Date(value).toISOString();
const sql = `
CREATE TABLE IF NOT EXISTS window_playbacks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, group_id TEXT NOT NULL, group_name TEXT NOT NULL, group_revision INTEGER NOT NULL, registry_revision INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, west REAL, east REAL, south REAL, north REAL, reference_lng REAL NOT NULL, reference_lat REAL NOT NULL, config_version TEXT NOT NULL, parser_version TEXT, mapping_version TEXT, time_semantics TEXT NOT NULL, verified INTEGER NOT NULL, units_verified INTEGER NOT NULL, alignment_verified INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS window_playbacks_created ON window_playbacks(project_id,created_at_ms DESC,id DESC);
CREATE INDEX IF NOT EXISTS window_playbacks_group_created ON window_playbacks(group_id,created_at_ms DESC,id DESC);
CREATE TABLE IF NOT EXISTS window_playback_radars (playback_id TEXT NOT NULL REFERENCES window_playbacks(id), radar_id TEXT NOT NULL, view_id TEXT NOT NULL, name TEXT NOT NULL, ordinal INTEGER NOT NULL, lng REAL NOT NULL, lat REAL NOT NULL, bearing REAL NOT NULL, device_code TEXT, station_id TEXT, position_text TEXT, PRIMARY KEY(playback_id,radar_id));
CREATE TABLE IF NOT EXISTS window_playback_sources (playback_id TEXT NOT NULL REFERENCES window_playbacks(id), source_id TEXT NOT NULL, name TEXT NOT NULL, ordinal INTEGER NOT NULL, PRIMARY KEY(playback_id,source_id));
CREATE TABLE IF NOT EXISTS window_playback_reads (id TEXT PRIMARY KEY, playback_id TEXT NOT NULL REFERENCES window_playbacks(id), start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, read_start_ms INTEGER NOT NULL, fingerprint TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS window_playback_reads_range ON window_playback_reads(playback_id,start_ms,end_ms,read_start_ms,created_at_ms DESC);
`;

export class WindowPlaybacks {
  constructor(store, registry, readWindow, readGroup, readSingle, readFrameTime) {
    Object.assign(this, { store, registry, readWindow, readGroup, readSingle, readFrameTime });
    store.db.exec(sql); this.current = null; this.cache = new Map(); this.controllers = new Map(); this.queue = Promise.resolve();
    this.windowMs = 120000; this.maxWindows = 3; this.maxBytes = 64 * 1024 * 1024;
  }
  create(groupId, query) {
    const group = this.registry.group(groupId); const project = this.registry.project(group.projectId);
    if (query.revision != null && query.revision !== group.revision) throw new InputError('匹配组已修改，请刷新配置后加载', 409);
    const id = randomUUID(); const area = query.queryArea;
    this.store.transaction(() => {
      this.store.put('window_playbacks', { id, project_id: project.id, group_id: group.id, group_name: group.name, group_revision: group.revision, registry_revision: project.registryRevision, created_at_ms: Date.now(), start_ms: Date.parse(query.start), end_ms: Date.parse(query.end), west: area?.west, east: area?.east, south: area?.south, north: area?.north, reference_lng: project.reference.lng, reference_lat: project.reference.lat, config_version: project.configVersion, parser_version: project.ais.parserVersion, mapping_version: project.clickhouse.mapping?.version, time_semantics: project.timeSemantics ?? 'unverified', verified: Number(!!project.verified), units_verified: Number(!!project.unitsVerified), alignment_verified: Number(!!project.alignmentVerified) });
      group.radarIds.forEach((radarId, ordinal) => { const radar = project.radars.find(value => value.id === radarId); this.store.put('window_playback_radars', { playback_id: id, radar_id: radarId, view_id: randomUUID(), name: radar.name, ordinal, lng: radar.baseline.lng, lat: radar.baseline.lat, bearing: radar.baseline.bearingOffsetDeg, device_code: radar.deviceCode, station_id: radar.stationId, position_text: radar.positionText }); });
      group.aisSourceIds.forEach((source_id, ordinal) => this.store.put('window_playback_sources', { playback_id: id, source_id, ordinal, name: project.aisSources.find(value => value.id === source_id).name }));
    });
    this.activate(id); return this.describe(id);
  }
  describe(id) {
    this.store.validate('sessions', id);
    const row = this.store.db.prepare('SELECT * FROM window_playbacks WHERE id=?').get(id);
    if (!row) throw new InputError('分窗回放记录不存在', 404);
    const radars = this.store.db.prepare('SELECT * FROM window_playback_radars WHERE playback_id=? ORDER BY ordinal').all(id).map(radar => ({ id: radar.radar_id, viewId: radar.view_id, name: radar.name, baseline: { lng: radar.lng, lat: radar.lat, bearingOffsetDeg: radar.bearing }, ...(radar.device_code ? { deviceCode: radar.device_code } : {}), ...(radar.station_id ? { stationId: radar.station_id } : {}), ...(radar.position_text ? { positionText: radar.position_text } : {}) }));
    const sources = this.store.db.prepare('SELECT source_id,name FROM window_playback_sources WHERE playback_id=? ORDER BY ordinal').all(id);
    return { id, mode: 'windowed', projectId: row.project_id, groupId: row.group_id, groupName: row.group_name, groupRevision: row.group_revision, registryRevision: row.registry_revision, createdAt: iso(row.created_at_ms), start: iso(row.start_ms), end: iso(row.end_ms), queryArea: row.west == null ? null : { west: row.west, east: row.east, south: row.south, north: row.north }, reference: { lng: row.reference_lng, lat: row.reference_lat }, radars, radarIds: radars.map(radar => radar.id), aisSourceIds: sources.map(source => source.source_id), aisSourceNames: Object.fromEntries(sources.map(source => [source.source_id, source.name])), snapshotIds: radars.map(radar => radar.viewId), snapshotHashes: [], storageKind: 'windowed', availability: this.current === id ? 'memory' : 'reload', configVersion: row.config_version, parserVersion: row.parser_version, mappingVersion: row.mapping_version, timeSemantics: row.time_semantics, verified: !!row.verified, unitsVerified: !!row.verified && !!row.units_verified, alignmentVerified: !!row.verified && !!row.alignment_verified, windowMs: this.windowMs, cacheWindows: this.maxWindows, cacheBytes: this.maxBytes };
  }
  list(filter = {}) {
    const conditions = []; const values = [];
    if (filter.projectId) { conditions.push('project_id=?'); values.push(filter.projectId); }
    if (filter.groupId) { conditions.push('group_id=?'); values.push(filter.groupId); }
    if (filter.cursor) { const [time, id] = String(filter.cursor).split(','); this.store.validate('sessions', id); if (!Number.isFinite(Number(time))) throw new InputError('分页游标无效'); conditions.push('(created_at_ms,id)<(?,?)'); values.push(Number(time), id); }
    const rows = this.store.db.prepare(`SELECT id,project_id,group_id,group_name,group_revision,registry_revision,created_at_ms,start_ms,end_ms,west,east,south,north FROM window_playbacks ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at_ms DESC,id DESC LIMIT 51`).all(...values);
    const page = rows.slice(0, 50); const radars = new Map(page.map(row => [row.id, []])); const sources = new Map(page.map(row => [row.id, []]));
    if (page.length) {
      const placeholders = page.map(() => '?').join(','); const ids = page.map(row => row.id);
      for (const row of this.store.db.prepare(`SELECT playback_id,radar_id FROM window_playback_radars WHERE playback_id IN (${placeholders}) ORDER BY playback_id,ordinal`).all(...ids)) radars.get(row.playback_id).push(row.radar_id);
      for (const row of this.store.db.prepare(`SELECT playback_id,source_id FROM window_playback_sources WHERE playback_id IN (${placeholders}) ORDER BY playback_id,ordinal`).all(...ids)) sources.get(row.playback_id).push(row.source_id);
    }
    const result = page.map(row => ({ id: row.id, mode: 'windowed', projectId: row.project_id, groupId: row.group_id, groupName: row.group_name, groupRevision: row.group_revision, registryRevision: row.registry_revision, start: iso(row.start_ms), end: iso(row.end_ms), createdAt: iso(row.created_at_ms), queryArea: row.west == null ? null : { west: row.west, east: row.east, south: row.south, north: row.north }, radarIds: radars.get(row.id), aisSourceIds: sources.get(row.id), snapshotIds: [], snapshotHashes: [], storageKind: 'windowed', availability: this.current === row.id ? 'memory' : 'reload' }));
    result.nextCursor = rows.length > 50 ? `${rows[49].created_at_ms},${rows[49].id}` : null; return result;
  }
  project(description) {
    const configured = this.registry.project(description.projectId);
    if (configured.configVersion !== description.configVersion || (configured.ais.parserVersion ?? null) !== description.parserVersion || (configured.clickhouse.mapping?.version ?? null) !== description.mappingVersion || (configured.timeSemantics ?? 'unverified') !== description.timeSemantics) throw new InputError('回放的数据契约配置已变化，请建立新回放', 409);
    return { ...configured, reference: description.reference, registryRevision: description.registryRevision, radars: description.radars, aisSources: description.aisSourceIds.map(id => ({ id, name: description.aisSourceNames[id] })), verified: description.verified, unitsVerified: description.unitsVerified, alignmentVerified: description.alignmentVerified };
  }
  activate(id) { if (id !== this.current) { this.release(this.current); if (this.store.current) this.store.release(this.store.current); this.current = id; } }
  release(id) { if (id && id === this.current) { for (const controller of this.controllers.values()) controller.abort(); this.cache.clear(); this.current = null; } }
  cancel(id, requestId) { if (id === this.current) this.controllers.get(requestId)?.abort(); return { cancelled: true }; }
  status(id) { const description = this.describe(id); const entries = this.current === id ? [...this.cache.values()] : []; return { id, active: this.current === id, windowCount: entries.length, retainedBytes: entries.reduce((sum, entry) => sum + entry.retainedBytes, 0), maxWindows: description.cacheWindows, maxBytes: description.cacheBytes, ranges: entries.map(entry => ({ start: entry.window.start, end: entry.window.end })) }; }
  serial(action) { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  async window(id, request, signal) {
    const descriptor = this.describe(id);
    if (this.current !== id) throw new InputError('回放内存已释放，请重新打开该回放', 410);
    const project = this.project(descriptor); const first = Date.parse(descriptor.start); const last = Date.parse(descriptor.end);
    if (request.at < first || request.at >= last) throw new InputError('播放时间超出所选完整时段');
    const span = request.windowMs ?? this.windowMs;
    const coreStart = first + Math.floor((request.at - first) / span) * span;
    const coreEnd = Math.min(last, coreStart + span); const start = Math.max(first, coreStart - request.trailSeconds * 1000);
    const key = `${start}:${coreEnd}`;
    if (this.cache.has(key)) { const cached = this.cache.get(key); this.cache.delete(key); this.cache.set(key, cached); return cached; }
    const controller = new AbortController(); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    this.controllers.set(request.requestId, controller);
    try {
      return await this.serial(async () => {
        if (signal?.aborted || controller.signal.aborted || this.current !== id) throw new InputError('窗口请求已取消', 499);
        if (this.cache.has(key)) return this.cache.get(key);
        const previous = [...this.cache.values()].reverse().find(entry => entry.window.start <= start && entry.window.end >= start);
        const query = { projectId: descriptor.projectId, radarIds: descriptor.radarIds, aisSourceIds: descriptor.aisSourceIds, start: iso(start), end: iso(coreEnd), queryArea: descriptor.queryArea, playbackRange: { start: descriptor.start, end: descriptor.end }, ...(previous ? { previous: { start: previous.window.start, end: previous.window.end, snapshots: previous.snapshots } } : {}) };
        const values = await this.readWindow(project, query, { groupSessionId: id }, controller.signal, this.store);
        if (controller.signal.aborted || this.current !== id) throw new InputError('窗口请求已取消', 499);
        if (values.length !== descriptor.radarIds.length || values.some((value, index) => value.dataset.projectId !== descriptor.projectId || value.dataset.radarId !== descriptor.radarIds[index] || Date.parse(value.dataset.timeRange?.start) !== first || Date.parse(value.dataset.timeRange?.end) !== last)) throw new InputError('匹配组窗口不完整，未发布数据', 502);
        for (const value of values) value.dataset.provenance = { ...value.dataset.provenance, representation: 'window-source', windowRange: { start: query.start, end: query.end } };
        const snapshots = await dataJob('identify', values.map(value => ({ ...value, id: randomUUID(), sessionId: id, createdAt: new Date().toISOString(), storageKind: 'temporary' })));
        const fingerprint = createHash('sha256').update(snapshots.map(snapshot => snapshot.fingerprint).join(':')).digest('hex');
        const prior = this.store.db.prepare('SELECT fingerprint FROM window_playback_reads WHERE playback_id=? AND start_ms=? AND end_ms=? AND read_start_ms=? ORDER BY created_at_ms DESC LIMIT 1').get(id, coreStart, coreEnd, start);
        const window = { id: randomUUID(), playbackId: id, start, end: coreEnd, coreStart, coreEnd, dataScope: 'window', fingerprint, changedFromPrevious: !!prior && prior.fingerprint !== fingerprint };
        const encoded = await dataJob('window-playback', { snapshots, session: descriptor, window }); const bytes = Buffer.from(encoded.bytes);
        if (controller.signal.aborted || this.current !== id) throw new InputError('窗口请求已取消', 499);
        const retainedBytes = encoded.retainedBytes;
        if (retainedBytes > this.maxBytes) throw new InputError('当前窗口及相邻观测超出内存预算，请缩小 AIS 查询区域或尾迹时长', 413);
        const protectedEntry = request.prefetch ? [...this.cache.values()].find(entry => entry.window.id === request.protectedWindowId) : null;
        if (protectedEntry && (this.maxWindows < 2 || protectedEntry.retainedBytes + retainedBytes > this.maxBytes)) throw new InputError('当前窗口仍在使用，预取窗口需缩小以满足缓存预算', 413);
        this.store.transaction(() => { this.store.put('window_playback_reads', { id: window.id, playback_id: id, start_ms: coreStart, end_ms: coreEnd, read_start_ms: start, fingerprint, created_at_ms: Date.now() }); });
        while (this.cache.size && (this.cache.size >= this.maxWindows || [...this.cache.values()].reduce((sum, entry) => sum + entry.retainedBytes, 0) + retainedBytes > this.maxBytes)) { const victim = [...this.cache].find(([, entry]) => entry !== protectedEntry); this.cache.delete(victim[0]); }
        const entry = { bytes, snapshots, window, retainedBytes }; this.cache.set(key, entry); return entry;
      });
    } finally { signal?.removeEventListener('abort', abort); if (this.controllers.get(request.requestId) === controller) this.controllers.delete(request.requestId); }
  }
  rawSnapshot(id) { for (const entry of this.cache.values()) { const snapshot = entry.snapshots.find(value => value.id === id); if (snapshot) return snapshot; } return null; }
  async frame(id, input, signal) {
    const description = this.describe(id); const project = this.project(description);
    if (this.current !== id) throw new InputError('回放已释放，请重新打开', 410);
    for (const controller of this.controllers.values()) controller.abort();
    let time = input.at; const first = Date.parse(description.start); const last = Date.parse(description.end);
    if (time < first || time >= last) throw new InputError('逐帧时间超出所选时段');
    while (true) {
      if (signal.aborted) throw new InputError('逐帧请求已取消', 499);
      const next = await this.serial(() => this.readFrameTime(project, { ...description, queryArea: description.queryArea }, time, input.direction, signal));
      if (next == null) return { at: input.direction > 0 ? last - 1 : first };
      const entry = await this.window(id, { at: next, trailSeconds: input.trailSeconds, requestId: input.requestId }, signal);
      const times = [...new Set(entry.snapshots.flatMap(snapshot => [snapshot.dataset.radar, snapshot.dataset.ais, snapshot.dataset.aisStatic ?? []].flatMap(points => points.map(point => point.timeMs))))].filter(value => value >= entry.window.start && value < entry.window.end && (input.direction > 0 ? value > input.at : value < input.at));
      if (times.length) return { at: times.reduce((best, value) => input.direction > 0 ? Math.min(best, value) : Math.max(best, value), times[0]) };
      time = input.direction > 0 ? entry.window.end - 1 : entry.window.start;
      if (time >= last - 1 || time <= first) return { at: input.direction > 0 ? last - 1 : first };
    }
  }
  async prepareRadar(description, radarId, signal, { snapshotId, reportStage, beginPublish } = {}) {
    if (!description.radarIds.includes(radarId)) throw new InputError('雷达不属于该回放');
    const project = this.project(description); reportStage?.('等待读取完整时段数据');
    return this.serial(async () => {
      if (signal?.aborted) throw new InputError('加载已取消', 499);
      reportStage?.('读取完整时段的雷达与 AIS');
      const query = { projectId: description.projectId, radarId, aisSourceIds: description.aisSourceIds, start: description.start, end: description.end, queryArea: description.queryArea };
      const value = await this.readSingle(project, query, signal, this.store);
      if (value.dataset.projectId !== description.projectId || value.dataset.radarId !== radarId || Date.parse(value.dataset.timeRange?.start) !== Date.parse(description.start) || Date.parse(value.dataset.timeRange?.end) !== Date.parse(description.end)) throw new InputError('完整标定输入范围不一致，未保存', 502);
      reportStage?.('校验并准备完整输入快照');
      return this.store.saveSnapshot(value, project, signal, beginPublish, snapshotId);
    });
  }
  async materialize(id, radarId, signal, beginPublish) {
    const description = this.describe(id); const project = this.project(description);
    for (const controller of this.controllers.values()) controller.abort();
    if (radarId) { const snapshot = await this.prepareRadar(description, radarId, signal, { beginPublish }); return { snapshotId: snapshot.id, snapshot: this.store.snapshotMeta(snapshot.id) }; }
    return this.serial(async () => {
      const query = { projectId: description.projectId, radarId, radarIds: description.radarIds, aisSourceIds: description.aisSourceIds, start: description.start, end: description.end, queryArea: description.queryArea };
      const sessionId = randomUUID(); const group = { id: description.groupId, name: description.groupName, projectId: description.projectId, revision: description.groupRevision, radarIds: description.radarIds, aisSourceIds: description.aisSourceIds };
      const values = await this.readGroup(project, query, { group, groupSessionId: sessionId }, signal, this.store);
      if (values.length !== description.radarIds.length || values.some((value, index) => value.dataset.projectId !== description.projectId || value.dataset.radarId !== description.radarIds[index] || Date.parse(value.dataset.timeRange?.start) !== Date.parse(description.start) || Date.parse(value.dataset.timeRange?.end) !== Date.parse(description.end))) throw new InputError('完整数据准备失败，匹配组成员或时段不一致', 502);
      const bundle = await this.store.saveSession(values, { ...description, id: sessionId }, project, signal, beginPublish);
      return { sessionId: bundle.session.id, snapshotIds: bundle.session.snapshotIds };
    });
  }
  async close() { this.release(this.current); await this.queue; }
}
