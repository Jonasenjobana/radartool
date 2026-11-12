import { z } from 'zod';
import { normalizeAngle } from './geo.js';

export const MAX_IMPORT_POINTS = 120000;
export const MAX_RADAR_RANGE_M = 100000;
export const timestampSchema = z.string().max(40).regex(/T.*(?:Z|[+-]\d{2}:\d{2})$/, '时间必须包含时区').refine((value) => Number.isFinite(Date.parse(value)), '无效时间');
const identifier = z.string().min(1).max(160);
const raw = z.record(z.string(), z.unknown());
export const positionSchema = z.object({ lng: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) });
export const geographicBoundsSchema = z.object({ west: z.number().min(-180).max(180), east: z.number().min(-180).max(180), south: z.number().min(-90).max(90), north: z.number().min(-90).max(90) }).refine((value) => value.west < value.east && value.south < value.north, '查询区域必须具有正的宽度与高度');
export const parametersSchema = positionSchema.extend({ bearingOffsetDeg: z.number().min(-36000).max(36000) });
const timeRangeSchema = z.object({ start: timestampSchema, end: timestampSchema }).refine((value) => Date.parse(value.start) < Date.parse(value.end), '数据时段必须是正的半开区间');
export const boundsSchema = z.object({ minEast: z.number().min(-30000).max(30000), maxEast: z.number().min(-30000).max(30000), minNorth: z.number().min(-30000).max(30000), maxNorth: z.number().min(-30000).max(30000) }).refine((value) => value.minEast < value.maxEast && value.minNorth < value.maxNorth, '区域必须具有正的宽度与高度');
const dimensionsSchema = z.object({
  bow: z.number().min(0).max(1000), stern: z.number().min(0).max(1000),
  port: z.number().min(0).max(200), starboard: z.number().min(0).max(200),
  observedAt: timestampSchema, validFrom: timestampSchema, validTo: timestampSchema, sourceId: identifier,
}).refine((value) => Date.parse(value.validFrom) < Date.parse(value.validTo), '静态信息有效期无效');
const observationSchema = z.object({
  id: identifier, eventTime: timestampSchema, receiveTime: timestampSchema.nullish(),
  mappingVersion: identifier, raw: raw.default({}), quality: z.array(z.string().max(160)).max(50).default([]),
});
export const radarSchema = observationSchema.extend({
  sourceId: identifier, deviceId: identifier, trackId: identifier,
  rangeM: z.number().min(0).max(MAX_RADAR_RANGE_M), azimuthDeg: z.number().min(-36000).max(36000),
  storedPosition: positionSchema.nullish(),
});
export const aisSchema = observationSchema.extend({
  sourceIds: z.array(identifier).min(1).max(100), observationIds: z.array(identifier).max(1000).optional(),
  mmsi: z.string().regex(/^\d{9}$/, 'MMSI 必须为 9 位数字'), messageType: identifier,
  position: positionSchema, sogKnots: z.number().min(0).max(102.3).nullish(),
  cogDeg: z.number().nullish(), headingDeg: z.number().min(0).max(511).nullish(),
  accuracyM: z.number().positive().max(1000).nullish(), dimensions: dimensionsSchema.nullish(),
});
const aisStaticSchema = aisSchema.omit({ position: true, sogKnots: true, cogDeg: true, headingDeg: true, accuracyM: true }).extend({ dimensions: dimensionsSchema })
  .refine((point) => point.dimensions.bow + point.dimensions.stern > 0 && point.dimensions.port + point.dimensions.starboard > 0, '静态报文船体尺寸不可用')
  .refine((point) => point.sourceIds.includes(point.dimensions.sourceId), '静态报文尺寸来源不一致');
export const datasetSchema = z.object({
  schemaVersion: z.literal(1), name: z.string().min(1).max(160),
  projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), radarId: identifier,
  reference: positionSchema, baseline: parametersSchema,
  timeRange: timeRangeSchema.optional(),
  timeSemantics: z.enum(['event-time', 'receive-time', 'unverified']),
  unitsVerified: z.boolean(), alignmentVerified: z.boolean(),
  radar: z.array(radarSchema), ais: z.array(aisSchema), aisStatic: z.array(aisStaticSchema).default([]),
  provenance: raw.default({}), warnings: z.array(z.string().max(500)).max(100).default([]),
});

export const DEFAULT_REFINEMENT_OPTIONS = {
  maxDistanceM: 200, maxPositionShiftM: 100, maxBearingShiftDeg: 5,
  minTrackPoints: 4, minTrackDurationMs: 12000, motionToleranceM: 75,
  radarExclusion: null, associationIds: null,
};

