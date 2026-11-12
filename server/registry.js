import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { InputError, parametersSchema, parseInput } from '../shared/data.js';

const deviceId = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/, '编号仅使用字母、数字、下划线或连字符');
const name = z.string().trim().min(1).max(100);
export const radarRegistrationSchema = z.object({ id: deviceId, name, baseline: parametersSchema, deviceCode: z.string().max(160).optional(), stationId: z.string().max(160).optional(), positionText: z.string().max(160).optional() });
export const aisRegistrationSchema = z.object({ id: deviceId, name });
export const groupRegistrationSchema = z.object({ projectId: z.string().min(1).max(80), name, radarIds: z.array(deviceId).min(1).max(8), aisSourceIds: z.array(deviceId).min(1).max(100) });

export class DeviceRegistry {
  constructor(store, projects) { this.store = store; this.sources = projects; this.state = { schemaVersion: 1, revision: 1, projects: {} }; this.pending = Promise.resolve(); }
  async init() {
    const saved = this.store.readRegistry();
    let changed = !saved;
    if (saved) this.state = saved;
    if (this.state.schemaVersion !== 1 || !this.state.projects) throw new Error('本地设备登记格式无效');
    for (const project of this.sources) {
      if (this.state.projects[project.id]) continue;
      this.state.projects[project.id] = {
        radars: structuredClone(project.radars), aisSources: structuredClone(project.aisSources),
        groups: project.radars.length && project.aisSources.length ? [{ id: randomUUID(), projectId: project.id, name: project.name, radarIds: project.radars.slice(0, 8).map((radar) => radar.id), aisSourceIds: project.aisSources.map((source) => source.id), revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] : [],
      };
      changed = true;
    }
    if (changed) await this.persist(this.state);
  }
  async persist(state) { await this.store.writeRegistry(state); }
  project(id, state = this.state) {
    const source = this.sources.find((project) => project.id === id);
    if (!source || !state.projects[id]) throw new InputError('数据源不存在', 404);
    const devices = state.projects[id];
    return { ...source, radars: devices.radars, aisSources: devices.aisSources, registryRevision: state.revision };
  }
  projects() { return this.sources.map((source) => this.project(source.id)); }
  groups(projectId, state = this.state) {
    return this.sources.filter((source) => !projectId || source.id === projectId).flatMap((source) => state.projects[source.id]?.groups ?? []);
  }
  group(id, state = this.state) {
    const group = this.groups(undefined, state).find((entry) => entry.id === id);
    if (!group) throw new InputError('匹配组不存在', 404);
    return group;
  }
  mutate(change) {
    // 上次失败已返回调用方；后续编辑仍可继续，避免一个磁盘错误永久锁住登记。
    const operation = this.pending.then(async () => {
      const next = structuredClone(this.state);
      const result = change(next);
      next.revision++;
      await this.persist(next);
      this.state = next;
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  saveDevice(projectId, kind, input, existingId) {
    if (!['radars', 'aisSources'].includes(kind)) throw new InputError('设备类型无效');
    const device = parseInput(kind === 'radars' ? radarRegistrationSchema : aisRegistrationSchema, input);
    if (existingId && device.id !== existingId) throw new InputError('已登记设备的编号不能修改');
    return this.mutate((state) => {
      this.project(projectId, state);
      const devices = state.projects[projectId][kind];
      const index = devices.findIndex((entry) => entry.id === device.id);
      if (existingId && index < 0) throw new InputError('设备不存在', 404);
      if (!existingId && index >= 0) throw new InputError('设备编号已登记', 409);
      if (index >= 0) devices[index] = device; else devices.push(device);
      return device;
    });
  }
  removeDevice(projectId, kind, id) {
    if (!['radars', 'aisSources'].includes(kind)) throw new InputError('设备类型无效');
    return this.mutate((state) => {
      this.project(projectId, state);
      const catalog = state.projects[projectId];
      const devices = catalog[kind];
      if (!devices.some((entry) => entry.id === id)) throw new InputError('设备不存在', 404);
      const linked = catalog.groups.filter((group) => (kind === 'radars' ? group.radarIds : group.aisSourceIds).includes(id));
      if (linked.length) throw new InputError(`设备仍被匹配组「${linked.map((group) => group.name).join('、')}」使用`, 409);
      catalog[kind] = devices.filter((entry) => entry.id !== id);
      return { removed: true };
    });
  }
  saveGroup(input, existingId) {
    const value = parseInput(groupRegistrationSchema, input);
    if (new Set(value.radarIds).size !== value.radarIds.length || new Set(value.aisSourceIds).size !== value.aisSourceIds.length) throw new InputError('匹配组不能重复选择同一设备');
    return this.mutate((state) => {
      const project = this.project(value.projectId, state);
      if (value.radarIds.some((id) => !project.radars.some((radar) => radar.id === id))) throw new InputError('匹配组包含未登记的雷达');
      if (value.aisSourceIds.some((id) => !project.aisSources.some((source) => source.id === id))) throw new InputError('匹配组包含未登记的 AIS 来源');
      const existing = existingId ? this.group(existingId, state) : null;
      if (existing && existing.projectId !== value.projectId) throw new InputError('匹配组不能跨数据源移动');
      const now = new Date().toISOString();
      const group = { ...value, id: existing?.id ?? randomUUID(), revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now };
      const groups = state.projects[value.projectId].groups;
      if (existing) groups[groups.findIndex((entry) => entry.id === existing.id)] = group; else groups.push(group);
      return group;
    });
  }
  removeGroup(id) {
    return this.mutate((state) => {
      const group = this.group(id, state);
      state.projects[group.projectId].groups = state.projects[group.projectId].groups.filter((entry) => entry.id !== id);
      return { removed: true };
    });
  }
}
