<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import * as L from 'leaflet';
import type { Bounds, GeographicBounds, Parameters, Position } from '../../shared/types';
import type { AisDisplay, MapMode, ParameterComparison, RadarDisplay, RefinementMap, Selection, Trail } from '../types';
import { signed, timeLabel } from '../api';
import { enuToWgs84, geographicBounds, normalizeAngle, wgs84ToEnu } from '../../shared/geo.js';
import { shipOutline, shipReferenceKnown } from '../shipGeometry';

const props = defineProps<{
  reference: Position; parameters: Parameters; baseline: Parameters; bounds: Bounds; roi: Bounds | null;
  queryArea: GeographicBounds | null; editable: boolean; disabled: boolean;
  radar: RadarDisplay[]; ais: AisDisplay[]; trails: Trail[];
  aisTrails: { mmsi: string; points: Position[] }[];
  extent: Position[]; selection: Selection | null; mode: MapMode;
  showBaseline: boolean; showCandidate: boolean; showStored: boolean; showLinks: boolean; showTiles: boolean;
  otherStations: { id: string; name: string; parameters: Parameters; color: string }[];
  comparison?: ParameterComparison | null;
  localSearch?: boolean; radarExclusion?: Bounds | null; refinement?: RefinementMap | null;
}>();
const emit = defineEmits<{
  parameters: [value: Parameters]; bounds: [value: Bounds, mode: MapMode]; queryArea: [value: GeographicBounds]; select: [selection: Selection | null]; mode: [value: MapMode]; activate: [radarId: string];
  clearExclusion: [];
}>();
const container = ref<HTMLElement>();
const tileError = ref(false);
const drawing = ref(false);
const colors = { ais: '#187c70', candidate: '#df7730', comparison: '#0c8ca0', baseline: '#627b9c', stored: '#a084ab' };
const shipOutlineZoom = 16;
let map: L.Map | undefined;
let vectors: L.LayerGroup;
let areas: L.LayerGroup;
let grid: L.LayerGroup;
let tiles: L.TileLayer | undefined;
let candidateMarker: L.Marker;
let rotationMarker: L.Marker;
let directionLine: L.Polyline;
let stationLayer: L.LayerGroup;
let observer: ResizeObserver | undefined;
let firstCorner: L.LatLng | null = null;
let pendingRectangle: L.Rectangle | undefined;
let pointerId: number | null = null;
let draggingStation = false;
let draggingRotation = false;
const latLng = (position: Position): L.LatLngTuple => [position.lat, position.lng];

function label(text: string) { const element = document.createElement('span'); element.textContent = text; return element; }
function selectRadar(point: RadarDisplay) { emit('select', { kind: 'radar', id: point.key }); }
function shipSelected(mmsi: string) { return props.selection?.kind === 'ais' && props.selection.id === mmsi; }
function radarSelected(key: string) { return props.selection?.kind === 'radar' && props.selection.id === key; }
function followSelection() {
  if (!map || props.mode !== 'view' || !props.selection || draggingStation || draggingRotation) return;
  const selected = props.selection;
  let position: Position | null | undefined;
  if (selected.kind === 'ais') position = props.ais.find((ship) => ship.mmsi === selected.id)?.displayPosition;
  else {
    const point = props.radar.find((value) => value.key === selected.id);
    if (point) position = props.showCandidate ? point.candidate : props.showBaseline ? point.baseline : props.showStored ? point.stored : null;
  }
  // 保留一像素容差，避免平移结束后因坐标舍入反复居中。
  if (position && map.latLngToContainerPoint(latLng(position)).distanceTo(map.getSize().divideBy(2)) > 1) map.panTo(latLng(position), { animate: false });
}

function rectangle(bounds: Bounds, color: string, dashed = false) {
  const coordinates = [[bounds.minEast, bounds.minNorth], [bounds.maxEast, bounds.minNorth], [bounds.maxEast, bounds.maxNorth], [bounds.minEast, bounds.maxNorth]].map(([east, north]) => latLng(enuToWgs84({ east, north }, props.reference)));
  return L.polygon(coordinates, { color, weight: 1.5, fillOpacity: 0.04, dashArray: dashed ? '5 5' : undefined, interactive: false });
}

