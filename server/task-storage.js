import { createHash } from 'node:crypto';
import { canonicalJson } from '../shared/data.js';
import { refinementBounds } from '../shared/refinement.js';
import { metricColumns, optionColumns, refinementColumns } from './storage-schema.js';

const ms = value => value == null ? null : Date.parse(value);
const iso = value => value == null ? undefined : new Date(value).toISOString();
const present = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item != null));
const bounds = (value, prefix = '') => ({ [`${prefix}min_east`]: value?.minEast ?? null, [`${prefix}max_east`]: value?.maxEast ?? null, [`${prefix}min_north`]: value?.minNorth ?? null, [`${prefix}max_north`]: value?.maxNorth ?? null });
const readBounds = (row, prefix = '') => row[`${prefix}min_east`] == null ? null : ({ minEast: row[`${prefix}min_east`], maxEast: row[`${prefix}max_east`], minNorth: row[`${prefix}min_north`], maxNorth: row[`${prefix}max_north`] });
export const optionsHash = options => {
  if (!options) return null;
  const { refinement, ...legacyOptions } = options;
  const normalized = refinement == null ? legacyOptions : { ...options, refinement: { ...refinement, associationIds: refinement.associationIds == null ? null : [...new Set(refinement.associationIds)].sort() } };
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex');
};

function writeMetrics(store, taskId, rank, metrics) {
  for (const split of ['training', 'validation']) {
    const metric = metrics?.[split];
    if (!metric) continue;
    store.put('task_metrics', { task_id: taskId, rank, split, ...Object.fromEntries(Object.entries(metricColumns).map(([field, column]) => [column, metric[field]])) });
    for (const [ordinal, group] of metric.groups.entries()) store.put('task_metric_groups', { task_id: taskId, rank, split, ordinal, dimension: group.dimension, group_key: group.key, points: group.points, matched: group.matched, background: group.background, p90: group.p90 });
  }
}

function readMetrics(store, taskId, rank) {
  const metrics = {};
  for (const split of ['training', 'validation']) {
    const metric = store.db.prepare('SELECT * FROM task_metrics WHERE task_id = ? AND rank = ? AND split = ?').get(taskId, rank, split);
    if (metric) metrics[split] = { ...Object.fromEntries(Object.entries(metricColumns).map(([field, column]) => [field, metric[column]])), groups: store.db.prepare('SELECT dimension, group_key, points, matched, background, p90 FROM task_metric_groups WHERE task_id = ? AND rank = ? AND split = ? ORDER BY ordinal').all(taskId, rank, split).map(group => ({ dimension: group.dimension, key: group.group_key, points: group.points, matched: group.matched, background: group.background, p90: group.p90 })) };
  }
  return Object.keys(metrics).length ? metrics : null;
}

