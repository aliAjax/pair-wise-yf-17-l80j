/**
 * 风箱压力复测 · 业务层二：状态存储
 * useWindPressure 以 React 状态承载各组状态，按场馆分别持久化到
 * localStorage；刷新后读回，不依赖任何后端。
 */
import { useEffect, useState } from "react";
import {
  PRESSURE_DROP_LIMIT_PA,
  RESPONSE_SPREAD_LIMIT_PA,
  STORAGE_VERSION,
  createStopState,
  registerMaintenance as applyMaintenance,
  submitRetest as applyRetest,
  type MaintenanceRecord,
  type PressurePoint,
  type RegisterInput,
  type RetestInput,
  type RetestRecord,
  type StopInfo,
  type StopState,
  type VenueData,
} from "./pressureLogic";

const STORAGE_KEY = `hxyfront-62005.windPressure.v${STORAGE_VERSION}`;
const ACTIVE_KEY = `hxyfront-62005.windPressure.v${STORAGE_VERSION}.active`;

/** 演示用固定时间戳，保证种子数据展示稳定 */
const SEED_BASE = Date.UTC(2026, 8, 20, 2, 0, 0);

interface PersistShape {
  version: number;
  venues: VenueData[];
}

interface PressureSeed {
  stop: StopInfo;
  /** 每次维护：[日期, 技术员, 测点, 备注]，时间戳依次递增 */
  maintenances?: Array<{
    date: string;
    technician: string;
    points: PressurePoint[];
    note: string;
  }>;
}

interface VenueSeed {
  id: string;
  name: string;
  stops: PressureSeed[];
}

const VENUE_SEEDS: VenueSeed[] = [
  {
    id: "st-mary",
    name: "St.Mary 教堂",
    stops: [
      {
        stop: {
          id: "mary-trumpet-8",
          name: "Trumpet 8'",
          tuningConclusion: "C#4 +9cent，簧片需微调（保留）",
        },
        maintenances: [
          {
            date: "2026-09-18",
            technician: "林师傅",
            points: [
              { point: "低音 C2", staticPressure: 62, playingMinPressure: 58 },
              { point: "中音 C4", staticPressure: 62.5, playingMinPressure: 54.5 },
              { point: "高音 C6", staticPressure: 61.5, playingMinPressure: 59 },
            ],
            note: "簧片音栓全键域风压复测",
          },
        ],
      },
      {
        stop: {
          id: "mary-principal-4",
          name: "Principal 4'",
          tuningConclusion: "G3 -3cent，正常（保留）",
        },
        maintenances: [
          {
            date: "2026-09-18",
            technician: "林师傅",
            points: [
              { point: "低音 C2", staticPressure: 55, playingMinPressure: 52.5 },
              { point: "中音 C4", staticPressure: 55, playingMinPressure: 52 },
              { point: "高音 C6", staticPressure: 54.5, playingMinPressure: 52 },
            ],
            note: "主音栓例行检测，响应齐整",
          },
        ],
      },
      {
        stop: {
          id: "mary-bourdon-16",
          name: "Bourdon 16'",
          tuningConclusion: "F2 -12cent，标记复检（保留）",
        },
        maintenances: [
          {
            date: "2026-09-15",
            technician: "周工",
            points: [
              { point: "低音 C1", staticPressure: 70, playingMinPressure: 61 },
              { point: "中音 C3", staticPressure: 69.5, playingMinPressure: 62 },
            ],
            note: "低音区供风滞后，初查",
          },
          {
            date: "2026-09-18",
            technician: "林师傅",
            points: [
              { point: "低音 C1", staticPressure: 71, playingMinPressure: 63.5 },
              { point: "中音 C3", staticPressure: 70.5, playingMinPressure: 64 },
            ],
            note: "风囊密封条处理后复查",
          },
        ],
      },
      {
        stop: {
          id: "mary-mixture-2",
          name: "Mixture II 2'",
          tuningConclusion: "整组 +2cent，稳定（保留）",
        },
      },
    ],
  },
  {
    id: "concert-hall-a",
    name: "ConcertHall A 音乐厅",
    stops: [
      {
        stop: {
          id: "hall-principal-8",
          name: "Principal 8'",
          tuningConclusion: "A4 +1cent，正常（保留）",
        },
      },
      {
        stop: {
          id: "hall-gamba-8",
          name: "Gamba 8'",
          tuningConclusion: "E4 -4cent，继续观察（保留）",
        },
      },
      {
        stop: {
          id: "hall-oboe-8",
          name: "Oboe 8'",
          tuningConclusion: "簧片状态良好（保留）",
        },
      },
    ],
  },
];