function updateAreas() {
  if (!map) return;
  areas.clearLayers();
  if (props.editable) rectangle(props.bounds, '#4779b5', true).addTo(areas).bindTooltip(label(props.localSearch ? '局部安装范围' : '安装点搜索区'), { permanent: true, direction: 'top', className: 'area-label', offset: [0, -10] });
  if (props.editable && props.roi) rectangle(props.roi, '#837147').addTo(areas).bindTooltip(label('拟合 AIS 区域'), { permanent: true, direction: 'bottom', className: 'area-label' });
  if (props.editable && props.radarExclusion) rectangle(props.radarExclusion, '#b55348').addTo(areas).bindTooltip(label('雷达排除区域'), { permanent: true, direction: 'bottom', className: 'area-label' });
  if (props.queryArea) {
    const { south, west, north, east } = props.queryArea;
    L.rectangle([[south, west], [north, east]], { color: colors.ais, weight: 1.5, fillOpacity: 0.06, interactive: false }).addTo(areas).bindTooltip(label('AIS 查询区域'), { permanent: true, direction: 'top', className: 'area-label' });
  }
}

function updateStation() {
  if (!map) return;
  if (!props.editable) { stationLayer.remove(); return; }
  if (!map.hasLayer(stationLayer)) stationLayer.addTo(map);
  if (!draggingStation) candidateMarker.setLatLng(latLng(props.parameters));
  const origin = wgs84ToEnu(props.parameters, props.reference);
  const radians = props.parameters.bearingOffsetDeg * Math.PI / 180;
  const metres = 65 * map.getZoomScale(15, map.getZoom());
  const handle = enuToWgs84({ east: origin.east + metres * Math.sin(radians), north: origin.north + metres * Math.cos(radians) }, props.reference);
  if (!draggingRotation) rotationMarker.setLatLng(latLng(handle));
  directionLine.setLatLngs([latLng(props.parameters), latLng(handle)]);
}

