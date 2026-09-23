/**
 * 风箱压力复测 · 业务层三：页面展示
 * 仅负责渲染与表单交互；判定取自 pressureLogic，状态取自 pressureStore。
 */
import { useMemo, useState } from "react";
import {
  evaluatePressure,
  getLatestMaintenance,
  getPendingStopIds,
  getStopState,
  PRESSURE_DROP_LIMIT_PA,
  RESPONSE_SPREAD_LIMIT_PA,
  type PressurePoint,
  type VenueData,
} from "./pressureLogic";
import { THRESHOLD_TEXT, useWindPressure } from "./pressureStore";

type EditorMode = "maintenance" | "retest";

interface DraftRow {
  point: string;
  staticPressure: string;
  playingMinPressure: string;
}

interface RowCheck {
  valid: boolean;
  error: string;
}

const STATUS_LABEL: Record<"normal" | "pending", string> = {
  normal: "正常",
  pending: "待复测",
};

function todayText(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function emptyRow(index: number): DraftRow {
  return { point: `测点 ${index}`, staticPressure: "", playingMinPressure: "" };
}

function checkRow(row: DraftRow): RowCheck {
  if (!row.point.trim()) return { valid: false, error: "测点名称为空" };
  const staticValue = Number(row.staticPressure);
  const playingValue = Number(row.playingMinPressure);
  if (row.staticPressure.trim() === "" || !Number.isFinite(staticValue)) {
    return { valid: false, error: "静压需填数字" };
  }
  if (row.playingMinPressure.trim() === "" || !Number.isFinite(playingValue)) {
    return { valid: false, error: "演奏最低风压需填数字" };
  }
  if (playingValue > staticValue) {
    return { valid: false, error: "演奏最低风压不能高于静压" };
  }
  return { valid: true, error: "" };
}

function pa(value: number): string {
  return `${value.toFixed(1)} Pa`;
}

function MetricTag(props: { label: string; value: number; limit: number; exceeded: boolean }) {
  return (
    <span className={props.exceeded ? "wp-tag wp-tag-bad" : "wp-tag wp-tag-ok"}>
      {props.label} <b>{pa(props.value)}</b>
      <em>
        {props.exceeded ? ">" : "≤"} 限 {props.limit} Pa
      </em>
    </span>
  );
}

function StopCard(props: {
  venue: VenueData;
  stopId: string;
  selected: boolean;
  onSelect: (stopId: string) => void;
  onRegister: (stopId: string) => void;
  onRetest: (stopId: string) => void;
}) {
  const { venue, stopId } = props;
  const stop = venue.stops.find((s) => s.id === stopId);
  const state = getStopState(venue, stopId);
  const latest = getLatestMaintenance(venue, stopId);
  if (!stop) return null;
  const pending = state.status === "pending";

  return (
    <article
      className={
        pending
          ? "wp-stop wp-stop-pending" + (props.selected ? " wp-stop-active" : "")
          : "wp-stop" + (props.selected ? " wp-stop-active" : "")
      }
      onClick={() => props.onSelect(stopId)}
    >
      <div className="wp-stop-head">
        <h3>{stop.name}</h3>
        <span className={pending ? "wp-badge wp-badge-pending" : "wp-badge wp-badge-normal"}>
          {STATUS_LABEL[state.status]}
        </span>
      </div>

      <p className="wp-conclusion">
        <span className="wp-lock" title="原调音结论保留，复测流程不修改">
          {pending ? "🔒" : "📋"}
        </span>
        原调音结论：{stop.tuningConclusion}
      </p>

      <div className="wp-stop-metrics">
        {latest ? (
          <>
            <MetricTag
              label="最近压降"
              value={latest.metric.maxDrop}
              limit={THRESHOLD_TEXT.drop}
              exceeded={latest.metric.maxDrop > THRESHOLD_TEXT.drop}
            />
            <MetricTag
              label="最近响应差"
              value={latest.metric.responseSpread}
              limit={THRESHOLD_TEXT.response}
              exceeded={latest.metric.responseSpread > THRESHOLD_TEXT.response}
            />
          </>
        ) : (
          <span className="wp-empty">暂无维护记录</span>
        )}
      </div>

      <div className="wp-stop-actions" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => props.onRegister(stopId)}>登记维护</button>
        {pending ? (
          <button className="primary" onClick={() => props.onRetest(stopId)}>
            提交复测
          </button>
        ) : (
          <button className="wp-retest-locked" disabled title="仅待复测音栓组可复测">
            复测（锁定中无需）
          </button>
        )}
      </div>
    </article>
  );
}

