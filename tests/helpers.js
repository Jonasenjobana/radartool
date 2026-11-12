import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { buildApp } from '../server/app.js';
import { createDemoDataset, DEMO_BASELINE, DEMO_REFERENCE } from './fixtures/demo.js';
import { normalizeDataset } from '../shared/data.js';

export function fixtureAppOptions() {
  const project = { id: 'demo', name: '算法测试数据源', mode: 'clickhouse-http', configVersion: 'fixture-v1', verified: true, reference: DEMO_REFERENCE, radars: [{ id: 'radar-demo-01', name: '测试雷达', baseline: DEMO_BASELINE }], aisSources: [{ id: 'ais-east', name: '测试 AIS A' }, { id: 'ais-west', name: '测试 AIS B' }], clickhouse: { urlEnv: 'FIXTURE_CH_URL', usernameEnv: 'FIXTURE_CH_USER', passwordEnv: 'FIXTURE_CH_PASSWORD' }, ais: { urlEnv: 'FIXTURE_AIS_URL' } };
  return { projectConfigs: [project], allowTestFixtures: true, readDataset: async (_project, query) => normalizeDataset(createDemoDataset({ start: Date.parse(query.start), end: Date.parse(query.end), sourceIds: query.aisSourceIds })) };
}

export async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'radar-tool-test-'));
  t.after(async () => {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert.ok(path.basename(target).startsWith('radar-tool-test-'));
    await rm(target, { recursive: true, force: true });
  });
  return directory;
}

export async function testApp(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'radar-tool-test-'));
  const app = await buildApp({ dataDir, serveClient: false, ...fixtureAppOptions(), ...options });
  t.after(async () => {
    await app.close();
    const target = path.resolve(dataDir);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert.ok(path.basename(target).startsWith('radar-tool-test-'));
    await rm(target, { recursive: true, force: true });
  });
  return app;
}

export const DEMO_QUERY = { projectId: 'demo', radarId: 'radar-demo-01', aisSourceIds: ['ais-east', 'ais-west'], start: '2026-11-10T02:00:00.000Z', end: '2026-11-10T02:10:00.000Z' };
export async function queryDemo(app) {
  const response = await app.inject({ method: 'POST', url: '/api/query?format=full', payload: DEMO_QUERY });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
export async function waitForTask(app, id) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const task = (await app.inject(`/api/tasks/${id}`)).json();
    if (task.status !== 'running') return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('任务未在测试期限内结束');
}
