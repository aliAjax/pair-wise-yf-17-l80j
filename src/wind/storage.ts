import { useCallback, useEffect, useRef, useState } from "react";
import {
  nextStopStatus,
  summarizePressure,
  type PressureSummary,
  type RegistrationKind,
  type StopStatus,
} from "./pressure";

/** 一次风压实测（维护登记或复测），测点判定结果随记录一并保存 */
export interface PressureEntry {
  id: string;
  kind: RegistrationKind;
  date: string;
  /** 测量时的静压设定（Pa），取组内首个测点静压作为代表值 */
  staticPressure: number;
  /** 演奏中最低风压（Pa），取各测点最低值 */
  playingMinPressure: number;
  summary: PressureSummary;
  note?: string;
  registeredAt: string;
}

/** 音栓组：风压状态独立保存，原调音结论（tuningConclusion）始终保留 */
export interface WindStop {
  id: string;
  name: string;
  status: StopStatus;
  /** 原调音结论，转待复测/复测时不改动 */
  tuningConclusion: string;
  entries: PressureEntry[];
}

/** 每个场馆独立保存各自的音栓组状态 */
export interface WindVenue {
  name: string;
  stops: WindStop[];
}

export interface WindState {
  venues: Record<string, WindVenue>;
  /** 当前选中的场馆名，切换后分别保存，刷新后回到该场馆 */
  currentVenue: string;
}

export interface RegisterInput {
  venueName: string;
  stopName: string;
  kind: RegistrationKind;
  date: string;
  points: { pointId: string; staticP: number; playingMinP: number }[];
  note?: string;
  /** 音栓不存在时附带的原调音结论（新音栓随首次登记建立） */
  tuningConclusion?: string;
}

export interface RegisterResult {
  entry: PressureEntry;
  summary: PressureSummary;
  stopId: string;
  status: StopStatus;
  locked: boolean;
  /** 复测合格并恢复原结论时为 true */
  restored: boolean;
}

const STORAGE_KEY = "organ-wind-pressure:v1";

export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

interface SeedStopSpec {
  name: string;
  status: StopStatus;
  tuningConclusion: string;
  kind: RegistrationKind;
  date: string;
  note: string;
  points: { pointId: string; staticP: number; playingMinP: number }[];
}

function buildSeedStop(spec: SeedStopSpec): WindStop {
  const summary = summarizePressure(spec.points);
  const entry: PressureEntry = {
    id: createId("entry"),
    kind: spec.kind,
    date: spec.date,
    staticPressure: summary.points[0]?.staticP ?? 0,
    playingMinPressure: Math.min(...summary.points.map((p) => p.playingMinP)),
    note: spec.note,
    registeredAt: spec.date,
    summary,
  };
  return {
    id: createId("stop"),
    name: spec.name,
    status: spec.status,
    tuningConclusion: spec.tuningConclusion,
    entries: [entry],
  };
}

function buildSeedState(): WindState {
  const stops: Record<string, SeedStopSpec[]> = {
    "Abbey Room": [
      {
        name: "Bourdon 16'",
        status: "pending",
        tuningConclusion: "F2 −12cent，标记复检",
        kind: "maintenance",
        date: "2026-09-12",
        note: "低音区风箱供风不稳，整组待复测",
        points: [
          { pointId: "F2", staticP: 62, playingMinP: 54 },
          { pointId: "A2", staticP: 62, playingMinP: 60 },
          { pointId: "C3", staticP: 62, playingMinP: 61 },
        ],
      },
    ],
    "St.Mary": [
      {
        name: "Trumpet 8'",
        status: "normal",
        tuningConclusion: "C#4 +9cent，簧片微调后合格",
        kind: "retest",
        date: "2026-09-10",
        note: "更换簧片压板后复测合格，恢复使用",
        points: [
          { pointId: "C#4", staticP: 70, playingMinP: 66 },
          { pointId: "G4", staticP: 70, playingMinP: 67 },
        ],
      },
    ],
    "ConcertHall A": [
      {
        name: "Principal 4'",
        status: "normal",
        tuningConclusion: "G3 −3cent，正常",
        kind: "maintenance",
        date: "2026-09-15",
        note: "供风稳定",
        points: [
          { pointId: "G3", staticP: 65, playingMinP: 62 },
          { pointId: "C4", staticP: 65, playingMinP: 63 },
        ],
      },
    ],
  };

  const venues: Record<string, WindVenue> = {};
  for (const [venueName, specs] of Object.entries(stops)) {
    venues[venueName] = {
      name: venueName,
      stops: specs.map(buildSeedStop),
    };
  }

  return { currentVenue: "Abbey Room", venues };
}