interface TimelineItem {
  key: string;
  kind: "maintenance" | "retest";
  date: string;
  technician: string;
  note: string;
  points: PressurePoint[];
  maxDrop: number;
  responseSpread: number;
  reasons: string[];
  passed: boolean | null;
  createdAt: number;
}

function StopTimeline(props: { venue: VenueData; stopId: string }) {
  const items = useMemo<TimelineItem[]>(() => {
    const maintenances = (props.venue.maintenances[props.stopId] ?? []).map(
      (m): TimelineItem => ({
        key: m.id,
        kind: "maintenance",
        date: m.date,
        technician: m.technician,
        note: m.note,
        points: m.points,
        maxDrop: m.metric.maxDrop,
        responseSpread: m.metric.responseSpread,
        reasons: m.reasons,
        passed: null,
        createdAt: m.createdAt,
      })
    );
    const retests = (props.venue.retests[props.stopId] ?? []).map(
      (r): TimelineItem => ({
        key: r.id,
        kind: "retest",
        date: r.date,
        technician: r.technician,
        note: r.note,
        points: r.points,
        maxDrop: r.metric.maxDrop,
        responseSpread: r.metric.responseSpread,
        reasons: r.reasons,
        passed: r.passed,
        createdAt: r.createdAt,
      })
    );
    return [...maintenances, ...retests].sort((a, b) => b.createdAt - a.createdAt);
  }, [props.venue, props.stopId]);

  if (items.length === 0) {
    return <p className="wp-empty">该音栓暂无维护与复测记录。</p>;
  }

  return (
    <ol className="wp-timeline">
      {items.map((item) => (
        <li key={item.key} className="wp-timeline-item">
          <div className="wp-timeline-head">
            <span
              className={
                item.kind === "retest"
                  ? item.passed
                    ? "wp-badge wp-badge-normal"
                    : "wp-badge wp-badge-pending"
                  : "wp-badge wp-badge-maint"
              }
            >
              {item.kind === "maintenance"
                ? "维护登记"
                : item.passed
                  ? "复测通过"
                  : "复测未过"}
            </span>
            <b>{item.date}</b>
            <span className="wp-technician">{item.technician}</span>
          </div>
          <div className="wp-timeline-metrics">
            <MetricTag
              label="压降"
              value={item.maxDrop}
              limit={THRESHOLD_TEXT.drop}
              exceeded={item.maxDrop > THRESHOLD_TEXT.drop}
            />
            <MetricTag
              label="响应差"
              value={item.responseSpread}
              limit={THRESHOLD_TEXT.response}
              exceeded={item.responseSpread > THRESHOLD_TEXT.response}
            />
          </div>
          <ul className="wp-point-list">
            {item.points.map((p, i) => (
              <li key={`${p.point}-${i}`}>
                {p.point}：静压 {p.staticPressure} Pa / 演奏最低 {p.playingMinPressure} Pa
                <em>（压降 {pa(p.staticPressure - p.playingMinPressure)}）</em>
              </li>
            ))}
          </ul>
          {item.reasons.length > 0 && (
            <p className="wp-reasons">⚠ {item.reasons.join("；")}</p>
          )}
          {item.note && <p className="wp-note">备注：{item.note}</p>}
        </li>
      ))}
    </ol>
  );
}

