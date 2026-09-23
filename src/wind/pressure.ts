/**
 * 风箱压力判定：纯函数业务规则，不依赖 React 与浏览器存储。
 *
 * 测量约定（每次维护按音栓内的若干测点分别登记）：
 * - 压降 drop        = 静压 staticP − 演奏中最低风压 playingMinP（同一测点）
 * - 响应差 responseDiff = 同一音栓内各测点压降的最大值与最小值之差
 *
 * 超限判定：响应差 > 4Pa，或任一测点压降 > 6Pa。
 */

/** 同一音栓内响应差阈值（Pa），超过则整组待复测 */
export const RESPONSE_DIFF_LIMIT = 4;
/** 单点压降阈值（Pa，静压与演奏最低风压之差），超过则整组待复测 */
export const PRESSURE_DROP_LIMIT = 6;

/** 登记类型：日常维护 / 复测 */
export type RegistrationKind = "maintenance" | "retest";

/** 音栓组状态：正常 / 待复测（锁定） */
export type StopStatus = "normal" | "pending";

export interface PressurePointInput {
  /** 测点标识，一般为音管编号/键位，如 F2、C4 */
  pointId: string;
  /** 静压（Pa） */
  staticP: number;
  /** 演奏中的最低风压（Pa） */
  playingMinP: number;
}

export interface PressurePointResult extends PressurePointInput {
  /** 该测点压降 = 静压 − 演奏最低风压 */
  drop: number;
}

export interface PressureSummary {
  points: PressurePointResult[];
  /** 组内最大压降（Pa） */
  maxDrop: number;
  /** 组内最小压降（Pa） */
  minDrop: number;
  /** 组内响应差 = 最大压降 − 最小压降（Pa） */
  responseDiff: number;
  /** 是否超限（需转待复测 / 复测不合格） */
  exceeds: boolean;
  /** 超限原因（用于页面提示） */
  reasons: string[];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 单个测点的压降（Pa） */
export function pressureDrop(staticP: number, playingMinP: number): number {
  return round1(staticP - playingMinP);
}

/**
 * 汇总一次登记的全部测点并给出超限判定。
 * 至少需要一个测点；空数组按不超限处理（表单层会拦截空提交）。
 */
export function summarizePressure(points: PressurePointInput[]): PressureSummary {
  const results: PressurePointResult[] = points.map((p) => ({
    ...p,
    drop: pressureDrop(p.staticP, p.playingMinP),
  }));
  const drops = results.map((p) => p.drop);
  const maxDrop = drops.length ? Math.max(...drops) : 0;
  const minDrop = drops.length ? Math.min(...drops) : 0;
  const responseDiff = round1(maxDrop - minDrop);

  const reasons: string[] = [];
  if (responseDiff > RESPONSE_DIFF_LIMIT) {
    reasons.push(`组内响应差 ${responseDiff}Pa 超过 ${RESPONSE_DIFF_LIMIT}Pa`);
  }
  if (maxDrop > PRESSURE_DROP_LIMIT) {
    reasons.push(`最大压降 ${maxDrop}Pa 超过 ${PRESSURE_DROP_LIMIT}Pa`);
  }

  return {
    points: results,
    maxDrop: round1(maxDrop),
    minDrop: round1(minDrop),
    responseDiff,
    exceeds: reasons.length > 0,
    reasons,
  };
}

/**
 * 音栓组状态流转：
 * - 维护超限       → pending（整组转待复测，原调音结论在存储层保留不动）
 * - 维护合格       → 维持现状（待复测组不会因一次合格维护自动解锁）
 * - 复测合格       → normal（仅恢复该音栓）
 * - 复测仍超限     → 维持 pending（继续锁定）
 */
export function nextStopStatus(
  current: StopStatus,
  kind: RegistrationKind,
  passes: boolean
): StopStatus {
  if (!passes) return "pending";
  if (kind === "retest") return "normal";
  return current;
}
