import type { Dimensions, Position } from '../shared/types';
import { enuToWgs84 } from '../shared/geo.js';

export function shipReferenceKnown(dimensions: Pick<Dimensions, 'bow' | 'stern' | 'port' | 'starboard'>): boolean {
  // AIS 的 A=C=0 表示只有船长、船宽，定位参考点相对船体的位置未提供。
  return dimensions.bow !== 0 || dimensions.port !== 0;
}

export function shipOutline(position: Position, dimensions: Pick<Dimensions, 'bow' | 'stern' | 'port' | 'starboard'>, headingDeg: number): Position[] {
  const length = dimensions.bow + dimensions.stern;
  const center = (dimensions.starboard - dimensions.port) / 2;
  const shoulder = dimensions.bow - length * 0.2;
  // 尖艏和平艉仅定义显示轮廓；外接长宽及参考点偏移完全使用 AIS 上报米数。
  const vertices = [
    [dimensions.bow, center],
    [shoulder, -dimensions.port],
    [-dimensions.stern, -dimensions.port],
    [-dimensions.stern, dimensions.starboard],
    [shoulder, dimensions.starboard],
  ];
  const angle = headingDeg * Math.PI / 180;
  const sin = Math.sin(angle); const cos = Math.cos(angle);
  return vertices.map(([forward, side]) => enuToWgs84({ east: forward * sin + side * cos, north: forward * cos - side * sin }, position));
}
