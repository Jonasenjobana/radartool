<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';
import { Plus, Edit, Delete, Aim } from '@element-plus/icons-vue';
import type { MatchGroup, Project, RadarRegistration } from '../../shared/types';
import { api, post } from '../api';

const props = defineProps<{ projects: Project[]; groups: MatchGroup[]; disabled: boolean }>();
const emit = defineEmits<{ changed: [groupId?: string]; debug: [groupId: string] }>();
const projectId = ref(''); const tab = ref('groups'); const dialog = ref(false); const saving = ref(false);
const editingId = ref(''); const kind = ref<'groups' | 'radars' | 'aisSources'>('groups'); const editor = ref<FormInstance>();
const editorError = ref('');
const form = reactive({ id: '', name: '', radarIds: [] as string[], aisSourceIds: [] as string[], lng: undefined as number | undefined, lat: undefined as number | undefined, bearing: undefined as number | undefined });
const project = computed(() => props.projects.find((value) => value.id === projectId.value));
const groups = computed(() => props.groups.filter((value) => value.projectId === projectId.value));
const title = computed(() => `${editingId.value ? '编辑' : '新增'}${kind.value === 'groups' ? '匹配组' : kind.value === 'radars' ? '雷达' : 'AIS 来源'}`);
const rules: FormRules = {
  id: [{ required: true, message: '填写设备编号', trigger: 'blur' }, { pattern: /^[A-Za-z0-9_-]+$/, message: '使用字母、数字、下划线或连字符', trigger: 'blur' }],
  name: [{ required: true, message: '填写名称', trigger: 'blur' }],
  radarIds: [{ type: 'array', required: true, min: 1, message: '选择雷达', trigger: 'change' }],
  aisSourceIds: [{ type: 'array', required: true, min: 1, message: '选择 AIS 来源', trigger: 'change' }],
  lng: [{ type: 'number', required: true, message: '填写参考经度', trigger: 'change' }],
  lat: [{ type: 'number', required: true, message: '填写参考纬度', trigger: 'change' }],
  bearing: [{ type: 'number', required: true, message: '填写参考朝向', trigger: 'change' }],
};
watch(() => props.projects, (values) => { if (!values.some((value) => value.id === projectId.value)) projectId.value = values[0]?.id ?? ''; }, { immediate: true });
function radarNames(ids: string[]) { return ids.map((id) => project.value?.radars.find((radar) => radar.id === id)?.name ?? id).join('、'); }
function sourceNames(ids: string[]) { return ids.map((id) => project.value?.aisSources.find((source) => source.id === id)?.name ?? id).join('、'); }
function linked(id: string, deviceKind: 'radars' | 'aisSources') { return groups.value.filter((group) => (deviceKind === 'radars' ? group.radarIds : group.aisSourceIds).includes(id)).map((group) => group.name).join('、') || '—'; }
function openEditor(deviceKind: typeof kind.value, value?: MatchGroup | RadarRegistration | { id: string; name: string }) {
  kind.value = deviceKind; editingId.value = value?.id ?? ''; editorError.value = '';
  Object.assign(form, { id: value?.id ?? '', name: value?.name ?? '', radarIds: value && 'radarIds' in value ? [...value.radarIds] : [], aisSourceIds: value && 'aisSourceIds' in value ? [...value.aisSourceIds] : [], lng: value && 'baseline' in value ? value.baseline.lng : undefined, lat: value && 'baseline' in value ? value.baseline.lat : undefined, bearing: value && 'baseline' in value ? value.baseline.bearingOffsetDeg : undefined });
  dialog.value = true;
}
function edit(deviceKind: typeof kind.value, id: string) {
  const value = deviceKind === 'groups' ? groups.value.find((entry) => entry.id === id) : deviceKind === 'radars' ? project.value?.radars.find((entry) => entry.id === id) : project.value?.aisSources.find((entry) => entry.id === id);
  if (value) openEditor(deviceKind, value);
}
async function save() {
  if (!await editor.value?.validate().catch(() => false)) return;
  saving.value = true; editorError.value = '';
  try {
    if (kind.value === 'groups') {
      const body = { projectId: projectId.value, name: form.name.trim(), radarIds: form.radarIds, aisSourceIds: form.aisSourceIds };
      const value = editingId.value ? await api<MatchGroup>(`/groups/${editingId.value}`, { method: 'PUT', body: JSON.stringify(body) }) : await post<MatchGroup>('/groups', body);
      emit('changed', value.id);
    } else {
      const original = kind.value === 'radars' ? project.value?.radars.find((value) => value.id === editingId.value) : undefined;
      const body = { ...original, id: form.id.trim(), name: form.name.trim(), ...(kind.value === 'radars' ? { baseline: { lng: form.lng, lat: form.lat, bearingOffsetDeg: form.bearing } } : {}) };
      const route = `/registry/${encodeURIComponent(projectId.value)}/${kind.value}${editingId.value ? `/${encodeURIComponent(editingId.value)}` : ''}`;
      await api(route, { method: editingId.value ? 'PUT' : 'POST', body: JSON.stringify(body) }); emit('changed');
    }
    dialog.value = false; ElMessage.success('已保存');
  } catch (reason) { editorError.value = reason instanceof Error ? reason.message : String(reason); }
  finally { saving.value = false; }
}
async function remove(deviceKind: typeof kind.value, id: string) {
  try { await api(deviceKind === 'groups' ? `/groups/${id}` : `/registry/${encodeURIComponent(projectId.value)}/${deviceKind}/${encodeURIComponent(id)}`, { method: 'DELETE' }); emit('changed'); }
  catch (reason) { ElMessage.error(reason instanceof Error ? reason.message : String(reason)); }
}
</script>