function buildSeedVenues(): VenueData[] {
  return VENUE_SEEDS.map((seed, venueIndex) => {
    let venue: VenueData = {
      id: seed.id,
      name: seed.name,
      stops: seed.stops.map((s) => s.stop),
      states: seed.stops.map((s) => createStopState(s.stop.id)),
      maintenances: {},
      retests: {},
    };

    seed.stops.forEach((entry, stopIndex) => {
      (entry.maintenances ?? []).forEach((m, mIndex) => {
        const input: RegisterInput = {
          stopId: entry.stop.id,
          date: m.date,
          technician: m.technician,
          points: m.points,
          note: m.note,
          createdAt: SEED_BASE + venueIndex * 86_400_000 + stopIndex * 600_000 + mIndex * 60_000,
        };
        venue = applyMaintenance(venue, input);
      });
    });

    return venue;
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizePoint(value: unknown): PressurePoint | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const staticPressure = toFiniteNumber(obj.staticPressure);
  const playingMinPressure = toFiniteNumber(obj.playingMinPressure);
  if (staticPressure === null || playingMinPressure === null) return null;
  return {
    point: typeof obj.point === "string" ? obj.point : "未命名测点",
    staticPressure,
    playingMinPressure,
  };
}

function normalizeMetric(value: unknown) {
  const obj = asRecord(value);
  const maxDrop = toFiniteNumber(obj?.maxDrop);
  const responseSpread = toFiniteNumber(obj?.responseSpread);
  if (maxDrop === null || responseSpread === null) return null;
  return { maxDrop, responseSpread };
}

function normalizeMaintenance(value: unknown): MaintenanceRecord | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const points = Array.isArray(obj.points)
    ? obj.points.map(normalizePoint).filter((p): p is PressurePoint => p !== null)
    : [];
  if (points.length === 0) return null;
  const metric = normalizeMetric(obj.metric);
  if (!metric) return null;
  return {
    id: typeof obj.id === "string" ? obj.id : `mnt-${Math.random()}`,
    date: typeof obj.date === "string" ? obj.date : "",
    technician: typeof obj.technician === "string" ? obj.technician : "",
    points,
    metric,
    triggeredRetest: obj.triggeredRetest === true,
    reasons: Array.isArray(obj.reasons) ? obj.reasons.filter((r): r is string => typeof r === "string") : [],
    note: typeof obj.note === "string" ? obj.note : "",
    createdAt: toFiniteNumber(obj.createdAt) ?? 0,
  };
}

function normalizeRetest(value: unknown): RetestRecord | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const points = Array.isArray(obj.points)
    ? obj.points.map(normalizePoint).filter((p): p is PressurePoint => p !== null)
    : [];
  if (points.length === 0) return null;
  const metric = normalizeMetric(obj.metric);
  if (!metric) return null;
  return {
    id: typeof obj.id === "string" ? obj.id : `ret-${Math.random()}`,
    date: typeof obj.date === "string" ? obj.date : "",
    technician: typeof obj.technician === "string" ? obj.technician : "",
    points,
    metric,
    passed: obj.passed === true,
    reasons: Array.isArray(obj.reasons) ? obj.reasons.filter((r): r is string => typeof r === "string") : [],
    note: typeof obj.note === "string" ? obj.note : "",
    createdAt: toFiniteNumber(obj.createdAt) ?? 0,
  };
}

function normalizeRecordMap<T>(
  value: unknown,
  normalize: (item: unknown) => T | null
): Record<string, T[]> {
  const obj = asRecord(value) ?? {};
  const result: Record<string, T[]> = {};
  for (const [key, rawList] of Object.entries(obj)) {
    if (!Array.isArray(rawList)) continue;
    const items = rawList.map(normalize).filter((item): item is T => item !== null);
    if (items.length > 0) result[key] = items;
  }
  return result;
}

