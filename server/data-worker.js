import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { readFile, open, unlink, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import { canonicalJson, InputError, normalizeDataset } from '../shared/data.js';
import { encodePlayback } from '../shared/playback.js';

const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
function identity(dataset) {
  const point = ({ raw, ...value }) => value;
  return { projectId: dataset.projectId, radarId: dataset.radarId, reference: dataset.reference, baseline: dataset.baseline, timeRange: dataset.timeRange, timeSemantics: dataset.timeSemantics, unitsVerified: dataset.unitsVerified, alignmentVerified: dataset.alignmentVerified, radar: dataset.radar.map(point), ais: dataset.ais.map(point), aisStatic: (dataset.aisStatic ?? []).map(point) };
}
function verified(record) {
  if (hash(record.dataset) !== record.hash) throw new InputError('快照内容与 SHA-256 不一致，请重新导入原始数据', 409);
  return record;
}
async function readLegacy(input) {
  if (input.location === 'file') return JSON.parse(await readFile(input.filePath, 'utf8'));
  const db = new DatabaseSync(input.database, { readOnly: true });
  try {
    const row = db.prepare('SELECT payload FROM records WHERE kind = ? AND id = ?').get(input.kind, input.id);
    if (!row) throw new InputError('旧记录不存在', 404);
    return JSON.parse(row.payload);
  } finally { db.close(); }
}

async function execute(action, input) {
  let value;
  if (action === 'normalize') value = normalizeDataset(input);
  else if (action === 'identify') value = input.map(record => ({ ...record, hash: hash(record.dataset), fingerprint: hash(identity(record.dataset)) }));
  else if (action === 'legacy-read' || action === 'legacy-index') {
    const record = await readLegacy(input);
    if (input.kind === 'snapshots') {
      verified(record);
      if (action === 'legacy-index') {
        const { radar, ais, aisStatic, provenance, ...header } = record.dataset;
        value = { ...record, fingerprint: hash(identity(record.dataset)), dataset: { ...header, provenance: { kind: provenance.kind, configVersion: provenance.configVersion, mappingVersion: provenance.mappingVersion, parserVersion: provenance.parserVersion, registryRevision: provenance.registryRevision, radarConfiguration: provenance.radarConfiguration, aisSourceNames: provenance.aisSourceNames, query: provenance.query } }, mappingVersions: [...new Set(radar.map(point => point.mappingVersion))], aisSourceIds: provenance.query?.aisSourceIds ?? [...new Set(ais.flatMap(point => point.sourceIds))] };
      } else value = record;
    } else value = record;
  } else if (action === 'playback' || action === 'window-playback') {
    const wire = { ...encodePlayback(input.snapshots, input.session), ...(input.reloadedFrom ? { reloadedFrom: input.reloadedFrom } : {}), ...(input.window ? { window: input.window } : {}) };
    if (input.window) wire.window.byteSize = Buffer.byteLength(JSON.stringify(wire));
    const bytes = Buffer.from(JSON.stringify(wire));
    value = action === 'window-playback' ? { bytes: new Uint8Array(bytes), retainedBytes: bytes.byteLength + Buffer.byteLength(JSON.stringify(input.snapshots)) } : bytes;
  } else if (action === 'export') value = Buffer.from(JSON.stringify(input));
  else if (action === 'archive') {
    if (!path.isAbsolute(input.directory)) throw new InputError('归档目录必须为服务器上的绝对路径');
    await mkdir(input.directory, { recursive: true });
    const filePath = path.resolve(input.directory, `radar-tool-${input.id}.json.gz`);
    if (path.dirname(filePath) !== path.resolve(input.directory)) throw new InputError('归档路径超出指定目录');
    const bytes = gzipSync(Buffer.from(JSON.stringify(input.bundle)));
    const handle = await open(filePath, 'wx'); let failure;
    try { await handle.writeFile(bytes); await handle.sync(); } catch (error) { failure = error; }
    try { await handle.close(); } catch (error) { failure ??= error; }
    if (failure) {
      try { await unlink(filePath); } catch (error) { throw new InputError(`归档失败且未能清理新建文件 ${filePath}：${error.message}`, 500); }
      throw failure;
    }
    value = { filePath, byteSize: bytes.byteLength, hash: createHash('sha256').update(bytes).digest('hex') };
  } else if (action === 'archive-read') {
    let bytes;
    try { bytes = await readFile(input.filePath); } catch (error) { if (error.code === 'ENOENT') throw new InputError('归档文件不存在，请恢复文件或按历史查询条件重新加载', 410); throw error; }
    if (createHash('sha256').update(bytes).digest('hex') !== input.hash) throw new InputError('归档文件与 SHA-256 不一致', 409);
    const bundle = JSON.parse(gunzipSync(bytes).toString('utf8'));
    for (const snapshot of bundle.snapshots) verified(snapshot);
    value = bundle;
  } else throw new Error(`未知数据处理操作：${action}`);
  return value;
}
parentPort.on('message', async ({ id, action, input }) => {
  try {
    const value = await execute(action, input);
    if (Buffer.isBuffer(value)) { const bytes = new Uint8Array(value); parentPort.postMessage({ id, value: bytes }, [bytes.buffer]); }
    else parentPort.postMessage({ id, value });
  } catch (error) { parentPort.postMessage({ id, error: error.message, statusCode: error.statusCode ?? 500 }); }
});
