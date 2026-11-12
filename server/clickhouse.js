import { createClient } from '@clickhouse/client';
import { InputError } from '../shared/data.js';

export const READ_SETTINGS = Object.freeze({ readonly: 1 });

let reading = false;
export async function withLiveRead(action) {
  if (reading) throw new InputError('已有只读查询运行中，请稍后重试', 409);
  reading = true;
  try { return await action(); } finally { reading = false; }
}

export function envValue(name) {
  if (!name || process.env[name] === undefined) throw new InputError(`服务端未配置 ${name ?? '必需环境变量'}`, 503);
  return process.env[name];
}

export function clientFor(project) {
  const config = project.clickhouse;
  let url;
  try { url = new URL(envValue(config.urlEnv)); }
  catch (error) { if (error instanceof InputError) throw error; throw new InputError('ClickHouse 地址格式无效', 503); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new InputError('ClickHouse URL 必须为不含凭据和查询参数的 HTTP(S) 地址', 503);
  return createClient({ url: url.toString(), username: envValue(config.usernameEnv), password: envValue(config.passwordEnv), database: config.database, max_open_connections: 1, log: { level: 'OFF' }, clickhouse_settings: READ_SETTINGS });
}

export function queryFailure(error, source) {
  if (error instanceof InputError) return error;
  const code = String(error.code ?? '');
  const bytesReason = '触发远程数据库读取量限制';
  const reason = {
    // 旧版对扫描行数和字节数可能共用 158，按异常中的具体超限项区分，不输出上游原文。
    158: /\bmax bytes\s*:/i.test(String(error.message ?? '')) ? bytesReason : '触发远程数据库扫描行数限制（包含索引块内未命中的行）',
    159: '触发远程数据库执行时间限制',
    160: '触发数据库最低读取速度限制',
    307: bytesReason,
    241: '触发远程数据库内存限制',
    202: '触发数据库并发查询数量限制',
    396: '触发返回结果行数或大小限制',
  }[code];
  if (reason) return new InputError(`${source}${reason}（${code}）；查询已停止，不会自动扩大范围重试`, 422);
  return new InputError(`${source}失败，请检查服务端连接、字段映射或查询上限；未生成部分快照`, 502);
}

export const quote = (identifier) => `\`${identifier}\``;
export const timeType = (config) => config.timeType === 'DateTime' ? "DateTime('UTC')" : "DateTime64(3, 'UTC')";
export function parameterTime(value, config = {}) {
  const native = config.timeType === 'DateTime';
  // 秒精度源使用向上取整的边界，保留原请求半开区间的精确成员关系。
  const milliseconds = native ? Math.ceil(Date.parse(value) / 1000) * 1000 : Date.parse(value);
  return new Date(milliseconds).toISOString().replace('T', ' ').replace('Z', '').slice(0, native ? 19 : 23);
}
