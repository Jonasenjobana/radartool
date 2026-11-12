import { decodePlayback } from '../shared/playback.js';

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  const headers = new Headers(options?.headers);
  if (options?.body != null && !headers.has('content-type')) headers.set('content-type', 'application/json');
  try { response = await fetch(`/api${path}`, { ...options, headers }); }
  catch (error) { if (options?.signal?.aborted) throw error; throw new Error('无法连接后端，请检查 Fastify 服务是否启动'); }
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error ?? `请求失败（${response.status}）`), { status: response.status });
  if (Array.isArray(body)) Object.defineProperty(body, 'nextCursor', { value: response.headers.get('X-Next-Cursor') });
  if (body.schemaVersion === 2) {
    const bundle = decodePlayback(body);
    return (bundle.session || bundle.snapshots.length !== 1 ? bundle : { ...bundle.snapshots[0], ...(bundle.reloadedFrom ? { reloadedFrom: bundle.reloadedFrom } : {}) }) as T;
  }
  return body as T;
}
export const post = <T>(path: string, body: unknown, signal?: AbortSignal) => api<T>(path, { method: 'POST', body: JSON.stringify(body), signal });

export function timeLabel(time: number | string, milliseconds = false) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', ...(milliseconds ? { fractionalSecondDigits: 3 } : {}) }).format(new Date(time));
}
export function dateLabel(time: number | string) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(time));
}
export function toInputTime(time: number | string) { return new Date(new Date(time).getTime() + 8 * 3600000).toISOString().slice(0, 23); }
export function fromInputTime(value: string) { return new Date(`${value}+08:00`).toISOString(); }
export function percent(value?: number) { return value == null ? '—' : `${(value * 100).toFixed(1)}%`; }
export function meters(value?: number | null) { return value == null ? '—' : `${value.toFixed(1)} m`; }
export function signed(value: number, digits = 2) { const rounded = Number(value.toFixed(digits)); return `${rounded > 0 ? '+' : ''}${rounded.toFixed(digits)}`; }
export const assessmentLabel: Record<string, string> = { recommended: '建议采用', insufficient: '证据不足', ambiguous: '存在多个候选', manual: '手动候选' };
export const statusLabel: Record<string, string> = { running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
