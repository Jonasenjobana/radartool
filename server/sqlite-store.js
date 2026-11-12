import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, InputError } from '../shared/data.js';
import { schema, summaryColumns } from './storage-schema.js';
import { readTask, readVersion, writeTask, writeVersion } from './task-storage.js';
import { dataJob } from './data-jobs.js';

const kinds = ['snapshots', 'sessions', 'tasks', 'versions'];
const tables = { snapshots: 'snapshot_metadata', sessions: 'query_sessions', tasks: 'calibration_tasks', versions: 'parameter_versions' };
const mockKinds = ['synthetic', 'schema-example', 'demo'];
const validId = /^[0-9a-f-]{36}$/;
const ms = value => value == null ? null : Date.parse(value);
const iso = value => value == null ? undefined : new Date(value).toISOString();
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const areaRow = area => ({ west: area?.west, east: area?.east, south: area?.south, north: area?.north });
const areaValue = row => row.west == null ? null : ({ west: row.west, east: row.east, south: row.south, north: row.north });

export class SqliteStore {
  constructor(directory) { this.directory = path.resolve(directory); this.database = path.join(this.directory, 'radar-tool.sqlite'); this.statements = new Map(); this.worksets = new Map(); this.playbackCache = new Map(); this.current = null; this.depth = 0; }
  async init() {
    await mkdir(this.directory, { recursive: true });
    this.db = new DatabaseSync(this.database);
    try { this.db.exec(schema); for (const table of ['snapshot_sources', 'query_session_ais_sources']) if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'name')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN name TEXT`); this.freezeLegacyWrites(); await this.migrateLegacy(); }
    catch (error) { this.db.close(); throw error; }
  }
  statement(sql) { if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql)); return this.statements.get(sql); }
  put(table, input) {
    const entries = Object.entries(input).map(([key, value]) => [key, value ?? null]);
    const columns = entries.map(([key]) => key);
    this.statement(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT DO UPDATE SET ${columns.map(key => `${key}=excluded.${key}`).join(',')}`).run(...entries.map(([, value]) => value));
  }
  transaction(action) {
    if (this.depth) return action();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  validate(kind, id) { if (!kinds.includes(kind) || !validId.test(id)) throw new InputError('无效记录标识'); }
  hasTable(name) { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  freezeLegacyWrites() {
    for (const table of ['records', 'settings']) if (this.hasTable(table)) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_legacy_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, '旧 JSON 存储已停止写入，请使用结构化存储'); END`);
  }
  async migrateLegacy() {
    const done = this.db.prepare("SELECT completed_at_ms FROM schema_migrations WHERE name='business-tables-v2'").get();
    if (done?.completed_at_ms) return;
    if (!this.db.prepare("SELECT completed_at_ms FROM schema_migrations WHERE name='registry-v2'").get()) {
      let registry;
      if (this.hasTable('settings')) { const saved = this.db.prepare("SELECT payload FROM settings WHERE key='registry'").get(); if (saved) registry = JSON.parse(saved.payload); }
      if (!registry) { try { registry = JSON.parse(await readFile(path.join(this.directory, 'registry.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      if (registry) this.writeRegistry(registry);
      this.put('schema_migrations', { name: 'registry-v2', completed_at_ms: Date.now() });
    }
    for (const kind of kinds) {
      const entries = new Map();
      if (this.hasTable('records')) for (const row of this.db.prepare('SELECT id FROM records WHERE kind=? ORDER BY id').all(kind)) entries.set(row.id, { location: 'database' });
      let files = [];
      try { files = await readdir(path.join(this.directory, kind)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const file of files.filter(file => /^[0-9a-f-]{36}\.json$/.test(file))) if (!entries.has(file.slice(0, -5))) entries.set(file.slice(0, -5), { location: 'file', filePath: path.join(this.directory, kind, file) });
      for (const [id, location] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
        if (this.db.prepare('SELECT 1 FROM legacy_entries WHERE kind=? AND id=?').get(kind, id)) continue;
        const record = await dataJob('legacy-index', { ...location, database: this.database, kind, id });
        if (record.id !== id || !Number.isFinite(ms(record.createdAt))) throw new InputError(`旧记录格式无效：${kind}/${id}`);
        this.transaction(() => {
          if (kind === 'snapshots') this.writeSnapshotMeta(record, 'legacy');
          else if (kind === 'sessions') this.writeSessionMeta(record, 'legacy');
          else if (kind === 'tasks') writeTask(this, record);
          else writeVersion(this, record);
          this.put('legacy_entries', { kind, id, location: location.location, file_path: location.filePath });
          this.put('schema_migrations', { name: 'business-tables-v2', cursor_kind: kind, cursor_id: id });
        });
      }
    }
    this.put('schema_migrations', { name: 'business-tables-v2', completed_at_ms: Date.now() });
  }
  readRegistry() {
    if (!this.db.prepare("SELECT 1 FROM schema_migrations WHERE name='registry-v2'").get()) return null;
    const state = { schemaVersion: 1, revision: this.db.prepare('SELECT registry_revision FROM app_state WHERE id=1').get().registry_revision, projects: {} };
    for (const project of this.db.prepare('SELECT id FROM registry_projects ORDER BY id').all()) {
      const radars = this.db.prepare('SELECT * FROM radars WHERE project_id=? ORDER BY rowid').all(project.id).map(row => ({ id: row.id, name: row.name, baseline: { lng: row.lng, lat: row.lat, bearingOffsetDeg: row.bearing_offset_deg }, ...(row.device_code != null ? { deviceCode: row.device_code } : {}), ...(row.station_id != null ? { stationId: row.station_id } : {}), ...(row.position_text != null ? { positionText: row.position_text } : {}) }));
      const aisSources = this.db.prepare('SELECT id,name FROM ais_sources WHERE project_id=? ORDER BY rowid').all(project.id).map(row => ({ ...row }));
      const groups = this.db.prepare('SELECT * FROM match_groups WHERE project_id=? ORDER BY created_at_ms,id').all(project.id).map(row => ({ id: row.id, projectId: row.project_id, name: row.name, revision: row.revision, createdAt: iso(row.created_at_ms), updatedAt: iso(row.updated_at_ms), radarIds: this.db.prepare('SELECT radar_id FROM match_group_radars WHERE group_id=? ORDER BY ordinal').all(row.id).map(item => item.radar_id), aisSourceIds: this.db.prepare('SELECT source_id FROM match_group_ais_sources WHERE group_id=? ORDER BY ordinal').all(row.id).map(item => item.source_id) }));
      state.projects[project.id] = { radars, aisSources, groups };
    }
    return state;
  }
  writeRegistry(state) {
    this.transaction(() => {
      this.db.exec('DELETE FROM match_groups; DELETE FROM radars; DELETE FROM ais_sources; DELETE FROM registry_projects');
      for (const [project_id, project] of Object.entries(state.projects)) {
        this.put('registry_projects', { id: project_id });
        for (const radar of project.radars) this.put('radars', { project_id, id: radar.id, name: radar.name, lng: radar.baseline.lng, lat: radar.baseline.lat, bearing_offset_deg: radar.baseline.bearingOffsetDeg, device_code: radar.deviceCode, station_id: radar.stationId, position_text: radar.positionText });
        for (const source of project.aisSources) this.put('ais_sources', { project_id, id: source.id, name: source.name });
        for (const group of project.groups) {
          this.put('match_groups', { id: group.id, project_id, name: group.name, revision: group.revision, created_at_ms: ms(group.createdAt), updated_at_ms: ms(group.updatedAt) });
          group.radarIds.forEach((radar_id, ordinal) => this.put('match_group_radars', { group_id: group.id, radar_id, ordinal }));
          group.aisSourceIds.forEach((source_id, ordinal) => this.put('match_group_ais_sources', { group_id: group.id, source_id, ordinal }));
        }
      }
      this.db.prepare('UPDATE app_state SET registry_revision=? WHERE id=1').run(state.revision);
      this.put('schema_migrations', { name: 'registry-v2', completed_at_ms: Date.now() });
    });
  }
  snapshot(normalized, sessionId) { return { id: randomUUID(), createdAt: new Date().toISOString(), hash: hash(normalized.dataset), ...normalized, ...(sessionId ? { sessionId } : {}) }; }
  writeSnapshotMeta(record, storageKind = 'temporary') {
    const data = record.dataset; const query = data.provenance?.query; const config = data.provenance?.radarConfiguration;
    this.put('snapshot_metadata', { id: record.id, session_id: record.sessionId, project_id: data.projectId, radar_id: data.radarId, name: data.name, created_at_ms: ms(record.createdAt), hash: record.hash, data_fingerprint: record.fingerprint ?? record.hash, start_ms: record.summary.start, end_ms: record.summary.end, storage_kind: storageKind, archive_id: record.archiveId, source_kind: data.provenance?.kind ?? 'import', config_version: data.provenance?.configVersion, parser_version: data.provenance?.parserVersion, mapping_version: data.provenance?.mappingVersion, registry_revision: data.provenance?.registryRevision, time_semantics: data.timeSemantics, units_verified: Number(data.unitsVerified), alignment_verified: Number(data.alignmentVerified), reference_lng: data.reference.lng, reference_lat: data.reference.lat, baseline_lng: data.baseline.lng, baseline_lat: data.baseline.lat, baseline_bearing: data.baseline.bearingOffsetDeg, radar_name: config?.name, device_code: config?.deviceCode, station_id: config?.stationId, position_text: config?.positionText, ...areaRow(query?.queryArea), ...Object.fromEntries(Object.entries(summaryColumns).map(([field, column]) => [column, record.summary[field] ?? 0])) });
    this.db.prepare('DELETE FROM snapshot_sources WHERE snapshot_id=?').run(record.id);
    const sources = record.aisSourceIds ?? query?.aisSourceIds ?? [...new Set((data.ais ?? []).flatMap(point => point.sourceIds))];
    sources.forEach((source_id, ordinal) => this.put('snapshot_sources', { snapshot_id: record.id, source_id, name: data.provenance?.aisSourceNames?.[source_id], ordinal }));
    this.db.prepare('DELETE FROM snapshot_mapping_versions WHERE snapshot_id=?').run(record.id);
    for (const mapping_version of record.mappingVersions ?? [...new Set((data.radar ?? []).map(point => point.mappingVersion))]) this.put('snapshot_mapping_versions', { snapshot_id: record.id, mapping_version });
    this.db.prepare('DELETE FROM snapshot_warnings WHERE snapshot_id=?').run(record.id);
    (record.summary.warnings ?? []).forEach((message, ordinal) => this.put('snapshot_warnings', { snapshot_id: record.id, ordinal, message }));
  }
  snapshotMeta(id, row, sources) {
    if (!id) return null;
    row ??= this.db.prepare('SELECT * FROM snapshot_metadata WHERE id=?').get(id);
    if (!row) return null;
    const sourceRows = sources ?? this.db.prepare('SELECT source_id,name FROM snapshot_sources WHERE snapshot_id=? ORDER BY ordinal').all(id);
    return { id: row.id, createdAt: iso(row.created_at_ms), hash: row.hash, fingerprint: row.data_fingerprint, sessionId: row.session_id ?? undefined, name: row.name, projectId: row.project_id, radarId: row.radar_id, aisSourceIds: sourceRows.map(item => item.source_id), aisSourceNames: Object.fromEntries(sourceRows.filter(item => item.name != null).map(item => [item.source_id, item.name])), queryArea: areaValue(row), storageKind: row.storage_kind, availability: this.worksets.has(id) ? 'memory' : row.storage_kind === 'temporary' ? 'reload' : row.storage_kind, sourceKind: row.source_kind, configVersion: row.config_version, parserVersion: row.parser_version, mappingVersion: row.mapping_version, timeSemantics: row.time_semantics, unitsVerified: !!row.units_verified, alignmentVerified: !!row.alignment_verified, reference: { lng: row.reference_lng, lat: row.reference_lat }, baseline: { lng: row.baseline_lng, lat: row.baseline_lat, bearingOffsetDeg: row.baseline_bearing }, radarConfiguration: { id: row.radar_id, name: row.radar_name ?? row.radar_id, baseline: { lng: row.baseline_lng, lat: row.baseline_lat, bearingOffsetDeg: row.baseline_bearing }, ...(row.device_code ? { deviceCode: row.device_code } : {}), ...(row.station_id ? { stationId: row.station_id } : {}), ...(row.position_text ? { positionText: row.position_text } : {}) }, summary: { ...Object.fromEntries(Object.entries(summaryColumns).map(([field, column]) => [field, row[column]])), start: row.start_ms, end: row.end_ms, coverage: [], warnings: [] } };
  }
  writeSessionMeta(session, storageKind = 'temporary') {
    const peers = (session.snapshotIds ?? []).map(id => this.snapshotMeta(id)).filter(Boolean);
    this.put('query_sessions', { id: session.id, project_id: session.projectId ?? peers[0]?.projectId, group_id: session.groupId, group_name: session.groupName, group_revision: session.groupRevision, registry_revision: session.registryRevision, start_ms: ms(session.start) ?? peers[0]?.summary.start, end_ms: ms(session.end) ?? peers[0]?.summary.end, ...areaRow(session.queryArea), created_at_ms: ms(session.createdAt), storage_kind: storageKind, archive_id: session.archiveId, data_fingerprint: session.fingerprint ?? hash(peers.map(peer => peer.fingerprint)), source_kind: peers.some(peer => mockKinds.includes(peer.sourceKind)) ? 'synthetic' : 'live-query' });
    this.db.prepare('DELETE FROM query_session_radars WHERE session_id=?').run(session.id);
    (session.snapshotIds ?? []).forEach((snapshot_id, ordinal) => this.put('query_session_radars', { session_id: session.id, radar_id: session.radarIds?.[ordinal] ?? peers[ordinal]?.radarId ?? '', snapshot_id, snapshot_hash: session.snapshotHashes?.[ordinal] ?? peers[ordinal]?.hash ?? '', ordinal }));
    this.db.prepare('DELETE FROM query_session_ais_sources WHERE session_id=?').run(session.id);
    (session.aisSourceIds ?? []).forEach((source_id, ordinal) => this.put('query_session_ais_sources', { session_id: session.id, source_id, name: session.aisSourceNames?.[source_id], ordinal }));
  }
  sessionMeta(row, radarRows, sourceRows) {
    if (!row) return null;
    const radars = radarRows ?? this.db.prepare('SELECT * FROM query_session_radars WHERE session_id=? ORDER BY ordinal').all(row.id);
    const sources = sourceRows ?? this.db.prepare('SELECT source_id,name FROM query_session_ais_sources WHERE session_id=? ORDER BY ordinal').all(row.id);
    return { id: row.id, projectId: row.project_id, groupId: row.group_id, groupName: row.group_name, groupRevision: row.group_revision, registryRevision: row.registry_revision, start: iso(row.start_ms), end: iso(row.end_ms), queryArea: areaValue(row), createdAt: iso(row.created_at_ms), radarIds: radars.map(item => item.radar_id), snapshotIds: radars.map(item => item.snapshot_id), snapshotHashes: radars.map(item => item.snapshot_hash), aisSourceIds: sources.map(item => item.source_id), aisSourceNames: Object.fromEntries(sources.filter(item => item.name != null).map(item => [item.source_id, item.name])), fingerprint: row.data_fingerprint, storageKind: row.storage_kind, availability: radars.length && radars.every(item => this.worksets.has(item.snapshot_id)) ? 'memory' : row.storage_kind === 'temporary' ? 'reload' : row.storage_kind };
  }
  async saveSnapshot(normalized, project, signal, beginPublish, id = randomUUID()) {
    const [record] = await dataJob('identify', [{ id, createdAt: new Date().toISOString(), ...normalized, storageKind: 'temporary' }]);
    if (signal?.aborted) throw new InputError('加载已取消', 499);
    beginPublish?.();
    this.transaction(() => { this.writeSnapshotMeta(record); }); this.activate([record]); return record;
  }
  async saveSession(normalized, context, project, signal, beginPublish) {
    const snapshots = await dataJob('identify', normalized.map(value => ({ id: randomUUID(), createdAt: new Date().toISOString(), ...value, sessionId: context.id, storageKind: 'temporary' })));
    const session = { ...context, aisSourceNames: context.aisSourceNames ?? normalized[0]?.dataset.provenance.aisSourceNames ?? {}, createdAt: new Date().toISOString(), snapshotIds: snapshots.map(value => value.id), snapshotHashes: snapshots.map(value => value.hash), fingerprint: hash(snapshots.map(value => value.fingerprint)), storageKind: 'temporary', availability: 'memory' };
    if (signal?.aborted) throw new InputError('加载已取消', 499);
    beginPublish?.();
    this.transaction(() => { for (const snapshot of snapshots) this.writeSnapshotMeta(snapshot); this.writeSessionMeta(session); });
    this.activate(snapshots, session); return { session, snapshots };
  }
  activate(snapshots, session = null) { const id = session?.id ?? snapshots[0]?.id ?? null; if (this.current !== id) this.playbackCache.clear(); this.worksets.clear(); for (const snapshot of snapshots) this.worksets.set(snapshot.id, snapshot); this.current = id; }
  release(id) { if (id === this.current) this.worksets.clear(); else for (const [key, value] of this.worksets) if (key === id || value.sessionId === id) this.worksets.delete(key); this.playbackCache.clear(); if (!this.worksets.size) this.current = null; }
  async read(kind, id) {
    this.validate(kind, id);
    if (kind === 'snapshots' && this.worksets.has(id)) return this.worksets.get(id);
    const row = this.db.prepare(`SELECT * FROM ${tables[kind]} WHERE id=?`).get(id);
    if (!row) throw new InputError('记录不存在', 404);
    if (kind === 'sessions') return this.sessionMeta(row);
    if (kind === 'tasks') {
      const linked = this.db.prepare('SELECT a.* FROM task_archives t JOIN archives a ON a.id=t.archive_id WHERE t.task_id=?').get(id);
      if (linked) { const bundle = await dataJob('archive-read', { filePath: linked.file_path, hash: linked.hash }); const task = bundle.tasks?.find(value => value.id === id); if (task) return task; }
    }
    const legacy = this.db.prepare('SELECT * FROM legacy_entries WHERE kind=? AND id=?').get(kind, id);
    if (kind === 'snapshots') {
      if (row.archive_id) { const archive = this.db.prepare('SELECT * FROM archives WHERE id=?').get(row.archive_id); const bundle = await dataJob('archive-read', { filePath: archive.file_path, hash: archive.hash }); const snapshot = bundle.snapshots.find(item => item.id === id); if (!snapshot || snapshot.hash !== row.hash) throw new InputError('归档快照与目录摘要不一致', 409); return { ...snapshot, storageKind: 'archive', fingerprint: row.data_fingerprint }; }
      if (legacy) { const snapshot = await dataJob('legacy-read', { database: this.database, location: legacy.location, filePath: legacy.file_path, kind, id }); if (snapshot.hash !== row.hash) throw new InputError('旧快照与目录 SHA-256 不一致', 409); return { ...snapshot, storageKind: 'legacy', fingerprint: row.data_fingerprint }; }
      throw new InputError('当前数据已释放，需要按历史查询条件重新加载；如需离线使用，请先完整归档', 410);
    }
    const value = kind === 'tasks' ? readTask(this, row) : readVersion(this, row);
    if (legacy) {
      const original = await dataJob('legacy-read', { database: this.database, location: legacy.location, filePath: legacy.file_path, kind, id });
      return { ...original, ...value, ...(original.result && value.result ? { result: { ...original.result, ...value.result, heatmap: original.result.heatmap ?? [], angleProfile: original.result.angleProfile ?? [], evidenceScope: 'complete' } } : {}) };
    }
    return value;
  }
  list(kind, filter = {}) {
    if (!kinds.includes(kind)) throw new InputError('无效记录类型');
    const conditions = []; const values = [];
    if (kind === 'snapshots') conditions.push('(session_id IS NULL OR EXISTS (SELECT 1 FROM query_session_radars r JOIN query_sessions s ON s.id=r.session_id WHERE r.session_id=snapshot_metadata.session_id AND r.snapshot_id=snapshot_metadata.id))');
    for (const [field, column] of [['projectId', 'project_id'], ['radarId', 'radar_id'], ['groupId', 'group_id'], ['status', 'status']]) if (filter[field]) {
      if (field === 'radarId' && kind === 'sessions') conditions.push('EXISTS (SELECT 1 FROM query_session_radars r WHERE r.session_id=query_sessions.id AND r.radar_id=?)');
      else if (field === 'groupId' && kind !== 'sessions') throw new InputError('此列表不支持按匹配组筛选');
      else if (field === 'status' && kind !== 'tasks') throw new InputError('此列表不支持按任务状态筛选');
      else { conditions.push(`${column}=?`); }
      values.push(filter[field]);
    }
    if (filter.includeSynthetic === false) {
      if (kind === 'snapshots' || kind === 'sessions') conditions.push("source_kind NOT IN ('synthetic','schema-example','demo')");
      else {
        const preparing = kind === 'tasks' && this.hasTable('window_playbacks') ? ` OR (snapshot_hash IS NULL AND NOT EXISTS (SELECT 1 FROM snapshot_metadata s WHERE s.id=calibration_tasks.snapshot_id) AND EXISTS (SELECT 1 FROM window_playbacks p JOIN window_playback_radars r ON r.playback_id=p.id WHERE p.id=calibration_tasks.session_id AND p.project_id=calibration_tasks.project_id AND r.radar_id=calibration_tasks.radar_id))` : '';
        conditions.push(`(EXISTS (SELECT 1 FROM snapshot_metadata s WHERE s.id=${tables[kind]}.snapshot_id AND s.source_kind NOT IN ('synthetic','schema-example','demo'))${preparing})`);
      }
    }
    if (filter.cursor) { const [time, id] = String(filter.cursor).split(','); if (!Number.isFinite(Number(time)) || !validId.test(id)) throw new InputError('分页游标无效'); conditions.push('(created_at_ms,id)<(?,?)'); values.push(Number(time), id); }
    const requested = Number(filter.limit ?? 50);
    if (!Number.isInteger(requested) || requested < 1) throw new InputError('每页数量必须为正整数');
    const limit = Math.min(50, requested);
    const columns = this.db.prepare(`PRAGMA table_info(${tables[kind]})`).all().map(row => row.name).join(',');
    const rows = this.db.prepare(`SELECT ${columns} FROM ${tables[kind]} ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at_ms DESC,id DESC LIMIT ?`).all(...values, limit + 1);
    const more = rows.length > limit; rows.length = Math.min(rows.length, limit);
    const related = (table, owner, columns, order) => {
      const values = new Map(rows.map(row => [row.id, []]));
      if (rows.length) for (const item of this.db.prepare(`SELECT ${owner},${columns} FROM ${table} WHERE ${owner} IN (${rows.map(() => '?').join(',')}) ORDER BY ${owner},${order}`).all(...rows.map(row => row.id))) values.get(item[owner]).push(item);
      return values;
    };
    const sources = kind === 'snapshots' ? related('snapshot_sources', 'snapshot_id', 'source_id,name', 'ordinal') : null;
    const radars = kind === 'sessions' ? related('query_session_radars', 'session_id', 'radar_id,snapshot_id,snapshot_hash,ordinal', 'ordinal') : null;
    const ais = kind === 'sessions' ? related('query_session_ais_sources', 'session_id', 'source_id,name', 'ordinal') : null;
    const mappings = kind === 'versions' ? related('version_mapping_versions', 'version_id', 'mapping_version', 'mapping_version') : null;
    const list = rows.map(row => kind === 'snapshots' ? this.snapshotMeta(row.id, row, sources.get(row.id)) : kind === 'sessions' ? this.sessionMeta(row, radars.get(row.id), ais.get(row.id)) : kind === 'tasks' ? readTask(this, row, false) : readVersion(this, row, false, mappings.get(row.id).map(item => item.mapping_version)));
    list.nextCursor = more ? `${rows.at(-1).created_at_ms},${rows.at(-1).id}` : null; return list;
  }
  async write(kind, record) {
    this.validate(kind, record.id);
    if (kind === 'snapshots') { const [identified] = await dataJob('identify', [record]); if (identified.hash !== record.hash) throw new InputError('快照内容与 SHA-256 不一致', 409); this.transaction(() => this.writeSnapshotMeta(identified, record.storageKind ?? 'temporary')); this.worksets.set(record.id, identified); return; }
    this.transaction(() => { if (kind === 'tasks') writeTask(this, record); else if (kind === 'versions') writeVersion(this, record); else this.writeSessionMeta(record); });
  }
  async playback(snapshots, session = null, reloadedFrom = null) { const key = session?.id ?? snapshots[0].id; if (!reloadedFrom && this.playbackCache.has(key)) return this.playbackCache.get(key); const bytes = Buffer.from(await dataJob('playback', { snapshots, session, reloadedFrom })); if (!reloadedFrom) this.playbackCache.set(key, bytes); return bytes; }
  async exportRecord(record) { return Buffer.from(await dataJob('export', record)); }
  async archive(snapshots, session, directory, tasks = []) {
    const id = randomUUID(); const ownerId = session?.id ?? snapshots[0].id; const kind = session ? 'sessions' : 'snapshots';
    const archived = await dataJob('archive', { directory, id, bundle: { schemaVersion: 1, session, snapshots, tasks } });
    try {
      this.transaction(() => { this.put('archives', { id, file_path: archived.filePath, byte_size: archived.byteSize, hash: archived.hash, format_version: 'snapshot-bundle-gzip-v1', created_at_ms: Date.now(), owner_kind: kind, owner_id: ownerId }); for (const snapshot of snapshots) this.db.prepare("UPDATE snapshot_metadata SET storage_kind='archive', archive_id=? WHERE id=?").run(id, snapshot.id); if (session) this.db.prepare("UPDATE query_sessions SET storage_kind='archive', archive_id=? WHERE id=?").run(id, session.id); for (const task of tasks) if (task.status === 'completed' && task.result && task.result.evidenceScope !== 'summary') this.put('task_archives', { task_id: task.id, archive_id: id }); });
    } catch (error) { await unlink(archived.filePath); throw error; }
    for (const snapshot of snapshots) snapshot.storageKind = 'archive';
    if (session) session.storageKind = 'archive'; this.playbackCache.clear();
    return { id, ...archived };
  }
  dimensionAt(project, sourceId, mmsi, timeMs) {
    const row = this.db.prepare('SELECT * FROM ais_dimension_versions WHERE project_id=? AND source_id=? AND mmsi=? AND config_version=? AND parser_version=? AND observed_at_ms<=? AND valid_from_ms<=? AND valid_to_ms>? ORDER BY observed_at_ms DESC LIMIT 1').get(project.id, sourceId, mmsi, project.configVersion, project.ais.parserVersion, timeMs, timeMs, timeMs);
    if (!row) return null;
    this.db.prepare('UPDATE ais_dimension_versions SET last_accessed_ms=? WHERE id=?').run(Date.now(), row.id);
    return { mmsi: row.mmsi, eventTime: iso(row.observed_at_ms), confirmedAt: iso(row.confirmed_at_ms), messageType: row.message_type, fromCache: true, sourceHash: row.source_hash, dimensions: { bow: row.bow, stern: row.stern, port: row.port, starboard: row.starboard, observedAt: iso(row.observed_at_ms), validFrom: iso(row.valid_from_ms), validTo: iso(row.valid_to_ms), sourceId: row.source_id }, quality: ['历史尺寸来自结构化缓存，原始报文未随缓存保存'] };
  }
  saveDimensions(project, reports, coverageStart, coverageEnd) {
    const maximum = Number(process.env.AIS_DIMENSION_CACHE_MAX_ROWS ?? 5000);
    if (!Number.isInteger(maximum) || maximum < 0) throw new InputError('AIS_DIMENSION_CACHE_MAX_ROWS 必须为非负整数', 503);
    if (!maximum) { this.db.exec('DELETE FROM ais_dimension_versions'); return; }
    this.transaction(() => {
      const grouped = new Map();
      for (const report of reports) { if (!['5', '19', '24'].includes(report.messageType)) continue; const key = `${report.dimensions.sourceId}:${report.mmsi}`; const list = grouped.get(key) ?? []; list.push(report); grouped.set(key, list); }
      for (const values of grouped.values()) {
        values.sort((a, b) => ms(a.eventTime) - ms(b.eventTime));
        const first = values[0]; const sourceId = first.dimensions.sourceId;
        const previous = this.dimensionAt(project, sourceId, first.mmsi, coverageStart);
        if (previous && ms(previous.eventTime) < ms(first.eventTime)) values.unshift(previous);
        // 已完整读取的窗口重新构造有效段，避免旧尺寸越过后来确认的变化再次生效。
        this.db.prepare('DELETE FROM ais_dimension_versions WHERE project_id=? AND source_id=? AND mmsi=? AND config_version=? AND parser_version=? AND observed_at_ms>=? AND observed_at_ms<?').run(project.id, sourceId, first.mmsi, project.configVersion, project.ais.parserVersion, coverageStart, coverageEnd);
        this.db.prepare('UPDATE ais_dimension_versions SET valid_to_ms=? WHERE project_id=? AND source_id=? AND mmsi=? AND config_version=? AND parser_version=? AND observed_at_ms<? AND valid_to_ms>?').run(coverageStart, project.id, sourceId, first.mmsi, project.configVersion, project.ais.parserVersion, coverageStart, coverageStart);
        const runs = [];
        for (const report of values) { const previous = runs.at(-1); const dims = report.dimensions; const confirmedAt = ms(report.confirmedAt ?? report.eventTime); if (previous && ['bow', 'stern', 'port', 'starboard'].every(field => previous.dimensions[field] === dims[field])) previous.confirmedAt = Math.max(previous.confirmedAt, confirmedAt); else runs.push({ ...report, confirmedAt }); }
        for (const [index, report] of runs.entries()) {
          const dims = report.dimensions; const observed = ms(report.eventTime); const to = index + 1 < runs.length ? ms(runs[index + 1].eventTime) : coverageEnd;
          if (to <= observed) continue;
          const id = hash([project.id, project.configVersion, project.ais.parserVersion, dims.sourceId, report.mmsi, observed, dims.bow, dims.stern, dims.port, dims.starboard]);
          this.put('ais_dimension_versions', { id, project_id: project.id, source_id: dims.sourceId, mmsi: report.mmsi, bow: dims.bow, stern: dims.stern, port: dims.port, starboard: dims.starboard, observed_at_ms: observed, valid_from_ms: observed, valid_to_ms: to, confirmed_at_ms: report.confirmedAt, coverage_start_ms: coverageStart, config_version: project.configVersion, parser_version: project.ais.parserVersion, message_type: report.messageType, source_hash: report.sourceHash ?? (report.raw?.hash == null ? null : String(report.raw.hash)), last_accessed_ms: Date.now() });
        }
      }
      this.db.prepare('DELETE FROM ais_dimension_versions WHERE id IN (SELECT id FROM ais_dimension_versions ORDER BY last_accessed_ms DESC,id LIMIT -1 OFFSET ?)').run(maximum);
    });
  }
  close() { this.worksets.clear(); this.db.close(); }
}
