<script setup lang="ts">
import { computed } from 'vue';
import type { ParameterComparison } from '../types';
import { meters, signed } from '../api';
import { normalizeAngle } from '../../shared/geo.js';

const props = defineProps<{ comparison: ParameterComparison }>();
const emit = defineEmits<{ apply: []; close: [] }>();
const rows = computed(() => {
  const { current, candidate, delta } = props.comparison;
  return [
    { name: '经度', current: current.lng.toFixed(7), candidate: candidate.lng.toFixed(7), delta: signed(delta.lngDeg, 7) },
    { name: '纬度', current: current.lat.toFixed(7), candidate: candidate.lat.toFixed(7), delta: signed(delta.latDeg, 7) },
    { name: '朝向', current: normalizeAngle(current.bearingOffsetDeg).toFixed(3), candidate: normalizeAngle(candidate.bearingOffsetDeg).toFixed(3), delta: signed(delta.bearingDeg, 3) },
  ];
});
</script>

<template>
  <section class="parameter-comparison" aria-label="候选与当前参数对比">
    <div class="comparison-heading"><strong>候选 {{ comparison.index + 1 }} 对比</strong><span class="comparison-current-legend">当前参数</span><span class="comparison-candidate-legend">预览候选</span><div class="row-actions"><el-button type="primary" @click="emit('apply')">使用候选</el-button><el-button @click="emit('close')">结束对比</el-button></div></div>
    <div class="comparison-values"><table class="mono"><thead><tr><th>参数（°）</th><th>当前</th><th>候选</th><th>候选 − 当前</th></tr></thead><tbody><tr v-for="row in rows" :key="row.name"><th>{{ row.name }}</th><td>{{ row.current }}</td><td>{{ row.candidate }}</td><td>{{ row.delta }}</td></tr></tbody></table></div>
    <div class="comparison-displacement">位置相距 {{ meters(comparison.delta.distanceM) }} · 东 {{ signed(comparison.delta.eastM) }} m · 北 {{ signed(comparison.delta.northM) }} m</div>
  </section>
</template>
