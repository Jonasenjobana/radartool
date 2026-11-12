import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { api, fromInputTime, post, toInputTime } from './api';
import type { AisObservation, Bounds, FitOptions, GeographicBounds, AisDimensionReport, AisDimensionsResponse, MatchGroup, ParameterVersion, Parameters, Position, Project, QuerySession, RadarObservation, RefinementOptions, RefinementSelection, SessionBundle, Snapshot, Task, WindowPlayback } from '../shared/types';
import type { AisDisplay, AisState, MapMode, ParameterComparison, RadarDisplay, RefinementMap, Selection, Trail } from './types';
import { DEFAULT_FIT_OPTIONS, DEFAULT_REFINEMENT_OPTIONS, fitOptionsSchema } from '../shared/data.js';
import { aisAtTime, createAisIndex, createAisStaticIndex, latestAisAtTime } from '../shared/alignment.js';
import { mergeAisObservations } from '../shared/session.js';
import { enuToWgs84, inBounds, moveParameters, normalizeAngle, parameterDifference, polarToEnu, wgs84ToEnu } from '../shared/geo.js';
import { associateObservation } from '../shared/model.js';
import { selectRefinementObservations } from '../shared/refinement.js';

export type RecentSnapshot = Omit<Snapshot, 'dataset'> & { name: string; projectId: string; radarId: string; aisSourceIds: string[]; queryArea?: GeographicBounds | null; configVersion?: string | null };
interface RadarDraft { parameters: Parameters; baselineVersion: string; fitOptions: FitOptions; versions: ParameterVersion[]; task: Task | null }
interface PlaybackSample<T> { observation: T; next: T | undefined; fraction: number }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const colors = ['#d77b2c', '#426fc0', '#8661ad', '#af7938', '#37879a', '#b15d74', '#617f39', '#6f6b95'];
function lowerBound(points: { timeMs: number }[], time: number) {
  let lo = 0; let hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].timeMs <= time) lo = mid + 1; else hi = mid; }
  return lo;
}
function playbackSample<T extends { timeMs: number }>(points: T[], time: number): PlaybackSample<T> | null {
  const index = lowerBound(points, time); const observation = points[index - 1]; const next = points[index];
  if (!observation) return null;
  return { observation, next, fraction: next ? (time - observation.timeMs) / (next.timeMs - observation.timeMs) : 0 };
}
function interpolateEnu(from: { east: number; north: number }, to: { east: number; north: number } | undefined, fraction: number) {
  return to && fraction > 0 ? { east: from.east + (to.east - from.east) * fraction, north: from.north + (to.north - from.north) * fraction } : from;
}
function radarPosition(sample: PlaybackSample<RadarObservation>, parameters: Parameters, reference: Position): Position {
  const from = polarToEnu(sample.observation, parameters, reference);
  const to = sample.next ? polarToEnu(sample.next, parameters, reference) : undefined;
  return enuToWgs84(interpolateEnu(from, to, sample.fraction), reference);
}
function storedPosition(sample: PlaybackSample<RadarObservation>, reference: Position): Position | null {
  const from = sample.observation.storedPosition; const to = sample.next?.storedPosition;
  if (!from) return null;
  return to && sample.fraction > 0 ? enuToWgs84(interpolateEnu(wgs84ToEnu(from, reference), wgs84ToEnu(to, reference), sample.fraction), reference) : from;
}
function trailSamples<T extends { timeMs: number }>(points: T[], start: number, end: number, limit: number): PlaybackSample<T>[] {
  const last = playbackSample(points, end);
  if (!last) return [];
  if (limit < 2) return [last];
  const first = playbackSample(points, start); const samples = first ? [first] : [];
  const from = lowerBound(points, start); const to = lowerBound(points, end);
  const step = Math.max(1, Math.ceil((to - from) / Math.max(1, limit - 2)));
  for (let index = from; index < to && samples.length < limit - 1; index += step) samples.push({ observation: points[index], next: undefined, fraction: 0 });
  samples.push(last);
  return samples;
}
function defaultOptions(data: Snapshot['dataset']): FitOptions {
  const origin = wgs84ToEnu(data.baseline, data.reference);
  return { ...copy(DEFAULT_FIT_OPTIONS), refinement: defaultRefinement(data.baseline), bounds: { minEast: origin.east - 250, maxEast: origin.east + 250, minNorth: origin.north - 250, maxNorth: origin.north + 250 } };
}
function defaultRefinement(initial: Parameters): RefinementOptions {
  return { ...copy(DEFAULT_REFINEMENT_OPTIONS), initial: { ...initial } };
}
function workbenchOptions(options: FitOptions, parameters: Parameters): FitOptions {
  return { ...copy(options), refinement: options.refinement ? copy(options.refinement) : defaultRefinement(parameters) };
}

