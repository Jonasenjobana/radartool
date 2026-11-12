<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Task } from '../../shared/types';
import { assessmentLabel, dateLabel, meters, percent, signed } from '../api';
import { angleDifference } from '../../shared/geo.js';
const props = defineProps<{ task: Task; selectedIndex: number; previewIndex?: number }>();
const emit = defineEmits<{ preview: [index: number] }>();
const tab = ref('candidates'); const dimension = ref('船舶');
const result = computed(() => props.task.result);
const candidateRows = computed(() => {
  const rows = result.value?.candidates.map((candidate, index) => ({ ...candidate, index })) ?? [];
  const initial = result.value?.options.refinement?.initial; const metrics = result.value?.initialMetrics;
  return initial && metrics ? [{ parameters: initial, ...metrics, index: -1 }, ...rows] : rows;
});
const candidate = computed(() => result.value?.candidates[Math.max(0, props.selectedIndex)]);
const validationLabel = computed(() => result.value?.validationReused ? '复用验证' : '独立验证');
const heat = computed(() => {
  const data = result.value?.heatmap ?? []; if (!data.length || !result.value) return [];
  const min = Math.min(...data.map((point) => point.score)); const max = Math.max(...data.map((point) => point.score));
  const bounds = result.value.options.bounds; const columns = new Set(data.map((point) => point.east)).size; const rows = new Set(data.map((point) => point.north)).size;
  return data.map((point) => ({ ...point, x: 20 + (point.east - bounds.minEast) / (bounds.maxEast - bounds.minEast) * 180, y: 190 - (point.north - bounds.minNorth) / (bounds.maxNorth - bounds.minNorth) * 170, width: 180 / Math.max(1, columns - 1), height: 170 / Math.max(1, rows - 1), opacity: 0.08 + 0.92 * (point.score - min) / Math.max(1e-10, max - min) }));
});
const angleRange = computed(() => {
  const refinement = result.value?.options.refinement;
  return refinement ? { min: -refinement.maxBearingShiftDeg, max: refinement.maxBearingShiftDeg, caption: `相对人工初值 ${refinement.initial.bearingOffsetDeg.toFixed(3)}°`, start: `${signed(-refinement.maxBearingShiftDeg, 1)}°`, end: `${signed(refinement.maxBearingShiftDeg, 1)}°` } : { min: 0, max: 360, caption: '完整角度', start: '0°', end: '360°' };
});
const profile = computed(() => {
  const data = result.value?.angleProfile ?? []; if (!data.length) return '';
  const min = Math.min(...data.map((point) => point.score)); const max = Math.max(...data.map((point) => point.score));
  const initial = result.value?.options.refinement?.initial;
  return data.map(point => ({ ...point, offset: initial ? angleDifference(point.angle, initial.bearingOffsetDeg) : point.angle })).sort((a, b) => a.offset - b.offset).map(point => `${20 + (point.offset - angleRange.value.min) / (angleRange.value.max - angleRange.value.min) * 190},${180 - (point.score - min) / Math.max(1e-10, max - min) * 150}`).join(' ');
});
</script>