export const refinementOptionsSchema = z.object({
  initial: parametersSchema,
  maxDistanceM: z.number().min(10).max(2000).default(200),
  maxPositionShiftM: z.number().min(1).max(2000).default(100),
  maxBearingShiftDeg: z.number().min(0.1).max(30).default(5),
  minTrackPoints: z.number().int().min(2).max(100).default(4),
  minTrackDurationMs: z.number().int().min(1000).max(300000).default(12000),
  motionToleranceM: z.number().min(1).max(1000).default(75),
  radarExclusion: boundsSchema.nullable().default(null),
  associationIds: z.array(z.string().min(1)).nullable().default(null),
});

export const DEFAULT_FIT_OPTIONS = {
  bounds: { minEast: -250, maxEast: 250, minNorth: -250, maxNorth: 250 },
  roi: null, refinement: null, positionStepM: 65, angleStepDeg: 5,
  maxFitPoints: 240, maxValidationPoints: 120, maxGapMs: 2000,
  validationFraction: 0.3, maxIterations: 16, keepCandidates: 6,
  rangeSigmaM: 8, angleSigmaDeg: 0.3, aisSigmaM: 6,
  fallbackSigmaM: 24, backgroundPrior: 0.25,
};

export const fitOptionsSchema = z.object({
  bounds: boundsSchema, roi: boundsSchema.nullable().default(null),
  refinement: refinementOptionsSchema.nullable().default(null),
  positionStepM: z.number().min(10).max(2000).default(65),
  angleStepDeg: z.number().min(1).max(30).default(5),
  maxFitPoints: z.number().int().min(30).max(1000).default(240),
  maxValidationPoints: z.number().int().min(15).max(500).default(120),
  maxGapMs: z.number().int().min(0).max(10000).default(2000),
  validationFraction: z.number().min(0.15).max(0.45).default(0.3),
  maxIterations: z.number().int().min(3).max(50).default(16),
  keepCandidates: z.number().int().min(2).max(12).default(6),
  rangeSigmaM: z.number().min(1).max(40).default(8),
  angleSigmaDeg: z.number().min(0.01).max(2).default(0.3),
  aisSigmaM: z.number().min(1).max(40).default(6),
  fallbackSigmaM: z.number().min(5).max(50).default(24),
  backgroundPrior: z.number().min(0.05).max(0.5).default(0.25),
});

export class InputError extends Error {
  constructor(message, statusCode = 400) { super(message); this.name = 'InputError'; this.statusCode = statusCode; }
}

export function parseInput(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new InputError(result.error.issues.slice(0, 6).map((issue) => `${issue.path.join('.') || '输入'}: ${issue.message}`).join('；'));
  return result.data;
}

function reportFingerprint(point) {
  return JSON.stringify([point.mmsi, point.timeMs, point.messageType, point.position.lng, point.position.lat, point.sogKnots, point.cogDeg, point.headingDeg, point.accuracyM, point.dimensions]);
}