export function useWorkbench() {
  const projects = shallowRef<Project[]>([]); const groups = shallowRef<MatchGroup[]>([]);
  const groupId = ref(''); const projectId = ref(''); const radarId = ref('');
  const queryStart = ref(''); const queryEnd = ref('');
  const queryArea = ref<GeographicBounds | null>(null);
  const recent = shallowRef<RecentSnapshot[]>([]); const sessions = shallowRef<QuerySession[]>([]);
  const historyCursors = ref<Record<string, string | null>>({ snapshots: null, sessions: null, tasks: null });
  const session = shallowRef<QuerySession | null>(null); const snapshots = shallowRef<Snapshot[]>([]);
  const snapshot = shallowRef<Snapshot | null>(null); const drafts = shallowRef<Record<string, RadarDraft>>({});
  const taskHistory = shallowRef<Task[]>([]); const task = shallowRef<Task | null>(null);
  const comparisonChoice = shallowRef<{ taskId: string; index: number; sequence: number } | null>(null); let comparisonSequence = 0;
  const versions = shallowRef<ParameterVersion[]>([]);
  const error = ref(''); const notice = ref(''); const busy = ref(false);
  const preparationId = ref<string | null>(null);
  const seekPreview = ref<number | null>(null);
  const parameters = ref<Parameters>({ lng: 0, lat: 0, bearingOffsetDeg: 0 }); const baselineVersion = ref('snapshot');
  const cursor = ref(0); const playing = ref(false); const speed = ref(10); const trailSeconds = ref(60);
  const selection = ref<Selection | null>(null); const mapMode = ref<MapMode>('view');
  const dimensionReports = shallowRef<Record<string, AisDimensionReport>>({});
  const fitOptions = ref<FitOptions>({ ...copy(DEFAULT_FIT_OPTIONS), refinement: defaultRefinement(parameters.value) });
  const refinementPreview = shallowRef<RefinementSelection | null>(null);
  const refinementCheck = shallowRef<{ fingerprint: string; snapshotId: string; options: FitOptions } | null>(null);
  const selectedAssociationIds = ref<string[]>([]); const refinementChecking = ref(false);
  const showOriginalRadar = ref(false); const refinementFocus = ref<{ id: string; sequence: number } | null>(null); let refinementFocusSequence = 0;
  let refinementGeneration = 0;
  const showBaseline = ref(false); const showCandidate = ref(true); const showTrails = ref(true);
  const showStored = ref(true); const showLinks = ref(false); const showTiles = ref(true);
  const visibleRadarIds = ref<string[]>([]); const panel = ref('manual');
  const versionName = ref(''); const enableEffective = ref(false); const effectiveFrom = ref('');
  const inspectResult = ref<unknown>(null);
  const group = computed(() => groups.value.find((value) => value.id === groupId.value));
  const project = computed(() => projects.value.find((value) => value.id === projectId.value));
  const dataset = computed(() => snapshot.value?.dataset ?? null);
  const start = computed(() => snapshots.value.length ? Math.min(...snapshots.value.map((value) => value.summary.start)) : 0);
  const end = computed(() => snapshots.value.length ? Math.max(...snapshots.value.map((value) => value.summary.end)) - 1 : 1);
  const playbackFrames = computed(() => {
    const times = new Set<number>();
    for (const value of snapshots.value) for (const points of [value.dataset.radar, value.dataset.ais, value.dataset.aisStatic ?? []]) for (const point of points) times.add(point.timeMs);
    return [...times].sort((a, b) => a - b).map((timeMs) => ({ timeMs }));
  });
  const fitError = computed(() => { const result = fitOptionsSchema.safeParse(fitOptions.value); return result.success ? '' : result.error.issues[0].message; });
  const refinementFingerprint = computed(() => JSON.stringify({ snapshotId: snapshot.value?.id, hash: snapshot.value?.hash, radarId: radarId.value, sessionId: session.value?.id, groupId: groupId.value, projectId: projectId.value, queryStart: queryStart.value, queryEnd: queryEnd.value, queryArea: queryArea.value, parameters: parameters.value, options: fitOptions.value }));
  const refinementValid = computed(() => !!refinementCheck.value && refinementCheck.value.fingerprint === refinementFingerprint.value && refinementCheck.value.snapshotId === snapshot.value?.id);
  function invalidateRefinement() {
    refinementGeneration++; refinementCheck.value = null; refinementPreview.value = null; selectedAssociationIds.value = [];
    refinementFocus.value = null; showOriginalRadar.value = false;
  }
  // 同步观察输入指纹，覆盖地图赋值、v-model 和改回原值；播放与人工取舍不在指纹内。
  watch([refinementFingerprint, dataset], invalidateRefinement, { flush: 'sync' });
  const refinementBounds = computed<Bounds>(() => {
    const origin = dataset.value ? wgs84ToEnu(parameters.value, dataset.value.reference) : { east: 0, north: 0 };
    const shift = fitOptions.value.refinement?.maxPositionShiftM ?? DEFAULT_REFINEMENT_OPTIONS.maxPositionShiftM;
    return { minEast: origin.east - shift, maxEast: origin.east + shift, minNorth: origin.north - shift, maxNorth: origin.north + shift };
  });
  const retainedRefinement = computed<RefinementSelection | null>(() => {
    if (!refinementValid.value || !dataset.value || !selectedAssociationIds.value.length) return null;
    const options = { ...refinementCheck.value!.options, refinement: { ...refinementCheck.value!.options.refinement!, associationIds: [...selectedAssociationIds.value] } };
    return selectRefinementObservations(dataset.value, options) as RefinementSelection;
  });
  const refinementMap = computed<RefinementMap | null>(() => {
    if (showOriginalRadar.value || !refinementValid.value || !visibleRadarIds.value.includes(radarId.value)) return null;
    const focusedId = refinementFocus.value && selectedAssociationIds.value.includes(refinementFocus.value.id) ? refinementFocus.value.id : null;
    const retained = retainedRefinement.value?.training ?? [];
    const rows = focusedId ? retained.filter(row => row.associationId === focusedId) : retained;
    const step = Math.max(1, Math.ceil(rows.length / 2000));
    const initial = refinementCheck.value!.options.refinement!.initial;
    return { focusedId, focusSequence: refinementFocus.value?.sequence ?? 0, points: rows.filter((_, index) => index % step === 0).map(row => ({ associationId: row.associationId, observationId: row.observation.id, trackId: row.observation.trackId, mmsi: row.ship.mmsi, timeMs: row.observation.timeMs, radar: enuToWgs84(polarToEnu(row.observation, initial, dataset.value!.reference), dataset.value!.reference), ais: row.ship.position })) };
  });
  function focusRefinementAssociation(id: string) {
    if (!refinementValid.value || !selectedAssociationIds.value.includes(id)) return;
    showOriginalRadar.value = false; refinementFocus.value = { id, sequence: ++refinementFocusSequence }; selection.value = null; mapMode.value = 'view';
  }
  function resolvedBaseline(value: Snapshot, draft: RadarDraft | undefined) {
    const choice = value.id === snapshot.value?.id ? baselineVersion.value : draft?.baselineVersion ?? 'snapshot';
    const available = value.id === snapshot.value?.id ? versions.value : draft?.versions ?? [];
    if (choice === 'effective') {
      const selected = available.filter((version) => version.effectiveFrom && Date.parse(version.effectiveFrom) <= cursor.value).sort((a, b) => Date.parse(b.effectiveFrom!) - Date.parse(a.effectiveFrom!))[0];
      if (selected) return selected.parameters;
    }
    return available.find((version) => version.id === choice)?.parameters ?? value.dataset.baseline;
  }
  const baseline = computed(() => snapshot.value ? resolvedBaseline(snapshot.value, drafts.value[snapshot.value.id]) : parameters.value);
  const baselineName = computed(() => baselineVersion.value === 'effective' ? '按生效时间' : versions.value.find((version) => version.id === baselineVersion.value)?.name ?? '快照参考值');
  function settings(value: Snapshot) {
    const active = value.id === snapshot.value?.id;
    const draft = drafts.value[value.id];
    return { parameters: active ? parameters.value : draft?.parameters ?? value.dataset.baseline, options: active ? fitOptions.value : draft?.fitOptions ?? defaultOptions(value.dataset), baseline: resolvedBaseline(value, draft) };
  }
  const contexts = computed(() => snapshots.value.map((value, index) => {
    const tracks = new Map<string, RadarObservation[]>();
    for (const point of value.dataset.radar) { const key = `${point.deviceId}:${point.trackId}`; const track = tracks.get(key) ?? []; track.push(point); tracks.set(key, track); }
    return { snapshot: value, tracks, ais: createAisIndex(value.dataset), maxRange: value.dataset.radar.reduce((max, point) => Math.max(max, point.rangeM), 1), color: colors[index % colors.length] };
  }));
  const radarMembers = computed(() => contexts.value.map((context) => ({ id: context.snapshot.dataset.radarId, name: (context.snapshot.dataset.provenance.radarConfiguration as Project['radars'][number] | undefined)?.name ?? projects.value.find((p) => p.id === context.snapshot.dataset.projectId)?.radars.find((radar) => radar.id === context.snapshot.dataset.radarId)?.name ?? context.snapshot.dataset.radarId, points: context.snapshot.summary.radarPoints, color: context.color })));
  const radarOptions = computed(() => {
    if (snapshots.value.length) return radarMembers.value;
    // 加载前允许先选组内雷达，选项不依赖观测到达。
    return (group.value?.radarIds ?? []).flatMap((id) => {
      const radar = project.value?.radars.find((value) => value.id === id);
      return radar ? [{ id: radar.id, name: radar.name }] : [];
    });
  });
  const mergedAis = computed(() => mergeAisObservations(snapshots.value) as AisObservation[]);
  const aisIndex = computed(() => dataset.value ? createAisIndex({ reference: dataset.value.reference, ais: mergedAis.value }) : new Map());
  const aisStaticIndex = computed(() => createAisStaticIndex(snapshots.value.flatMap((value) => value.dataset.aisStatic ?? [])));
  const aisCurrent = computed<AisDisplay[]>(() => (latestAisAtTime(aisIndex.value, cursor.value, aisStaticIndex.value) as AisState[]).map((point) => {
    const sample = playbackSample(aisIndex.value.get(point.mmsi) as AisState[], cursor.value)!;
    const interpolated = sample.fraction > 0;
    const dimensionReport = point.sourceIds.map((sourceId) => dimensionReports.value[`${sourceId}:${point.mmsi}`]).filter((report): report is AisDimensionReport => !!report).sort((a, b) => Date.parse(b.eventTime) - Date.parse(a.eventTime))[0];
    return { ...point, dimensions: dimensionReport?.dimensions ?? point.dimensions, dimensionReport, interpolated, displayPosition: interpolated ? enuToWgs84(interpolateEnu(point, sample.next, sample.fraction), dataset.value!.reference) : point.position };
  }));
  const radarCurrent = computed(() => {
    const result: (PlaybackSample<RadarObservation> & { key: string; context: typeof contexts.value[number] })[] = [];
    for (const context of contexts.value) {
      if (!visibleRadarIds.value.includes(context.snapshot.dataset.radarId)) continue;
      const config = settings(context.snapshot);
      for (const [key, points] of context.tracks) {
        const sample = playbackSample(points, cursor.value);
        if (sample && (sample.next || cursor.value - sample.observation.timeMs <= Math.max(5000, config.options.maxGapMs))) result.push({ ...sample, key, context });
      }
    }
    return result;
  });
  const radarDisplay = computed<RadarDisplay[]>(() => {
    const perRadar = Math.max(1, Math.floor(2000 / Math.max(1, visibleRadarIds.value.length)));
    const counts = new Map<string, number>();
    return radarCurrent.value.filter(({ observation }) => { const count = counts.get(observation.deviceId) ?? 0; counts.set(observation.deviceId, count + 1); return count < perRadar; }).map(({ key, observation, next, fraction, context }) => {
      const value = context.snapshot; const data = value.dataset; const config = settings(value); const parsed = fitOptionsSchema.safeParse(config.options); const options = parsed.success ? parsed.data : config.options;
      const region = { minEast: options.bounds.minEast - context.maxRange - 1, maxEast: options.bounds.maxEast + context.maxRange + 1, minNorth: options.bounds.minNorth - context.maxRange - 1, maxNorth: options.bounds.maxNorth + context.maxRange + 1 };
      const area = (region.maxEast - region.minEast) * (region.maxNorth - region.minNorth);
      let states = aisAtTime(context.ais, observation.timeMs, options.maxGapMs) as AisState[];
      if (options.roi) states = states.filter((state) => inBounds(state, options.roi!));
      const valid = parsed.success;
      const association = valid ? associateObservation(observation, states, config.parameters, data.reference, { ...options, backgroundDensity: 1 / area }) : { position: polarToEnu(observation, config.parameters, data.reference), ship: null, probability: 0, background: 1, residual: null };
      if (!inBounds(association.position, region)) Object.assign(association, { ship: null, probability: 0, background: 1, residual: null, outsideStudy: true });
      const sample = { observation, next, fraction };
      return { key, observation, association, radarId: data.radarId, radarName: radarMembers.value.find((member) => member.id === data.radarId)?.name ?? data.radarId, color: context.color, candidate: radarPosition(sample, config.parameters, data.reference), baseline: radarPosition(sample, config.baseline, data.reference), stored: storedPosition(sample, data.reference), interpolated: fraction > 0 };
    });
  });
  const trails = computed<Trail[]>(() => {
    const result: Trail[] = []; let remaining = 12000;
    if (!showTrails.value) return result;
    for (const context of contexts.value) {
      if (!visibleRadarIds.value.includes(context.snapshot.dataset.radarId)) continue;
      const config = settings(context.snapshot); const reference = context.snapshot.dataset.reference;
      for (const [key, points] of context.tracks) {
        if (remaining <= 0) break;
        const samples = trailSamples(points, cursor.value - trailSeconds.value * 1000, cursor.value, Math.min(300, remaining)); remaining -= samples.length;
        if (samples.length) result.push({ key, color: context.color, candidate: samples.map((sample) => radarPosition(sample, config.parameters, reference)), baseline: samples.map((sample) => radarPosition(sample, config.baseline, reference)), stored: samples.flatMap((sample) => { const position = storedPosition(sample, reference); return position ? [position] : []; }) });
      }
    }
    return result;
  });
  const mapRadar = computed(() => refinementMap.value ? radarDisplay.value.filter(point => point.radarId !== radarId.value) : radarDisplay.value);
  const mapTrails = computed(() => {
    if (!refinementMap.value) return trails.value;
    const activeTracks = contexts.value.find(context => context.snapshot.id === snapshot.value?.id)?.tracks;
    return trails.value.filter(trail => !activeTracks?.has(trail.key));
  });
  const aisTrails = computed(() => {
    const result: { mmsi: string; points: Position[] }[] = []; let remaining = 12000;
    if (!showTrails.value) return result;
    for (const [mmsi, points] of aisIndex.value) {
      if (remaining <= 0) break;
      const samples = trailSamples(points as AisState[], cursor.value - trailSeconds.value * 1000, cursor.value, Math.min(300, remaining)); remaining -= samples.length;
      result.push({ mmsi, points: samples.map((sample) => sample.fraction > 0 ? enuToWgs84(interpolateEnu(sample.observation, sample.next, sample.fraction), dataset.value!.reference) : sample.observation.position) });
    }
    return result;
  });
  const otherStations = computed(() => contexts.value.filter((context) => context.snapshot.id !== snapshot.value?.id && visibleRadarIds.value.includes(context.snapshot.dataset.radarId)).map((context) => ({ id: context.snapshot.dataset.radarId, name: radarMembers.value.find((member) => member.id === context.snapshot.dataset.radarId)?.name ?? context.snapshot.dataset.radarId, parameters: settings(context.snapshot).parameters, color: context.color })));
  const inspection = computed(() => selection.value?.kind === 'radar' ? radarDisplay.value.find((point) => point.key === selection.value!.id) ?? null : selection.value?.kind === 'ais' ? aisCurrent.value.find((point) => point.mmsi === selection.value!.id) ?? null : null);
  const currentMatches = computed(() => radarDisplay.value.filter((point) => point.association.probability >= 0.55).length);
  const candidateIndex = computed(() => !task.value?.result || task.value.snapshotId !== snapshot.value?.id ? -1 : task.value.result.candidates.findIndex((candidate) => Math.abs(candidate.parameters.lng - parameters.value.lng) < 1e-10 && Math.abs(candidate.parameters.lat - parameters.value.lat) < 1e-10 && Math.abs(candidate.parameters.bearingOffsetDeg - normalizeAngle(parameters.value.bearingOffsetDeg)) < 1e-8));
  const comparison = computed<ParameterComparison | null>(() => {
    const choice = comparisonChoice.value; const activeTask = task.value;
    if (!choice || !dataset.value || !activeTask || choice.taskId !== activeTask.id || activeTask.snapshotId !== snapshot.value?.id) return null;
    const candidate = activeTask.result?.candidates[choice.index]?.parameters;
    return candidate ? { key: `${activeTask.id}:${choice.sequence}`, index: choice.index, current: parameters.value, candidate, delta: parameterDifference(parameters.value, candidate, dataset.value.reference) } : null;
  });
  const canFit = computed(() => !fitError.value && !!dataset.value?.unitsVerified && dataset.value.alignmentVerified && dataset.value.timeSemantics !== 'unverified' && !!dataset.value.radar.length && !!dataset.value.ais.length);
  const canStartFit = computed(() => canFit.value && refinementValid.value && selectedAssociationIds.value.length > 0 && selectedAssociationIds.value.every(id => refinementPreview.value?.associations.some(row => row.id === id)));
  const runningTask = computed(() => taskHistory.value.find((value) => value.status === 'running') ?? (task.value?.status === 'running' ? task.value : null));
  const offset = computed(() => { if (!dataset.value) return { east: 0, north: 0, distance: 0 }; const a = wgs84ToEnu(parameters.value, dataset.value.reference); const b = wgs84ToEnu(baseline.value, dataset.value.reference); return { east: a.east - b.east, north: a.north - b.north, distance: Math.hypot(a.east - b.east, a.north - b.north) }; });

  function stash() {
    if (snapshot.value) drafts.value = { ...drafts.value, [snapshot.value.id]: { parameters: { ...parameters.value }, baselineVersion: baselineVersion.value, fitOptions: copy(fitOptions.value), versions: versions.value, task: task.value } };
  }
  async function guarded(action: () => Promise<void>) {
    if (busy.value) return;
    busy.value = true; error.value = ''; notice.value = '';
    try { await action(); } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
    finally { busy.value = false; }
  }
  async function refreshLists() {
    const filter = projectId.value ? `?projectId=${encodeURIComponent(projectId.value)}` : '';
    const [snapshots, history, savedSessions, playbacks] = await Promise.all([api<RecentSnapshot[]>(`/snapshots${filter}`), api<Task[]>(`/tasks${filter}`), api<QuerySession[]>(`/sessions${filter}`), api<QuerySession[]>(`/playbacks${filter}`)]);
    recent.value = snapshots; taskHistory.value = history; sessions.value = [...playbacks, ...savedSessions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    historyCursors.value = Object.fromEntries([['snapshots', snapshots], ['tasks', history], ['sessions', savedSessions], ['playbacks', playbacks]].map(([kind, values]) => [kind, (values as unknown as { nextCursor?: string }).nextCursor ?? null]));
  }
  async function moreHistory(kind: 'snapshots' | 'sessions' | 'tasks') {
    const filter = projectId.value ? '&projectId=' + encodeURIComponent(projectId.value) : '';
    const next = historyCursors.value[kind]; const nextWindows = kind === 'sessions' ? historyCursors.value.playbacks : null;
    if (!next && !nextWindows) return;
    await guarded(async () => {
      if (kind === 'sessions') {
        const [whole, windows] = await Promise.all([
          next ? api<QuerySession[]>('/sessions?cursor=' + encodeURIComponent(next) + filter) : Promise.resolve([] as QuerySession[]),
          nextWindows ? api<WindowPlayback[]>('/playbacks?cursor=' + encodeURIComponent(nextWindows) + filter) : Promise.resolve([] as WindowPlayback[]),
        ]);
        sessions.value = [...sessions.value, ...whole, ...windows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        if (next) historyCursors.value.sessions = (whole as unknown as { nextCursor?: string }).nextCursor ?? null;
        if (nextWindows) historyCursors.value.playbacks = (windows as unknown as { nextCursor?: string }).nextCursor ?? null;
      } else {
        const page = await api<(RecentSnapshot | Task)[]>('/' + kind + '?cursor=' + encodeURIComponent(next!) + filter);
        if (kind === 'snapshots') recent.value = [...recent.value, ...page as RecentSnapshot[]]; else taskHistory.value = [...taskHistory.value, ...page as Task[]];
        historyCursors.value[kind] = (page as unknown as { nextCursor?: string }).nextCursor ?? null;
      }
    });
  }
  async function activateRadarInternal(id: string) {
    const value = snapshots.value.find((entry) => entry.dataset.radarId === id);
    if (!value || value.id === snapshot.value?.id) return;
    stash(); comparisonChoice.value = null; snapshot.value = value; radarId.value = id; selection.value = null; mapMode.value = 'view';
    const draft = drafts.value[value.id];
    parameters.value = { ...(draft?.parameters ?? value.dataset.baseline) }; fitOptions.value = draft ? copy(draft.fitOptions) : defaultOptions(value.dataset);
    baselineVersion.value = draft?.baselineVersion ?? 'snapshot'; versions.value = draft?.versions ?? []; task.value = draft?.task ?? null;
    versionName.value = ''; enableEffective.value = false; effectiveFrom.value = toInputTime(cursor.value);
    const base = `/versions?projectId=${encodeURIComponent(value.dataset.projectId)}&radarId=${encodeURIComponent(id)}`;
    const saved: ParameterVersion[] = []; let next: string | null = null;
    do { const page: ParameterVersion[] = await api<ParameterVersion[]>(base + (next ? `&cursor=${encodeURIComponent(next)}` : '')); saved.push(...page); next = (page as unknown as { nextCursor?: string }).nextCursor ?? null; } while (next);
    if (snapshot.value?.id === value.id) versions.value = saved;
  }
  async function activateRadar(id: string) {
    await guarded(async () => {
      if (!snapshots.value.length) { if (radarOptions.value.some((radar) => radar.id === id)) radarId.value = id; return; }
      await activateRadarInternal(id);
    });
  }
  async function setSnapshots(values: Snapshot[], savedSession: QuerySession | null = null) {
    invalidateRefinement(); const generation = refinementGeneration;
    const preferredRadar = radarId.value;
    const previous = session.value?.id ?? snapshot.value?.id;
    if (previous && !values.length) {
      await post(`/${session.value ? 'sessions' : 'snapshots'}/${previous}/release`, {});
      if (generation !== refinementGeneration) return false;
    }
    stash(); snapshots.value = values; snapshot.value = null; session.value = savedSession;
    dimensionReports.value = {}; comparisonChoice.value = null; seekPreview.value = null;
    queryArea.value = savedSession?.queryArea ?? (values[0]?.dataset.provenance.query as { queryArea?: GeographicBounds } | undefined)?.queryArea ?? null;
    visibleRadarIds.value = values.map((value) => value.dataset.radarId); cursor.value = start.value; playing.value = false; selection.value = null; mapMode.value = 'view'; showStored.value = true;
    if (values.length) await activateRadarInternal((values.find((value) => value.dataset.radarId === preferredRadar) ?? values[0]).dataset.radarId);
    else { radarId.value = ''; task.value = null; versions.value = []; }
    return true;
  }
  async function loadGroupCache(id: string) {
    const selected = groups.value.find(value => value.id === id);
    if (session.value && selected?.id === session.value.groupId && selected.revision === session.value.groupRevision) return;
    groupId.value = selected?.id ?? ''; projectId.value = selected?.projectId ?? projects.value[0]?.id ?? '';
    const source = projects.value.find(value => value.id === projectId.value); const now = Date.now();
    queryStart.value = toInputTime(source?.defaultRange?.start ?? now - 60000); queryEnd.value = toInputTime(source?.defaultRange?.end ?? now);
    inspectResult.value = null; await setSnapshots([]);
    if (!selected) return;
    radarId.value = radarOptions.value[0]?.id ?? '';
    const filter = '?groupId=' + encodeURIComponent(selected.id);
    const [whole, windows] = await Promise.all([api<QuerySession[]>('/sessions' + filter), api<QuerySession[]>('/playbacks' + filter)]);
    const latest = [...whole, ...windows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (latest) { queryStart.value = toInputTime(latest.start); queryEnd.value = toInputTime(latest.end); queryArea.value = latest.queryArea ?? null; notice.value = '历史条件已恢复，点击加载完整时段数据'; }
  }
  async function chooseGroup(id: string) { await guarded(() => loadGroupCache(id)); }
  async function refreshRegistry(selectId?: string) {
    await guarded(async () => { const [sources, values] = await Promise.all([api<Project[]>('/projects'), api<MatchGroup[]>('/groups')]); projects.value = sources; groups.value = values; await refreshLists(); const current = values.some((value) => value.id === groupId.value) ? groupId.value : values[0]?.id ?? ''; await loadGroupCache(selectId ?? current); });
  }
  function previewSeek(value: number) {
    seekPreview.value = Math.max(start.value, Math.min(end.value, value));
  }
  async function seekTo(value: number) {
    seekPreview.value = null; cursor.value = Math.max(start.value, Math.min(end.value, value));
  }
  async function applySession(bundle: SessionBundle) {
    groupId.value = groups.value.some(value => value.id === bundle.session.groupId) ? bundle.session.groupId : ''; projectId.value = bundle.session.projectId;
    queryStart.value = toInputTime(bundle.session.start); queryEnd.value = toInputTime(bundle.session.end); inspectResult.value = null;
    await setSnapshots(bundle.snapshots, bundle.session);
  }
  async function loadQuery(forceReload: boolean) {
    await guarded(async () => {
      if (!group.value) throw new Error('请选择匹配组');
      playing.value = false;
      const startTime = fromInputTime(queryStart.value); const endTime = fromInputTime(queryEnd.value);
      const bundle = await preparePlayback<SessionBundle>(`/groups/${group.value.id}/query`, { start: startTime, end: endTime, queryArea: queryArea.value, revision: group.value.revision, forceReload });
      await applySession(bundle); notice.value = '所选完整时段已加载'; await refreshLists();
    });
  }
  async function runQuery() { await loadQuery(false); }
  async function forceQuery() { await loadQuery(true); }

  async function preparePlayback<T>(path: string, body: unknown): Promise<T> {
    const job = await post<{ id: string }>(`${path}?async=1`, body); preparationId.value = job.id;
    try {
      while (true) {
        const state = await api<{ status: string; phase: string; error?: string }>(`/preparations/${job.id}`);
        if (state.status === 'completed') return await api<T>(`/preparations/${job.id}/result`);
        if (state.status === 'cancelled') throw new Error('加载已取消');
        if (state.status === 'failed') throw new Error(state.error ?? '历史数据准备失败');
        notice.value = state.phase;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } finally { preparationId.value = null; }
  }
  async function cancelQuery() { if (preparationId.value) { const state = await post<{ status: string }>(`/preparations/${preparationId.value}/cancel`, {}); if (state.status === 'preparing') notice.value = '数据正在完成发布，稍后返回结果'; } }
  async function openSession(id: string) {
    if (id) await guarded(async () => {
      playing.value = false;
      let bundle: SessionBundle;
      if (sessions.value.find(value => value.id === id)?.mode === 'windowed') {
        const prepared = await preparePlayback<{ sessionId: string }>(`/playbacks/${id}/prepare`, {});
        bundle = await api<SessionBundle>(`/sessions/${prepared.sessionId}`);
      } else bundle = await preparePlayback<SessionBundle>(`/sessions/${id}/load`, {});
      await applySession(bundle); notice.value = '所选完整时段已加载';
      if (bundle.reloadedFrom) notice.value = bundle.reloadedFrom.changed ? '已回源创建新会话，输入数据与原记录不同，原记录保留' : '已按历史条件重新加载为新会话，业务数据指纹一致';
      await refreshLists();
    });
  }
  async function loadSingleSnapshot(value: Snapshot) {
    groupId.value = ''; projectId.value = value.dataset.projectId; inspectResult.value = null;
    queryStart.value = toInputTime(value.summary.start); queryEnd.value = toInputTime(value.summary.end);
    await setSnapshots([value]);
    if (value.reloadedFrom) notice.value = value.reloadedFrom.changed ? '已回源创建新输入，业务数据与原记录不同，原记录保留' : '已按历史条件重新加载为新输入，业务数据指纹一致';
  }
  async function openSnapshot(id: string) { if (id) await guarded(async () => { await loadSingleSnapshot(await preparePlayback<Snapshot>(`/snapshots/${id}/load`, {})); await refreshLists(); }); }
  async function archiveCurrent(directory: string) {
    if (!snapshot.value) return;
    await guarded(async () => { const owner = session.value?.id ?? snapshot.value!.id; const saved = await post<{ filePath: string }>(`/${session.value ? 'sessions' : 'snapshots'}/${owner}/archive`, { directory }); notice.value = `完整归档已保存：${saved.filePath}`; await refreshLists(); });
  }
  async function importFile(file?: File) {
    if (!file) return;
    await guarded(async () => { if (file.size > 32 * 1024 * 1024) throw new Error('导入文件不能超过 32 MB'); const value = await preparePlayback<Snapshot>('/snapshots/import', JSON.parse(await file.text())); await loadSingleSnapshot(value); await refreshLists(); });
  }
  async function selectTarget(value: Selection | null) {
    if (!value || selection.value?.kind === value.kind && selection.value.id === value.id) { selection.value = null; return; }
    if (busy.value) return;
    await guarded(async () => {
      if (value.kind === 'radar') { const point = radarDisplay.value.find((entry) => entry.key === value.id); if (point && point.radarId !== radarId.value) await activateRadarInternal(point.radarId); }
      selection.value = value;
      if (value.kind !== 'ais' || project.value?.mode !== 'clickhouse-raw') return;
      const ship = aisCurrent.value.find((point) => point.mmsi === value.id);
      if (!ship) return;
      const positionTime = new Date(cursor.value).toISOString();
      const currentSnapshots = snapshots.value;
      const response = await post<AisDimensionsResponse>(`/projects/${encodeURIComponent(project.value.id)}/ais/dimensions`, { mmsi: ship.mmsi, aisSourceIds: ship.sourceIds, positionTime });
      if (snapshots.value !== currentSnapshots || selection.value?.kind !== 'ais' || selection.value.id !== ship.mmsi) return;
      if (response.report) {
        const report = response.report;
        dimensionReports.value = { ...Object.fromEntries(Object.entries(dimensionReports.value).filter(([, known]) => known.mmsi !== report.mmsi)), [`${report.sourceId}:${report.mmsi}`]: report };
        notice.value = `已更新 ${ship.mmsi} 点击补查尺寸：${report.lengthM} × ${report.widthM} m`;
      } else notice.value = `点击时的回放时间之后 48 小时内未找到 ${ship.mmsi} 的有效静态尺寸报文`;
    });
  }
  function stepFrame(direction: -1 | 1) {
    if (!snapshot.value || busy.value) return;
    playing.value = false;
    const currentTime = cursor.value;
    const frames = playbackFrames.value;
    let index = lowerBound(frames, currentTime);
    if (direction < 0) { index--; if (frames[index]?.timeMs === currentTime) index--; }
    cursor.value = frames[index]?.timeMs ?? (direction < 0 ? start.value : end.value);
  }
  function setParameter(field: keyof Parameters, value: number | undefined) {
    if (value == null || !Number.isFinite(value)) return;
    if (field === 'lng' && Math.abs(value) > 180 || field === 'lat' && Math.abs(value) > 85) return;
    parameters.value = { ...parameters.value, [field]: field === 'bearingOffsetDeg' ? normalizeAngle(value) : value };
  }
  function nudge(east: number, north: number) { if (dataset.value && Number.isFinite(east) && Number.isFinite(north)) parameters.value = moveParameters(parameters.value, east, north, dataset.value.reference); }
  function setBounds(bounds: Bounds, mode: MapMode) { if (mode === 'search') fitOptions.value.bounds = bounds; else if (mode === 'roi') fitOptions.value.roi = bounds; else if (mode === 'exclusion' && fitOptions.value.refinement) fitOptions.value.refinement.radarExclusion = bounds; mapMode.value = 'view'; }
  function setQueryArea(value: GeographicBounds | null) { queryArea.value = value; mapMode.value = 'view'; }
  async function exportCurrent() { return snapshot.value ? `/api/snapshots/${snapshot.value.id}/export` : null; }
  async function checkRefinement() {
    if (!dataset.value || !snapshot.value || !canFit.value || busy.value || refinementChecking.value) return;
    invalidateRefinement(); const generation = refinementGeneration;
    const data = dataset.value; const snapshotId = snapshot.value.id; const fingerprint = refinementFingerprint.value;
    const options = copy(fitOptions.value);
    options.refinement = { ...(options.refinement ?? defaultRefinement(parameters.value)), initial: { ...parameters.value }, associationIds: null };
    options.bounds = { ...refinementBounds.value };
    refinementChecking.value = true; error.value = '';
    try {
      // 先让界面显示计算状态；输入变化后不发布旧检查。
      await new Promise(resolve => setTimeout(resolve, 0));
      const preview = selectRefinementObservations(data, options) as RefinementSelection;
      if (generation !== refinementGeneration || fingerprint !== refinementFingerprint.value || data !== dataset.value) return;
      refinementPreview.value = preview; refinementCheck.value = { fingerprint, snapshotId, options };
      selectedAssociationIds.value = preview.associations.map(row => row.id);
    } catch (reason) { if (generation === refinementGeneration) error.value = reason instanceof Error ? reason.message : String(reason); }
    finally { refinementChecking.value = false; }
  }
  async function startFit() {
    if (!snapshot.value || !canStartFit.value || runningTask.value) return;
    const snapshotId = snapshot.value.id;
    const options = copy(refinementCheck.value!.options);
    options.refinement!.associationIds = [...selectedAssociationIds.value];
    await guarded(async () => {
      const submitted = await post<Task>('/tasks', { snapshotId, options });
      if (snapshot.value?.id === snapshotId) { task.value = submitted; panel.value = 'auto'; }
      notice.value = '标定任务已提交，后台使用已检查的固定关联计算'; await refreshLists();
    });
  }
  async function cancelFit() { if (task.value) await guarded(async () => { task.value = await post<Task>(`/tasks/${task.value!.id}/cancel`, {}); await refreshLists(); }); }
  async function openTask(id: string) {
    if (!id) return;
    await guarded(async () => {
      invalidateRefinement(); const generation = refinementGeneration;
      const value = await api<Task>(`/tasks/${id}`);
      if (generation !== refinementGeneration) return;
      const existing = snapshots.value.find(entry => entry.id === value.snapshotId);
      if (existing) {
        const activating = activateRadarInternal(existing.dataset.radarId); const activatedGeneration = refinementGeneration;
        await activating;
        if (activatedGeneration !== refinementGeneration || snapshot.value?.id !== value.snapshotId) return;
      }
      else if (!value.snapshotHash && value.sessionId) { if (!await setSnapshots([])) return; projectId.value = value.projectId; groupId.value = ''; notice.value = '该任务尚未完成完整时段的数据准备'; }
      else {
        const meta = await api<RecentSnapshot>(`/snapshots/${value.snapshotId}/metadata`);
        if (generation !== refinementGeneration) return;
        if (meta.availability === 'reload') { if (!await setSnapshots([])) return; projectId.value = value.projectId; groupId.value = ''; notice.value = '任务摘要已恢复，原始观测已释放；重新加载会创建新的数据输入'; }
        else {
          const restored = await api<Snapshot>(`/snapshots/${value.snapshotId}`);
          if (generation !== refinementGeneration) return;
          const loading = loadSingleSnapshot(restored); const restoredGeneration = refinementGeneration;
          await loading;
          if (restoredGeneration !== refinementGeneration || snapshot.value?.id !== value.snapshotId) return;
        }
      }
      task.value = value; if (value.options) fitOptions.value = workbenchOptions(value.options, parameters.value); panel.value = 'auto';
    });
  }
  function previewCandidate(index: number) {
    if (task.value?.snapshotId !== snapshot.value?.id) { notice.value = '请先恢复该任务的原始输入，再对比其候选参数'; return; }
    if (task.value?.result?.candidates[index]) { comparisonChoice.value = { taskId: task.value.id, index, sequence: ++comparisonSequence }; selection.value = null; mapMode.value = 'view'; }
  }
  function clearComparison() { comparisonChoice.value = null; }
  function applyCandidate() {
    const value = comparison.value;
    if (value) { invalidateRefinement(); parameters.value = { ...value.candidate }; fitOptions.value = workbenchOptions(task.value!.options, parameters.value); clearComparison(); }
  }
  async function saveVersion() {
    if (!snapshot.value) return;
    await guarded(async () => { const automatic = candidateIndex.value >= 0; const snapshotId = automatic ? task.value!.snapshotId : snapshot.value!.id; const value = await post<ParameterVersion>('/versions', { name: versionName.value.trim() || `候选 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`, snapshotId, parameters: parameters.value, effectiveFrom: enableEffective.value ? fromInputTime(effectiveFrom.value) : null, source: automatic ? 'task' : 'manual', ...(automatic ? { taskId: task.value!.id, candidateIndex: candidateIndex.value } : {}) }); versions.value = [value, ...versions.value]; versionName.value = ''; notice.value = '参数版本已保存'; });
  }
  async function inspect() { if (projectId.value) await guarded(async () => { inspectResult.value = await post(`/projects/${encodeURIComponent(projectId.value)}/inspect`, {}); }); }
  let timer: ReturnType<typeof setInterval> | undefined; let poll: ReturnType<typeof setInterval> | undefined; let lastTick = 0; let polling = false;
  onMounted(async () => {
    await refreshRegistry(); lastTick = performance.now();
    timer = setInterval(() => {
      const now = performance.now(); const elapsed = now - lastTick; lastTick = now;
      if (!playing.value || !snapshot.value || seekPreview.value != null) return;
      const next = Math.min(end.value, cursor.value + elapsed * speed.value);
      cursor.value = next; if (cursor.value >= end.value) playing.value = false;
    }, 100);
    poll = setInterval(async () => {
      if (polling || !runningTask.value) return; polling = true; const id = runningTask.value.id;
      try { const value = await api<Task>(`/tasks/${id}`); if (task.value?.id === id) task.value = value; taskHistory.value = taskHistory.value.map(entry => entry.id === id ? { ...entry, status: value.status, progress: value.progress } : entry); for (const [key, draft] of Object.entries(drafts.value)) if (draft.task?.id === id) drafts.value = { ...drafts.value, [key]: { ...draft, task: value } }; if (value.status !== 'running') await refreshLists(); }
      catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); } finally { polling = false; }
    }, 800);
  });
  onUnmounted(() => { clearInterval(timer); clearInterval(poll); void setSnapshots([]).catch(reason => console.error('释放回放数据失败', reason)); });
  return { projects, groups, groupId, projectId, radarId, group, project, queryStart, queryEnd, queryArea, recent, sessions, historyCursors, session, snapshots, snapshot, taskHistory, task, versions, comparison, clearComparison, applyCandidate, error, notice, busy, preparationId, seekPreview, previewSeek, seekTo, exportCurrent, parameters, baselineVersion, baseline, baselineName, cursor, playing, speed, trailSeconds, selection, mapMode, fitOptions, fitError, refinementPreview, refinementValid, selectedAssociationIds, refinementChecking, canStartFit, checkRefinement, refinementBounds, retainedRefinement, refinementMap, mapRadar, mapTrails, showOriginalRadar, focusRefinementAssociation, showBaseline, showCandidate, showTrails, showStored, showLinks, showTiles, visibleRadarIds, panel, versionName, enableEffective, effectiveFrom, inspectResult, dataset, start, end, radarMembers, radarOptions, aisCurrent, radarCurrent, radarDisplay, trails, aisTrails, otherStations, inspection, currentMatches, candidateIndex, canFit, runningTask, offset, chooseGroup, refreshRegistry, activateRadar, runQuery, forceQuery, cancelQuery, openSession, openSnapshot, importFile, moreHistory, archiveCurrent, selectTarget, stepFrame, setParameter, nudge, setBounds, setQueryArea, startFit, cancelFit, openTask, previewCandidate, saveVersion, inspect };
}
