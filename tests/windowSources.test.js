import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { decodePlayback } from '../shared/playback.js';
import { createAisIndex, createAisStaticIndex, latestAisAtTime } from '../shared/alignment.js';
import { DEMO_START } from './fixtures/demo.js';
import { testApp } from './helpers.js';

function positionMessage(lng, mmsi = 538090215) {
  const bits = Array(168).fill('0');
  const put = (offset, length, value) => bits.splice(offset, length, ...value.toString(2).padStart(length, '0'));
  put(0, 6, 1); put(8, 30, mmsi); put(50, 10, 100); put(60, 1, 1); put(61, 28, Math.round(lng * 600000)); put(89, 27, 23 * 600000);
  let payload = ''; for (let offset = 0; offset < bits.length; offset += 6) { const value = parseInt(bits.slice(offset, offset + 6).join(''), 2); payload += String.fromCharCode(value + (value < 40 ? 48 : 56)); }
  const body = `AIVDM,1,1,,A,${payload},0`; return `!${body}*${[...body].reduce((checksum, value) => checksum ^ value.charCodeAt(0), 0).toString(16).toUpperCase().padStart(2, '0')}`;
}

test('历史窗口仅取 1/2/3/18，保留相邻同刻冲突且逐帧跳过静态报告', { skip: !existsSync(new URL('../.runtime/ais-parser/classes/AisBridge.class', import.meta.url)) }, async t => {
  const configs = JSON.parse(await readFile(new URL('../config/projects.raw.example.json', import.meta.url), 'utf8')).projects; const project = configs[0];
  Object.assign(project.clickhouse, { urlEnv: 'WINDOW_CH_URL', usernameEnv: 'WINDOW_CH_USER', passwordEnv: 'WINDOW_CH_PASSWORD' });
  project.clickhouse.timeType = 'DateTime64'; project.ais.timeType = 'DateTime64';
  project.aisSources.push({ id: 'second-station', name: '另一 AIS 来源' });
  const source = project.aisSources[0].id; const start = DEMO_START; const end = start + 600000; const calls = [];
  const raw = (offset, message, mmsi = '538090215', messageType = '1') => ({ time_ms: start + offset, source_id: source, mmsi, messageType, message });
  const rows = [raw(0, positionMessage(117)), { ...raw(0, positionMessage(117.001)), source_id: 'second-station' }, raw(1000, positionMessage(181)), { ...raw(30000, positionMessage(117.002)), source_id: 'second-station' }, raw(119900, '!AIVDM,2,1,9,B,53nFBv01SJ<thHp6220H4heHTf2222222222221?50:454o<`9QSlUDp,0*09', '258315000', '5'), raw(120100, '!AIVDM,2,2,9,B,888888888888880,2*2E', '0', '5'), raw(180000, positionMessage(117.01)), { ...raw(180000, positionMessage(117.01)), source_id: 'second-station' }];
  const radarRows = [0, 0, 180000].map((offset, index) => ({ time_ms: start + offset, track_id: 'same-track', source_range: 100 + index, source_azimuth: 0 }));
  rows.push(raw(0, positionMessage(117.02, 258315000), '258315000'));
  const server = http.createServer(async (request, response) => {
    const params = new URL(request.url, 'http://localhost').searchParams; const sql = Buffer.concat(await Array.fromAsync(request)).toString('utf8'); calls.push({ params, sql });
    assert.equal(params.get('readonly'), '1');
    const parseTime = name => Date.parse(params.get(`param_${name}`).replace(' ', 'T') + 'Z');
    const from = parseTime('start'); const to = parseTime('end'); const radar = sql.includes('radar_data_combine_all');
    let values = (radar ? radarRows.map(row => ({ ...row, radar_id: params.get('param_radar_id') })) : rows).filter(row => row.time_ms >= from && row.time_ms < to);
    if (!radar) values = values.filter(row => params.get('param_sources').includes(row.source_id));
    if (!radar) { assert.match(sql, /IN \('1', '2', '3', '18'\)/); values = values.filter(row => ['1', '2', '3', '18'].includes(row.messageType)); }
    if (params.has('param_position_ships')) values = values.filter(row => params.get('param_position_ships').includes(row.mmsi));
    if (params.has('param_ships')) values = values.filter(row => (params.get('param_ships').includes(row.mmsi) || row.mmsi === '0') && ['5', '19', '24', '0', ''].includes(row.messageType));
    if (params.has('param_fragment_header')) values = values.filter(row => row.message.includes(params.get('param_fragment_header')));
    const context = [...params].filter(([name]) => /^param_context_\d+$/.test(name)).map(([, value]) => Date.parse(value.replace(' ', 'T') + 'Z'));
    if (context.length) values = values.filter(row => context.includes(row.time_ms));
    const descending = /ORDER BY[^\n]* DESC/.test(sql); values.sort((a, b) => descending ? b.time_ms - a.time_ms : a.time_ms - b.time_ms);
    if (sql.includes('HAVING count()>0')) values = values.length ? [{ time_ms: /toDateTime64\(min\(/.test(sql) ? Math.min(...values.map(row => row.time_ms)) : Math.max(...values.map(row => row.time_ms)) }] : [];
    else if (sql.includes('LIMIT 1 BY')) { const seen = new Set(); values = values.filter(row => { const key = radar ? row.track_id : `${row.source_id}:${row.mmsi}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
    else if (params.has('param_fragment_header')) values = values.slice(0, 1);
    response.setHeader('content-type', 'application/x-ndjson'); response.end(values.map(row => JSON.stringify(row)).join('\n') + (values.length ? '\n' : ''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const environment = { WINDOW_CH_URL: `http://127.0.0.1:${server.address().port}`, WINDOW_CH_USER: 'window-test', WINDOW_CH_PASSWORD: 'test-password', AIS_STATIC_LOOKBACK_HOURS: '0', AIS_DIMENSION_CACHE_MAX_ROWS: '0' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const app = await testApp(t, { projectConfigs: configs }); const group = (await app.inject('/api/groups')).json()[0];
  const opened = await app.inject({ method: 'POST', url: `/api/groups/${group.id}/playback`, payload: { start: new Date(start).toISOString(), end: new Date(end).toISOString() } }); const id = opened.json().id;
  const get = async at => { const response = await app.inject({ method: 'POST', url: `/api/playbacks/${id}/windows`, payload: { at, requestId: `at-${at}`, trailSeconds: 60 } }); assert.equal(response.statusCode, 200, response.body); return decodePlayback(response.json()); };
  const first = await get(start);
  assert.equal(first.snapshots[0].dataset.aisStatic.length, 0);
  assert.ok(first.snapshots[0].dataset.ais.every(point => point.dimensions == null));
  assert.equal(first.snapshots[0].dataset.ais[0].headingDeg, 0);
  const before = calls.length; const second = await get(start + 125000); const data = second.snapshots[0].dataset;
  const conflicts = data.ais.filter(point => point.timeMs === start && point.mmsi === '538090215');
  assert.equal(conflicts.length, 2); assert.ok(conflicts.every(point => point.quality.includes('同时间位置冲突')));
  assert.equal(data.radar.filter(point => point.timeMs === start).length, 2);
  const shared = data.ais.find(point => point.timeMs === start + 180000);
  assert.equal(shared.sourceIds.length, 2); assert.equal(shared.observationIds.length, 2);
  assert.deepEqual(shared.observationIds, first.snapshots[0].dataset.ais.find(point => point.timeMs === start + 180000).observationIds);
  assert.ok(!calls.slice(before).some(call => call.sql.includes('LIMIT 1 BY') && /ORDER BY[^\n]* DESC/.test(call.sql)), '连续覆盖内不重复读取全部历史前置状态');
  const next = await app.inject({ method: 'POST', url: `/api/playbacks/${id}/frame`, payload: { at: start + 30000, direction: 1, requestId: 'frame-context', trailSeconds: 60 } });
  assert.equal(next.statusCode, 200, next.body); assert.equal(next.json().at, start + 180000);
  const third = await get(start + 300000);
  const state = latestAisAtTime(createAisIndex(third.snapshots[0].dataset), start + 300000, createAisStaticIndex(third.snapshots[0].dataset.aisStatic)).find(point => point.mmsi === '258315000');
  assert.equal(state.dimensions, null, '连续播放不从静态报文取得尺寸');
  const reopened = await app.inject({ method: 'POST', url: `/api/groups/${group.id}/playback`, payload: { start: new Date(start).toISOString(), end: new Date(end).toISOString() } });
  const cold = await app.inject({ method: 'POST', url: `/api/playbacks/${reopened.json().id}/windows`, payload: { at: start + 125000, requestId: 'cold-seek', trailSeconds: 60 } });
  assert.equal(cold.statusCode, 200, cold.body); const restored = decodePlayback(cold.json()).snapshots[0].dataset;
  assert.equal(restored.ais.filter(point => point.timeMs === start && point.mmsi === '538090215').length, 2, '冷跳转跳过不可用位置后仍恢复同刻冲突');
  const coldLater = await app.inject({ method: 'POST', url: `/api/playbacks/${reopened.json().id}/windows`, payload: { at: start + 300000, requestId: 'cold-static', trailSeconds: 60 } });
  assert.equal(coldLater.statusCode, 200, coldLater.body); const restoredLater = decodePlayback(coldLater.json()).snapshots[0].dataset;
  const restoredSize = latestAisAtTime(createAisIndex(restoredLater), start + 300000, createAisStaticIndex(restoredLater.aisStatic)).find(point => point.mmsi === '258315000');
  assert.equal(restoredSize.dimensions, null, '冷跳转不补取历史尺寸');
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM ais_dimension_versions').get().n, 0);
});