function comparisonPoints(value: ParameterComparison): L.LatLngTuple[] {
  // 把候选放在当前参数邻近的世界副本，跨日期变更线时也只定位到局部范围。
  return [latLng(value.current), [value.candidate.lat, value.current.lng + value.delta.lngDeg]];
}
function comparisonEnd(origin: L.LatLngTuple, bearing: number) {
  const point = map!.latLngToContainerPoint(origin); const radians = bearing * Math.PI / 180;
  return map!.containerPointToLatLng([point.x + 80 * Math.sin(radians), point.y - 80 * Math.cos(radians)]);
}
function drawComparison() {
  if (!map || !props.comparison) return;
  const value = props.comparison; const points = comparisonPoints(value);
  const stations = [
    { point: points[0], bearing: value.current.bearingOffsetDeg, color: colors.candidate, caption: '当前', direction: 'top' as const },
    { point: points[1], bearing: value.candidate.bearingOffsetDeg, color: colors.comparison, caption: `候选 ${value.index + 1}`, direction: 'bottom' as const },
  ];
  stations.forEach((station, index) => {
    L.circleMarker(station.point, { color: station.color, weight: 2, radius: index === 0 ? 11 : 7, fillOpacity: 0, interactive: false }).addTo(vectors).bindTooltip(label(`${station.caption} · ${normalizeAngle(station.bearing).toFixed(3)}°`), { permanent: true, direction: station.direction, offset: [0, index === 0 ? -12 : 12] });
    const end = comparisonEnd(station.point, station.bearing);
    L.polyline([station.point, end], { color: station.color, weight: 3, interactive: false }).addTo(vectors);
    const icon = L.divIcon({ className: 'comparison-heading-tip', html: `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1 L11 11 L7 9 L3 11 Z" fill="${station.color}" transform="rotate(${normalizeAngle(station.bearing)} 7 7)"/></svg>`, iconSize: [14, 14], iconAnchor: [7, 7] });
    L.marker(end, { icon, keyboard: false, interactive: false }).addTo(vectors);
  });
  L.polyline(points, { color: '#526570', weight: 2, dashArray: '5 4', interactive: false }).addTo(vectors);
  const middle: L.LatLngTuple = [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2];
  L.tooltip({ permanent: true, direction: 'bottom', offset: [0, 36], className: 'comparison-map-label' }).setLatLng(middle).setContent(label(`位置差 ${value.delta.distanceM.toFixed(2)} m · 朝向差 ${signed(value.delta.bearingDeg, 3)}°`)).addTo(vectors);
}
function focusComparison() {
  if (!map || !props.comparison) return;
  const size = map.getSize();
  map.fitBounds(L.latLngBounds(comparisonPoints(props.comparison)), { padding: [Math.min(120, size.x / 4), Math.min(80, size.y / 4)], maxZoom: 19, animate: false });
}
function drawRefinement() {
  if (!props.refinement) return;
  const tracks = new Map<string, RefinementMap['points']>();
  for (const point of props.refinement.points) {
    const points = tracks.get(point.associationId) ?? []; points.push(point); tracks.set(point.associationId, points);
    const selected = point.associationId === props.refinement.focusedId;
    L.circleMarker(latLng(point.radar), { color: colors.candidate, radius: selected ? 4 : 2.5, weight: 1, fillOpacity: 0.9 }).addTo(vectors).bindTooltip(label(`${point.trackId} → ${point.mmsi} · ${timeLabel(point.timeMs, true)}`));
    // 检查线直接使用共享筛选器固定的同刻船舶，不再执行概率重关联。
    L.polyline([latLng(point.radar), latLng(point.ais)], { color: colors.ais, weight: selected ? 1.5 : 0.7, dashArray: '3 5', opacity: selected ? 0.85 : 0.35, interactive: false }).addTo(vectors);
  }
  for (const points of tracks.values()) {
    points.sort((a, b) => a.timeMs - b.timeMs);
    const selected = points[0].associationId === props.refinement.focusedId;
    if (points.length > 1) {
      L.polyline(points.map(point => latLng(point.radar)), { color: colors.candidate, weight: selected ? 3 : 1.5, opacity: 0.8, interactive: false }).addTo(vectors);
      L.polyline(points.map(point => latLng(point.ais)), { color: colors.ais, weight: selected ? 3 : 1.5, opacity: 0.6, interactive: false }).addTo(vectors);
    }
  }
}
function focusRefinement() {
  if (!map || !props.refinement) return;
  const points = props.refinement.points.filter(point => !props.refinement!.focusedId || point.associationId === props.refinement!.focusedId).flatMap(point => [latLng(point.radar), latLng(point.ais)]);
  if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [50, 50], maxZoom: 18, animate: false });
}
function redraw() {
  if (!map) return;
  vectors.clearLayers();
  for (const station of props.otherStations) L.circleMarker(latLng(station.parameters), { color: station.color, fillColor: '#fff', fillOpacity: 1, weight: 2, radius: 7 }).addTo(vectors).bindTooltip(label(station.name)).on('click', () => emit('activate', station.id));
  if (props.editable && !props.comparison) L.circleMarker(latLng(props.baseline), { color: colors.baseline, fillColor: '#fff', fillOpacity: 1, weight: 2, radius: 6 }).addTo(vectors).bindTooltip(label('对比参数安装点'));
  for (const trail of props.trails) {
    const selected = radarSelected(trail.key);
    if (props.showBaseline && trail.baseline.length > 1) L.polyline(trail.baseline.map(latLng), { color: colors.baseline, weight: 1, opacity: selected ? 0.8 : 0.3, dashArray: '3 4', interactive: false }).addTo(vectors);
    if (props.showCandidate && trail.candidate.length > 1) L.polyline(trail.candidate.map(latLng), { color: trail.color, weight: selected ? 3 : 1.4, opacity: selected ? 0.9 : 0.45, interactive: false }).addTo(vectors);
    if (props.showStored && trail.stored.length > 1) L.polyline(trail.stored.map(latLng), { color: colors.stored, weight: 1, dashArray: '2 4', opacity: 0.5, interactive: false }).addTo(vectors);
  }
  for (const trail of props.aisTrails) {
    if (trail.points.length > 1) L.polyline(trail.points.map(latLng), { color: colors.ais, weight: shipSelected(trail.mmsi) ? 3 : 1.5, opacity: 0.5, interactive: false }).addTo(vectors);
  }
  const aisPositions = new Map(props.ais.map((ship) => [ship.mmsi, ship.displayPosition]));
  for (const point of props.radar) {
    const selected = radarSelected(point.key);
    if (props.showBaseline) L.circleMarker(latLng(point.baseline), { radius: 3, color: colors.baseline, weight: 1, fillOpacity: 0.25 }).addTo(vectors).on('click', () => selectRadar(point));
    if (props.showStored && point.stored) L.circleMarker(latLng(point.stored), { radius: 4, color: colors.stored, weight: 1, fillOpacity: 0 }).addTo(vectors).on('click', () => selectRadar(point));
    if (props.showCandidate) {
      const marker = L.circleMarker(latLng(point.candidate), { radius: selected ? 6 : 3.5, color: point.color, weight: selected ? 2 : 1, fillColor: point.color, fillOpacity: 0.9 }).addTo(vectors);
      marker.on('click', () => selectRadar(point));
      marker.bindTooltip(label(`${point.radarName} · ${point.observation.trackId}`));
    }
    if ((props.showLinks || selected) && point.association.probability >= 0.55 && point.association.ship) {
      const position = aisPositions.get(point.association.ship.mmsi);
      if (position) L.polyline([latLng(point.candidate), latLng(position)], { color: colors.ais, weight: selected ? 1.7 : 0.7, dashArray: '3 5', opacity: 0.65, interactive: false }).addTo(vectors);
    }
  }
  for (const ship of props.ais.slice(0, 2000)) {
    const selected = shipSelected(ship.mmsi);
    // 仅在显示层用有效 COG 回退朝向，不回写真实船艏向。
    const heading = ship.headingDeg ?? (ship.cogDeg != null && ship.cogDeg >= 0 && ship.cogDeg < 360 ? ship.cogDeg : null);
    const dims = ship.dimensions;
    const toScale = map.getZoom() >= shipOutlineZoom && dims != null && heading != null && shipReferenceKnown(dims);
    if (toScale) {
      L.polygon(shipOutline(ship.displayPosition, dims, heading).map(latLng), { color: colors.ais, weight: selected ? 2 : 1.5, fillOpacity: selected ? 0.12 : 0.04 }).addTo(vectors).on('click', () => emit('select', { kind: 'ais', id: ship.mmsi })).bindTooltip(label(`${ship.mmsi} · ${dims.bow + dims.stern} × ${dims.port + dims.starboard} m`));
    }
    const size = toScale || heading == null ? 12 : 18;
    const rotation = heading == null ? '' : ` style="transform:rotate(${heading}deg)"`;
    const icon = L.divIcon({ className: `ais-symbol${toScale ? ' to-scale' : ''}${selected ? ' selected' : ''}`, html: toScale || heading == null ? '<span class="ais-dot"></span>' : `<span class="ais-arrow"${rotation}></span><span class="ais-anchor-dot"></span>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    L.marker(latLng(ship.displayPosition), { icon, keyboard: true, title: `AIS 定位参考点 ${ship.mmsi}` }).addTo(vectors).on('click', () => emit('select', { kind: 'ais', id: ship.mmsi })).bindTooltip(label(`${ship.mmsi} · AIS定位点`), { permanent: selected, direction: 'top', offset: [0, -8] });
  }
  drawRefinement(); drawComparison(); updateStation();
  followSelection();
}

function updateTiles() {
  if (!map) return;
  if (tiles) { map.removeLayer(tiles); tiles = undefined; }
  tileError.value = false;
  if (props.showTiles) {
    tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
    tiles.on('tileerror', () => { tileError.value = true; });
    tiles.addTo(map);
  }
}

function clearDrawing() {
  firstCorner = null; drawing.value = false;
  pendingRectangle?.remove(); pendingRectangle = undefined;
  if (pointerId != null && container.value?.hasPointerCapture(pointerId)) container.value.releasePointerCapture(pointerId);
  pointerId = null;
}
function drawingEvent(event: PointerEvent) { event.preventDefault(); event.stopImmediatePropagation(); }
function startDrawing(event: PointerEvent) {
  if (!map || props.disabled || props.mode === 'view' || event.button !== 0 || (event.target as HTMLElement).closest('.leaflet-control')) return;
  drawingEvent(event);
  pointerId = event.pointerId; container.value!.setPointerCapture(pointerId);
  firstCorner = map.mouseEventToLatLng(event); drawing.value = true;
  pendingRectangle = L.rectangle(L.latLngBounds(firstCorner, firstCorner), { color: props.mode === 'query' ? colors.ais : props.mode === 'exclusion' ? '#b55348' : '#4779b5', weight: 1.5, fillOpacity: 0.1, interactive: false }).addTo(map);
}
function moveDrawing(event: PointerEvent) {
  if (!map || !firstCorner || pointerId !== event.pointerId) return;
  drawingEvent(event);
  pendingRectangle!.setBounds(L.latLngBounds(firstCorner, map.mouseEventToLatLng(event)));
}
function finishDrawing(event: PointerEvent) {
  if (!map || !firstCorner || pointerId !== event.pointerId) return;
  drawingEvent(event);
  const corner = firstCorner; const end = map.mouseEventToLatLng(event);
  const a = map.latLngToContainerPoint(corner); const b = map.latLngToContainerPoint(end);
  clearDrawing();
  if (Math.abs(a.x - b.x) < 3 || Math.abs(a.y - b.y) < 3) return;
  if (props.mode === 'query') emit('queryArea', geographicBounds(corner, end));
  else {
    const from = wgs84ToEnu(corner, props.reference); const to = wgs84ToEnu(end, props.reference);
    emit('bounds', { minEast: Math.min(from.east, to.east), maxEast: Math.max(from.east, to.east), minNorth: Math.min(from.north, to.north), maxNorth: Math.max(from.north, to.north) }, props.mode);
  }
}
function updateMode() {
  clearDrawing();
  if (!map) return;
  if (props.mode === 'view') { map.dragging.enable(); map.boxZoom.enable(); map.doubleClickZoom.enable(); }
  else { map.dragging.disable(); map.boxZoom.disable(); map.doubleClickZoom.disable(); }
  if (props.mode === 'view' && !props.disabled) { candidateMarker.dragging?.enable(); rotationMarker.dragging?.enable(); }
  else { candidateMarker.dragging?.disable(); rotationMarker.dragging?.disable(); }
  followSelection();
}
function keydown(event: KeyboardEvent) { if (event.key === 'Escape') { clearDrawing(); emit('mode', 'view'); } }
async function fitAll() { emit('select', null); await nextTick(); if (map && props.extent.length) map.fitBounds(L.latLngBounds(props.extent.map(latLng)), { padding: [60, 60], maxZoom: 16 }); }

onMounted(() => {
  map = L.map(container.value!, { center: latLng(props.reference), zoom: 14, preferCanvas: true, zoomControl: false });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);
  grid = L.layerGroup().addTo(map);
  for (let i = -6000; i <= 6000; i += 500) {
    for (const horizontal of [true, false]) L.polyline([-6000, 6000].map((other) => latLng(enuToWgs84(horizontal ? { east: other, north: i } : { east: i, north: other }, props.reference))), { color: '#6f8f9b', weight: i === 0 ? 1 : 0.5, opacity: i === 0 ? 0.2 : 0.1, interactive: false }).addTo(grid);
  }
  areas = L.layerGroup().addTo(map);
  vectors = L.layerGroup().addTo(map);
  const stationIcon = L.divIcon({ className: 'station-marker', html: '<span>R</span>', iconSize: [28, 28], iconAnchor: [14, 14] });
  candidateMarker = L.marker(latLng(props.parameters), { icon: stationIcon, draggable: true, title: '拖动雷达安装点', zIndexOffset: 1000 });
  rotationMarker = L.marker(latLng(props.parameters), { icon: L.divIcon({ className: 'rotation-marker', html: '↻', iconSize: [23, 23], iconAnchor: [11.5, 11.5] }), draggable: true, title: '拖动旋转北向偏差', zIndexOffset: 1001 });
  directionLine = L.polyline([], { color: '#155d75', weight: 1.5, dashArray: '4 3', interactive: false });
  stationLayer = L.layerGroup([candidateMarker, rotationMarker, directionLine]);
  candidateMarker.on('dragstart', () => { draggingStation = true; });
  candidateMarker.on('drag', () => { const p = candidateMarker.getLatLng(); emit('parameters', { lng: p.lng, lat: p.lat, bearingOffsetDeg: props.parameters.bearingOffsetDeg }); });
  candidateMarker.on('dragend', () => { draggingStation = false; updateStation(); followSelection(); });
  rotationMarker.on('dragstart', () => { draggingRotation = true; });
  rotationMarker.on('drag', () => {
    const current = rotationMarker.getLatLng();
    const target = wgs84ToEnu({ lng: current.lng, lat: current.lat }, props.reference);
    const origin = wgs84ToEnu(props.parameters, props.reference);
    emit('parameters', { ...props.parameters, bearingOffsetDeg: normalizeAngle(Math.atan2(target.east - origin.east, target.north - origin.north) * 180 / Math.PI) });
  });
  rotationMarker.on('dragend', () => { draggingRotation = false; updateStation(); followSelection(); });
  map.on('zoomend', redraw);
  map.on('moveend', followSelection);
  container.value!.addEventListener('pointerdown', startDrawing, true);
  container.value!.addEventListener('pointermove', moveDrawing, true);
  container.value!.addEventListener('pointerup', finishDrawing, true);
  container.value!.addEventListener('pointercancel', clearDrawing);
  observer = new ResizeObserver(() => { map?.invalidateSize({ pan: false }); followSelection(); }); observer.observe(container.value!);
  window.addEventListener('keydown', keydown);
  updateTiles(); updateAreas(); redraw(); updateMode(); if (props.comparison) focusComparison(); else fitAll();
});
watch(() => props.showTiles, updateTiles);
watch([() => props.bounds, () => props.roi, () => props.queryArea, () => props.editable, () => props.radarExclusion, () => props.localSearch], updateAreas, { deep: true });
watch([() => props.parameters, () => props.baseline, () => props.radar, () => props.ais, () => props.trails, () => props.aisTrails, () => props.otherStations, () => props.selection, () => props.showBaseline, () => props.showCandidate, () => props.showStored, () => props.showLinks, () => props.comparison, () => props.refinement], redraw, { deep: false });
watch(() => props.refinement?.focusSequence, async () => { await nextTick(); focusRefinement(); });
watch(() => props.comparison?.key, async () => { await nextTick(); if (props.comparison) { map?.invalidateSize({ pan: false }); focusComparison(); } });
watch([() => props.mode, () => props.disabled], updateMode);
onUnmounted(() => { clearDrawing(); observer?.disconnect(); window.removeEventListener('keydown', keydown); container.value?.removeEventListener('pointerdown', startDrawing, true); container.value?.removeEventListener('pointermove', moveDrawing, true); container.value?.removeEventListener('pointerup', finishDrawing, true); container.value?.removeEventListener('pointercancel', clearDrawing); map?.remove(); map = undefined; });
</script>

<template>
  <div class="map-shell">
    <div ref="container" class="map-canvas" :class="{ drawing: mode !== 'view' }" aria-label="雷达 AIS 轨迹与安装参数地图"></div>
    <div class="map-tools">
      <el-button-group><el-button v-if="!localSearch" size="small" :disabled="!editable || disabled" :type="mode === 'search' ? 'primary' : 'default'" @click="emit('mode', mode === 'search' ? 'view' : 'search')">安装搜索区</el-button><el-button size="small" :disabled="!editable || disabled" :type="mode === 'roi' ? 'primary' : 'default'" @click="emit('mode', mode === 'roi' ? 'view' : 'roi')">拟合 AIS 区域</el-button><el-button size="small" :disabled="!editable || disabled" :type="mode === 'exclusion' ? 'primary' : 'default'" @click="emit('mode', mode === 'exclusion' ? 'view' : 'exclusion')">雷达排除区域</el-button><el-button v-if="radarExclusion" size="small" :disabled="disabled" @click="emit('clearExclusion')">清除排除区</el-button><el-button size="small" @click="fitAll">全域</el-button></el-button-group>
    </div>
    <div v-if="mode !== 'view'" class="map-instruction" role="status">{{ mode === 'query' ? 'AIS 查询区域' : mode === 'search' ? '安装点搜索区' : mode === 'exclusion' ? '雷达排除区域' : '拟合 AIS 区域' }} · {{ drawing ? '松开完成' : '按住拖动画框' }} · Esc 取消</div>
    <div v-if="tileError" class="tile-error" role="status">底图加载失败，轨迹与标定仍可使用。</div>
    <div class="north-indicator" aria-label="北向朝上"><span>↑</span>N</div>
  </div>
</template>