function normalizeVenue(value: unknown, fallback: VenueData): VenueData {
  const obj = asRecord(value);
  if (!obj || obj.id !== fallback.id) return fallback;

  const stopIds = new Set(fallback.stops.map((s) => s.id));
  const stateList: StopState[] = fallback.stops.map((s) => createStopState(s.id));
  if (Array.isArray(obj.states)) {
    for (const raw of obj.states) {
      const stateObj = asRecord(raw);
      if (!stateObj || typeof stateObj.stopId !== "string") continue;
      const index = stateList.findIndex((s) => s.stopId === stateObj.stopId);
      if (index < 0 || !stopIds.has(stateObj.stopId)) continue;
      if (stateObj.status !== "normal" && stateObj.status !== "pending") continue;
      stateList[index] = {
        stopId: stateObj.stopId,
        status: stateObj.status,
        pendingSince: toFiniteNumber(stateObj.pendingSince),
      };
    }
  }

  const maintenances = normalizeRecordMap(obj.maintenances, normalizeMaintenance);
  for (const key of Object.keys(maintenances)) {
    if (!stopIds.has(key)) delete maintenances[key];
  }
  const retests = normalizeRecordMap(obj.retests, normalizeRetest);
  for (const key of Object.keys(retests)) {
    if (!stopIds.has(key)) delete retests[key];
  }

  return {
    id: fallback.id,
    name: typeof obj.name === "string" && obj.name ? obj.name : fallback.name,
    stops: fallback.stops,
    states: stateList,
    maintenances,
    retests,
  };
}

function loadStored(): { venues: VenueData[]; activeId: string | null } {
  const seeds = buildSeedVenues();
  let activeId: string | null = null;
  try {
    const rawActive = window.localStorage.getItem(ACTIVE_KEY);
    if (rawActive) activeId = rawActive;
  } catch {
    /* localStorage 不可用时退回内存态 */
  }

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return { venues: seeds, activeId };
  }
  if (!raw) return { venues: seeds, activeId };

  try {
    const parsed = JSON.parse(raw) as PersistShape;
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.venues)) {
      return { venues: seeds, activeId };
    }
    const venues = seeds.map((seed) => {
      const found = parsed.venues.find((v) => asRecord(v)?.id === seed.id);
      return found ? normalizeVenue(found, seed) : seed;
    });
    if (activeId && !venues.some((v) => v.id === activeId)) activeId = null;
    return { venues, activeId };
  } catch {
    return { venues: seeds, activeId };
  }
}

export interface WindPressureStore {
  venues: VenueData[];
  activeVenue: VenueData;
  activeVenueId: string;
  setActiveVenue: (id: string) => void;
  registerMaintenance: (input: RegisterInput) => void;
  submitRetest: (input: RetestInput) => void;
  resetDemo: () => void;
}

export function useWindPressure(): WindPressureStore {
  const [{ venues, activeId }, setState] = useState(() => {
    const loaded = loadStored();
    return {
      venues: loaded.venues,
      activeId: loaded.activeId ?? loaded.venues[0].id,
    };
  });

  useEffect(() => {
    try {
      const payload: PersistShape = { version: STORAGE_VERSION, venues };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      window.localStorage.setItem(ACTIVE_KEY, activeId);
    } catch {
      /* 存储失败不影响当前会话 */
    }
  }, [venues, activeId]);

  const updateActiveVenue = (updater: (venue: VenueData) => VenueData) => {
    setState((prev) => ({
      ...prev,
      venues: prev.venues.map((v) => (v.id === prev.activeId ? updater(v) : v)),
    }));
  };

  const activeVenue = venues.find((v) => v.id === activeId) ?? venues[0];

  return {
    venues,
    activeVenue,
    activeVenueId: activeVenue.id,
    setActiveVenue: (id) =>
      setState((prev) =>
        venues.some((v) => v.id === id) ? { ...prev, activeId: id } : prev
      ),
    registerMaintenance: (input) => updateActiveVenue((v) => applyMaintenance(v, input)),
    submitRetest: (input) => updateActiveVenue((v) => applyRetest(v, input)),
    resetDemo: () => {
      const seeds = buildSeedVenues();
      setState({ venues: seeds, activeId: seeds[0].id });
    },
  };
}

export const THRESHOLD_TEXT = {
  response: RESPONSE_SPREAD_LIMIT_PA,
  drop: PRESSURE_DROP_LIMIT_PA,
};

export type { StopInfo };
