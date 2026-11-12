const DEG = Math.PI / 180;
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const B = A * (1 - F);

export function normalizeAngle(degrees) {
  return ((degrees % 360) + 360) % 360;
}

export function angleDifference(a, b) {
  return ((a - b + 540) % 360 + 360) % 360 - 180;
}

export function toEcef(position) {
  const lat = position.lat * DEG;
  const lng = position.lng * DEG;
  const radius = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  const height = position.height ?? 0;
  return [
    (radius + height) * Math.cos(lat) * Math.cos(lng),
    (radius + height) * Math.cos(lat) * Math.sin(lng),
    (radius * (1 - E2) + height) * Math.sin(lat),
  ];
}

function basis(reference) {
  const lng = reference.lng * DEG;
  const lat = reference.lat * DEG;
  return {
    origin: toEcef(reference),
    east: [-Math.sin(lng), Math.cos(lng), 0],
    north: [-Math.sin(lat) * Math.cos(lng), -Math.sin(lat) * Math.sin(lng), Math.cos(lat)],
    up: [Math.cos(lat) * Math.cos(lng), Math.cos(lat) * Math.sin(lng), Math.sin(lat)],
  };
}

export function wgs84ToEnu(position, reference) {
  const frame = basis(reference);
  const delta = toEcef(position).map((value, i) => value - frame.origin[i]);
  const dot = (axis) => axis.reduce((sum, value, i) => sum + value * delta[i], 0);
  return { east: dot(frame.east), north: dot(frame.north), up: dot(frame.up) };
}

export function enuToWgs84(position, reference) {
  const frame = basis(reference);
  const tangent = frame.origin.map((value, i) => value + position.east * frame.east[i] + position.north * frame.north[i]);
  // 取局部切平面法线与 WGS84 椭球的近交点，避免把切平面高度当作地面高度。
  const scales = [A * A, A * A, B * B];
  const qa = frame.up.reduce((sum, value, i) => sum + value * value / scales[i], 0);
  const qb = 2 * tangent.reduce((sum, value, i) => sum + value * frame.up[i] / scales[i], 0);
  const qc = tangent.reduce((sum, value, i) => sum + value * value / scales[i], 0) - 1;
  const discriminant = qb * qb - 4 * qa * qc;
  if (discriminant < 0) throw new Error('局部坐标超出椭球近交点范围');
  const up = -2 * qc / (qb + Math.sqrt(discriminant));
  const [x, y, z] = tangent.map((value, i) => value + up * frame.up[i]);
  const p = Math.hypot(x, y);
  return { lng: Math.atan2(y, x) / DEG, lat: Math.atan2(z, p * (1 - E2)) / DEG };
}

export function polarToEnu(observation, parameters, reference) {
  const origin = 'east' in parameters ? parameters : wgs84ToEnu(parameters, reference);
  const angle = (observation.azimuthDeg + parameters.bearingOffsetDeg) * DEG;
  return {
    east: origin.east + observation.rangeM * Math.sin(angle),
    north: origin.north + observation.rangeM * Math.cos(angle),
  };
}

export function moveParameters(parameters, eastM, northM, reference) {
  const origin = wgs84ToEnu(parameters, reference);
  return { ...enuToWgs84({ east: origin.east + eastM, north: origin.north + northM }, reference), bearingOffsetDeg: parameters.bearingOffsetDeg };
}

export function parameterDifference(current, candidate, reference) {
  const from = wgs84ToEnu(current, reference);
  const to = wgs84ToEnu(candidate, reference);
  const eastM = to.east - from.east;
  const northM = to.north - from.north;
  // 经度和朝向使用最短周期差，避免跨北向或日期变更线时出现近 360° 的差值。
  return { lngDeg: angleDifference(candidate.lng, current.lng), latDeg: candidate.lat - current.lat, bearingDeg: angleDifference(candidate.bearingOffsetDeg, current.bearingOffsetDeg), eastM, northM, distanceM: Math.hypot(eastM, northM) };
}

export function inBounds(point, bounds) {
  return point.east >= bounds.minEast && point.east <= bounds.maxEast && point.north >= bounds.minNorth && point.north <= bounds.maxNorth;
}

export function geographicBounds(a, b) {
  return { west: Math.min(a.lng, b.lng), east: Math.max(a.lng, b.lng), south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat) };
}

export function inGeographicBounds(position, bounds) {
  return position.lng >= bounds.west && position.lng <= bounds.east && position.lat >= bounds.south && position.lat <= bounds.north;
}

