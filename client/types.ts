import type { AisObservation, AisDimensionReport, Parameters, Position, RadarObservation } from '../shared/types';

export interface AisState extends AisObservation { east: number; north: number; deltaMs: number }
export interface AisDisplay extends Omit<AisState, 'dimensions'> { displayPosition: Position; interpolated: boolean; dimensions?: AisDimensionReport['dimensions'] | null; dimensionReport?: AisDimensionReport }
export interface RadarDisplay {
  key: string; observation: RadarObservation; candidate: Position; baseline: Position; stored: Position | null; interpolated: boolean;
  radarId: string; radarName: string; color: string;
  association: { ship: AisState | null; probability: number; background: number; residual: number | null; outsideStudy?: boolean };
}
export interface Trail { key: string; candidate: Position[]; baseline: Position[]; stored: Position[]; color: string }
export interface Selection { kind: 'radar' | 'ais'; id: string }
export interface ParameterComparison {
  key: string; index: number; current: Parameters; candidate: Parameters;
  delta: { lngDeg: number; latDeg: number; bearingDeg: number; eastM: number; northM: number; distanceM: number };
}
export interface RefinementMapPoint {
  associationId: string; observationId: string; trackId: string; mmsi: string; timeMs: number;
  radar: Position; ais: Position;
}
export interface RefinementMap {
  points: RefinementMapPoint[]; focusedId: string | null; focusSequence: number;
}
export type MapMode = 'view' | 'query' | 'search' | 'roi' | 'exclusion';