export function writeTask(store, task) {
  const result = task.result;
  const snapshot = store.snapshotMeta(task.snapshotId);
  store.put('calibration_tasks', {
    id: task.id, snapshot_id: task.snapshotId, session_id: task.sessionId ?? snapshot?.sessionId, snapshot_hash: task.snapshotHash ?? snapshot?.hash, project_id: task.projectId ?? snapshot?.projectId, radar_id: task.radarId ?? snapshot?.radarId,
    created_at_ms: ms(task.createdAt), updated_at_ms: ms(task.updatedAt), status: task.status, error: task.error,
    phase: task.progress?.phase, fraction: task.progress?.fraction, completed: task.progress?.completed, total: task.progress?.total, progress_evaluations: task.progress?.evaluations,
    data_start_ms: task.dataRange?.start, data_end_ms: task.dataRange?.end, validation_start_ms: task.validationRange?.start, validation_end_ms: task.validationRange?.end,
    options_hash: optionsHash(task.options), assessment: result?.assessment, split_time_ms: ms(result?.splitTime), evaluations: result?.evaluations, model_version: result?.modelVersion, sampling_version: result?.samplingVersion, validation_reused: result?.validationReused == null ? null : Number(result.validationReused), ...bounds(result?.studyRegion, 'study_'), detailed_evidence: Number(!!result),
  });
  for (const table of ['task_options', 'task_refinements', 'task_candidates', 'task_metrics', 'task_metric_groups', 'task_reasons', 'task_exclusions', 'task_validation_refs']) store.db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(task.id);
  if (task.options) store.put('task_options', { task_id: task.id, ...bounds(task.options.bounds), ...bounds(task.options.roi, 'roi_'), ...Object.fromEntries(Object.entries(optionColumns).map(([field, column]) => [column, task.options[field]])) });
  const refinement = task.options?.refinement;
  if (refinement) {
    store.put('task_refinements', { task_id: task.id, initial_lng: refinement.initial.lng, initial_lat: refinement.initial.lat, initial_bearing_offset_deg: refinement.initial.bearingOffsetDeg, ...Object.fromEntries(Object.entries(refinementColumns).map(([field, column]) => [column, refinement[field]])), ...bounds(refinement.radarExclusion, 'exclusion_'), associations_checked: Number(refinement.associationIds != null) });
    for (const [ordinal, association_id] of (refinement.associationIds ?? []).entries()) store.put('task_refinement_associations', { task_id: task.id, ordinal, association_id });
  }
  for (const [rank, candidate] of (result?.candidates ?? []).entries()) {
    store.put('task_candidates', { task_id: task.id, rank, lng: candidate.parameters.lng, lat: candidate.parameters.lat, bearing_offset_deg: candidate.parameters.bearingOffsetDeg, east: candidate.east, north: candidate.north, on_boundary: Number(candidate.onBoundary), iterations: candidate.iterations });
    writeMetrics(store, task.id, rank, candidate);
  }
  // -1 保留给人工初值，自动候选仍从 0 开始。
  writeMetrics(store, task.id, -1, result?.initialMetrics);
  for (const [ordinal, message] of (result?.reasons ?? []).entries()) store.put('task_reasons', { task_id: task.id, ordinal, message });
  for (const [reason, count] of Object.entries(result?.exclusions ?? {})) store.put('task_exclusions', { task_id: task.id, reason, count });
  for (const previous_task_id of result?.validationPreviousTasks ?? task.validationPreviousTasks ?? []) store.put('task_validation_refs', { task_id: task.id, previous_task_id });
}

export function readTask(store, row, detail = true) {
  const task = present({ id: row.id, snapshotId: row.snapshot_id, sessionId: row.session_id, snapshotHash: row.snapshot_hash, projectId: row.project_id, radarId: row.radar_id, createdAt: iso(row.created_at_ms), updatedAt: iso(row.updated_at_ms), status: row.status, error: row.error, assessment: row.assessment });
  if (row.phase != null) task.progress = { phase: row.phase, fraction: row.fraction, completed: row.completed, total: row.total, evaluations: row.progress_evaluations };
  if (row.data_start_ms != null) task.dataRange = { start: row.data_start_ms, end: row.data_end_ms };
  if (row.validation_start_ms != null) task.validationRange = { start: row.validation_start_ms, end: row.validation_end_ms };
  if (!detail) return task;
  const option = store.db.prepare('SELECT * FROM task_options WHERE task_id = ?').get(row.id);
  if (option) {
    const refinement = store.db.prepare('SELECT * FROM task_refinements WHERE task_id = ?').get(row.id);
    task.options = { bounds: readBounds(option), roi: readBounds(option, 'roi_'), ...Object.fromEntries(Object.entries(optionColumns).map(([field, column]) => [field, option[column]])), refinement: refinement ? { initial: { lng: refinement.initial_lng, lat: refinement.initial_lat, bearingOffsetDeg: refinement.initial_bearing_offset_deg }, ...Object.fromEntries(Object.entries(refinementColumns).map(([field, column]) => [field, refinement[column]])), radarExclusion: readBounds(refinement, 'exclusion_'), associationIds: refinement.associations_checked ? store.db.prepare('SELECT association_id FROM task_refinement_associations WHERE task_id = ? ORDER BY ordinal').all(row.id).map(item => item.association_id) : null } : null };
  }
  task.validationPreviousTasks = store.db.prepare('SELECT previous_task_id FROM task_validation_refs WHERE task_id = ? ORDER BY previous_task_id').all(row.id).map(item => item.previous_task_id);
  if (row.assessment != null) {
    const candidates = store.db.prepare('SELECT * FROM task_candidates WHERE task_id = ? ORDER BY rank').all(row.id).map(candidate => {
      return { parameters: { lng: candidate.lng, lat: candidate.lat, bearingOffsetDeg: candidate.bearing_offset_deg }, east: candidate.east, north: candidate.north, onBoundary: !!candidate.on_boundary, iterations: candidate.iterations, ...readMetrics(store, row.id, candidate.rank) };
    });
    const resultOptions = task.options?.refinement ? { ...task.options, bounds: refinementBounds(task.options.refinement, store.snapshotMeta(task.snapshotId).reference) } : task.options;
    task.result = { assessment: row.assessment, reasons: store.db.prepare('SELECT message FROM task_reasons WHERE task_id = ? ORDER BY ordinal').all(row.id).map(item => item.message), candidates, splitTime: iso(row.split_time_ms), evaluations: row.evaluations, studyRegion: readBounds(row, 'study_'), options: resultOptions, exclusions: Object.fromEntries(store.db.prepare('SELECT reason, count FROM task_exclusions WHERE task_id = ?').all(row.id).map(item => [item.reason, item.count])), heatmap: [], angleProfile: [], modelVersion: row.model_version, samplingVersion: row.sampling_version, snapshotHash: row.snapshot_hash, validationReused: !!row.validation_reused, validationPreviousTasks: task.validationPreviousTasks, evidenceScope: 'summary' };
    const initialMetrics = readMetrics(store, row.id, -1);
    if (initialMetrics) task.result.initialMetrics = initialMetrics;
  }
  return task;
}

