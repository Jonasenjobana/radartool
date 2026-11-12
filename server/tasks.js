import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { InputError } from '../shared/data.js';
import { optionsHash } from './task-storage.js';

export class TaskManager {
  constructor(store, logger) { this.store = store; this.logger = logger; this.tasks = new Map(); this.jobs = new Map(); }
  async init() {
    for (const row of this.store.db.prepare("SELECT id FROM calibration_tasks WHERE status='running'").all()) {
      const task = await this.store.read('tasks', row.id);
      if (task.status === 'running') { task.status = 'interrupted'; task.error = '服务已重启，任务中断；可以重新提交标定任务'; task.updatedAt = new Date().toISOString(); await this.store.write('tasks', task); }
    }
  }
  async start(snapshot, options) {
    return this.launch({ snapshotId: snapshot.id, snapshotHash: snapshot.hash, projectId: snapshot.dataset.projectId, radarId: snapshot.dataset.radarId, sessionId: snapshot.sessionId, dataRange: { start: snapshot.summary.start, end: snapshot.summary.end } }, options, async () => snapshot);
  }
  async startPlayback(description, radarId, options, prepare) {
    // 提交时预留完整输入的快照标识，准备成功后才发布对应观测与摘要。
    return this.launch({ snapshotId: randomUUID(), sessionId: description.id, projectId: description.projectId, radarId, dataRange: { start: Date.parse(description.start), end: Date.parse(description.end) } }, options, prepare);
  }
  async launch(input, options, prepare) {
    if (this.jobs.size) throw new InputError('已有自动任务运行中，请完成或取消后再开始', 409);
    const task = { ...input, id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'running', options, progress: { phase: input.snapshotHash ? '准备固定数据快照' : '准备完整时段数据', fraction: 0, completed: 0, total: 0, evaluations: 0 } };
    task.validationRange = { start: task.dataRange.start + (task.dataRange.end - task.dataRange.start) * (1 - options.validationFraction), end: task.dataRange.end };
    for (const [id, previous] of this.tasks) if (previous.status !== 'running') this.tasks.delete(id);
    // 先占用任务槽，避免两个并发请求在首次磁盘写入期间同时启动。
    const job = { controller: new AbortController(), worker: null, promise: null };
    this.jobs.set(task.id, job);
    this.tasks.set(task.id, task);
    try { await this.store.write('tasks', task); }
    catch (error) { this.jobs.delete(task.id); this.tasks.delete(task.id); throw error; }
    job.promise = new Promise(resolve => setImmediate(resolve)).then(() => this.run(task, job, prepare)).catch(async error => {
      if (task.status !== 'running') return;
      task.status = 'failed'; task.error = error instanceof InputError ? error.message : '标定任务失败，请检查服务日志';
      if (!(error instanceof InputError)) this.logger.error({ err: error }, '自动标定任务失败');
      await this.persist(task);
    }).finally(() => this.jobs.delete(task.id));
    return task;
  }
  async run(task, job, prepare) {
    if (task.status !== 'running') return;
    const snapshot = await prepare(job.controller.signal, phase => { if (task.status === 'running') { task.progress.phase = phase; this.persist(task); } }, task.snapshotId);
    if (task.status !== 'running' || job.controller.signal.aborted) return;
    task.snapshotHash = snapshot.hash;
    task.validationPreviousTasks = this.store.db.prepare("SELECT id FROM calibration_tasks WHERE status='completed' AND project_id=? AND radar_id=? AND data_start_ms<? AND data_end_ms>? AND options_hash<>? ORDER BY created_at_ms,id").all(task.projectId, task.radarId, task.validationRange.end, task.validationRange.start, optionsHash(task.options)).map(value => value.id);
    task.progress.phase = '开始标定计算'; await this.store.write('tasks', task);
    if (task.status !== 'running' || job.controller.signal.aborted) return;
    const strip = ({ raw, ...point }) => point;
    const dataset = { ...snapshot.dataset, radar: snapshot.dataset.radar.map(strip), ais: snapshot.dataset.ais.map(strip), aisStatic: (snapshot.dataset.aisStatic ?? []).map(strip), provenance: {} };
    await new Promise(resolve => {
      const worker = new Worker(new URL('./fit-worker.js', import.meta.url), { workerData: { dataset, options: task.options, snapshotHash: snapshot.hash }, execArgv: process.execArgv.filter(value => !value.startsWith('--input-type')) });
      job.worker = worker;
      worker.on('message', (message) => {
        if (task.status !== 'running') return;
        task.updatedAt = new Date().toISOString();
        if (message.type === 'progress') task.progress = message.progress;
        else if (message.type === 'result') {
          task.status = 'completed'; task.result = message.result;
          task.result.validationReused = task.validationPreviousTasks.length > 0;
          task.result.validationPreviousTasks = task.validationPreviousTasks;
          if (task.result.validationReused) {
            task.result.assessment = 'insufficient';
            task.result.reasons.push('验证时段与此前不同设置的任务数据重叠，属于复用验证；需要新的未参与调参时段复核');
          }
          task.progress.fraction = 1; task.progress.phase = '已完成'; this.persist(task);
        }
        else if (message.type === 'error') { task.status = 'failed'; task.error = message.error; this.persist(task); }
      });
      worker.on('error', (error) => { if (task.status === 'running') { task.status = 'failed'; task.error = `拟合工作线程失败：${error.message}`; this.persist(task); } });
      worker.on('exit', (code) => {
        if (task.status === 'running') { task.status = 'failed'; task.error = `拟合工作线程提前退出（${code}）`; this.persist(task); }
        resolve();
      });
    });
  }
  persist(task) {
    task.updatedAt = new Date().toISOString();
    return this.store.write('tasks', task).catch((error) => { task.status = 'failed'; task.error = '任务结果持久化失败，请检查数据目录'; this.logger.error({ err: error }, '任务持久化失败'); });
  }
  async get(id) { return this.tasks.get(id) ?? await this.store.read('tasks', id); }
  async cancel(id) {
    const task = await this.get(id);
    if (task.status !== 'running') return task;
    task.status = 'cancelled'; task.updatedAt = new Date().toISOString(); task.error = '用户取消';
    const job = this.jobs.get(id); job?.controller.abort();
    if (job?.worker) await job.worker.terminate();
    await this.store.write('tasks', task);
    return task;
  }
  async close() {
    const pending = [];
    for (const [id, job] of this.jobs) {
      const task = this.tasks.get(id);
      if (task.status === 'running') { task.status = 'interrupted'; task.error = '服务关闭，任务中断'; task.updatedAt = new Date().toISOString(); await this.store.write('tasks', task); }
      job.controller.abort();
      if (job.worker) await job.worker.terminate();
      pending.push(job.promise);
    }
    await Promise.all(pending); this.jobs.clear();
  }
}
