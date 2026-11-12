import { randomUUID } from 'node:crypto';
import { InputError } from '../shared/data.js';

export class Preparations {
  constructor(logger) { this.logger = logger; this.jobs = new Map(); this.active = null; }
  async run(signal, action) {
    if (this.active) throw new InputError('已有历史数据正在加载或准备，请完成或取消后重试', 409);
    const controller = new AbortController(); const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    const job = { controller }; this.active = job;
    try { job.promise = action(controller.signal); return await job.promise; }
    finally { signal.removeEventListener('abort', abort); if (this.active === job) this.active = null; }
  }
  wrap(handler) {
    return async (request, reply) => {
      if (this.active) throw new InputError('已有历史数据正在加载或准备，请完成或取消后重试', 409);
      const controller = new AbortController(); const id = randomUUID();
      const job = { id, status: 'preparing', phase: '准备查询', controller, result: null };
      const reportStage = phase => { job.phase = phase; };
      const beginPublish = () => { job.publishing = true; job.phase = '生成回放响应'; };
      this.active = job;
      if (request.query.async !== '1') {
        const abort = () => controller.abort(); request.raw.once('aborted', abort); reply.raw.once('close', abort);
        try { return await handler(Object.assign(request, { preparationSignal: controller.signal, reportStage, beginPublish }), reply); }
        finally { request.raw.off('aborted', abort); reply.raw.off('close', abort); if (this.active === job) this.active = null; }
      }
      for (const previous of this.jobs.values()) previous.result = null;
      while (this.jobs.size >= 20) this.jobs.delete(this.jobs.keys().next().value);
      this.jobs.set(id, job);
      const response = { type() { return this; }, send(value) { return value; } };
      job.promise = handler({ body: request.body, params: request.params, query: { ...request.query, format: 'playback-v2' }, preparationSignal: controller.signal, reportStage, beginPublish }, response).then(value => {
        if (!controller.signal.aborted) { job.result = value; job.status = 'completed'; job.phase = '已完成'; }
      }).catch(error => {
        if (!controller.signal.aborted) { job.status = 'failed'; job.error = error instanceof InputError ? error.message : '数据准备失败，请检查服务日志'; job.statusCode = error.statusCode ?? 500; if (!(error instanceof InputError)) this.logger.error({ err: error }, '历史数据准备失败'); }
      }).finally(() => { if (controller.signal.aborted) { job.status = 'cancelled'; job.phase = '已取消'; } if (this.active === job) this.active = null; });
      return reply.code(202).send({ id, status: job.status, phase: job.phase });
    };
  }
  get(id) { const job = this.jobs.get(id); if (!job) throw new InputError('数据准备记录不存在或已释放', 404); return job; }
  status(id) { const { status, phase, error, statusCode } = this.get(id); return { id, status, phase, error, statusCode }; }
  cancel(id) { const job = this.get(id); if (job.status === 'preparing' && !job.publishing) { job.controller.abort(); job.status = 'cancelled'; job.phase = '已取消'; } return this.status(id); }
  async close() { if (this.active) { this.active.controller.abort(); await this.active.promise; } }
}