<template>
  <div v-if="result" class="evidence-panel">
    <el-alert v-if="result.evidenceScope === 'summary'" title="当前保留结果摘要，粗搜索图未持久化。完整证据请在任务结果仍可用时导出或归档。" type="info" :closable="false"/><div class="evidence-toolbar"><el-tag :type="result.assessment === 'recommended' ? 'success' : 'warning'">{{ assessmentLabel[result.assessment] }}</el-tag><span>{{ validationLabel }} · {{ dateLabel(result.splitTime) }}</span><el-button tag="a" :href="`/api/tasks/${task.id}/export`" download>导出证据</el-button></div>
    <el-tabs v-model="tab" class="evidence-tabs">
      <el-tab-pane label="候选对比" name="candidates">
        <div v-if="result.initialMetrics" class="evidence-input-summary">人工初值与候选使用同一批保留时段观测 · 原始雷达 {{ result.exclusions.totalRadarPoints }} · 筛选保留 {{ result.exclusions.retainedTrainingPoints }} / {{ result.exclusions.retainedValidationPoints }}（拟合 / 验证）</div>
        <el-table :data="candidateRows" row-key="index" highlight-current-row :current-row-key="selectedIndex >= 0 ? selectedIndex : undefined" @row-click="row => row.index >= 0 && emit('preview', row.index)" height="100%" size="small"><el-table-column label="参数" width="60"><template #default="{ row }">{{ row.index < 0 ? '人工初值' : row.index + 1 }}</template></el-table-column><el-table-column label="经纬度" min-width="155"><template #default="{ row }"><span class="mono">{{ row.parameters.lng.toFixed(7) }}<br>{{ row.parameters.lat.toFixed(7) }}</span></template></el-table-column><el-table-column label="朝向" min-width="90"><template #default="{ row }">{{ row.parameters.bearingOffsetDeg.toFixed(3) }}°</template></el-table-column><el-table-column label="拟合 / 验证点数" min-width="120"><template #default="{ row }">{{ row.training.points }} / {{ row.validation.points }}</template></el-table-column><el-table-column label="拟合 / 验证支持" min-width="145"><template #default="{ row }">{{ percent(row.training.support) }} / {{ percent(row.validation.support) }}</template></el-table-column><el-table-column label="拟合 / 验证背景" min-width="145"><template #default="{ row }">{{ percent(row.training.background) }} / {{ percent(row.validation.background) }}</template></el-table-column><el-table-column label="拟合 / 验证 P90" min-width="145"><template #default="{ row }">{{ meters(row.training.residualP90) }} / {{ meters(row.validation.residualP90) }}</template></el-table-column><el-table-column label="" width="80" fixed="right"><template #default="{ row }"><el-button v-if="row.index >= 0" link type="primary" @click.stop="emit('preview', row.index)">{{ previewIndex === row.index ? '对比中' : selectedIndex === row.index ? '当前' : '对比' }}</el-button></template></el-table-column></el-table>
      </el-tab-pane>
      <el-tab-pane label="分组残差" name="residuals"><div class="table-toolbar"><el-select v-model="dimension" aria-label="残差分组维度" style="width: 130px"><el-option v-for="value in ['船舶', '距离', '方位', '时段']" :key="value" :value="value" :label="value"/></el-select><span>{{ validationLabel }}</span></div><el-table :data="candidate?.validation.groups.filter((group) => group.dimension === dimension) ?? []" height="100%"><el-table-column label="分组" min-width="200"><template #default="{ row }">{{ dimension === '时段' ? dateLabel(row.key) : row.key }}</template></el-table-column><el-table-column prop="points" label="总点数"/><el-table-column prop="matched" label="关联点数"/><el-table-column label="背景后验"><template #default="{ row }">{{ percent(row.background) }}</template></el-table-column><el-table-column label="包络 P90"><template #default="{ row }">{{ meters(row.p90) }}</template></el-table-column></el-table></el-tab-pane>
      <el-tab-pane label="粗搜索评分" name="scores"><el-scrollbar height="100%"><div class="result-charts"><figure><figcaption>安装位置</figcaption><svg viewBox="0 0 230 220" role="img" aria-label="安装位置粗搜索评分"><rect x="10" y="10" width="205" height="190" fill="#eff3f5"/><rect v-for="(point, index) in heat" :key="index" :x="point.x - point.width / 2" :y="point.y - point.height / 2" :width="point.width + 0.5" :height="point.height + 0.5" fill="#187c70" :opacity="point.opacity"><title>{{ point.east.toFixed(1) }}, {{ point.north.toFixed(1) }} · {{ point.score.toFixed(4) }}</title></rect><text x="110" y="215" text-anchor="middle">East →</text><text x="15" y="17">North ↑</text></svg></figure><figure><figcaption>{{ angleRange.caption }}</figcaption><svg viewBox="0 0 230 215" role="img" aria-label="角度粗评分剖面"><path d="M20 20 V180 H215" fill="none" stroke="#b4c1c8"/><polyline :points="profile" fill="none" stroke="#187c70" stroke-width="2"/><text x="20" y="200">{{ angleRange.start }}</text><text x="210" y="200" text-anchor="end">{{ angleRange.end }}</text></svg></figure></div><p class="muted">粗网格分数用于比较候选，不表示统计置信区间。</p></el-scrollbar></el-tab-pane>
      <el-tab-pane label="复现信息" name="metadata"><el-scrollbar height="100%"><el-descriptions :column="1" border><el-descriptions-item label="模型">{{ result.modelVersion }}</el-descriptions-item><el-descriptions-item label="采样">{{ result.samplingVersion }}</el-descriptions-item><el-descriptions-item label="快照 SHA-256"><span class="mono break">{{ result.snapshotHash }}</span></el-descriptions-item><el-descriptions-item label="拟合 / 验证点数">{{ candidate?.training.points }} / {{ candidate?.validation.points }}</el-descriptions-item><el-descriptions-item v-if="result.options.refinement" label="精调筛选"><p>原始雷达 {{ result.exclusions.totalRadarPoints }}；保留拟合 {{ result.exclusions.retainedTrainingPoints }} / 验证 {{ result.exclusions.retainedValidationPoints }}</p><p>排除框 {{ result.exclusions.radarExclusionPoints }} · 未靠近 {{ result.exclusions.notNearbyPoints }} · 不稳定 {{ result.exclusions.unstablePoints }} · 人工剔除 {{ result.exclusions.manuallyExcludedPoints }} · 无法区分 {{ result.exclusions.ambiguousPoints }}</p></el-descriptions-item><el-descriptions-item label="超出 30 km 的 AIS 观测数">{{ result.exclusions.outsideLocalAisPoints ?? '—' }}</el-descriptions-item><el-descriptions-item label="评分次数">{{ result.evaluations.toLocaleString() }}</el-descriptions-item><el-descriptions-item label="评估"><p v-for="reason in result.reasons" :key="reason">{{ reason }}</p></el-descriptions-item><el-descriptions-item label="排除 / 降级"><pre class="raw-view">{{ JSON.stringify(result.exclusions, null, 2) }}</pre></el-descriptions-item></el-descriptions></el-scrollbar></el-tab-pane>
    </el-tabs>
  </div>
</template>
