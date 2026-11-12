<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { Aim, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Back, Download, FolderOpened, InfoFilled, List, Loading, Setting, VideoPause, VideoPlay } from '@element-plus/icons-vue';
import CalibrationMap from './components/CalibrationMap.vue';
import RegistryPage from './components/RegistryPage.vue';
import TargetInspector from './components/TargetInspector.vue';
import TaskResults from './components/TaskResults.vue';
import ParameterComparison from './components/ParameterComparison.vue';
import { useWorkbench } from './useWorkbench';
import { dateLabel, meters, percent, statusLabel, timeLabel } from './api';
import type { Project } from '../shared/types';

const w = reactive(useWorkbench());
const timelineTime = computed(() => w.seekPreview ?? w.cursor);
const loadingPlayback = computed(() => !!w.preparationId || w.busy && !w.snapshot);
const page = ref('debug'); const fileInput = ref<HTMLInputElement>(); const nudgeStep = ref<number | undefined>(5);
const controlsHidden = ref(window.innerWidth < 760); const targetsOpen = ref(false); const sourceOpen = ref(false); const historyOpen = ref(false);
const advancedOpen = ref(false); const versionOpen = ref(false); const evidenceOpen = ref(false); const historyTab = ref('sessions');
const availabilityLabel: Record<string, string> = { memory: '内存可用', reload: '需回源', legacy: '旧历史', archive: '已归档' };
async function moreHistory() { await w.moreHistory(historyTab.value as 'sessions' | 'snapshots' | 'tasks'); }
async function archiveCurrent() {
  try { const { value } = await ElMessageBox.prompt('填写服务器上的绝对目录，完整数据将保存到该位置。', '完整归档', { inputPlaceholder: '例如 G:\\radar-archives', confirmButtonText: '保存归档', cancelButtonText: '取消', inputValidator: value => !!value.trim() || '填写归档目录' }); await w.archiveCurrent(value.trim()); }
  catch (reason) { if (reason !== 'cancel' && reason !== 'close') ElMessage.error(reason instanceof Error ? reason.message : String(reason)); }
}
const range = computed({ get: () => [w.queryStart, w.queryEnd] as [string, string], set: (value: [string, string] | null) => { if (value) [w.queryStart, w.queryEnd] = value; } });
const canActivate = computed(() => w.candidateIndex < 0 || w.task?.result?.assessment === 'recommended');
watch(canActivate, (allowed) => { if (!allowed) w.enableEffective = false; });
const radarConfiguration = computed(() => w.dataset?.provenance.radarConfiguration as Project['radars'][number] | undefined);
const parseStats = computed(() => w.dataset?.provenance.parseStats);
const loadedAisSources = computed(() => {
  if (w.session) return w.session.aisSourceIds;
  const query = w.dataset?.provenance.query as { aisSourceIds?: unknown } | undefined;
  if (Array.isArray(query?.aisSourceIds) && query.aisSourceIds.every((value) => typeof value === 'string')) return query.aisSourceIds as string[];
  return [...new Set(w.snapshots.flatMap((snapshot) => snapshot.dataset.ais.flatMap((point) => point.sourceIds)))];
});
const activeName = computed(() => w.radarOptions.find((value) => value.id === w.radarId)?.name ?? w.radarId);
const registeredRadars = computed(() => w.project?.radars.filter((value) => !w.group || w.group.radarIds.includes(value.id)) ?? []);
const mapReference = computed(() => w.dataset?.reference ?? w.project?.reference);
const mapParameters = computed(() => w.dataset ? w.parameters : (registeredRadars.value.find((value) => value.id === w.radarId) ?? registeredRadars.value[0])?.baseline ?? { ...mapReference.value!, bearingOffsetDeg: 0 });
const mapStations = computed(() => w.dataset ? w.otherStations : registeredRadars.value.map((value) => ({ id: value.id, name: value.name, parameters: value.baseline, color: '#627b9c' })));
const mapKey = computed(() => w.snapshots.length ? w.snapshots.map((value) => value.id).join(':') : w.projectId);
const extent = computed(() => w.snapshots.length ? w.snapshots.flatMap((snapshot) => [...snapshot.dataset.ais.filter((_, index) => index % Math.max(1, Math.ceil(snapshot.dataset.ais.length / 200)) === 0).map((point) => point.position), snapshot.dataset.baseline]) : registeredRadars.value.map((value) => value.baseline));
const coverage = computed(() => {
  const bins = Array.from({ length: 20 }, () => ({ radar: 0, ais: 0 }));
  const duration = Math.max(1, w.end - w.start + 1);
  for (const snapshot of w.snapshots) for (let index = 0; index < 20; index++) bins[index].radar += snapshot.summary.coverage[index]?.radar ?? 0;
  const seen = new Set<string>();
  for (const snapshot of w.snapshots) for (const point of snapshot.dataset.ais) { const key = `${point.mmsi}:${point.timeMs}:${point.messageType}:${point.position.lng}:${point.position.lat}`; if (!seen.has(key)) { bins[Math.min(19, Math.max(0, Math.floor((point.timeMs - w.start) / duration * 20)))].ais++; seen.add(key); } }
  return bins;
});
async function chooseGroup(id: string) { await w.chooseGroup(id); }
async function debugGroup(id: string) { await w.chooseGroup(id); page.value = 'debug'; }
function togglePlayback() { if (!w.snapshot || w.busy) return; if (!w.playing && w.cursor >= w.end) w.cursor = w.start; w.playing = !w.playing; }
function playbackKeydown(event: KeyboardEvent) {
  if (page.value !== 'debug' || !w.snapshot || w.busy || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (targetsOpen.value || sourceOpen.value || historyOpen.value || advancedOpen.value || versionOpen.value || evidenceOpen.value) return;
  if (!['ArrowLeft', 'ArrowRight', ' '].includes(event.key)) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="spinbutton"], [role="combobox"], [role="listbox"], [role="menu"], [role="tablist"], [role="radiogroup"], [role="dialog"]')) return;
  if (event.key === ' ' && target instanceof HTMLElement && target.closest('button, a[href], [role="button"]') && !target.closest('.timeline-actions, .leaflet-marker-icon')) return;
  event.preventDefault(); event.stopPropagation();
  if (event.key === ' ') { if (!event.repeat) togglePlayback(); }
  else w.stepFrame(event.key === 'ArrowLeft' ? -1 : 1);
}
function adjustBearing(event: WheelEvent) {
  const input = (event.currentTarget as HTMLElement).querySelector('input');
  if (!w.snapshot || w.busy || !input || document.activeElement !== input || event.deltaY === 0 || event.ctrlKey || event.metaKey) return;
  const value = Number(input.value);
  if (!input.value.trim() || !Number.isFinite(value)) return;
  event.preventDefault();
  // 先提交编辑文本，让输入框同步显示滚轮调整后的参数。
  input.dispatchEvent(new Event('change', { bubbles: true }));
  w.setParameter('bearingOffsetDeg', Number((w.parameters.bearingOffsetDeg - Math.sign(event.deltaY) * 0.1).toFixed(3)));
}
// 在捕获阶段处理，避免左右键同时触发 Leaflet 的地图平移。
onMounted(() => window.addEventListener('keydown', playbackKeydown, true));
onUnmounted(() => window.removeEventListener('keydown', playbackKeydown, true));
function selectFile(event: Event) { const input = event.target as HTMLInputElement; void w.importFile(input.files?.[0]); input.value = ''; }
async function saveVersion() { await w.saveVersion(); if (!w.error) { versionOpen.value = false; ElMessage.success('参数已保存'); } }
async function openSnapshot(id: string) { await w.openSnapshot(id); historyOpen.value = false; }
async function openSession(id: string) { await w.openSession(id); historyOpen.value = false; }
async function openTask(id: string) { await w.openTask(id); historyOpen.value = false; }
function preview(index: number) { w.previewCandidate(index); if (w.comparison) { evidenceOpen.value = false; targetsOpen.value = false; } }
async function exportSnapshot() { const url = await w.exportCurrent(); if (url) window.location.assign(url); }
</script>