/** 只做最外层形状校验，结构损坏时回退种子数据 */
function isWindState(value: unknown): value is WindState {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.currentVenue === "string" &&
    typeof s.venues === "object" &&
    s.venues !== null
  );
}

function loadState(): WindState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isWindState(parsed)) return parsed;
    }
  } catch {
    // localStorage 不可用或数据损坏时使用种子数据
  }
  return buildSeedState();
}

function saveState(state: WindState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用时仅保留内存状态
  }
}

export interface WindStore {
  state: WindState;
  venue: WindVenue;
  venueNames: string[];
  switchVenue: (name: string) => void;
  addVenue: (name: string) => void;
  registerReading: (input: RegisterInput) => RegisterResult;
}

/**
 * 风箱压力状态：以场馆为键分别保存；每次写入同步到 localStorage，
 * 刷新页面后可重新读出（“切换场馆后各组状态分别保存，刷新仍可读”）。
 *
 * 用 ref 同步持有最新状态，使 registerReading 在事件处理中能
 * 立即返回判定结果，同时由 effect 统一负责持久化。
 */
export function useWindStore(): WindStore {
  const stateRef = useRef<WindState | null>(null);
  if (stateRef.current === null) {
    stateRef.current = loadState();
  }
  const [, setVersion] = useState(0);

  const commit = useCallback((next: WindState) => {
    stateRef.current = next;
    setVersion((v) => v + 1);
  }, []);

  const state = stateRef.current;

  useEffect(() => {
    saveState(state);
  }, [state]);

  const switchVenue = useCallback(
    (name: string) => {
      const current = stateRef.current as WindState;
      if (current.venues[name] && current.currentVenue !== name) {
        commit({ ...current, currentVenue: name });
      }
    },
    [commit]
  );

  const addVenue = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const current = stateRef.current as WindState;
      if (current.venues[trimmed]) {
        if (current.currentVenue !== trimmed) {
          commit({ ...current, currentVenue: trimmed });
        }
        return;
      }
      commit({
        ...current,
        currentVenue: trimmed,
        venues: {
          ...current.venues,
          [trimmed]: { name: trimmed, stops: [] },
        },
      });
    },
    [commit]
  );

  const registerReading = useCallback(
    (input: RegisterInput): RegisterResult => {
      const current = stateRef.current as WindState;
      const summary = summarizePressure(input.points);
      const entry: PressureEntry = {
        id: createId("entry"),
        kind: input.kind,
        date: input.date,
        staticPressure: summary.points[0]?.staticP ?? 0,
        playingMinPressure: summary.points.length
          ? Math.min(...summary.points.map((p) => p.playingMinP))
          : 0,
        summary,
        note: input.note?.trim() || undefined,
        registeredAt: new Date().toISOString(),
      };

      const existingVenue = current.venues[input.venueName];
      const venue: WindVenue = existingVenue ?? {
        name: input.venueName,
        stops: [],
      };

      const oldStop = venue.stops.find((s) => s.name === input.stopName);

      // 待复测组的唯一解锁途径是复测合格：其他登记一律拒绝，保持锁定
      if (oldStop && oldStop.status === "pending" && input.kind !== "retest") {
        throw new Error("该音栓已锁定为待复测，只能登记复测结果");
      }

      const status = nextStopStatus(
        oldStop?.status ?? "normal",
        input.kind,
        !summary.exceeds
      );
      const nextStop: WindStop = oldStop
        ? {
            ...oldStop,
            status,
            // 原调音结论保留不动，仅追加本次风压记录
            entries: [...oldStop.entries, entry],
          }
        : {
            id: createId("stop"),
            name: input.stopName,
            status,
            tuningConclusion: input.tuningConclusion?.trim() || "（未填写调音结论）",
            entries: [entry],
          };

      const result: RegisterResult = {
        entry,
        summary,
        stopId: nextStop.id,
        status,
        locked: status === "pending",
        restored:
          input.kind === "retest" &&
          !summary.exceeds &&
          (oldStop?.status ?? "normal") === "pending",
      };

      commit({
        ...current,
        currentVenue: venue.name,
        venues: {
          ...current.venues,
          [venue.name]: {
            ...venue,
            stops: [
              ...venue.stops.filter((s) => s.id !== nextStop.id),
              nextStop,
            ],
          },
        },
      });

      return result;
    },
    [commit]
  );

  const venue = state.venues[state.currentVenue] ?? {
    name: state.currentVenue,
    stops: [],
  };

  return {
    state,
    venue,
    venueNames: Object.keys(state.venues),
    switchVenue,
    addVenue,
    registerReading,
  };
}
