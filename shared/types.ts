export interface Position { lng: number; lat: number }
export interface Parameters extends Position { bearingOffsetDeg: number }
export interface Bounds { minEast: number; maxEast: number; minNorth: number; maxNorth: number }
export interface GeographicBounds { west: number; east: number; south: number; north: number }
export interface Dimensions {
  bow: number; stern: number; port: number; starboard: number;
  observedAt: string; validFrom: string; validTo: string; sourceId: string;
}
export interface AisDimensionReport {
  mmsi: string; sourceId: string; messageType: string; eventTime: string;
  dimensions: Pick<Dimensions, 'bow' | 'stern' | 'port' | 'starboard'>;
  lengthM: number; widthM: number; parserVersion: string;
}
export interface AisDimensionsResponse {
  projectId: string; mmsi: string; positionTime: string; queriedAt: string; report: AisDimensionReport | null;
}
export interface RadarObservation {
  id: string; sourceId: string; deviceId: string; trackId: string;
  eventTime: string; timeMs: number; receiveTime?: string | null;
  rangeM: number; azimuthDeg: number; storedPosition?: Position | null;
  raw: Record<string, unknown>; mappingVersion: string; quality: string[];
}
export interface AisObservation {
  id: string; sourceIds: string[]; observationIds: string[]; mmsi: string;
  eventTime: string; timeMs: number; receiveTime?: string | null; messageType: string;
  position: Position; sogKnots?: number | null; cogDeg?: number | null;
  headingDeg?: number | null; accuracyM?: number | null; dimensions?: Dimensions | null;
  raw: Record<string, unknown>; mappingVersion: string; quality: string[];
}
export interface AisStaticObservation extends Omit<AisObservation, 'position' | 'sogKnots' | 'cogDeg' | 'headingDeg' | 'accuracyM' | 'dimensions'> {
  dimensions: Dimensions;
}
export interface Dataset {
  schemaVersion: 1; name: string; projectId: string; radarId: string;
  reference: Position; baseline: Parameters;
  timeRange?: { start: string; end: string };
  timeSemantics: 'event-time' | 'receive-time' | 'unverified';
  unitsVerified: boolean; alignmentVerified: boolean;
  radar: RadarObservation[]; ais: AisObservation[]; aisStatic?: AisStaticObservation[];
  provenance: Record<string, unknown>; warnings: string[];
}
export interface Snapshot {
  id: string; createdAt: string; hash: string; dataset: Dataset;
  sessionId?: string;
  evidenceSnapshotId?: string;
  fingerprint?: string; storageKind?: 'temporary' | 'legacy' | 'archive'; availability?: 'memory' | 'reload' | 'legacy' | 'archive';
  reloadedFrom?: { id: string; changed: boolean };
  summary: { radarPoints: number; aisPoints: number; rawAisPoints: number; deduplicated: number; conflicts: number; radarTracks: number; ships: number; start: number; end: number; warnings: string[]; coverage: { start: number; end: number; radar: number; ais: number }[] };
}
export interface RadarRegistration { id: string; name: string; baseline: Parameters; deviceCode?: string; stationId?: string; positionText?: string }
export interface Project {
  id: string; name: string; mode: 'clickhouse-http' | 'clickhouse-raw'; configVersion: string;
  reference: Position; radars: RadarRegistration[];
  aisSources: { id: string; name: string }[]; verified: boolean;
  defaultRange?: { start: string; end: string }; available: boolean; unavailableReason?: string;
  readOnly?: boolean;
  registryRevision?: number;
}
export interface MatchGroup { id: string; projectId: string; name: string; radarIds: string[]; aisSourceIds: string[]; revision: number; createdAt: string; updatedAt: string }
export interface QuerySession { id: string; projectId: string; groupId: string; groupName: string; groupRevision: number; registryRevision: number; radarIds: string[]; aisSourceIds: string[]; aisSourceNames?: Record<string, string>; start: string; end: string; queryArea?: GeographicBounds | null; createdAt: string; snapshotIds: string[]; snapshotHashes: string[]; fingerprint?: string; storageKind?: 'temporary' | 'legacy' | 'archive' | 'windowed'; availability?: 'memory' | 'reload' | 'legacy' | 'archive'; mode?: 'windowed' }
export interface SessionBundle { session: QuerySession; snapshots: Snapshot[]; reloadedFrom?: { id: string; changed: boolean } }
export interface WindowPlayback extends QuerySession {
  mode: 'windowed'; reference: Position; radars: (RadarRegistration & { viewId: string })[];
  timeSemantics: Dataset['timeSemantics']; unitsVerified: boolean; alignmentVerified: boolean;
  windowMs: number; cacheWindows: number; cacheBytes: number;
}
export interface WindowBundle extends SessionBundle {
  window: { id: string; playbackId: string; start: number; end: number; coreStart: number; coreEnd: number; dataScope: 'window'; byteSize: number; fingerprint?: string; changedFromPrevious?: boolean };
  bufferBytes?: number;
}
export interface RefinementOptions {
  initial: Parameters;
  maxDistanceM: number; maxPositionShiftM: number; maxBearingShiftDeg: number;
  minTrackPoints: number; minTrackDurationMs: number; motionToleranceM: number;
  radarExclusion: Bounds | null; associationIds: string[] | null;
}
export interface RefinementAssociation {
  id: string; deviceId: string; trackId: string; mmsi: string;
  points: number; start: number; end: number; distanceP50M: number; motionErrorM: number;
}
export interface RefinementObservation {
  observation: RadarObservation;
  ship: AisObservation & { east: number; north: number; deltaMs: number };
  associationId: string;
}
export interface RefinementSelection {
  associations: RefinementAssociation[];
  training: RefinementObservation[]; validation: RefinementObservation[];
  exclusions: Record<string, number>; splitTime: number;
}
export interface FitOptions {
  bounds: Bounds; roi: Bounds | null; positionStepM: number; angleStepDeg: number;
  refinement: RefinementOptions | null;
  maxFitPoints: number; maxValidationPoints: number; maxGapMs: number;
  validationFraction: number; maxIterations: number; keepCandidates: number;
  rangeSigmaM: number; angleSigmaDeg: number; aisSigmaM: number;
  fallbackSigmaM: number; backgroundPrior: number;
}
export interface Metrics {
  points: number; alignedPoints: number; matchedPoints: number; ships: number; tracks: number;
  support: number; background: number; score: number;
  residualP50: number | null; residualP90: number | null; residualP95: number | null;
  groups: { dimension: string; key: string; points: number; matched: number; background: number; p90: number | null }[];
}
export interface FitCandidate {
  parameters: Parameters; east: number; north: number; training: Metrics; validation: Metrics;
  onBoundary: boolean; iterations: number;
}
export interface FitResult {
  assessment: 'recommended' | 'insufficient' | 'ambiguous'; reasons: string[];
  candidates: FitCandidate[]; splitTime: string; evaluations: number;
  studyRegion: Bounds; options: FitOptions; exclusions: Record<string, number>;
  initialMetrics?: { training: Metrics; validation: Metrics };
  heatmap: { east: number; north: number; score: number }[];
  angleProfile: { angle: number; score: number }[];
  modelVersion: string; samplingVersion: string; snapshotHash: string;
  validationReused?: boolean; validationPreviousTasks?: string[];
  evidenceScope?: 'summary' | 'complete';
}
export interface Task {
  id: string; snapshotId: string; snapshotHash?: string; sessionId?: string; projectId: string; radarId: string;
  dataRange?: { start: number; end: number };
  createdAt: string; updatedAt: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  progress: { phase: string; fraction: number; completed: number; total: number; evaluations: number };
  options: FitOptions; result?: FitResult; error?: string;
}
export interface ParameterVersion {
  id: string; name: string; projectId: string; radarId: string; parameters: Parameters;
  createdAt: string; effectiveFrom: string | null; source: 'manual' | 'task';
  snapshotId: string; snapshotHash: string; taskId?: string; candidateIndex?: number;
  assessment: string; convention: string; evidence: Record<string, unknown>;
}
