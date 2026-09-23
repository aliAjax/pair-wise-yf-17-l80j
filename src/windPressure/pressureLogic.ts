/**
 * 风箱压力复测 · 业务层一：风压判定
 * 纯函数，不依赖 React / localStorage，便于独立验证。
 *
 * 每次维护登记每个测点的：
 *  - 静压 staticPressure：未按键时风箱内的稳定风压
 *  - 演奏最低风压 playingMinPressure：演奏中实测的最低风压
 *
 * 同一音栓（整组）两个判定指标：
 *  1. 压降：各测点「静压 - 演奏最低风压」中的最大值，上限 6 Pa
 *  2. 响应差：各测点「静压 - 演奏最低风压」相互之间的最大差异，
 *     即管组在供风时压降响应是否齐整，上限 4 Pa
 * 任一超限，整组转为「待复测」，原调音结论保留。
 */

export const RESPONSE_SPREAD_LIMIT_PA = 4;
export const PRESSURE_DROP_LIMIT_PA = 6;
export const STORAGE_VERSION = 1;

/** 单次风压测点读数，单位均为 Pa */
export interface PressurePoint {
  point: string;
  staticPressure: number;
  playingMinPressure: number;
}

/** 测点指标：静压与演奏最低风压之间的压降 */
export interface PointMetric {
  point: string;
  drop: number;
}

export interface PressureMetric {
  /** 组内最大压降：max(静压 - 演奏最低风压) */
  maxDrop: number;
  /** 组内响应差：各测点压降之间的最大差异 */
  responseSpread: number;
}

export interface PressureVerdict {
  metric: PressureMetric;
  points: PointMetric[];
  responseExceeded: boolean;
  dropExceeded: boolean;
  ok: boolean;
  /** 超限原因（人类可读） */
  reasons: string[];
}

export type StopStatus = "normal" | "pending";

export interface MaintenanceRecord {
  id: string;
  date: string;
  technician: string;
  points: PressurePoint[];
  metric: PressureMetric;
  triggeredRetest: boolean;
  reasons: string[];
  note: string;
  createdAt: number;
}

export interface RetestRecord {
  id: string;
  date: string;
  technician: string;
  points: PressurePoint[];
  metric: PressureMetric;
  passed: boolean;
  reasons: string[];
  note: string;
  createdAt: number;
}

export interface StopState {
  stopId: string;
  status: StopStatus;
  /** 待复测时间：状态最近一次被置为 pending 的维护创建时间 */
  pendingSince: number | null;
}

export interface StopInfo {
  id: string;
  name: string;
  /** 原调音结论：仅保留展示，复测流程不修改它 */
  tuningConclusion: string;
}

export interface VenueData {
  id: string;
  name: string;
  stops: StopInfo[];
  states: StopState[];
  maintenances: Record<string, MaintenanceRecord[]>;
  retests: Record<string, RetestRecord[]>;
}

let idCounter = 0;

function genId(prefix: string, now: number): string {
  idCounter += 1;
  return `${prefix}-${now.toString(36)}-${idCounter.toString(36)}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 依据测点读数计算组内指标并判定是否超限 */
export function evaluatePressure(points: PressurePoint[]): PressureVerdict {
  const pointMetrics: PointMetric[] = points.map((p) => ({
    point: p.point,
    drop: round2(p.staticPressure - p.playingMinPressure),
  }));

  const drops = pointMetrics.map((m) => m.drop);
  const maxDrop = round2(Math.max(...drops));
  const responseSpread = round2(Math.max(...drops) - Math.min(...drops));

  const responseExceeded = responseSpread > RESPONSE_SPREAD_LIMIT_PA;
  const dropExceeded = maxDrop > PRESSURE_DROP_LIMIT_PA;
  const reasons: string[] = [];
  if (responseExceeded) {
    reasons.push(
      `响应差 ${responseSpread} Pa 超过 ${RESPONSE_SPREAD_LIMIT_PA} Pa`
    );
  }
  if (dropExceeded) {
    reasons.push(`压降 ${maxDrop} Pa 超过 ${PRESSURE_DROP_LIMIT_PA} Pa`);
  }

  return {
    metric: { maxDrop, responseSpread },
    points: pointMetrics,
    responseExceeded,
    dropExceeded,
    ok: !responseExceeded && !dropExceeded,
    reasons,
  };
}

/** 新增音栓时的默认状态：正常 */
export function createStopState(stopId: string): StopState {
  return { stopId, status: "normal", pendingSince: null };
}

export interface RegisterInput {
  stopId: string;
  date: string;
  technician: string;
  points: PressurePoint[];
  note: string;
  createdAt?: number;
}

/**
 * 登记一次维护：写入维护记录并更新音栓组状态。
 * 判定超限时整组转为「待复测」，原调音结论保留不动。
 */
export function registerMaintenance(
  venue: VenueData,
  input: RegisterInput
): VenueData {
  const now = input.createdAt ?? Date.now();
  const verdict = evaluatePressure(input.points);
  const record: MaintenanceRecord = {
    id: genId("mnt", now),
    date: input.date,
    technician: input.technician,
    points: input.points,
    metric: verdict.metric,
    triggeredRetest: !verdict.ok,
    reasons: verdict.reasons,
    note: input.note,
    createdAt: now,
  };

  const maintenances = { ...venue.maintenances };
  maintenances[input.stopId] = [
    ...(maintenances[input.stopId] ?? []),
    record,
  ];

  const states = venue.states.map((s) => {
    if (s.stopId !== input.stopId) return s;
    if (verdict.ok) {
      // 合格登记不改变既有状态：待复测组仍锁定，正常组保持正常
      return s;
    }
    return { stopId: input.stopId, status: "pending" as const, pendingSince: now };
  });

  return { ...venue, maintenances, states };
}

export interface RetestInput {
  stopId: string;
  date: string;
  technician: string;
  points: PressurePoint[];
  note: string;
  createdAt?: number;
}

/**
 * 提交复测：复测结果写入记录；
 * 合格则只恢复本音栓组（待复测 → 正常），不合格仍锁定；
 * 其它未复测音栓组状态一律不动。
 */
export function submitRetest(venue: VenueData, input: RetestInput): VenueData {
  const now = input.createdAt ?? Date.now();
  const verdict = evaluatePressure(input.points);
  const record: RetestRecord = {
    id: genId("ret", now),
    date: input.date,
    technician: input.technician,
    points: input.points,
    metric: verdict.metric,
    passed: verdict.ok,
    reasons: verdict.reasons,
    note: input.note,
    createdAt: now,
  };

  const retests = { ...venue.retests };
  retests[input.stopId] = [...(retests[input.stopId] ?? []), record];

  const states = venue.states.map((s) => {
    if (s.stopId !== input.stopId) return s;
    return verdict.ok
      ? { stopId: input.stopId, status: "normal" as const, pendingSince: null }
      : s;
  });

  return { ...venue, retests, states };
}

export function getStopState(venue: VenueData, stopId: string): StopState {
  return venue.states.find((s) => s.stopId === stopId) ?? createStopState(stopId);
}

export function getPendingStopIds(venue: VenueData): string[] {
  return venue.states.filter((s) => s.status === "pending").map((s) => s.stopId);
}

export function getLatestMaintenance(
  venue: VenueData,
  stopId: string
): MaintenanceRecord | undefined {
  const list = venue.maintenances[stopId] ?? [];
  return list[list.length - 1];
}

export function getLatestRetest(
  venue: VenueData,
  stopId: string
): RetestRecord | undefined {
  const list = venue.retests[stopId] ?? [];
  return list[list.length - 1];
}