<template>
  <section class="registry-page">
    <div class="page-toolbar"><h2>设备与匹配组</h2><el-select v-model="projectId" aria-label="数据源" placeholder="选择数据源" class="project-select" :disabled="disabled"><el-option v-for="value in projects" :key="value.id" :value="value.id" :label="value.name"/></el-select><el-tag type="info" effect="plain">本地配置</el-tag></div>
    <el-empty v-if="!project" description="未配置数据源" />
    <el-tabs v-else v-model="tab" class="registry-tabs">
      <el-tab-pane label="匹配组" name="groups">
        <div class="table-toolbar"><span>{{ groups.length }} 个匹配组</span><el-button type="primary" :icon="Plus" :disabled="disabled" @click="openEditor('groups')">新增匹配组</el-button></div>
        <el-table :data="groups" height="100%" row-key="id" empty-text="暂无匹配组">
          <el-table-column prop="name" label="名称" min-width="180"/>
          <el-table-column label="雷达" min-width="240"><template #default="{ row }">{{ radarNames(row.radarIds) }}</template></el-table-column>
          <el-table-column label="AIS 来源" min-width="240"><template #default="{ row }">{{ sourceNames(row.aisSourceIds) }}</template></el-table-column>
          <el-table-column label="操作" width="224" fixed="right"><template #default="{ row }"><el-button link type="primary" :icon="Aim" :disabled="disabled" @click="emit('debug', row.id)">调试</el-button><el-button link :icon="Edit" :disabled="disabled" @click="edit('groups', row.id)">编辑</el-button><el-popconfirm title="移除这个匹配组？" @confirm="remove('groups', row.id)"><template #reference><el-button link type="danger" :icon="Delete" :disabled="disabled">移除</el-button></template></el-popconfirm></template></el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="雷达登记" name="radars">
        <div class="table-toolbar"><span>{{ project.radars.length }} 台雷达</span><el-button type="primary" :icon="Plus" :disabled="disabled" @click="openEditor('radars')">登记雷达</el-button></div>
        <el-table :data="project.radars" height="100%" row-key="id" empty-text="暂无雷达">
          <el-table-column prop="name" label="名称" min-width="170"/><el-table-column prop="id" label="设备编号" min-width="130"/>
          <el-table-column label="参考经度" min-width="130"><template #default="{ row }">{{ row.baseline.lng.toFixed(6) }}</template></el-table-column>
          <el-table-column label="参考纬度" min-width="130"><template #default="{ row }">{{ row.baseline.lat.toFixed(6) }}</template></el-table-column>
          <el-table-column label="参考朝向" width="110"><template #default="{ row }">{{ row.baseline.bearingOffsetDeg }}°</template></el-table-column>
          <el-table-column label="匹配组" min-width="200"><template #default="{ row }">{{ linked(row.id, 'radars') }}</template></el-table-column>
          <el-table-column label="操作" width="152" fixed="right"><template #default="{ row }"><el-button link :icon="Edit" :disabled="disabled" @click="edit('radars', row.id)">编辑</el-button><el-popconfirm title="移除这台雷达？" @confirm="remove('radars', row.id)"><template #reference><el-button link type="danger" :icon="Delete" :disabled="disabled">移除</el-button></template></el-popconfirm></template></el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="AIS 登记" name="aisSources">
        <div class="table-toolbar"><span>{{ project.aisSources.length }} 个接收来源</span><el-button type="primary" :icon="Plus" :disabled="disabled" @click="openEditor('aisSources')">登记 AIS</el-button></div>
        <el-table :data="project.aisSources" height="100%" row-key="id" empty-text="暂无 AIS 来源"><el-table-column prop="name" label="名称" min-width="220"/><el-table-column prop="id" label="stationMmsi" min-width="180"/><el-table-column label="匹配组" min-width="240"><template #default="{ row }">{{ linked(row.id, 'aisSources') }}</template></el-table-column><el-table-column label="操作" width="152" fixed="right"><template #default="{ row }"><el-button link :icon="Edit" :disabled="disabled" @click="edit('aisSources', row.id)">编辑</el-button><el-popconfirm title="移除这个 AIS 来源？" @confirm="remove('aisSources', row.id)"><template #reference><el-button link type="danger" :icon="Delete" :disabled="disabled">移除</el-button></template></el-popconfirm></template></el-table-column></el-table>
      </el-tab-pane>
    </el-tabs>
    <el-dialog v-model="dialog" :title="title" width="510px" destroy-on-close :close-on-click-modal="false" @opened="editor?.clearValidate()">
      <el-alert v-if="editorError" :title="editorError" type="error" :closable="false" class="dialog-error"/>
      <el-form ref="editor" :model="form" :rules="rules" label-width="90px" @submit.prevent="save">
        <el-form-item v-if="kind !== 'groups'" label="设备编号" prop="id"><el-input v-model="form.id" :disabled="!!editingId" maxlength="160"/></el-form-item>
        <el-form-item label="名称" prop="name"><el-input v-model="form.name" maxlength="100"/></el-form-item>
        <template v-if="kind === 'groups'"><el-form-item label="雷达" prop="radarIds"><el-select v-model="form.radarIds" multiple filterable :multiple-limit="8" placeholder="选择雷达"><el-option v-for="value in project?.radars ?? []" :key="value.id" :value="value.id" :label="`${value.name} · ${value.id}`"/></el-select></el-form-item><el-form-item label="AIS 来源" prop="aisSourceIds"><el-select v-model="form.aisSourceIds" multiple filterable :multiple-limit="100" placeholder="选择接收来源"><el-option v-for="value in project?.aisSources ?? []" :key="value.id" :value="value.id" :label="`${value.name} · ${value.id}`"/></el-select></el-form-item></template>
        <template v-if="kind === 'radars'"><el-form-item label="参考经度" prop="lng"><el-input-number v-model="form.lng" :min="-180" :max="180" :precision="7" :step="0.00001" controls-position="right"/></el-form-item><el-form-item label="参考纬度" prop="lat"><el-input-number v-model="form.lat" :min="-85" :max="85" :precision="7" :step="0.00001" controls-position="right"/></el-form-item><el-form-item label="参考朝向" prop="bearing"><el-input-number v-model="form.bearing" :min="0" :max="360" :precision="3" :step="0.1" controls-position="right"/><span class="field-unit">°</span></el-form-item></template>
      </el-form>
      <template #footer><el-button :disabled="saving" @click="dialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template>
    </el-dialog>
  </section>
</template>
