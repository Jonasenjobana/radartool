<script setup lang="ts">
import { computed, ref } from 'vue';
import { Close, Document } from '@element-plus/icons-vue';
import type { Task } from '../../shared/types';
import type { AisDisplay, RadarDisplay, Selection } from '../types';
import { api, assessmentLabel, dateLabel, meters, percent, timeLabel } from '../api';
import { shipReferenceKnown } from '../shipGeometry';

const props = defineProps<{ radar: RadarDisplay[]; ais: AisDisplay[]; selection: Selection | null; inspection: RadarDisplay | AisDisplay | null; task: Task | null; candidateIndex: number; previewIndex?: number; snapshotId?: string }>();
const emit = defineEmits<{ select: [selection: Selection | null]; preview: [index: number]; evidence: [] }>();
const tab = ref('targets'); const targetKind = ref('radar'); const rawOpen = ref(false);
const candidateRows = computed(() => props.task?.result?.candidates.map((candidate, index) => ({ ...candidate, index })) ?? []);
const selectedRadar = computed(() => props.inspection && 'observation' in props.inspection ? props.inspection : null);
const selectedAis = computed(() => props.inspection && 'mmsi' in props.inspection ? props.inspection : null);
const dimensions = computed(() => selectedAis.value?.dimensions);
const referenceKnown = computed(() => !!dimensions.value && shipReferenceKnown(dimensions.value));
const raw = computed(() => selectedRadar.value?.observation.raw ?? selectedAis.value?.raw ?? {});
const rawValue = ref<unknown>(null); const rawLoading = ref(false); const rawError = ref('');
async function openRaw() {
  rawOpen.value = true; rawError.value = ''; rawValue.value = null;
  const reference = raw.value.evidenceRef as { snapshotId: string; snapshotIds?: string[]; kind: string; id: string; playbackId?: string } | undefined;
  if (!reference) { rawValue.value = raw.value; return; }
  rawLoading.value = true;
  const snapshotId = props.snapshotId && reference.snapshotIds?.includes(props.snapshotId) ? props.snapshotId : reference.snapshotId;
  try { rawValue.value = (await api<{ raw: unknown }>(`/snapshots/${encodeURIComponent(snapshotId)}/observations/${reference.kind}/${encodeURIComponent(reference.id)}${reference.playbackId ? `?playbackId=${encodeURIComponent(reference.playbackId)}` : ''}`)).raw; }
  catch (reason) { rawError.value = reason instanceof Error ? reason.message : String(reason); }
  finally { rawLoading.value = false; }
}
function selectRadar(row: RadarDisplay) { emit('select', { kind: 'radar', id: row.key }); }
function selectAis(row: AisDisplay) { emit('select', { kind: 'ais', id: row.mmsi }); }
</script>

