import { enuToWgs84, normalizeAngle, polarToEnu, wgs84ToEnu } from '../../shared/geo.js';

export const DEMO_REFERENCE = { lng: 122.12, lat: 30.12 };
export const DEMO_TRUTH = { ...enuToWgs84({ east: 42, north: -28 }, DEMO_REFERENCE), bearingOffsetDeg: 347.4 };
export const DEMO_BASELINE = { ...enuToWgs84({ east: -70, north: 60 }, DEMO_REFERENCE), bearingOffsetDeg: 333 };
export const DEMO_START = Date.parse('2026-11-10T02:00:00.000Z');
export const DEMO_END = DEMO_START + 10 * 60 * 1000;

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
}

export function createDemoDataset({ start = DEMO_START, end = DEMO_END, sourceIds = ['ais-east', 'ais-west'] } = {}) {
  const random = randomGenerator(20261110);
  const radar = [];
  const ais = [];
  const truth = wgs84ToEnu(DEMO_TRUTH, DEMO_REFERENCE);
  const ships = [
    { mmsi: '413000101', east: 350, north: -1500, ve: 0.7, vn: 4.1, heading: 10, bow: 58, stern: 20, port: 9, starboard: 7 },
    { mmsi: '413000202', east: -1200, north: 780, ve: 3.5, vn: -0.65, heading: 100, bow: 90, stern: 22, port: 13, starboard: 11 },
    { mmsi: '413000303', east: 1400, north: 1000, ve: -2.7, vn: -2.3, heading: 228, bow: 30, stern: 12, port: 5, starboard: 5 },
  ];
  for (let t = 0; t < 600; t += 4) {
    const timeMs = DEMO_START + t * 1000;
    for (const [shipIndex, ship] of ships.entries()) {
      const east = ship.east + ship.ve * t + 22 * Math.sin(t / 110 + shipIndex);
      const north = ship.north + ship.vn * t + 16 * Math.sin(t / 95 + shipIndex);
      const position = enuToWgs84({ east, north }, DEMO_REFERENCE);
      const eventTime = new Date(timeMs).toISOString();
      const dimensions = { bow: ship.bow, stern: ship.stern, port: ship.port, starboard: ship.starboard, observedAt: new Date(DEMO_START - 3600000).toISOString(), validFrom: new Date(DEMO_START - 3600000).toISOString(), validTo: new Date(DEMO_END + 3600000).toISOString(), sourceId: 'demo-static' };
      if (!(shipIndex === 2 && t >= 240 && t < 300)) for (const sourceId of ['ais-east', 'ais-west']) {
        if (!sourceIds.includes(sourceId)) continue;
        const id = `${sourceId}-${ship.mmsi}-${t}`;
        ais.push({ id, sourceIds: [sourceId], mmsi: ship.mmsi, eventTime, receiveTime: new Date(timeMs + (sourceId === 'ais-east' ? 150 : 360)).toISOString(), messageType: '1', position, sogKnots: Math.hypot(ship.ve, ship.vn) / 0.514444, cogDeg: normalizeAngle(Math.atan2(ship.ve, ship.vn) * 180 / Math.PI), headingDeg: ship.heading, dimensions, accuracyM: 5, mappingVersion: 'demo-wgs84-v1', raw: { simulation: true, sequence: t, receiver: sourceId }, quality: [] });
      }
      for (let echo = 0; echo < 2; echo++) {
        const forward = -ship.stern + random() * (ship.bow + ship.stern);
        const side = -ship.port + random() * (ship.port + ship.starboard);
        const angle = ship.heading * Math.PI / 180;
        const observedEast = east + forward * Math.sin(angle) + side * Math.cos(angle) + (random() - 0.5) * 10;
        const observedNorth = north + forward * Math.cos(angle) - side * Math.sin(angle) + (random() - 0.5) * 10;
        const rangeM = Math.hypot(observedEast - truth.east, observedNorth - truth.north);
        const azimuthDeg = normalizeAngle(Math.atan2(observedEast - truth.east, observedNorth - truth.north) * 180 / Math.PI - DEMO_TRUTH.bearingOffsetDeg);
        const point = { id: `radar-${shipIndex}-${t}-${echo}`, sourceId: 'demo-radar', deviceId: 'radar-demo-01', trackId: `T${shipIndex + 1}-${echo}-${t < 300 ? 'a' : 'b'}`, eventTime, receiveTime: new Date(timeMs + 100).toISOString(), rangeM, azimuthDeg, mappingVersion: 'demo-polar-v1', raw: { distance: rangeM, direction: azimuthDeg, simulation: true }, quality: [] };
        point.storedPosition = enuToWgs84(polarToEnu(point, DEMO_BASELINE, DEMO_REFERENCE), DEMO_REFERENCE);
        radar.push(point);
      }
    }
    for (let k = 0; k < 2; k++) radar.push({ id: `background-${t}-${k}`, sourceId: 'demo-radar', deviceId: 'radar-demo-01', trackId: `U${k}`, eventTime: new Date(timeMs).toISOString(), rangeM: 500 + random() * 2100, azimuthDeg: random() * 360, mappingVersion: 'demo-polar-v1', raw: { simulation: true, role: 'unexplained' }, quality: [] });
  }
  return {
    schemaVersion: 1, name: '舟山水域 · 可复现演示', projectId: 'demo', radarId: 'radar-demo-01', reference: DEMO_REFERENCE,
    baseline: DEMO_BASELINE, timeRange: { start: new Date(start).toISOString(), end: new Date(end).toISOString() }, timeSemantics: 'event-time', unitsVerified: true, alignmentVerified: true,
    radar: radar.filter((p) => Date.parse(p.eventTime) >= start && Date.parse(p.eventTime) < end),
    ais: ais.filter((p) => Date.parse(p.eventTime) >= start && Date.parse(p.eventTime) < end),
    provenance: { kind: 'synthetic', generatorVersion: 'seed-20261110-v1', truth: DEMO_TRUTH, seed: 20261110, queryRange: { start: new Date(start).toISOString(), end: new Date(end).toISOString() } },
    warnings: ['演示数据为合成观测，不能证明真实现场标定精度', '演示含多站重复、多回波、轨迹分裂、AIS 断报及未解释目标'],
  };
}
