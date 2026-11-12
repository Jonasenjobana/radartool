import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fitOptionsSchema, geographicBoundsSchema, InputError, MAX_IMPORT_POINTS, parametersSchema, parseInput, timestampSchema } from '../shared/data.js';
import { normalizeAngle } from '../shared/geo.js';
import { loadProjects, publicProject } from './config.js';
import { inspectSource, queryDataset, queryGroupDatasets, queryAisDimensions } from './sources.js';
import { SqliteStore } from './storage.js';
import { TaskManager } from './tasks.js';
import { DeviceRegistry } from './registry.js';
import { dataJob } from './data-jobs.js';
import { Preparations } from './preparations.js';
import { WindowPlaybacks } from './window-playbacks.js';
import { queryWindowDatasets, queryWindowFrameTime } from './window-sources.js';

const validRange = (value) => Date.parse(value.end) > Date.parse(value.start);
const querySchema = z.object({ projectId: z.string().min(1), radarId: z.string().min(1), aisSourceIds: z.array(z.string()).min(1).max(100), start: timestampSchema, end: timestampSchema, queryArea: geographicBoundsSchema.nullish(), forceReload: z.boolean().default(false) }).refine(validRange, '结束时间必须晚于开始时间');
const groupQuerySchema = z.object({ start: timestampSchema, end: timestampSchema, queryArea: geographicBoundsSchema.nullish(), revision: z.number().int().positive().optional(), forceReload: z.boolean().default(false) }).refine(validRange, '结束时间必须晚于开始时间');
const aisDimensionsSchema = z.object({ mmsi: z.string().regex(/^\d{9}$/, 'MMSI 必须为 9 位数字'), aisSourceIds: z.array(z.string().min(1).max(160)).min(1).max(100), positionTime: timestampSchema });
const versionSchema = z.object({ name: z.string().min(1).max(100), snapshotId: z.string(), parameters: parametersSchema, effectiveFrom: timestampSchema.nullable().default(null), source: z.enum(['manual', 'task']), taskId: z.string().optional(), candidateIndex: z.number().int().min(0).max(11).optional() });
const download = (reply, name, body) => reply.header('Content-Disposition', `attachment; filename="${name}.json"`).type('application/json').send(body);

const isMockDataset = (dataset) => ['synthetic', 'schema-example', 'demo'].includes(dataset?.provenance?.kind);

