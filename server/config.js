import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { parseInput, parametersSchema, positionSchema, timestampSchema } from '../shared/data.js';
import { aisParserReady } from './ais-parser.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const sqlId = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const liveProjectSchema = z.object({
  id, name: z.string().min(1).max(160), mode: z.enum(['clickhouse-http', 'clickhouse-raw']), configVersion: z.string().min(1),
  reference: positionSchema, verified: z.boolean(),
  defaultRange: z.object({ start: timestampSchema, end: timestampSchema }).optional(),
  warnings: z.array(z.string().max(500)).max(30).default([]),
  radars: z.array(z.object({ id: z.string().min(1), name: z.string(), baseline: parametersSchema, deviceCode: z.string().optional(), stationId: z.string().optional(), positionText: z.string().optional() })).min(1),
  aisSources: z.array(z.object({ id: z.string().min(1), name: z.string() })).min(1),
  timeSemantics: z.enum(['event-time', 'receive-time', 'unverified']), unitsVerified: z.boolean(), alignmentVerified: z.boolean(),
  clickhouse: z.object({
    urlEnv: envName, usernameEnv: envName, passwordEnv: envName, database: sqlId, table: sqlId,
    timeType: z.enum(['DateTime', 'DateTime64']).default('DateTime64'),
    radarIdType: z.enum(['String', 'UInt64', 'Int64']).default('String'),
    columns: z.object({ time: sqlId, radarId: sqlId, trackId: sqlId, range: sqlId, azimuth: sqlId, storedLng: sqlId.optional(), storedLat: sqlId.optional(), deviceTime: sqlId.optional(), targetTime: sqlId.optional(), sequence: sqlId.optional() }),
    mapping: z.object({ version: z.string().min(1), rangeScaleToM: z.number().positive(), azimuthScaleToDeg: z.number().positive(), azimuthSign: z.union([z.literal(1), z.literal(-1)]), azimuthZeroDeg: z.number() }),
  }),
  ais: z.union([
    z.object({ urlEnv: envName, authorizationEnv: envName.optional(), parserVersion: z.string().min(1) }),
    z.object({ mode: z.literal('clickhouse-raw'), database: sqlId, table: sqlId, timeType: z.enum(['DateTime', 'DateTime64']).default('DateTime64'), parserVersion: z.string().min(1), columns: z.object({ time: sqlId, sourceId: sqlId, message: sqlId, eventTime: sqlId.optional(), mmsi: sqlId.optional(), messageType: sqlId.optional(), lng: sqlId.optional(), lat: sqlId.optional(), hash: sqlId.optional(), status: sqlId.optional() }) }),
  ]),
}).refine((project) => (project.mode === 'clickhouse-raw') === (project.ais.mode === 'clickhouse-raw'), '项目模式与 AIS 适配方式不一致');

export async function loadProjects(configPath) {
  const projects = [];
  if (configPath) {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    projects.push(...parseInput(z.object({ projects: z.array(liveProjectSchema).max(30) }), config).projects);
  }
  if (new Set(projects.map((p) => p.id)).size !== projects.length) throw new Error('数据源 id 必须唯一');
  return projects;
}

export function publicProject(project) {
  const { id, name, mode, configVersion, reference, radars, aisSources, verified, defaultRange } = project;
  const missing = [project.clickhouse.urlEnv, project.clickhouse.usernameEnv, project.clickhouse.passwordEnv, project.ais.urlEnv, project.ais.authorizationEnv].filter((name) => name && process.env[name] === undefined);
  const parserAvailable = mode !== 'clickhouse-raw' || aisParserReady();
  return { id, name, mode, configVersion, reference, radars, aisSources, verified, defaultRange, registryRevision: project.registryRevision, readOnly: true, available: !missing.length && parserAvailable, ...(missing.length ? { unavailableReason: `服务端缺少环境变量：${missing.join('、')}` } : !parserAvailable ? { unavailableReason: '请先在服务端运行 npm run setup:ais-parser' } : {}) };
}