export function normalizeDataset(input) {
  const data = parseInput(datasetSchema, input);
  const staticIds = new Set();
  const aisStatic = data.aisStatic.map((point) => {
    if (staticIds.has(point.id)) throw new InputError(`AIS 静态观测 ID 重复：${point.id}`);
    staticIds.add(point.id);
    return { ...point, sourceIds: [...new Set(point.sourceIds)].sort(), observationIds: point.observationIds ?? [point.id], eventTime: new Date(point.eventTime).toISOString(), timeMs: Date.parse(point.eventTime) };
  }).sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
  const radarIds = new Set();
  const radar = data.radar.map((point) => {
    if (point.deviceId !== data.radarId) throw new InputError(`雷达观测 ${point.id} 的 deviceId 与所选雷达不一致`);
    if (radarIds.has(point.id)) throw new InputError(`雷达观测 ID 重复：${point.id}`);
    radarIds.add(point.id);
    return { ...point, azimuthDeg: normalizeAngle(point.azimuthDeg), eventTime: new Date(point.eventTime).toISOString(), timeMs: Date.parse(point.eventTime) };
  }).sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
  const dedup = new Map();
  const positions = new Map();
  for (const original of data.ais) {
    const point = { ...original, sourceIds: [...new Set(original.sourceIds)].sort(), observationIds: original.observationIds ?? [original.id], timeMs: Date.parse(original.eventTime), eventTime: new Date(original.eventTime).toISOString(), quality: [...original.quality] };
    const unavailableValues = {};
    if (point.headingDeg != null && point.headingDeg >= 360) { unavailableValues.headingDeg = point.headingDeg; point.headingDeg = null; point.quality.push('船艏向不可用'); }
    if (point.sogKnots === 102.3) { unavailableValues.sogKnots = point.sogKnots; point.sogKnots = null; point.quality.push('SOG 不可用'); }
    if (point.dimensions && (point.dimensions.bow + point.dimensions.stern <= 0 || point.dimensions.port + point.dimensions.starboard <= 0)) {
      unavailableValues.dimensions = point.dimensions;
      point.dimensions = null; point.quality.push('船体尺寸不可用');
    }
    if (Object.keys(unavailableValues).length) point.raw = { source: point.raw, unavailableValues };
    const key = reportFingerprint(point);
    const existing = dedup.get(key);
    if (existing) {
      const previousSources = [...existing.sourceIds];
      existing.sourceIds = [...new Set([...existing.sourceIds, ...point.sourceIds])].sort();
      existing.observationIds = [...new Set([...existing.observationIds, ...point.observationIds])];
      existing.quality = [...new Set([...existing.quality, ...point.quality])];
      // 保留每份原始报告，不能因多站去重丢失接收时间和来源证据。
      existing.raw = { reports: [...(Array.isArray(existing.raw.reports) ? existing.raw.reports : [{ id: existing.id, sourceIds: previousSources, receiveTime: existing.receiveTime, raw: existing.raw }]), { id: point.id, sourceIds: point.sourceIds, receiveTime: point.receiveTime, raw: point.raw }] };
    } else dedup.set(key, point);
    const timeKey = `${point.mmsi}:${point.timeMs}`;
    const set = positions.get(timeKey) ?? new Set();
    set.add(`${point.position.lng},${point.position.lat}`);
    positions.set(timeKey, set);
  }
  const ais = [...dedup.values()].sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
  const aisIds = new Set();
  let conflicts = 0;
  for (const point of ais) {
    if (aisIds.has(point.id)) throw new InputError(`不同 AIS 报告的 ID 重复：${point.id}`);
    aisIds.add(point.id);
    if (positions.get(`${point.mmsi}:${point.timeMs}`).size > 1) {
      point.quality = [...new Set([...point.quality, '同时间位置冲突'])]; conflicts++;
    }
  }
  const warnings = [...new Set(data.warnings)];
  if (!data.unitsVerified) warnings.push('距离/方位单位尚未核实，自动拟合不可用');
  if (data.timeSemantics === 'unverified' || !data.alignmentVerified) warnings.push('时间语义或对齐窗口尚未核实，自动拟合不可用');
  if (conflicts) warnings.push(`${conflicts} 条 AIS 观测存在同时间位置冲突；保留原始报告，自动关联排除该时刻`);
  if (!radar.length) warnings.push('所选范围没有雷达观测');
  if (!ais.length) warnings.push('所选范围没有 AIS 动态观测');
  const dataset = { ...data, baseline: { ...data.baseline, bearingOffsetDeg: normalizeAngle(data.baseline.bearingOffsetDeg) }, radar, ais, aisStatic, warnings: [...new Set(warnings)] };
  const hasPoints = radar.length + ais.length + aisStatic.length > 0;
  const observedStart = hasPoints ? Math.min(radar[0]?.timeMs ?? Infinity, ais[0]?.timeMs ?? Infinity, aisStatic[0]?.timeMs ?? Infinity) : 0;
  const observedEnd = hasPoints ? Math.max(radar.at(-1)?.timeMs ?? -Infinity, ais.at(-1)?.timeMs ?? -Infinity, aisStatic.at(-1)?.timeMs ?? -Infinity) + 1 : 1;
  const start = data.timeRange ? Date.parse(data.timeRange.start) : observedStart;
  const end = data.timeRange ? Date.parse(data.timeRange.end) : observedEnd;
  if (hasPoints && (observedStart < start || observedEnd > end)) throw new InputError('观测超出数据声明的半开时间范围');
  if (!data.timeRange) dataset.warnings = [...new Set([...dataset.warnings, '导入数据未声明完整查询时段，覆盖仅代表已导入观测的时间跨度'])];
  dataset.timeRange = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  const coverage = Array.from({ length: 20 }, (_, i) => ({ start: start + (end - start) * i / 20, end: start + (end - start) * (i + 1) / 20, radar: 0, ais: 0 }));
  for (const [kind, points] of [['radar', radar], ['ais', ais]]) for (const point of points) coverage[Math.min(19, Math.floor((point.timeMs - start) / (end - start) * 20))][kind]++;
  return {
    dataset,
    summary: { radarPoints: radar.length, aisPoints: ais.length, rawAisPoints: data.ais.length, deduplicated: data.ais.length - ais.length, conflicts, radarTracks: new Set(radar.map((p) => p.trackId)).size, ships: new Set(ais.map((p) => p.mmsi)).size, start, end, coverage, warnings: dataset.warnings },
  };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