<template>
  <el-config-provider :locale="zhCn" size="small">
    <div class="app" :class="{ 'controls-hidden': controlsHidden }">
      <header class="app-header">
        <div class="brand"><el-icon :size="24"><Aim/></el-icon><h1>雷达 · AIS</h1></div>
        <el-radio-group v-model="page" class="app-nav" :disabled="w.busy"><el-radio-button value="debug">匹配调试</el-radio-button><el-radio-button value="registry">设备关联</el-radio-button></el-radio-group>
        <div class="header-status"><span>{{ w.project?.name ?? '未选择数据源' }}</span><el-tag type="info" effect="plain">只读</el-tag></div>
      </header>
      <el-alert v-if="w.error" :title="w.error" type="error" show-icon closable class="app-error" @close="w.error = ''"/>
      <RegistryPage v-if="page === 'registry'" :projects="w.projects" :groups="w.groups" :disabled="w.busy" @changed="w.refreshRegistry" @debug="debugGroup"/>
      <template v-else>
        <div class="query-bar">
          <el-select :model-value="w.groupId" class="group-select" placeholder="选择匹配组" filterable :disabled="w.busy" aria-label="匹配组" @change="chooseGroup"><el-option v-for="value in w.groups" :key="value.id" :value="value.id" :label="value.name"/></el-select>
          <el-date-picker v-model="range" type="datetimerange" value-format="YYYY-MM-DDTHH:mm:ss.SSS" format="MM-DD HH:mm:ss" range-separator="至" start-placeholder="开始时间" end-placeholder="结束时间" :clearable="false" :disabled="w.busy" aria-label="查询时间（北京时间）"/>
          <el-button :type="w.mapMode === 'query' || w.queryArea ? 'primary' : 'default'" plain :disabled="!w.group || w.busy" @click="w.mapMode = w.mapMode === 'query' ? 'view' : 'query'">{{ w.queryArea ? '已选船舶区域' : '框选船舶区域' }}</el-button>
          <el-button v-if="w.queryArea" link :disabled="w.busy" @click="w.setQueryArea(null)">清除区域</el-button>
          <el-button type="primary" :loading="w.busy" :disabled="!w.group || !w.project?.available" @click="w.runQuery()">加载匹配组</el-button><el-button v-if="w.preparationId" @click="w.cancelQuery">取消加载</el-button>
          <el-button :icon="FolderOpened" :disabled="w.busy" @click="historyOpen = true">历史</el-button>
          <el-dropdown trigger="click"><el-button :icon="Download" aria-label="导入导出"/><template #dropdown><el-dropdown-menu><el-dropdown-item :disabled="!w.group || w.busy || !w.project?.available" @click="w.forceQuery">重新读取远程数据</el-dropdown-item><el-dropdown-item @click="fileInput?.click()">导入真实观测</el-dropdown-item><el-dropdown-item :disabled="!w.snapshot" @click="exportSnapshot">导出当前雷达</el-dropdown-item><el-dropdown-item :disabled="!w.snapshot || w.busy" @click="archiveCurrent">完整归档到指定目录</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
          <input ref="fileInput" class="sr-only" type="file" accept=".json,application/json" aria-label="导入真实观测" @change="selectFile">
          <el-button :icon="InfoFilled" aria-label="数据详情" @click="sourceOpen = true"/>
        </div>
        <main class="debug-workspace">
          <aside v-show="!controlsHidden" class="control-pane">
            <div class="pane-toolbar"><el-select :model-value="w.radarId" placeholder="选择雷达" :disabled="!w.radarOptions.length || w.busy" aria-label="当前调整雷达" @change="w.activateRadar"><el-option v-for="value in w.radarOptions" :key="value.id" :value="value.id" :label="value.name"/></el-select></div>
            <el-tabs v-model="w.panel" class="control-tabs">
              <el-tab-pane label="参数调整" name="manual"><el-scrollbar height="100%"><div class="panel-content">
                <el-form label-width="60px" :disabled="!w.snapshot">
                  <el-form-item label="经度"><el-input-number :model-value="w.snapshot ? w.parameters.lng : undefined" :min="-180" :max="180" :precision="7" :step="0.000001" controls-position="right" @update:model-value="value => w.setParameter('lng', value)"/></el-form-item>
                  <el-form-item label="纬度"><el-input-number :model-value="w.snapshot ? w.parameters.lat : undefined" :min="-85" :max="85" :precision="7" :step="0.000001" controls-position="right" @update:model-value="value => w.setParameter('lat', value)"/></el-form-item>
                  <el-form-item label="朝向 °" @wheel="adjustBearing"><el-input-number :model-value="w.snapshot ? w.parameters.bearingOffsetDeg : undefined" :min="0" :max="360" :precision="3" :step="0.1" controls-position="right" title="选中输入框后，滚轮向上增加、向下减少 0.1°" aria-label="朝向（选中后滚轮微调 0.1 度）" @update:model-value="value => w.setParameter('bearingOffsetDeg', value)"/></el-form-item>
                </el-form>
                <div class="section-line"><h3>米制微调</h3><el-input-number v-model="nudgeStep" :min="0.1" :max="1000" :step="1" controls-position="right" class="nudge-step" aria-label="移动步长（米）"/></div>
                <div class="nudge-pad"><el-button class="north" :icon="ArrowUp" :disabled="!w.snapshot || !nudgeStep" @click="w.nudge(0, nudgeStep ?? 0)"/><el-button class="west" :icon="ArrowLeft" :disabled="!w.snapshot || !nudgeStep" @click="w.nudge(-(nudgeStep ?? 0), 0)"/><span>{{ meters(w.offset.distance) }}</span><el-button :icon="ArrowRight" :disabled="!w.snapshot || !nudgeStep" @click="w.nudge(nudgeStep ?? 0, 0)"/><el-button class="south" :icon="ArrowDown" :disabled="!w.snapshot || !nudgeStep" @click="w.nudge(0, -(nudgeStep ?? 0))"/></div>
                <div class="offset-line">E {{ w.offset.east.toFixed(1) }} / N {{ w.offset.north.toFixed(1) }} m</div>
                <el-divider/>
                <el-form label-width="60px"><el-form-item label="对比"><el-select v-model="w.baselineVersion" :disabled="!w.snapshot"><el-option value="snapshot" label="快照参考值"/><el-option value="effective" label="按生效时间"/><el-option v-for="value in w.versions" :key="value.id" :value="value.id" :label="value.name"/></el-select></el-form-item></el-form>
                <div class="row-actions"><el-button :icon="Back" :disabled="!w.snapshot" @click="w.parameters = { ...w.baseline }">恢复对比值</el-button><el-button type="primary" :disabled="!w.snapshot || w.busy" @click="versionOpen = true">保存版本</el-button></div>
                <div v-if="w.versions.length" class="saved-versions"><h3>已存版本</h3><div v-for="value in w.versions" :key="value.id" class="version-row"><span>{{ value.name }}</span><el-button link type="primary" @click="w.parameters = { ...value.parameters }">预览</el-button></div></div>
              </div></el-scrollbar></el-tab-pane>
              <el-tab-pane label="自动标定" name="auto"><el-scrollbar height="100%"><div class="panel-content">
                <el-form v-if="w.fitOptions.refinement" label-position="top"><el-form-item label="AIS 附近距离（m）"><el-input-number v-model="w.fitOptions.refinement.maxDistanceM" :min="10" :max="2000" :step="10" controls-position="right"/></el-form-item><el-form-item label="位置修正范围（各方向 ±m）"><el-input-number v-model="w.fitOptions.refinement.maxPositionShiftM" :min="1" :max="2000" :step="10" controls-position="right"/></el-form-item><el-form-item label="朝向修正范围（±°）"><el-input-number v-model="w.fitOptions.refinement.maxBearingShiftDeg" :min="0.1" :max="30" :step="0.1" controls-position="right"/></el-form-item></el-form>
                <div class="region-value mono">局部安装范围<br>E {{ w.refinementBounds.minEast.toFixed(0) }} ～ {{ w.refinementBounds.maxEast.toFixed(0) }}<br>N {{ w.refinementBounds.minNorth.toFixed(0) }} ～ {{ w.refinementBounds.maxNorth.toFixed(0) }} m</div>
                <div class="section-line"><span>拟合 AIS 区域</span><el-button link :disabled="!w.snapshot" @click="w.mapMode = 'roi'">圈选</el-button><el-button v-if="w.fitOptions.roi" link type="danger" @click="w.fitOptions.roi = null">清除</el-button></div>
                <div class="section-line"><span>雷达排除区域</span><el-button link :disabled="!w.snapshot" @click="w.mapMode = 'exclusion'">圈选</el-button><el-button v-if="w.fitOptions.refinement?.radarExclusion" link type="danger" @click="w.fitOptions.refinement.radarExclusion = null">清除</el-button></div>
                <div class="section-line"><span>标定时段</span></div><div class="region-value">{{ w.snapshot ? `${dateLabel(w.start)} ～ ${dateLabel(w.end + 1)}` : '—' }}</div>
                <el-form label-position="top"><el-form-item label="时间对齐窗口（ms）"><el-input-number v-model="w.fitOptions.maxGapMs" :min="0" :max="10000" :step="100" controls-position="right"/></el-form-item><el-form-item label="验证时段比例"><el-input-number v-model="w.fitOptions.validationFraction" :min="0.15" :max="0.45" :step="0.05" controls-position="right"/></el-form-item></el-form>
                <el-button class="full-width" :icon="Setting" @click="advancedOpen = true">算法设置</el-button>
                <div class="fit-state"><el-tag v-if="!w.canFit" type="info" size="small">{{ w.fitError || '时间、单位或数据待确认' }}</el-tag></div>
                <el-button class="full-width" :loading="w.refinementChecking" :disabled="!w.canFit || w.busy" @click="w.checkRefinement">{{ w.refinementValid ? '重新筛选附近雷达' : '筛选附近雷达' }}</el-button>
                <div class="row-actions"><el-button type="primary" :disabled="!w.canStartFit || !!w.runningTask || w.busy || w.refinementChecking" @click="w.startFit">创建标定任务</el-button><el-button v-if="w.task?.status === 'running'" :disabled="w.busy" @click="w.cancelFit">取消</el-button></div>
                <div v-if="w.task" class="task-progress"><div class="section-line"><span>{{ statusLabel[w.task.status] }}</span><span>{{ percent(w.task.progress.fraction) }}</span></div><el-progress :percentage="Math.round(w.task.progress.fraction * 100)" :show-text="false"/><p>{{ w.task.progress.phase }}</p><el-alert v-if="w.task.error" :title="w.task.error" type="error" :closable="false"/><el-button v-if="w.task.result" class="full-width" @click="evidenceOpen = true">查看结果</el-button></div>
                <el-button v-if="w.runningTask && w.runningTask.id !== w.task?.id" class="full-width" @click="w.openTask(w.runningTask.id)">查看运行中的任务</el-button>
              </div></el-scrollbar></el-tab-pane>
            </el-tabs>
          </aside>
          <section class="map-panel">
            <div class="layer-bar"><el-button :icon="Setting" aria-label="展开或收起参数" @click="controlsHidden = !controlsHidden"/><el-checkbox-group v-model="w.visibleRadarIds"><el-checkbox v-for="value in w.radarMembers" :key="value.id" :value="value.id"><i class="legend-dot" :style="{ background: value.color }"/>{{ value.name }}</el-checkbox></el-checkbox-group><span class="ais-legend"><i class="legend-dot ais"/>AIS</span><el-dropdown trigger="click"><el-button link>图层<el-icon><ArrowDown/></el-icon></el-button><template #dropdown><el-dropdown-menu><div class="layer-options"><el-checkbox v-model="w.showCandidate">候选坐标</el-checkbox><el-checkbox v-model="w.showStored">历史存储坐标</el-checkbox><el-checkbox v-model="w.showBaseline">对比坐标</el-checkbox><el-checkbox v-model="w.showTrails">尾迹</el-checkbox><el-checkbox v-model="w.showLinks">关联线</el-checkbox><el-checkbox v-model="w.showTiles">地理底图</el-checkbox></div></el-dropdown-menu></template></el-dropdown><el-button class="targets-button" :icon="List" aria-label="目标与候选" @click="targetsOpen = true"/></div>
            <ParameterComparison v-if="w.comparison" :comparison="w.comparison" @apply="w.applyCandidate" @close="w.clearComparison"/>
            <div class="map-viewport">
            <CalibrationMap v-if="mapReference" :key="mapKey" :reference="mapReference" :comparison="w.comparison" :parameters="mapParameters" :baseline="w.dataset ? w.baseline : mapParameters" :bounds="w.refinementBounds" :local-search="true" :roi="w.fitOptions.roi" :radar-exclusion="w.fitOptions.refinement?.radarExclusion ?? null" :refinement="w.refinementMap" :query-area="w.queryArea" :editable="!!w.dataset" :disabled="w.busy" :aria-busy="loadingPlayback" :radar="w.mapRadar" :ais="w.aisCurrent" :trails="w.mapTrails" :ais-trails="w.aisTrails" :other-stations="mapStations" :extent="extent" :selection="w.selection" :mode="w.mapMode" :show-baseline="w.showBaseline" :show-candidate="w.showCandidate" :show-stored="w.showStored" :show-links="w.showLinks" :show-tiles="w.showTiles" @parameters="w.parameters = $event" @bounds="w.setBounds" @query-area="w.setQueryArea" @clear-exclusion="w.fitOptions.refinement!.radarExclusion = null" @select="w.selectTarget" @mode="w.mapMode = $event" @activate="w.activateRadar"/>
            <div v-else class="empty-map"><el-empty :description="w.group ? '尚未加载观测' : '尚未配置匹配组'" :image-size="90"><el-button v-if="!w.group" type="primary" @click="page = 'registry'">配置匹配组</el-button><el-button v-else type="primary" :disabled="!w.project?.available || w.busy" @click="w.runQuery">加载匹配组</el-button></el-empty></div>
              <div v-if="loadingPlayback" class="playback-loading" role="status" aria-live="polite">
                <el-icon class="is-loading" :size="32" aria-hidden="true"><Loading/></el-icon>
                <strong>{{ w.preparationId ? '正在准备完整数据' : '正在加载数据' }}</strong>
                <span v-if="w.preparationId">{{ w.notice }}</span>
                <el-button v-if="w.preparationId" @click="w.cancelQuery">取消加载</el-button>
              </div>
            </div>
            <section v-if="w.refinementValid && w.refinementPreview" class="association-review" aria-label="关联检查">
              <div class="association-toolbar"><strong>关联检查 · 拟合时段</strong><span>保留 {{ w.selectedAssociationIds.length }} / {{ w.refinementPreview.associations.length }} 项 · {{ w.retainedRefinement?.training.length ?? 0 }} 个观测</span><el-checkbox v-model="w.showOriginalRadar">查看原始雷达回放</el-checkbox></div>
              <el-checkbox-group v-model="w.selectedAssociationIds" aria-label="保留关联"><el-table :data="w.refinementPreview.associations" row-key="id" height="180" size="small" empty-text="没有符合稳定门限的关联" @row-click="row => w.focusRefinementAssociation(row.id)"><el-table-column width="42"><template #default="{ row }"><el-checkbox :value="row.id" :aria-label="`保留轨迹 ${row.trackId} 与 ${row.mmsi}`"><span class="sr-only">保留</span></el-checkbox></template></el-table-column><el-table-column prop="mmsi" label="AIS" min-width="105"/><el-table-column prop="trackId" label="雷达轨迹" min-width="95"/><el-table-column prop="points" label="有效时刻" width="80"/><el-table-column label="持续（s）" width="92"><template #default="{ row }">{{ ((row.end - row.start) / 1000).toFixed(1) }}</template></el-table-column><el-table-column label="距离 P50" min-width="100"><template #default="{ row }">{{ meters(row.distanceP50M) }}</template></el-table-column><el-table-column label="运动误差" min-width="100"><template #default="{ row }">{{ meters(row.motionErrorM) }}</template></el-table-column><el-table-column label="拟合时段" min-width="160"><template #default="{ row }">{{ timeLabel(row.start) }} ～ {{ timeLabel(row.end) }}</template></el-table-column></el-table></el-checkbox-group>
            </section>
            <div class="map-summary"><span>雷达 {{ w.radarCurrent.length }} · AIS {{ w.aisCurrent.length }} · 关联 {{ w.currentMatches }}</span><span>{{ w.snapshots.length }} 台雷达 · 当前调整 {{ activeName || '—' }}</span></div>
            <div class="timeline" :class="{ 'is-loading': !!w.preparationId }"><div class="timeline-heading">
              <strong class="mono">{{ w.snapshot ? timeLabel(timelineTime, true) : '—' }}</strong><span>{{ w.snapshot ? dateLabel(timelineTime).slice(0, 10) : '' }}</span>
              <div v-if="w.seekPreview != null" class="timeline-load-state">松开后跳转</div>
              <span v-else-if="w.snapshot && !w.preparationId">完整时段已加载</span><div class="timeline-actions">
              <el-button :icon="ArrowLeft" :disabled="!w.snapshot || w.busy" aria-label="上一帧" aria-keyshortcuts="ArrowLeft" title="上一帧（←）" @click="w.stepFrame(-1)"/>
              <el-button :icon="w.playing ? VideoPause : VideoPlay" :disabled="!w.snapshot || w.busy" aria-keyshortcuts="Space" title="播放 / 暂停（空格）" @click="togglePlayback">{{ w.playing ? '暂停' : '播放' }}</el-button>
              <el-button :icon="ArrowRight" :disabled="!w.snapshot || w.busy" aria-label="下一帧" aria-keyshortcuts="ArrowRight" title="下一帧（→）" @click="w.stepFrame(1)"/>
              <el-select v-model="w.speed" aria-label="播放速度" class="speed-select"><el-option v-for="value in [1, 5, 10, 30, 60]" :key="value" :value="value" :label="`${value}×`"/></el-select><el-select v-model="w.trailSeconds" aria-label="尾迹时间" class="tail-select"><el-option v-for="value in [30, 60, 120, 300]" :key="value" :value="value" :label="`${value} 秒尾迹`"/></el-select>
            </div></div><div class="coverage"><svg viewBox="0 0 1000 20" preserveAspectRatio="none" aria-hidden="true"><g v-for="(bin, index) in coverage" :key="index"><rect :x="index * 50" y="1" width="48" height="7" :fill="bin.radar ? '#d89b65' : '#e3e9ed'"/><rect :x="index * 50" y="12" width="48" height="7" :fill="bin.ais ? '#79b4a8' : '#e3e9ed'"/></g></svg><el-slider :model-value="timelineTime" aria-label="回放进度" :min="w.start" :max="Math.max(w.start + 1, w.end)" :step="1" :show-tooltip="false" :disabled="!w.snapshot" @input="value => w.previewSeek(value as number)" @change="value => w.seekTo(value as number)"/></div></div>
          </section>
          <aside class="right-pane"><TargetInspector :snapshot-id="w.snapshot?.evidenceSnapshotId ?? w.snapshot?.id" :radar="w.radarDisplay" :ais="w.aisCurrent" :selection="w.selection" :inspection="w.inspection" :task="w.task" :candidate-index="w.candidateIndex" :preview-index="w.comparison?.index ?? -1" @select="value => value ? w.selectTarget(value) : w.selection = null" @preview="preview" @evidence="evidenceOpen = true"/></aside>
        </main>
      </template>

      <el-drawer v-model="targetsOpen" title="目标与候选" size="min(370px, 96vw)"><TargetInspector :snapshot-id="w.snapshot?.evidenceSnapshotId ?? w.snapshot?.id" :radar="w.radarDisplay" :ais="w.aisCurrent" :selection="w.selection" :inspection="w.inspection" :task="w.task" :candidate-index="w.candidateIndex" :preview-index="w.comparison?.index ?? -1" @select="value => value ? w.selectTarget(value) : w.selection = null" @preview="preview" @evidence="evidenceOpen = true"/></el-drawer>
      <el-drawer v-model="sourceOpen" title="数据详情" size="min(480px, 96vw)"><el-scrollbar height="100%"><div class="drawer-content"><el-alert v-if="w.project && !w.project.available" :title="w.project.unavailableReason" type="error" :closable="false"/><el-descriptions :column="1" border><el-descriptions-item label="数据源">{{ w.project?.name ?? '—' }}</el-descriptions-item><el-descriptions-item label="匹配组">{{ w.session?.groupName ?? w.group?.name ?? '—' }}</el-descriptions-item><el-descriptions-item label="雷达">{{ w.snapshots.length ? w.snapshots.map((value) => value.dataset.radarId).join('、') : w.group?.radarIds.join('、') ?? '—' }}</el-descriptions-item><el-descriptions-item label="AIS 来源">{{ w.snapshot ? loadedAisSources.join('、') || '—' : w.group?.aisSourceIds.join('、') ?? '—' }}</el-descriptions-item><el-descriptions-item label="时间">{{ w.snapshot ? `${dateLabel(w.start)} ～ ${dateLabel(w.end)}` : '—' }}</el-descriptions-item><el-descriptions-item label="时间语义">{{ w.dataset?.timeSemantics ?? '—' }}</el-descriptions-item><el-descriptions-item label="单位 / 对齐">{{ w.dataset?.unitsVerified ? '已核实' : '待核实' }} / {{ w.dataset?.alignmentVerified ? '已核实' : '待核实' }}</el-descriptions-item><el-descriptions-item v-if="radarConfiguration?.stationId" label="站点">{{ radarConfiguration.stationId }}</el-descriptions-item></el-descriptions><el-collapse><el-collapse-item title="质量与解析统计" name="quality"><ul class="quality-list"><li v-for="value in w.snapshot?.summary.warnings ?? []" :key="value">{{ value }}</li></ul><pre v-if="parseStats" class="raw-view">{{ JSON.stringify(parseStats, null, 2) }}</pre></el-collapse-item><el-collapse-item title="快照与版本" name="snapshot"><p class="mono break">{{ w.snapshot?.hash }}</p><p>{{ w.dataset?.provenance.parserVersion }}</p></el-collapse-item></el-collapse><el-button :loading="w.busy" :disabled="!w.project?.available" @click="w.inspect">只读检查表结构</el-button><pre v-if="w.inspectResult" class="raw-view">{{ JSON.stringify(w.inspectResult, null, 2) }}</pre></div></el-scrollbar></el-drawer>
      <el-drawer v-model="advancedOpen" title="算法设置" size="min(390px, 96vw)"><el-scrollbar height="100%"><div class="drawer-content"><el-form label-position="top"><template v-if="w.fitOptions.refinement"><h3>稳定关联</h3><el-form-item label="最少真实时刻数"><el-input-number v-model="w.fitOptions.refinement.minTrackPoints" :min="2" :max="100" controls-position="right"/></el-form-item><el-form-item label="最短持续时间（ms）"><el-input-number v-model="w.fitOptions.refinement.minTrackDurationMs" :min="1000" :max="300000" :step="1000" controls-position="right"/></el-form-item><el-form-item label="运动容许尺度（m）"><el-input-number v-model="w.fitOptions.refinement.motionToleranceM" :min="1" :max="1000" :step="5" controls-position="right"/></el-form-item><el-divider/></template><el-form-item label="空间粗步长（m）"><el-input-number v-model="w.fitOptions.positionStepM" :min="10" :max="2000" controls-position="right"/></el-form-item><el-form-item label="角度粗步长（°）"><el-input-number v-model="w.fitOptions.angleStepDeg" :min="1" :max="30" controls-position="right"/></el-form-item><el-form-item label="拟合采样上限"><el-input-number v-model="w.fitOptions.maxFitPoints" :min="30" :max="1000" controls-position="right"/></el-form-item><el-form-item label="验证采样上限"><el-input-number v-model="w.fitOptions.maxValidationPoints" :min="15" :max="500" controls-position="right"/></el-form-item><el-form-item label="候选数"><el-input-number v-model="w.fitOptions.keepCandidates" :min="2" :max="12" controls-position="right"/></el-form-item><el-form-item label="EM 迭代上限"><el-input-number v-model="w.fitOptions.maxIterations" :min="3" :max="50" controls-position="right"/></el-form-item><el-divider/><el-form-item label="测距 σ（m）"><el-input-number v-model="w.fitOptions.rangeSigmaM" :min="1" :max="40" controls-position="right"/></el-form-item><el-form-item label="测角 σ（°）"><el-input-number v-model="w.fitOptions.angleSigmaDeg" :min="0.01" :max="2" :step="0.01" controls-position="right"/></el-form-item><el-form-item label="AIS σ 下限（m）"><el-input-number v-model="w.fitOptions.aisSigmaM" :min="1" :max="40" controls-position="right"/></el-form-item><el-form-item label="无尺寸退化 σ（m）"><el-input-number v-model="w.fitOptions.fallbackSigmaM" :min="5" :max="50" controls-position="right"/></el-form-item><el-form-item label="背景先验"><el-input-number v-model="w.fitOptions.backgroundPrior" :min="0.05" :max="0.5" :step="0.05" controls-position="right"/></el-form-item></el-form></div></el-scrollbar></el-drawer>
      <el-dialog v-model="versionOpen" title="保存当前雷达参数" width="460px"><el-form label-width="90px"><el-form-item label="雷达">{{ activeName }}</el-form-item><el-form-item label="版本名称"><el-input v-model="w.versionName" maxlength="100"/></el-form-item><el-form-item label="设为生效"><el-switch v-model="w.enableEffective" :disabled="!canActivate"/></el-form-item><el-form-item v-if="w.enableEffective" label="生效时间"><el-date-picker v-model="w.effectiveFrom" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss.SSS" :clearable="false"/></el-form-item></el-form><template #footer><el-button @click="versionOpen = false">取消</el-button><el-button type="primary" :loading="w.busy" @click="saveVersion">保存</el-button></template></el-dialog>
      <el-drawer v-model="evidenceOpen" title="标定证据" size="min(1120px, 96vw)"><TaskResults v-if="w.task?.result" :task="w.task" :selected-index="w.comparison?.index ?? w.candidateIndex" :preview-index="w.comparison?.index ?? -1" @preview="preview"/><el-empty v-else description="暂无结果"/></el-drawer>
      <el-drawer v-model="historyOpen" title="查询与标定历史" size="min(860px, 96vw)"><el-tabs v-model="historyTab" class="history-tabs"><el-tab-pane label="匹配会话" name="sessions"><el-table :data="w.sessions" height="100%" empty-text="暂无匹配会话"><el-table-column prop="groupName" label="匹配组" min-width="180"/><el-table-column label="时间" min-width="160"><template #default="{ row }">{{ dateLabel(row.createdAt) }}</template></el-table-column><el-table-column label="雷达" min-width="160"><template #default="{ row }">{{ row.radarIds.join('、') }}</template></el-table-column><el-table-column label="数据" min-width="100"><template #default="{ row }">{{ row.mode === 'windowed' ? '按原条件完整读取' : availabilityLabel[row.availability] ?? '—' }}</template></el-table-column><el-table-column width="72"><template #default="{ row }"><el-button link type="primary" @click="openSession(row.id)">打开</el-button></template></el-table-column></el-table></el-tab-pane><el-tab-pane label="单雷达记录" name="snapshots"><el-table :data="w.recent" height="100%" empty-text="暂无快照"><el-table-column prop="name" label="名称" min-width="220"/><el-table-column prop="radarId" label="雷达" min-width="120"/><el-table-column label="时间" min-width="165"><template #default="{ row }">{{ dateLabel(row.createdAt) }}</template></el-table-column><el-table-column label="数据" min-width="100"><template #default="{ row }">{{ row.mode === 'windowed' ? '按原条件完整读取' : availabilityLabel[row.availability] ?? '—' }}</template></el-table-column><el-table-column width="72"><template #default="{ row }"><el-button link type="primary" @click="openSnapshot(row.id)">打开</el-button></template></el-table-column></el-table></el-tab-pane><el-tab-pane label="标定任务" name="tasks"><el-table :data="w.taskHistory" height="100%" empty-text="暂无任务"><el-table-column prop="radarId" label="雷达"/><el-table-column label="创建时间" min-width="165"><template #default="{ row }">{{ dateLabel(row.createdAt) }}</template></el-table-column><el-table-column label="状态"><template #default="{ row }">{{ statusLabel[row.status] }}</template></el-table-column><el-table-column width="72"><template #default="{ row }"><el-button link type="primary" @click="openTask(row.id)">打开</el-button></template></el-table-column></el-table></el-tab-pane></el-tabs><el-button v-if="w.historyCursors[historyTab] || historyTab === 'sessions' && w.historyCursors.playbacks" :loading="w.busy" @click="moreHistory">加载更多</el-button></el-drawer>
    </div>
  </el-config-provider>
</template>
