import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../server/storage.js';
import { normalizeDataset } from '../shared/data.js';
import { createDemoDataset, DEMO_START } from './fixtures/demo.js';
import { temporaryDirectory } from './helpers.js';

test('旧 JSON 提取结构化目录并保留原文、摘要与关联，重启不覆盖新表编辑', async t => {
  const directory = await temporaryDirectory(t);
  const seed = new SqliteStore(directory);
  const normalized = normalizeDataset(createDemoDataset({ end: DEMO_START + 4000 }));
  const sessionId = randomUUID(); const snapshot = seed.snapshot(normalized, sessionId);
  const records = {
    snapshots: snapshot,
    tasks: { id: randomUUID(), snapshotId: snapshot.id, snapshotHash: snapshot.hash, createdAt: snapshot.createdAt, status: 'completed', customLegacyField: '保留旧字段' },
    versions: { id: randomUUID(), snapshotId: snapshot.id, snapshotHash: snapshot.hash, createdAt: snapshot.createdAt, name: '旧版本', parameters: normalized.dataset.baseline },
    sessions: { id: sessionId, snapshotIds: [snapshot.id], snapshotHashes: [snapshot.hash], createdAt: snapshot.createdAt },
  };
  for (const [kind, record] of Object.entries(records)) {
    await mkdir(path.join(directory, kind));
    await writeFile(path.join(directory, kind, record.id + '.json'), JSON.stringify(record), 'utf8');
  }
  const registry = { schemaVersion: 1, revision: 7, projects: { demo: { radars: [], aisSources: [], groups: [] } } };
  await writeFile(path.join(directory, 'registry.json'), JSON.stringify(registry), 'utf8');
  const store = new SqliteStore(directory); await store.init();
  try {
    assert.equal((await store.read('snapshots', snapshot.id)).hash, snapshot.hash);
    assert.equal((await store.read('tasks', records.tasks.id)).customLegacyField, '保留旧字段');
    assert.deepEqual((await store.read('sessions', sessionId)).snapshotIds, [snapshot.id]);
    assert.deepEqual(store.readRegistry(), registry);
    assert.equal(store.hasTable('records'), false); assert.equal(store.hasTable('settings'), false);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM snapshot_metadata').get().n, 1);
    await store.write('versions', { ...records.versions, name: '结构化编辑' });
    store.writeRegistry({ ...registry, revision: 8 });
  } finally { store.close(); }
  const reopened = new SqliteStore(directory); await reopened.init();
  try {
    assert.equal((await reopened.read('versions', records.versions.id)).name, '结构化编辑');
    assert.equal(reopened.readRegistry().revision, 8);
    assert.equal(reopened.list('snapshots').length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'registry.json'), 'utf8')), registry);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'snapshots', snapshot.id + '.json'), 'utf8')), snapshot);
  } finally { reopened.close(); }
});

test('旧 SQLite 逐条迁移时保留原正文并停止旧写入，列表不解码正文', async t => {
  const directory = await temporaryDirectory(t); const db = new DatabaseSync(path.join(directory, 'radar-tool.sqlite'));
  const seed = new SqliteStore(directory); const snapshot = seed.snapshot(normalizeDataset(createDemoDataset({ end: DEMO_START + 4000 })));
  db.exec('CREATE TABLE records(kind TEXT,id TEXT,created_at TEXT,payload TEXT,PRIMARY KEY(kind,id)); CREATE TABLE settings(key TEXT PRIMARY KEY,payload TEXT)');
  db.prepare('INSERT INTO records VALUES(?,?,?,?)').run('snapshots', snapshot.id, snapshot.createdAt, JSON.stringify(snapshot)); db.close();
  const store = new SqliteStore(directory); await store.init();
  try {
    const original = store.db.prepare('SELECT payload FROM records WHERE id=?').get(snapshot.id).payload;
    assert.equal(original, JSON.stringify(snapshot));
    assert.throws(() => store.db.prepare('UPDATE records SET payload=? WHERE id=?').run('{}', snapshot.id), /停止写入/);
    assert.equal(store.list('snapshots')[0].hash, snapshot.hash);
    assert.equal(store.worksets.size, 0);
    assert.equal((await store.read('snapshots', snapshot.id)).dataset.ais.length, snapshot.dataset.ais.length);
  } finally { store.close(); }
});

test('迁移失败保留已提交游标，修正原文件后幂等继续，旧文件不被改写', async t => {
  const directory = await temporaryDirectory(t); await mkdir(path.join(directory, 'versions'));
  const firstId = '00000000-0000-4000-8000-000000000001'; const secondId = '00000000-0000-4000-8000-000000000002';
  const record = { id: firstId, createdAt: new Date().toISOString(), name: '完整版本' };
  await writeFile(path.join(directory, 'versions', firstId + '.json'), JSON.stringify(record), 'utf8');
  const brokenFile = path.join(directory, 'versions', secondId + '.json'); await writeFile(brokenFile, '{', 'utf8');
  await assert.rejects(new SqliteStore(directory).init());
  const database = new DatabaseSync(path.join(directory, 'radar-tool.sqlite'));
  try {
    assert.equal(database.prepare('SELECT count(*) AS total FROM parameter_versions').get().total, 1);
    assert.equal(database.prepare("SELECT completed_at_ms FROM schema_migrations WHERE name='business-tables-v2'").get().completed_at_ms, null);
    database.prepare('UPDATE parameter_versions SET name=? WHERE id=?').run('已编辑', firstId);
  } finally { database.close(); }
  await writeFile(brokenFile, JSON.stringify({ ...record, id: secondId }), 'utf8');
  const retried = new SqliteStore(directory); await retried.init();
  try { assert.equal(retried.list('versions').length, 2); assert.equal((await retried.read('versions', firstId)).name, '已编辑'); }
  finally { retried.close(); }
});
