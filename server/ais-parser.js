import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { InputError } from '../shared/data.js';

export const AIS_PARSER_VERSION = 'dma-aislib-2.8.8-bridge-v4';
const runtime = fileURLToPath(new URL('../.runtime/ais-parser/', import.meta.url));
export function aisParserReady() { return existsSync(path.join(runtime, 'classes', 'AisBridge.class')); }
export function assertAisParserReady() {
  if (!aisParserReady()) throw new InputError('AIS 解析适配尚未准备，请在服务端运行 npm run setup:ais-parser', 503);
}

export async function parseAisRows(rows, query, signal = new AbortController().signal) {
  assertAisParserReady();
  const payload = await new Promise((resolve, reject) => {
    const child = spawn(process.env.JAVA_BIN ?? 'java', ['-Dfile.encoding=UTF-8', '-cp', path.join(runtime, 'classes') + path.delimiter + path.join(runtime, 'lib', '*'), 'AisBridge'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal });
    const output = []; const diagnostics = []; let inputError;
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => diagnostics.push(chunk));
    child.stdin.on('error', (error) => { inputError = error; });
    child.on('error', (error) => reject(new InputError(`AIS 解析进程启动失败：${error.message}`, 502)));
    child.on('close', (code, exitSignal) => {
      if (code !== 0) {
        const detail = Buffer.concat(diagnostics).toString('utf8').split(/\r?\n/).find((line) => /^(?:Exception in thread|Error[: ]|Caused by:)/.test(line.trim()))?.trim();
        reject(new InputError(`AIS 解析进程失败（${exitSignal ?? `退出码 ${code}`}）${detail ? `：${detail}` : ''}`, 502));
        return;
      }
      if (inputError) { reject(new InputError(`AIS 解析进程输入失败：${inputError.message}`, 502)); return; }
      try { resolve(JSON.parse(Buffer.concat(output).toString('utf8'))); }
      catch { reject(new InputError('AIS 解析器返回格式无效', 502)); }
    });
    child.stdin.end(JSON.stringify({ rows }));
  });
  if (payload.parseStats.failedReports) throw new InputError(`AIS 有 ${payload.parseStats.failedReports} 条报文解析失败，未生成部分快照`, 502);
  const mapDimensions = (dimensions) => {
    if (!dimensions) return null;
    const source = rows[dimensions.rowIndex];
    const observedAt = new Date(Number(source.time_ms)).toISOString();
    return { bow: dimensions.bow, stern: dimensions.stern, port: dimensions.port, starboard: dimensions.starboard, observedAt, validFrom: observedAt, validTo: query.end, sourceId: source.source_id };
  };
  const staticObservations = payload.staticReports.map((point, index) => {
    const row = rows[point.rowIndex];
    const eventTime = new Date(Number(row.time_ms)).toISOString();
    return { id: createHash('sha256').update(JSON.stringify(['static', row, index, point.mmsi, point.messageType])).digest('hex').slice(0, 32), sourceIds: [row.source_id], mmsi: point.mmsi, messageType: point.messageType, eventTime, receiveTime: eventTime, dimensions: mapDimensions(point.dimensions), mappingVersion: AIS_PARSER_VERSION, raw: row, quality: [] };
  });
  const observations = payload.observations.map((point, index) => {
    const row = rows[point.rowIndex];
    const eventTime = new Date(Number(row.time_ms)).toISOString();
    const dimensions = point.dimensions;
    const staticInformation = mapDimensions(dimensions);
    return { id: createHash('sha256').update(JSON.stringify([row, index, point.mmsi, point.messageType])).digest('hex').slice(0, 32), sourceIds: [row.source_id], mmsi: point.mmsi, messageType: point.messageType, eventTime, receiveTime: eventTime, position: { lng: point.position[0], lat: point.position[1] }, sogKnots: point.sogKnots ?? null, cogDeg: point.cogDeg ?? null, headingDeg: point.headingDeg ?? null, dimensions: staticInformation, mappingVersion: AIS_PARSER_VERSION, raw: { ...row, accuracyBit: point.accuracyBit, ...(dimensions ? { staticReport: rows[dimensions.rowIndex] } : {}) }, quality: ['使用 receiveTime 接收时间，尚未确认与雷达的时间偏差'] };
  });
  return { observations, staticObservations, parseStats: payload.parseStats, parserVersion: AIS_PARSER_VERSION, warnings: [...(payload.parseStats.invalidPositions ? [`${payload.parseStats.invalidPositions} 条 AIS 动态报告位置不可用，原始报文保留在快照查询证据中`] : []), ...(payload.parseStats.discardedFragments ? [`${payload.parseStats.discardedFragments} 个 AIS 片段未被完整句组消耗，保留原始报文供复核`] : []), '船体尺寸仅使用本查询内已收到的静态报告；回放到达接收时刻即更新显示，缺失时采用退化模型'] };
}