export async function buildApp({ dataDir = process.env.DATA_DIR ?? './data', configPath = process.env.PROJECT_CONFIG, logger = false, serveClient = true, projectConfigs, readDataset = queryDataset, readGroupDatasets = queryGroupDatasets, readWindowDatasets = queryWindowDatasets, readPlaybackFrameTime = queryWindowFrameTime, readAisDimensions = queryAisDimensions, allowTestFixtures = false } = {}) {
  const app = Fastify({ logger, bodyLimit: 32 * 1024 * 1024, requestTimeout: 90000 });
  const projects = projectConfigs ?? await loadProjects(configPath);
  const store = new SqliteStore(dataDir);
  await store.init();
  const registry = new DeviceRegistry(store, projects);
  const tasks = new TaskManager(store, app.log);
  let windowPlaybacks;
  try { await registry.init(); await tasks.init(); windowPlaybacks = new WindowPlaybacks(store, registry, readWindowDatasets, readGroupDatasets, readDataset, readPlaybackFrameTime); } catch (error) { store.close(); throw error; }
  const preparations = new Preparations(app.log);
  app.decorate('store', store);
  app.decorate('tasks', tasks);
  app.decorate('registry', registry);
  app.decorate('windowPlaybacks', windowPlaybacks);
  app.addHook('onClose', async () => { windowPlaybacks.release(windowPlaybacks.current); await tasks.close(); await preparations.close(); await windowPlaybacks.close(); await registry.pending; store.close(); });
  const visible = (snapshot) => allowTestFixtures || !['synthetic', 'schema-example', 'demo'].includes(snapshot.sourceKind ?? snapshot.dataset?.provenance?.kind);
  const snapshotMeta = (id) => { store.validate('snapshots', id); const value = store.snapshotMeta(id); if (!value || !visible(value)) throw new InputError('数据快照不存在', 404); return value; };
  const readSnapshot = async (id) => {
    snapshotMeta(id);
    const record = await store.read('snapshots', id);
    if (record.sessionId) await store.read('sessions', record.sessionId);
    return record;
  };
  const visibleTask = (task) => {
    if (store.snapshotMeta(task.snapshotId)) snapshotMeta(task.snapshotId);
    else { const description = windowPlaybacks.describe(task.sessionId); if (description.projectId !== task.projectId || !description.radarIds.includes(task.radarId)) throw new InputError('标定任务不存在', 404); }
    return task;
  };
  const list = (kind, request, reply) => { const values = store.list(kind, { ...request.query, includeSynthetic: allowTestFixtures }); if (values.nextCursor) reply.header('X-Next-Cursor', values.nextCursor); return values; };
  const playback = async (request, reply, snapshots, session = null, reloadedFrom = null) => reply.type('application/json').send(request.query.format === 'full' ? await store.exportRecord(session ? { session, snapshots } : snapshots[0]) : await store.playback(snapshots, session, reloadedFrom));
  const bundleFor = async (id, signal, beginPublish) => {
    const session = await store.read('sessions', id);
    const snapshots = [];
    for (const snapshotId of session.snapshotIds) snapshots.push(await readSnapshot(snapshotId));
    if (signal?.aborted) throw new InputError('加载已取消', 499);
    beginPublish?.();
    store.activate(snapshots, session); return { session, snapshots };
  };
  const archiveTasks = async snapshotIds => {
    const rows = store.db.prepare(`SELECT id FROM calibration_tasks WHERE snapshot_id IN (${snapshotIds.map(() => '?').join(',')}) ORDER BY created_at_ms,id`).all(...snapshotIds);
    const result = []; for (const row of rows) result.push(await tasks.get(row.id)); return result;
  };
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof InputError || error.statusCode === 413) reply.code(error.statusCode).send({ error: error.message });
    else if (error.statusCode === 400) reply.code(400).send({ error: '请求格式无效，请检查 JSON 和参数' });
    else { request.log.error({ err: error }, '请求失败'); reply.code(500).send({ error: '服务端处理失败，请检查服务日志和数据目录' }); }
  });
  app.get('/api/health', async () => ({ status: 'ok', version: '1.0.0' }));
  app.get('/api/preparations/:id', request => preparations.status(request.params.id));
  app.post('/api/preparations/:id/cancel', request => preparations.cancel(request.params.id));
  app.get('/api/preparations/:id/result', (request, reply) => { const job = preparations.get(request.params.id); if (job.status === 'failed') throw new InputError(job.error, job.statusCode); if (job.status === 'cancelled') throw new InputError('加载已取消', 499); if (!job.result) throw new InputError('数据尚未准备完成或结果已释放，请重新加载', 409); return reply.type('application/json').send(job.result); });
  app.get('/api/projects', async () => registry.projects().map(publicProject));
  app.get('/api/registry', async () => ({ revision: registry.state.revision, projects: registry.projects().map(publicProject) }));
  app.post('/api/registry/:projectId/:kind', async (request, reply) => reply.code(201).send(await registry.saveDevice(request.params.projectId, request.params.kind, request.body)));
  app.put('/api/registry/:projectId/:kind/:id', (request) => registry.saveDevice(request.params.projectId, request.params.kind, request.body, request.params.id));
  app.delete('/api/registry/:projectId/:kind/:id', (request) => registry.removeDevice(request.params.projectId, request.params.kind, request.params.id));
  app.get('/api/groups', async (request) => registry.groups(request.query.projectId));
  app.post('/api/groups', async (request, reply) => reply.code(201).send(await registry.saveGroup(request.body)));
  app.put('/api/groups/:id', (request) => registry.saveGroup(request.body, request.params.id));
  app.delete('/api/groups/:id', (request) => registry.removeGroup(request.params.id));
  app.post('/api/groups/:id/playback', (request, reply) => reply.code(201).send(windowPlaybacks.create(request.params.id, parseInput(groupQuerySchema, request.body))));
  app.get('/api/playbacks', (request, reply) => { const values = windowPlaybacks.list(request.query); if (values.nextCursor) reply.header('X-Next-Cursor', values.nextCursor); return values; });
  app.get('/api/playbacks/:id/status', request => windowPlaybacks.status(request.params.id));
  app.post('/api/playbacks/:id/open', request => { const value = windowPlaybacks.describe(request.params.id); windowPlaybacks.project(value); windowPlaybacks.activate(value.id); return windowPlaybacks.describe(value.id); });
  app.delete('/api/playbacks/:id', request => { windowPlaybacks.describe(request.params.id); windowPlaybacks.release(request.params.id); return { released: true }; });
  app.post('/api/playbacks/:id/cancel', request => { const { requestId } = parseInput(z.object({ requestId: z.string().min(1).max(160) }), request.body); return windowPlaybacks.cancel(request.params.id, requestId); });
  app.post('/api/playbacks/:id/windows', async (request, reply) => {
    const input = parseInput(z.object({ at: z.number().finite(), trailSeconds: z.number().int().min(0).max(300).default(60), windowMs: z.number().int().min(1000).max(1800000).multipleOf(1000).optional(), prefetch: z.boolean().default(false), protectedWindowId: z.string().max(160).optional(), requestId: z.string().min(1).max(160) }), request.body);
    const controller = new AbortController(); const abort = () => controller.abort(); request.raw.once('aborted', abort); reply.raw.once('close', abort);
    try { const entry = await windowPlaybacks.window(request.params.id, input, controller.signal); return reply.type('application/json').send(entry.bytes); }
    finally { request.raw.off('aborted', abort); reply.raw.off('close', abort); }
  });
  app.post('/api/playbacks/:id/frame', async (request, reply) => {
    const input = parseInput(z.object({ at: z.number().finite(), direction: z.union([z.literal(-1), z.literal(1)]), trailSeconds: z.number().int().min(0).max(300).default(60), requestId: z.string().min(1).max(160) }), request.body);
    const controller = new AbortController(); const abort = () => controller.abort(); request.raw.once('aborted', abort); reply.raw.once('close', abort);
    try { return await windowPlaybacks.frame(request.params.id, input, controller.signal); }
    finally { request.raw.off('aborted', abort); reply.raw.off('close', abort); }
  });
  app.post('/api/playbacks/:id/prepare', preparations.wrap(async (request, reply) => {
    const input = parseInput(z.object({ radarId: z.string().optional() }), request.body ?? {});
    request.reportStage('准备完整业务输入'); return reply.send(await windowPlaybacks.materialize(request.params.id, input.radarId, request.preparationSignal, request.beginPublish));
  }));
  app.post('/api/projects/:id/inspect', async (request) => {
    const project = registry.project(request.params.id);
    return inspectSource(project);
  });
  app.post('/api/projects/:id/ais/dimensions', async (request, reply) => {
    const query = parseInput(aisDimensionsSchema, request.body);
    const project = registry.project(request.params.id);
    if (query.aisSourceIds.some((id) => !project.aisSources.some((source) => source.id === id))) throw new InputError('AIS 来源不属于所选项目');
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once('aborted', abort); reply.raw.once('close', abort);
    try { return await windowPlaybacks.serial(() => readAisDimensions(project, query, controller.signal)); }
    finally { request.raw.off('aborted', abort); reply.raw.off('close', abort); }
  });
  app.post('/api/query', preparations.wrap(async (request, reply) => {
    const query = parseInput(querySchema, request.body);
    const project = registry.project(query.projectId);
    if (!project.radars.some((r) => r.id === query.radarId)) throw new InputError('雷达不属于所选项目');
    if (query.aisSourceIds.some((id) => !project.aisSources.some((source) => source.id === id))) throw new InputError('AIS 来源不属于所选项目');
    request.reportStage('读取雷达与 AIS');
    const normalized = await readDataset(project, query, request.preparationSignal, store);
    request.reportStage('准备回放数据');
    const snapshot = await store.saveSnapshot(normalized, project, request.preparationSignal, request.beginPublish);
    return playback(request, reply, [snapshot]);
  }));
  app.post('/api/groups/:id/query', preparations.wrap(async (request, reply) => {
    const body = parseInput(groupQuerySchema, request.body);
    const group = registry.group(request.params.id);
    if (body.revision != null && body.revision !== group.revision) throw new InputError('匹配组已修改，请刷新配置后加载', 409);
    const project = registry.project(group.projectId);
    const matches = cached => cached && cached.groupId === group.id && cached.groupRevision === group.revision && cached.registryRevision === project.registryRevision && Date.parse(cached.start) === Date.parse(body.start) && Date.parse(cached.end) === Date.parse(body.end) && JSON.stringify(cached.queryArea) === JSON.stringify(body.queryArea ?? null) && cached.snapshotIds.every(id => { const meta = store.snapshotMeta(id); return meta?.configVersion === project.configVersion && meta.parserVersion === (project.ais.parserVersion ?? null) && meta.mappingVersion === (project.clickhouse.mapping?.version ?? null) && meta.timeSemantics === project.timeSemantics && meta.reference.lng === project.reference.lng && meta.reference.lat === project.reference.lat; });
    if (!body.forceReload && store.current) {
      const row = store.db.prepare('SELECT * FROM query_sessions WHERE id=?').get(store.current);
      const cached = row && store.sessionMeta(row);
      if (cached?.availability === 'memory' && matches(cached)) return playback(request, reply, cached.snapshotIds.map(id => store.worksets.get(id)), cached);
    }
    if (!body.forceReload) {
      const saved = store.list('sessions', { groupId: group.id, includeSynthetic: allowTestFixtures }).find(value => value.storageKind !== 'temporary' && matches(value));
      if (saved) { request.reportStage('验证已有完整历史'); const bundle = await bundleFor(saved.id, request.preparationSignal, request.beginPublish); return playback(request, reply, bundle.snapshots, bundle.session); }
    }
    const id = randomUUID();
    const evidence = { group: structuredClone(group), groupSessionId: id };
    const query = { ...body, projectId: project.id, radarIds: group.radarIds, aisSourceIds: group.aisSourceIds };
    request.reportStage('读取雷达与 AIS');
    const values = await readGroupDatasets(project, query, evidence, request.preparationSignal, store);
    if (values.length !== group.radarIds.length || values.some((value, i) => value.dataset.radarId !== group.radarIds[i] || value.dataset.projectId !== group.projectId || Date.parse(value.dataset.timeRange.start) !== Date.parse(body.start) || Date.parse(value.dataset.timeRange.end) !== Date.parse(body.end))) throw new InputError('匹配组查询返回不完整，未保存会话', 502);
    request.reportStage('准备回放数据');
    const bundle = await store.saveSession(values, { id, projectId: project.id, groupId: group.id, groupName: group.name, groupRevision: group.revision, registryRevision: project.registryRevision, radarIds: [...group.radarIds], aisSourceIds: [...group.aisSourceIds], start: body.start, end: body.end, queryArea: body.queryArea ?? null }, project, request.preparationSignal, request.beginPublish);
    return playback(request, reply, bundle.snapshots, bundle.session);
  }));
  app.get('/api/sessions', (request, reply) => list('sessions', request, reply));
  app.get('/api/sessions/:id', async (request, reply) => { const bundle = await bundleFor(request.params.id); return playback(request, reply, bundle.snapshots, bundle.session); });
  const requery = async (meta, session, request) => {
    const configured = registry.project(meta.projectId);
    if (meta.configVersion && meta.configVersion !== configured.configVersion) throw new InputError('数据源配置已变化，请按当前配置重新加载；原历史记录保留', 409);
    const members = session ? session.snapshotIds.map(snapshotMeta) : [meta];
    const project = { ...configured, reference: meta.reference, registryRevision: session?.registryRevision ?? configured.registryRevision, radars: members.map(member => member.radarConfiguration), aisSources: (session?.aisSourceIds ?? meta.aisSourceIds).map(id => ({ id, name: (session?.aisSourceNames ?? meta.aisSourceNames)?.[id] ?? configured.aisSources.find(source => source.id === id)?.name ?? id })) };
    const query = { projectId: meta.projectId, radarId: meta.radarId, radarIds: members.map(member => member.radarId), aisSourceIds: session?.aisSourceIds ?? meta.aisSourceIds, start: session?.start ?? new Date(meta.summary.start).toISOString(), end: session?.end ?? new Date(meta.summary.end).toISOString(), queryArea: session?.queryArea ?? meta.queryArea };
    if (!meta.configVersion) throw new InputError('此记录没有完整回源配置，请重新导入或打开已有归档', 410);
    request.reportStage('按历史条件读取雷达与 AIS');
    if (session) {
      const id = randomUUID(); const group = { id: session.groupId, projectId: session.projectId, name: session.groupName, revision: session.groupRevision, radarIds: session.radarIds, aisSourceIds: session.aisSourceIds };
      const values = await readGroupDatasets(project, query, { group, groupSessionId: id }, request.preparationSignal, store);
      if (values.length !== members.length || values.some((value, index) => value.dataset.radarId !== members[index].radarId || value.dataset.projectId !== meta.projectId || Date.parse(value.dataset.timeRange.start) !== Date.parse(query.start) || Date.parse(value.dataset.timeRange.end) !== Date.parse(query.end))) throw new InputError('历史回源返回不完整，未保存会话', 502);
      request.reportStage('准备回放数据');
      return store.saveSession(values, { ...session, id, archiveId: undefined }, project, request.preparationSignal, request.beginPublish);
    }
    const normalized = await readDataset(project, query, request.preparationSignal, store);
    request.reportStage('准备回放数据');
    return { session: null, snapshots: [await store.saveSnapshot(normalized, project, request.preparationSignal, request.beginPublish)] };
  };
  app.post('/api/sessions/:id/load', preparations.wrap(async (request, reply) => {
    const session = await store.read('sessions', request.params.id);
    if (session.availability !== 'reload') { request.reportStage('验证已有完整历史'); const bundle = await bundleFor(session.id, request.preparationSignal, request.beginPublish); return playback(request, reply, bundle.snapshots, bundle.session); }
    const meta = snapshotMeta(session.snapshotIds[0]); const bundle = await requery(meta, session, request);
    const reloadedFrom = { id: session.id, changed: bundle.session.fingerprint !== session.fingerprint };
    return playback(request, reply, bundle.snapshots, bundle.session, reloadedFrom);
  }));
  app.post('/api/snapshots/:id/load', preparations.wrap(async (request, reply) => {
    const meta = snapshotMeta(request.params.id);
    if (meta.availability !== 'reload') { request.reportStage('验证已有完整历史'); const record = await readSnapshot(meta.id); if (request.preparationSignal.aborted) throw new InputError('加载已取消', 499); request.beginPublish(); store.activate([record]); return playback(request, reply, [record]); }
    const bundle = await requery(meta, null, request); return playback(request, reply, bundle.snapshots, null, { id: meta.id, changed: bundle.snapshots[0].fingerprint !== meta.fingerprint });
  }));
  app.post('/api/sessions/:id/release', (request) => { store.release(request.params.id); return { released: true }; });
  app.post('/api/snapshots/:id/release', (request) => { store.release(request.params.id); return { released: true }; });
  app.post('/api/sessions/:id/archive', async (request) => { const { directory } = parseInput(z.object({ directory: z.string().min(1).max(2000) }), request.body); const bundle = await bundleFor(request.params.id); return store.archive(bundle.snapshots, bundle.session, directory, await archiveTasks(bundle.session.snapshotIds)); });
  app.post('/api/snapshots/:id/archive', async (request) => { const { directory } = parseInput(z.object({ directory: z.string().min(1).max(2000) }), request.body); return store.archive([await readSnapshot(request.params.id)], null, directory, await archiveTasks([request.params.id])); });
  app.post('/api/snapshots/import', preparations.wrap(async (request, reply) => {
    const body = request.body;
    const input = body?.dataset ?? body;
    if (['playback-v2', 'window-playback', 'window-source'].includes(input?.provenance?.representation)) throw new InputError('回放视图不是完整业务归档，请使用服务端导出的原始观测文件');
    if (!allowTestFixtures && isMockDataset(input)) throw new InputError('仅支持真实历史数据');
    const points = (Array.isArray(input?.radar) ? input.radar.length : 0) + (Array.isArray(input?.ais) ? input.ais.length : 0) + (Array.isArray(input?.aisStatic) ? input.aisStatic.length : 0);
    if (points > MAX_IMPORT_POINTS) throw new InputError(`导入总观测数不能超过 ${MAX_IMPORT_POINTS}`);
    request.reportStage('校验导入数据');
    const snapshot = await store.saveSnapshot(await dataJob('normalize', input), undefined, request.preparationSignal, request.beginPublish); return playback(request, reply, [snapshot]);
  }));
  app.get('/api/snapshots', (request, reply) => list('snapshots', request, reply));
  app.post('/api/playback', preparations.wrap(async (request, reply) => { const { snapshotIds } = parseInput(z.object({ snapshotIds: z.array(z.string()).min(1).max(8) }), request.body); request.reportStage('验证已有完整历史'); const snapshots = []; for (const id of snapshotIds) snapshots.push(await readSnapshot(id)); if (request.preparationSignal.aborted) throw new InputError('加载已取消', 499); request.beginPublish(); store.activate(snapshots); return playback(request, reply, snapshots); }));
  app.get('/api/snapshots/:id/metadata', request => snapshotMeta(request.params.id));
  app.get('/api/snapshots/:id', async (request, reply) => { const record = await readSnapshot(request.params.id); store.activate([record]); return playback(request, reply, [record]); });
  app.get('/api/snapshots/:id/observations/:kind/:pointId', async request => {
    if (!['radar', 'ais', 'aisStatic'].includes(request.params.kind)) throw new InputError('观测类型无效');
    const windowSnapshot = request.query.playbackId ? windowPlaybacks.rawSnapshot(request.params.id) : null;
    if (request.query.playbackId && (!windowSnapshot || windowSnapshot.sessionId !== request.query.playbackId)) throw new InputError('原始观测所属窗口已释放，请重新加载对应播放时间', 410);
    const snapshot = windowSnapshot ?? await readSnapshot(request.params.id); const point = snapshot.dataset[request.params.kind]?.find(value => value.id === request.params.pointId || value.observationIds?.includes(request.params.pointId));
    if (!point) throw new InputError('观测不存在', 404); return { raw: point.raw, snapshotHash: snapshot.hash };
  });
  app.get('/api/snapshots/:id/export', async (request, reply) => { const record = await readSnapshot(request.params.id); return download(reply, `snapshot-${record.id}`, await store.exportRecord(record)); });
  app.post('/api/tasks', async (request, reply) => {
    const body = parseInput(z.object({ snapshotId: z.string().optional(), playbackId: z.string().optional(), radarId: z.string().optional(), options: fitOptionsSchema }).refine(value => (value.snapshotId != null) !== (value.playbackId != null) && (value.playbackId == null || !!value.radarId), '指定完整快照，或指定分窗回放与雷达'), request.body);
    if (body.options.refinement && !body.options.refinement.associationIds?.length) throw new InputError('请先完成关联检查并至少保留一个关联，再开始自动精调');
    if (body.playbackId) {
      const description = windowPlaybacks.describe(body.playbackId); windowPlaybacks.project(description);
      if (!description.radarIds.includes(body.radarId)) throw new InputError('雷达不属于该回放');
      if (!description.unitsVerified || !description.alignmentVerified || description.timeSemantics === 'unverified') throw new InputError('数据单位或时间语义未核实，不能运行自动拟合');
      if (preparations.active) throw new InputError('已有历史数据正在加载或准备，请完成或取消后重试', 409);
      const task = await tasks.startPlayback(description, body.radarId, body.options, (signal, reportStage, snapshotId) => preparations.run(signal, inputSignal => windowPlaybacks.prepareRadar(description, body.radarId, inputSignal, { snapshotId, reportStage })));
      return reply.code(202).send(task);
    }
    const snapshot = await readSnapshot(body.snapshotId);
    if (!snapshot.dataset.unitsVerified || !snapshot.dataset.alignmentVerified || snapshot.dataset.timeSemantics === 'unverified') throw new InputError('数据单位或时间语义未核实，不能运行自动拟合');
    const task = await tasks.start(snapshot, body.options);
    return reply.code(202).send(task);
  });
  app.get('/api/tasks', (request, reply) => list('tasks', request, reply));
  app.get('/api/tasks/:id', async request => visibleTask(await tasks.get(request.params.id)));
  app.post('/api/tasks/:id/cancel', async request => { visibleTask(await tasks.get(request.params.id)); return tasks.cancel(request.params.id); });
  app.get('/api/tasks/:id/export', async (request, reply) => { const task = visibleTask(await tasks.get(request.params.id)); return download(reply, `calibration-${request.params.id}`, await store.exportRecord(task)); });
  app.get('/api/versions', (request, reply) => list('versions', request, reply));
  app.post('/api/versions', async (request, reply) => {
    const body = parseInput(versionSchema, request.body);
    const meta = snapshotMeta(body.snapshotId);
    const snapshot = { id: meta.id, hash: meta.hash, dataset: { projectId: meta.projectId, radarId: meta.radarId, provenance: { configVersion: meta.configVersion }, radar: [{ mappingVersion: meta.mappingVersion }] } };
    let task;
    let parameters = { ...body.parameters, bearingOffsetDeg: normalizeAngle(body.parameters.bearingOffsetDeg) };
    if (body.source === 'task') {
      task = await tasks.get(body.taskId);
      if (task.status !== 'completed' || task.snapshotId !== snapshot.id || body.candidateIndex == null || !task.result?.candidates?.[body.candidateIndex]) throw new InputError('任务、快照或候选不匹配');
      parameters = task.result.candidates[body.candidateIndex].parameters;
    }
    const version = { id: randomUUID(), name: body.name, projectId: snapshot.dataset.projectId, radarId: snapshot.dataset.radarId, parameters, createdAt: new Date().toISOString(), effectiveFrom: body.effectiveFrom, source: body.source, snapshotId: snapshot.id, snapshotHash: snapshot.hash, ...(task ? { taskId: task.id, candidateIndex: body.candidateIndex } : {}), assessment: task?.result.assessment ?? 'manual', convention: 'WGS84；距离米；从北顺时针；真北方位=原始标准方位+北向偏差', evidence: task ? { modelVersion: task.result.modelVersion, splitTime: task.result.splitTime, options: task.options, assessmentReasons: task.result.reasons, initialMetrics: task.result.initialMetrics } : { configVersion: snapshot.dataset.provenance.configVersion ?? 'import', mappingVersions: store.db.prepare('SELECT mapping_version FROM snapshot_mapping_versions WHERE snapshot_id=? ORDER BY mapping_version').all(snapshot.id).map(row => row.mapping_version) } };
    if (body.effectiveFrom && task?.result.assessment !== 'recommended' && body.source === 'task') throw new InputError('证据不足或存在多解的自动候选只能保存为候选版本');
    await store.write('versions', version);
    return reply.code(201).send(version);
  });
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  if (serveClient && existsSync(dist)) await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: request.url.startsWith('/api') ? '接口不存在' : '请先 npm run build，或使用 npm run dev 启动前端' }));
  return app;
}
