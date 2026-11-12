import { parentPort, workerData } from 'node:worker_threads';
import { runFit } from './fitter.js';

try {
  const result = runFit(workerData.dataset, workerData.options, (progress) => parentPort.postMessage({ type: 'progress', progress }));
  parentPort.postMessage({ type: 'result', result: { ...result, snapshotHash: workerData.snapshotHash } });
} catch (error) {
  parentPort.postMessage({ type: 'error', error: error instanceof Error ? error.message : '自动拟合失败' });
}
