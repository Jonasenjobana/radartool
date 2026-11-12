import test from 'node:test';
import assert from 'node:assert/strict';
import { shipOutline, shipReferenceKnown } from '../client/shipGeometry.ts';
import { wgs84ToEnu } from '../shared/geo.js';

const position = { lng: 117.107758, lat: 23.388403 };
const dimensions = { bow: 80, stern: 20, port: 3, starboard: 17, observedAt: '2026-11-10T00:00:00Z', validFrom: '2026-11-10T00:00:00Z', validTo: '2026-11-11T00:00:00Z', sourceId: 'test-ais' };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.0001, `${actual} 与 ${expected} 不一致`);

test('船形按 AIS 米数绘制长宽，偏心定位点保持为原始坐标', () => {
  const before = structuredClone({ position, dimensions });
  const points = shipOutline(position, dimensions, 0).map((point) => wgs84ToEnu(point, position));
  close(Math.min(...points.map((point) => point.east)), -3);
  close(Math.max(...points.map((point) => point.east)), 17);
  close(Math.min(...points.map((point) => point.north)), -20);
  close(Math.max(...points.map((point) => point.north)), 80);
  close((Math.min(...points.map((point) => point.east)) + Math.max(...points.map((point) => point.east))) / 2, 7);
  assert.deepEqual({ position, dimensions }, before);
});

test('船形包含尖艏、矩形船身和平直船艉，并按真船艏向旋转', () => {
  const bounds = [[-3, 17, -20, 80], [-20, 80, -17, 3], [-17, 3, -80, 20], [-80, 20, -3, 17]];
  for (let i = 0; i < 4; i++) {
    const points = shipOutline(position, dimensions, i * 90).map((point) => wgs84ToEnu(point, position));
    const actual = [Math.min(...points.map((point) => point.east)), Math.max(...points.map((point) => point.east)), Math.min(...points.map((point) => point.north)), Math.max(...points.map((point) => point.north))];
    actual.forEach((value, index) => close(value, bounds[i][index]));
  }
  const points = shipOutline(position, dimensions, 0).map((point) => wgs84ToEnu(point, position));
  assert.equal(points.length, 5);
  close(points[0].east, 7); close(points[0].north, 80);
  close(points[1].east, points[2].east); close(points[3].east, points[4].east);
  close(points[2].north, -dimensions.stern); close(points[3].north, points[2].north);
});

test('AIS 仅提供总尺寸时不推定定位参考点在船上的偏移', () => {
  assert.equal(shipReferenceKnown(dimensions), true);
  assert.equal(shipReferenceKnown({ ...dimensions, bow: 0, port: 0 }), false);
  assert.equal(shipReferenceKnown({ ...dimensions, bow: 0, port: 1 }), true);
  assert.equal(shipReferenceKnown({ ...dimensions, bow: 1, port: 0 }), true);
});