export function WindPressurePanel() {
  const store = useWindPressure();
  const { activeVenue } = store;

  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [mode, setMode] = useState<EditorMode | null>(null);
  const [date, setDate] = useState(todayText());
  const [technician, setTechnician] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<DraftRow[]>([emptyRow(1)]);

  const pendingIds = useMemo(() => new Set(getPendingStopIds(activeVenue)), [activeVenue]);
  const selectedStop =
    activeVenue.stops.find((s) => s.id === selectedStopId) ?? activeVenue.stops[0];
  const selectedState = getStopState(activeVenue, selectedStop.id);

  const openEditor = (nextMode: EditorMode, stopId: string) => {
    setSelectedStopId(stopId);
    setMode(nextMode);
    setDate(todayText());
    setTechnician("");
    setNote("");
    setRows([emptyRow(1)]);
  };

  const updateRow = (index: number, patch: Partial<DraftRow>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };
  const addRow = () => setRows((prev) => [...prev, emptyRow(prev.length + 1)]);
  const removeRow = (index: number) =>
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));

  const checks = rows.map(checkRow);
  const validPoints: PressurePoint[] = rows
    .map((r, i) => ({ r, c: checks[i] }))
    .filter(({ c }) => c.valid)
    .map(({ r }) => ({
      point: r.point.trim(),
      staticPressure: Number(r.staticPressure),
      playingMinPressure: Number(r.playingMinPressure),
    }));
  const allValid = validPoints.length === rows.length && rows.length > 0 && technician.trim() !== "";
  const preview = validPoints.length > 0 ? evaluatePressure(validPoints) : null;

  const submit = () => {
    if (!mode || !allValid || !preview) return;
    const base = {
      stopId: selectedStop.id,
      date,
      technician: technician.trim(),
      points: validPoints,
      note: note.trim(),
    };
    if (mode === "maintenance") {
      store.registerMaintenance(base);
    } else {
      store.submitRetest(base);
    }
    setMode(null);
  };

  return (
    <section className="panel wp-panel">
      <div className="heading">
        <div>
          <p>风箱压力复测</p>
          <h2>风压维护与待复测管理</h2>
        </div>
        <button
          className="wp-reset"
          onClick={() => {
            if (window.confirm("恢复演示数据将清除本机已登记的风压记录，确定继续？")) {
              store.resetDemo();
              setMode(null);
              setSelectedStopId(null);
            }
          }}
        >
          恢复演示数据
        </button>
      </div>

      <p className="wp-rule">
        每次维护登记各测点「静压 / 演奏中最低风压」（单位 Pa）。同一音栓内
        <b> 响应差 &gt; {RESPONSE_SPREAD_LIMIT_PA} Pa</b>（各测点压降最大差异）或
        <b> 压降 &gt; {PRESSURE_DROP_LIMIT_PA} Pa</b> 时，整组转为「待复测」，
        原调音结论保留；复测仅恢复对应音栓，未复测组仍锁定。数据按场馆分别保存在本机。
      </p>

      <div className="wp-venues" role="tablist" aria-label="场馆切换">
        {store.venues.map((v) => {
          const pendingCount = getPendingStopIds(v).length;
          return (
            <button
              key={v.id}
              role="tab"
              aria-selected={v.id === store.activeVenueId}
              className={
                v.id === store.activeVenueId
                  ? "wp-venue wp-venue-active"
                  : "wp-venue"
              }
              onClick={() => {
                store.setActiveVenue(v.id);
                setMode(null);
                setSelectedStopId(null);
              }}
            >
              {v.name}
              {pendingCount > 0 && <span className="wp-venue-count">{pendingCount} 待复测</span>}
            </button>
          );
        })}
      </div>

      <p className="wp-summary">
        共 {activeVenue.stops.length} 个音栓组，当前
        <b className={pendingIds.size > 0 ? "wp-summary-bad" : "wp-summary-ok"}>
          {" "}{pendingIds.size} 组待复测
        </b>
        ；切换场馆后各组状态分别保存，刷新页面仍可读取。
      </p>

      <div className="wp-stops">
        {activeVenue.stops.map((stop) => (
          <StopCard
            key={stop.id}
            venue={activeVenue}
            stopId={stop.id}
            selected={stop.id === selectedStop.id}
            onSelect={(id) => {
              setSelectedStopId(id);
              setMode(null);
            }}
            onRegister={(id) => openEditor("maintenance", id)}
            onRetest={(id) => openEditor("retest", id)}
          />
        ))}
      </div>

      {mode && (
        <div className="wp-editor">
          <div className="wp-editor-head">
            <h3>
              {mode === "maintenance" ? "登记维护" : "提交复测"} · {selectedStop.name}
            </h3>
            <button onClick={() => setMode(null)}>收起</button>
          </div>

          {mode === "retest" && selectedState.status !== "pending" && (
            <p className="wp-reasons">该音栓组当前不在待复测状态，复测仅用于恢复待复测组。</p>
          )}
          {mode === "maintenance" && pendingIds.has(selectedStop.id) && (
            <p className="wp-reasons">
              该组正处于待复测锁定状态；若本次登记再次超限将继续锁定，合格登记也不会自动解锁，请通过复测恢复。
            </p>
          )}

          <div className="wp-form-grid">
            <label>
              <span>日期</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label>
              <span>维护人</span>
              <input
                placeholder="填写维护人姓名"
                value={technician}
                onChange={(e) => setTechnician(e.target.value)}
              />
            </label>
          </div>

          <div className="wp-rows">
            {rows.map((row, index) => (
              <div className="wp-row" key={index}>
                <label className="wp-row-point">
                  <span>测点 {index + 1}</span>
                  <input
                    placeholder="如：低音 C2"
                    value={row.point}
                    onChange={(e) => updateRow(index, { point: e.target.value })}
                  />
                </label>
                <label>
                  <span>静压 (Pa)</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    placeholder="如 62"
                    value={row.staticPressure}
                    onChange={(e) => updateRow(index, { staticPressure: e.target.value })}
                  />
                </label>
                <label>
                  <span>演奏最低风压 (Pa)</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    placeholder="如 56"
                    value={row.playingMinPressure}
                    onChange={(e) =>
                      updateRow(index, { playingMinPressure: e.target.value })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="wp-row-remove"
                  disabled={rows.length <= 1}
                  onClick={() => removeRow(index)}
                  title="删除测点"
                >
                  ✕
                </button>
                {!checks[index].valid && (
                  <span className="wp-row-error">{checks[index].error}</span>
                )}
              </div>
            ))}
          </div>

          <div className="wp-editor-tools">
            <button type="button" onClick={addRow}>
              + 增加测点
            </button>
            {preview && (
              <div className="wp-preview">
                <MetricTag
                  label="实时压降"
                  value={preview.metric.maxDrop}
                  limit={THRESHOLD_TEXT.drop}
                  exceeded={preview.dropExceeded}
                />
                <MetricTag
                  label="实时响应差"
                  value={preview.metric.responseSpread}
                  limit={THRESHOLD_TEXT.response}
                  exceeded={preview.responseExceeded}
                />
                <span className={preview.ok ? "wp-preview-ok" : "wp-preview-bad"}>
                  {preview.ok
                    ? "判定合格：组状态保持/复测可恢复"
                    : `将转为待复测：${preview.reasons.join("；")}`}
                </span>
                <span className="wp-preview-count">
                  有效测点 {validPoints.length}/{rows.length}
                </span>
              </div>
            )}
          </div>

          <label className="wp-note-field">
            <span>备注</span>
            <input
              placeholder="如：风囊密封条处理后复查"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>

          <div className="wp-submit">
            <button onClick={() => setMode(null)}>取消</button>
            <button className="primary" disabled={!allValid} onClick={submit}>
              {mode === "maintenance" ? "保存维护登记" : "保存复测结果"}
            </button>
          </div>
        </div>
      )}

      <div className="wp-history">
        <h3>维护 / 复测记录 · {selectedStop.name}</h3>
        <StopTimeline venue={activeVenue} stopId={selectedStop.id} />
      </div>
    </section>
  );
}
