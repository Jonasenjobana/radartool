import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createAisIndex, latestAisAtTime } from '../shared/alignment.js';
import { shipOutline, shipReferenceKnown } from '../client/shipGeometry.ts';

// 隔离执行地图中实际的 AIS 渲染分支，验证图标语义，无需启动浏览器。
const source = readFileSync(new URL('../client/components/CalibrationMap.vue', import.meta.url), 'utf8');
const script = source.split('<script setup lang="ts">')[1].split('</script>')[0];
const ast = ts.createSourceFile('CalibrationMap.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const redraw = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'redraw');
const loop = redraw?.body.statements.find(node => ts.isForOfStatement(node) && node.expression.getText(ast) === 'props.ais.slice(0, 2000)');
assert.ok(loop, 'AIS 渲染分支必须存在');
const renderLoop = loop.getText(ast);

function renderMarker(ship, zoom = 15, expectedHeading = ship.headingDeg) {
  ship = { displayPosition: ship.position, ...ship };
  const icons = [];
  const layer = { addTo() { return this; }, on() { return this; }, bindTooltip() { return this; } };
  runInNewContext(renderLoop, {
    props: { ais: [ship] }, shipSelected: () => false, map: { getZoom: () => zoom }, shipOutlineZoom: 16,
    vectors: {}, colors: { ais: '#187c70' }, latLng: ({ lng, lat }) => [lat, lng], label: (value) => value,
    shipOutline, shipReferenceKnown, emit: () => {},
    L: { divIcon: (value) => value, marker: (position, options) => { assert.deepEqual(Array.from(position), [ship.displayPosition.lat, ship.displayPosition.lng]); icons.push(options.icon); return layer; }, polygon: (points) => { assert.deepEqual(points, shipOutline(ship.displayPosition, ship.dimensions, expectedHeading).map(({ lat, lng }) => [lat, lng])); return layer; } },
  });
  return icons[0];
}

const position = { lng: 117.1, lat: 23.3 };

test('缺失船艏向时按有效 COG 显示运动方向，真实 0 度有效', () => {
  for (const headingDeg of [null, undefined]) for (const cogDeg of [0, 135, 359.9]) {
    const ship = { mmsi: '123456789', position, headingDeg, cogDeg }; const before = structuredClone(ship);
    const icon = renderMarker(ship);
    assert.match(icon.html, /ais-arrow/);
    assert.ok(icon.html.includes(`rotate(${cogDeg}deg)`));
    assert.deepEqual(ship, before);
  }
});

test('缺失船艏向且 COG 不可用时显示定位点，不将不可用码转成方向', () => {
  for (const cogDeg of [null, undefined, -1, 360, 360.1, 409.5, NaN, Infinity]) {
    const icon = renderMarker({ mmsi: '123456789', position, headingDeg: null, cogDeg });
    assert.match(icon.html, /ais-dot/); assert.doesNotMatch(icon.html, /ais-arrow|rotate\(/);
  }
});

test('取得 A/B/C/D 后，缺失船艏向也可按运动方向绘制等比例船形', () => {
  const ship = { mmsi: '123456789', position, headingDeg: null, cogDeg: 90, dimensions: { bow: 80, stern: 20, port: 3, starboard: 17 } };
  const before = structuredClone(ship); const icon = renderMarker(ship, 16, 90);
  assert.match(icon.className, /to-scale/);
  assert.deepEqual(ship, before);
});

test('真实 0 度保留朝北箭头，后续有效船艏向随回放更新', () => {
  const base = { mmsi: '123456789', sourceIds: ['source'], position, quality: [], dimensions: null, cogDeg: 135 };
  const index = createAisIndex({ reference: position, ais: [{ ...base, id: 'north', timeMs: 1000, headingDeg: 0 }, { ...base, id: 'turned', timeMs: 2000, headingDeg: 217 }] });
  assert.match(renderMarker(latestAisAtTime(index, 1000)[0]).html, /rotate\(0deg\)/);
  assert.match(renderMarker(latestAisAtTime(index, 2000)[0]).html, /rotate\(217deg\)/);
  assert.match(renderMarker(latestAisAtTime(index, 1500)[0]).html, /rotate\(0deg\)/);
});

test('AIS 定位图标使用插值后的展示坐标，保留上报坐标', () => {
  const ship = { mmsi: '123456789', position, displayPosition: { lng: 117.2, lat: 23.4 }, headingDeg: 0 };
  const before = structuredClone(ship); renderMarker(ship); assert.deepEqual(ship, before);
  renderMarker({ ...ship, dimensions: { bow: 80, stern: 20, port: 3, starboard: 17 } }, 16);
});
