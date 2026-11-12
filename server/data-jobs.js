import { Worker } from 'node:worker_threads';
import { InputError } from '../shared/data.js';

let pending = Promise.resolve();
let worker; let active; let sequence = 0;
function processingWorker() {
  if (worker) return worker;
  const created = new Worker(new URL('./data-worker.js', import.meta.url), { execArgv: process.execArgv.filter(value => !value.startsWith('--input-type')) });
  worker = created;
  created.on('message', result => {
    if (active?.id !== result.id) return;
    const job = active; active = null; created.unref();
    if (result.error) job.reject(new InputError(result.error, result.statusCode ?? 500)); else job.resolve(result.value);
  });
  const failed = error => { if (worker === created) worker = null; const job = active; active = null; job?.reject(error); };
  created.on('error', failed);
  created.on('exit', code => { if (worker === created) failed(new InputError(`数据处理线程提前退出（${code}）`, 500)); });
  created.unref(); return created;
}
export function dataJob(action, input) {
  const work = pending.then(() => new Promise((resolve, reject) => {
    const current = processingWorker(); const id = ++sequence; active = { id, resolve, reject }; current.ref();
    try { current.postMessage({ id, action, input }); }
    catch (error) { active = null; current.unref(); reject(error); }
  }));
  pending = work.catch(() => {});
  return work;
}