<template>
  <div class="target-inspector">
    <el-tabs v-model="tab" class="inspector-tabs">
      <el-tab-pane label="目标" name="targets">
        <div v-if="inspection" class="target-summary">
          <div class="section-line"><strong>{{ selectedRadar?.observation.trackId ?? selectedAis?.mmsi }}</strong><div><el-button link :icon="Document" aria-label="查看原始观测" @click="openRaw"/><el-button link :icon="Close" aria-label="取消选择" @click="emit('select', null)"/></div></div>
          <el-descriptions v-if="selectedRadar" :column="1" size="small"><el-descriptions-item label="雷达">{{ selectedRadar.radarName }}</el-descriptions-item><el-descriptions-item label="观测时间">{{ timeLabel(selectedRadar.observation.eventTime, true) }}</el-descriptions-item><el-descriptions-item :label="selectedRadar.interpolated ? '候选位置（插值）' : '候选位置'"><span class="mono">{{ selectedRadar.candidate.lng.toFixed(7) }}, {{ selectedRadar.candidate.lat.toFixed(7) }}</span></el-descriptions-item><el-descriptions-item label="原始距离 / 方位">{{ meters(selectedRadar.observation.rangeM) }} / {{ selectedRadar.observation.azimuthDeg.toFixed(2) }}°</el-descriptions-item><el-descriptions-item label="AIS">{{ selectedRadar.association.ship?.mmsi ?? '—' }}</el-descriptions-item><el-descriptions-item label="关联 / 背景">{{ percent(selectedRadar.association.probability) }} / {{ percent(selectedRadar.association.background) }}</el-descriptions-item><el-descriptions-item label="包络残差">{{ meters(selectedRadar.association.residual) }}</el-descriptions-item></el-descriptions>
          <el-descriptions v-else-if="selectedAis" :column="1" size="small">
            <el-descriptions-item label="上报位置时间">{{ timeLabel(selectedAis.eventTime, true) }}</el-descriptions-item>
            <el-descriptions-item :label="selectedAis.interpolated ? '回放定位点（插值）' : '回放定位点'"><span class="mono">{{ selectedAis.displayPosition.lng.toFixed(7) }}, {{ selectedAis.displayPosition.lat.toFixed(7) }}</span></el-descriptions-item>
            <el-descriptions-item label="AIS 长 × 宽">{{ dimensions ? `${meters(dimensions.bow + dimensions.stern)} × ${meters(dimensions.port + dimensions.starboard)}` : '—' }}</el-descriptions-item>
            <el-descriptions-item v-if="dimensions" label="定位点至艏 / 艉">{{ referenceKnown ? `${meters(dimensions.bow)} / ${meters(dimensions.stern)}` : '未提供参考点偏移' }}</el-descriptions-item>
            <el-descriptions-item v-if="dimensions" label="定位点至左 / 右舷">{{ referenceKnown ? `${meters(dimensions.port)} / ${meters(dimensions.starboard)}` : '未提供参考点偏移' }}</el-descriptions-item>
            <el-descriptions-item v-if="selectedAis.dimensionReport" label="尺寸报文">点击补查 · {{ dateLabel(selectedAis.dimensionReport.eventTime) }}</el-descriptions-item>
            <el-descriptions-item v-if="selectedAis.dimensionReport" label="尺寸来源">{{ selectedAis.dimensionReport.sourceId }} · 消息 {{ selectedAis.dimensionReport.messageType }}</el-descriptions-item>
            <el-descriptions-item label="来源">{{ selectedAis.sourceIds.join('、') }}</el-descriptions-item>
            <el-descriptions-item label="船艏向">{{ selectedAis.headingDeg == null ? '—' : `${selectedAis.headingDeg.toFixed(1)}°` }}</el-descriptions-item>
            <el-descriptions-item label="COG / SOG">{{ selectedAis.cogDeg == null ? '—' : `${selectedAis.cogDeg.toFixed(1)}°` }} / {{ selectedAis.sogKnots == null ? '—' : `${selectedAis.sogKnots.toFixed(1)} kn` }}</el-descriptions-item>
          </el-descriptions>
        </div>
        <div class="target-kind"><el-radio-group v-model="targetKind" size="small"><el-radio-button value="radar">雷达 {{ radar.length }}</el-radio-button><el-radio-button value="ais">AIS {{ ais.length }}</el-radio-button></el-radio-group></div>
        <el-table v-if="targetKind === 'radar'" :data="radar" height="100%" size="small" highlight-current-row row-key="key" empty-text="当前无雷达目标" @row-click="selectRadar"><el-table-column label="目标" min-width="125"><template #default="{ row }"><div class="target-label"><i :style="{ background: row.color }"/><span>{{ row.observation.trackId }}</span></div><span class="table-secondary">{{ row.radarName }}</span></template></el-table-column><el-table-column label="AIS / 后验" min-width="128"><template #default="{ row }"><span v-if="row.association.probability >= 0.55">{{ row.association.ship?.mmsi }}<br><span class="table-secondary">{{ percent(row.association.probability) }}</span></span><span v-else class="muted">未关联</span></template></el-table-column></el-table>
        <el-table v-else :data="ais" height="100%" size="small" highlight-current-row row-key="mmsi" empty-text="当前无 AIS 目标" @row-click="selectAis"><el-table-column label="MMSI / 上报时间" min-width="125"><template #default="{ row }">{{ row.mmsi }}<br><span class="table-secondary">{{ timeLabel(row.eventTime) }}</span></template></el-table-column><el-table-column label="来源" min-width="140"><template #default="{ row }">{{ row.sourceIds.join('、') }}</template></el-table-column></el-table>
      </el-tab-pane>
      <el-tab-pane label="候选" name="candidates">
        <template v-if="task?.result"><div class="candidate-header"><el-tag :type="task.result.assessment === 'recommended' ? 'success' : 'warning'" size="small">{{ assessmentLabel[task.result.assessment] }}</el-tag><el-button link @click="emit('evidence')">详细证据</el-button></div><el-table :data="candidateRows" row-key="index" highlight-current-row :current-row-key="(previewIndex ?? -1) >= 0 ? previewIndex : candidateIndex" @row-click="row => emit('preview', row.index)" height="100%" size="small" empty-text="暂无候选"><el-table-column label="#" width="42"><template #default="{ $index }">{{ $index + 1 }}</template></el-table-column><el-table-column label="朝向" min-width="80"><template #default="{ row }">{{ row.parameters.bearingOffsetDeg.toFixed(2) }}°</template></el-table-column><el-table-column label="验证支持" min-width="85"><template #default="{ row }">{{ percent(row.validation.support) }}</template></el-table-column><el-table-column label="" width="66"><template #default="{ $index }"><el-button link type="primary" @click.stop="emit('preview', $index)">{{ previewIndex === $index ? '对比中' : candidateIndex === $index ? '当前' : '对比' }}</el-button></template></el-table-column></el-table><div class="candidate-reasons"><el-scrollbar max-height="120px"><p v-for="reason in task.result.reasons" :key="reason">{{ reason }}</p></el-scrollbar></div></template>
        <el-empty v-else description="暂无标定候选" :image-size="70"/>
      </el-tab-pane>
    </el-tabs>
    <el-drawer v-model="rawOpen" title="原始观测" size="min(560px, 94vw)" append-to-body><el-scrollbar height="100%"><p v-if="rawLoading">读取原始观测…</p><el-alert v-else-if="rawError" :title="rawError" type="error" :closable="false"/><pre v-else class="raw-view">{{ JSON.stringify(rawValue, null, 2) }}</pre></el-scrollbar></el-drawer>
  </div>
</template>