export function writeVersion(store, value) {
  const snapshot = store.snapshotMeta(value.snapshotId);
  store.put('parameter_versions', { id: value.id, name: value.name, project_id: value.projectId ?? snapshot?.projectId, radar_id: value.radarId ?? snapshot?.radarId, lng: value.parameters?.lng, lat: value.parameters?.lat, bearing_offset_deg: value.parameters?.bearingOffsetDeg, created_at_ms: ms(value.createdAt), effective_from_ms: ms(value.effectiveFrom), source: value.source, snapshot_id: value.snapshotId, snapshot_hash: value.snapshotHash, task_id: value.taskId, candidate_index: value.candidateIndex, assessment: value.assessment, convention: value.convention, config_version: value.evidence?.configVersion, model_version: value.evidence?.modelVersion, split_time_ms: ms(value.evidence?.splitTime) });
  store.db.prepare('DELETE FROM version_mapping_versions WHERE version_id = ?').run(value.id);
  for (const mapping_version of value.evidence?.mappingVersions ?? []) store.put('version_mapping_versions', { version_id: value.id, mapping_version });
}

export function readVersion(store, row, detail = true, mappingVersions) {
  const value = present({ id: row.id, name: row.name, projectId: row.project_id, radarId: row.radar_id, createdAt: iso(row.created_at_ms), source: row.source, snapshotId: row.snapshot_id, snapshotHash: row.snapshot_hash, taskId: row.task_id, candidateIndex: row.candidate_index, assessment: row.assessment, convention: row.convention });
  value.parameters = { lng: row.lng, lat: row.lat, bearingOffsetDeg: row.bearing_offset_deg };
  value.effectiveFrom = iso(row.effective_from_ms) ?? null;
  if (row.task_id) {
    const taskRow = detail ? store.db.prepare('SELECT * FROM calibration_tasks WHERE id = ?').get(row.task_id) : null;
    const task = detail && taskRow ? readTask(store, taskRow) : null;
    value.evidence = present({ modelVersion: row.model_version, splitTime: iso(row.split_time_ms), options: task?.options, assessmentReasons: task?.result?.reasons, initialMetrics: task?.result?.initialMetrics });
  } else value.evidence = present({ configVersion: row.config_version, mappingVersions: mappingVersions ?? store.db.prepare('SELECT mapping_version FROM version_mapping_versions WHERE version_id = ? ORDER BY mapping_version').all(row.id).map(item => item.mapping_version) });
  return value;
}
