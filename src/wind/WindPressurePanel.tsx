import { useMemo, useState } from "react";
import {
  PRESSURE_DROP_LIMIT,
  RESPONSE_DIFF_LIMIT,
  summarizePressure,
} from "./pressure";
import {
  useWindStore,
  type PressureEntry,
  type RegisterInput,
  type RegisterResult,
  type WindStop,
} from "./storage";

interface PointRow {
  pointId: string;
  staticP: string;
  playingMinP: string;
}

interface FormMode {
  kind: "maintenance" | "retest";
  stopId: string | null;
  stopName: string;
  tuningConclusion: string;
}

interface Banner {
  tone: "warn" | "ok";
  text: string;
}

function today(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const KIND_LABEL: Record<PressureEntry["kind"], string> = {
  maintenance: "维护登记",
  retest: "复测",
};

function StatusBadge({ status }: { status: WindStop["status"] }) {
  return status === "pending" ? (
    <span className="wind-badge wind-badge-pending">待复测 · 已锁定</span>
  ) : (
    <span className="wind-badge wind-badge-normal">正常</span>
  );
}

function MetricLine({ entry }: { entry: PressureEntry }) {
  const { maxDrop, responseDiff, exceeds } = entry.summary;
  return (
    <span className={exceeds ? "wind-metric wind-metric-bad" : "wind-metric"}>
      最大压降 {maxDrop}Pa · 组内响应差 {responseDiff}Pa ·{" "}
      {exceeds ? "超限" : "合格"}
    </span>
  );
}

function EntryCard({ entry }: { entry: PressureEntry }) {
  return (
    <div className="wind-entry">
      <div className="wind-entry-head">
        <span className="wind-entry-kind">{KIND_LABEL[entry.kind]}</span>
        <time>{entry.date}</time>
      </div>
      <p className="wind-entry-pressures">
        静压 {entry.staticPressure}Pa ／ 演奏中最低风压 {entry.playingMinPressure}
        Pa
      </p>
      <MetricLine entry={entry} />
      <ul className="wind-points">
        {entry.summary.points.map((p) => (
          <li key={p.pointId}>
            {p.pointId}：{p.staticP}Pa → {p.playingMinP}Pa（压降 {p.drop}Pa）
          </li>
        ))}
      </ul>
      {entry.summary.reasons.length > 0 && (
        <ul className="wind-reasons">
          {entry.summary.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {entry.kind === "retest" && !entry.summary.exceeds && (
        <p className="wind-restored">复测合格，恢复该音栓；原调音结论不变。</p>
      )}
      {entry.note && <p className="wind-note">备注：{entry.note}</p>}
    </div>
  );
}

function compilePoints(rows: PointRow[]): RegisterInput["points"] | string {
  const filled = rows.filter(
    (r) => r.pointId.trim() || r.staticP.trim() || r.playingMinP.trim()
  );
  if (filled.length === 0) return "至少填写一个测点";
  const points: RegisterInput["points"] = [];
  const seen = new Set<string>();
  for (const r of filled) {
    const pointId = r.pointId.trim();
    if (!pointId || !r.staticP.trim() || !r.playingMinP.trim()) {
      return "每个测点需填写编号、静压与最低风压";
    }
    if (seen.has(pointId)) return `测点编号重复：${pointId}`;
    seen.add(pointId);
    const staticP = Number(r.staticP);
    const playingMinP = Number(r.playingMinP);
    if (!Number.isFinite(staticP) || !Number.isFinite(playingMinP)) {
      return "风压数值不正确";
    }
    if (playingMinP > staticP) {
      return `测点 ${pointId}：最低风压不能高于静压`;
    }
    points.push({ pointId, staticP, playingMinP });
  }
  return points;
}

function StopCard({
  stop,
  onOpen,
}: {
  stop: WindStop;
  onOpen: (mode: FormMode) => void;
}) {
  const pending = stop.status === "pending";
  return (
    <article className={pending ? "wind-stop wind-stop-locked" : "wind-stop"}>
      <div className="wind-stop-head">
        <h3>{stop.name}</h3>
        <StatusBadge status={stop.status} />
      </div>
      <p className="wind-conclusion">
        <span>原调音结论</span>
        {stop.tuningConclusion}
      </p>
      <div className="wind-stop-actions">
        {pending ? (
          <>
            <button
              className="primary"
              onClick={() =>
                onOpen({
                  kind: "retest",
                  stopId: stop.id,
                  stopName: stop.name,
                  tuningConclusion: stop.tuningConclusion,
                })
              }
            >
              复测本组
            </button>
            <button disabled title="待复测组只能登记复测">
              维护登记已锁定
            </button>
          </>
        ) : (
          <button
            onClick={() =>
              onOpen({
                kind: "maintenance",
                stopId: stop.id,
                stopName: stop.name,
                tuningConclusion: stop.tuningConclusion,
              })
            }
          >
            登记维护
          </button>
        )}
      </div>
      <div className="wind-entries">
        {stop.entries
          .slice()
          .reverse()
          .map((entry) => (
            <EntryCard key={entry.id} entry={entry} />
          ))}
      </div>
    </article>
  );
}

/**
 * 风压登记表单：本地维护输入与实时判定，提交时通过 submit 回调写入 store。
 */
function EntryForm({
  mode,
  onModeChange,
  venueName,
  onClose,
  submit,
}: {
  mode: FormMode;
  onModeChange: (mode: FormMode) => void;
  venueName: string;
  onClose: () => void;
  submit: (
    date: string,
    note: string,
    rows: PointRow[],
    tuning: string
  ) => void;
}) {
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [tuningConclusion, setTuningConclusion] = useState(
    mode.tuningConclusion
  );
  const [rows, setRows] = useState<PointRow[]>([
    { pointId: "", staticP: "", playingMinP: "" },
    { pointId: "", staticP: "", playingMinP: "" },
  ]);
  const [error, setError] = useState<string | null>(null);

  const isNew = mode.stopId === null;
  const isRetest = mode.kind === "retest";

  const preview = useMemo(() => {
    const compiled = compilePoints(rows);
    if (typeof compiled === "string") return null;
    return summarizePressure(compiled);
  }, [rows]);

  const updateRow = (index: number, patch: Partial<PointRow>) => {
    setRows((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...patch } : r))
    );
  };

  const handleSubmit = () => {
    const compiled = compilePoints(rows);
    if (typeof compiled === "string") {
      setError(compiled);
      return;
    }
    if (!date) {
      setError("请选择日期");
      return;
    }
    if (!mode.stopName.trim()) {
      setError("请填写音栓名称");
      return;
    }
    if (isNew && !tuningConclusion.trim()) {
      setError("首次登记请填写原调音结论（将长期保留）");
      return;
    }
    setError(null);
    submit(date, note, rows, tuningConclusion);
  };

  return (
    <div className="wind-form" role="dialog" aria-label="风箱压力登记">
      <div className="wind-form-head">
        <h3>
          {isRetest ? "风箱压力复测" : "风箱压力维护登记"} ·{" "}
          {mode.stopName || "新音栓"}
        </h3>
        <button type="button" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>
      <p className="wind-form-venue">场馆：{venueName}</p>
      {isRetest && (
        <p className="wind-form-hint">
          复测仅恢复本音栓；其他未复测组仍保持锁定，原调音结论保留不动。
        </p>
      )}

      <div className="wind-form-grid">
        <label>
          <span>日期</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          <span>音栓{isNew ? "名称" : "（不可改）"}</span>
          <input
            value={mode.stopName}
            disabled={!isNew}
            onChange={(e) => onModeChange({ ...mode, stopName: e.target.value })}
          />
        </label>
      </div>

      {isNew && (
        <label className="wind-form-full">
          <span>原调音结论（转待复测/复测后仍保留）</span>
          <input
            value={tuningConclusion}
            placeholder="如：F2 −12cent，标记复检"
            onChange={(e) => setTuningConclusion(e.target.value)}
          />
        </label>
      )}

      <div className="wind-point-table">
        <div className="wind-point-row wind-point-header">
          <span>测点（音管/键位）</span>
          <span>静压 Pa</span>
          <span>演奏中最低风压 Pa</span>
          <span>压降</span>
        </div>
        {rows.map((row, i) => {
          const s = Number(row.staticP);
          const p = Number(row.playingMinP);
          const drop =
            row.staticP !== "" &&
            row.playingMinP !== "" &&
            Number.isFinite(s) &&
            Number.isFinite(p)
              ? Math.round((s - p) * 10) / 10
              : null;
          return (
            <div className="wind-point-row" key={i}>
              <input
                value={row.pointId}
                placeholder="如 F2"
                onChange={(e) => updateRow(i, { pointId: e.target.value })}
              />
              <input
                type="number"
                value={row.staticP}
                inputMode="decimal"
                placeholder="如 62"
                onChange={(e) => updateRow(i, { staticP: e.target.value })}
              />
              <input
                type="number"
                value={row.playingMinP}
                inputMode="decimal"
                placeholder="如 58"
                onChange={(e) => updateRow(i, { playingMinP: e.target.value })}
              />
              <span className="wind-drop-cell">
                {drop === null ? "—" : `${drop}Pa`}
              </span>
            </div>
          );
        })}
      </div>
      <div className="wind-point-actions">
        <button
          type="button"
          onClick={() =>
            setRows((prev) => [
              ...prev,
              { pointId: "", staticP: "", playingMinP: "" },
            ])
          }
        >
          添加测点
        </button>
        {rows.length > 1 && (
          <button
            type="button"
            onClick={() => setRows((prev) => prev.slice(0, -1))}
          >
            删除末行
          </button>
        )}
      </div>

      {preview && (
        <div
          className={
            preview.exceeds ? "wind-preview wind-preview-bad" : "wind-preview"
          }
        >
          实时判定：最大压降 {preview.maxDrop}Pa ／ 响应差{" "}
          {preview.responseDiff}Pa
          {preview.exceeds ? ` —— ${preview.reasons.join("；")}` : " —— 合格"}
        </div>
      )}

      <label className="wind-form-full">
        <span>维修备注</span>
        <input
          value={note}
          placeholder="如：低音区风箱供风不稳"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>

      {error && <p className="wind-error">{error}</p>}

      <div className="wind-form-actions">
        <button type="button" onClick={onClose}>
          取消
        </button>
        <button type="button" className="primary" onClick={handleSubmit}>
          {isRetest ? "提交复测结果" : "提交维护登记"}
        </button>
      </div>
    </div>
  );
}

export default function WindPressurePanel() {
  const store = useWindStore();
  const [mode, setMode] = useState<FormMode | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [newVenue, setNewVenue] = useState("");
  const [banner, setBanner] = useState<Banner | null>(null);

  const openForm = (next: FormMode) => {
    setBanner(null);
    setMode(next);
    setFormKey((k) => k + 1);
  };

  const closeForm = () => setMode(null);

  const submit = (
    dateValue: string,
    noteValue: string,
    rows: PointRow[],
    tuning: string
  ) => {
    if (!mode) return;
    const compiled = compilePoints(rows);
    if (typeof compiled === "string") return;
    const stopName = mode.stopName.trim();
    try {
      const result: RegisterResult = store.registerReading({
        venueName: store.venue.name,
        stopName,
        kind: mode.kind,
        date: dateValue,
        note: noteValue,
        points: compiled,
        tuningConclusion: tuning,
      });

      if (mode.kind === "retest") {
        setBanner(
          result.summary.exceeds
            ? {
                tone: "warn",
                text: `复测仍超限：「${stopName}」继续锁定待复测，原调音结论保留。`,
              }
            : {
                tone: "ok",
                text: `复测合格：「${stopName}」已恢复；其他未复测组仍保持锁定。`,
              }
        );
      } else {
        setBanner(
          result.summary.exceeds
            ? {
                tone: "warn",
                text: `已登记维护：${result.summary.reasons.join(
                  "；"
                )}，整组「${stopName}」转为待复测，原调音结论已保留。`,
              }
            : {
                tone: "ok",
                text: `已登记维护：风压合格，「${stopName}」组状态保持。`,
              }
        );
      }
      setMode(null);
    } catch (err) {
      setBanner({
        tone: "warn",
        text: err instanceof Error ? err.message : "登记失败",
      });
    }
  };

  const pendingCount = store.venue.stops.filter(
    (s) => s.status === "pending"
  ).length;

  return (
    <section className="panel wind-panel">
      <div className="heading">
        <div>
          <p>风箱压力复测</p>
          <h2>静压与演奏最低风压</h2>
        </div>
        <span className="wind-rule">
          判定：同栓响应差 &gt; {RESPONSE_DIFF_LIMIT}Pa 或压降 &gt;{" "}
          {PRESSURE_DROP_LIMIT}Pa 即整组待复测
        </span>
      </div>

      <div className="wind-venues">
        <div className="chips">
          {store.venueNames.map((name) => (
            <button
              key={name}
              className={name === store.venue.name ? "wind-venue-on" : ""}
              onClick={() => {
                setBanner(null);
                store.switchVenue(name);
              }}
            >
              {name}
            </button>
          ))}
        </div>
        <form
          className="wind-add-venue"
          onSubmit={(e) => {
            e.preventDefault();
            store.addVenue(newVenue);
            setNewVenue("");
          }}
        >
          <input
            value={newVenue}
            placeholder="新增场馆名称"
            onChange={(e) => setNewVenue(e.target.value)}
          />
          <button type="submit">切换/新建</button>
        </form>
      </div>

      <p className="wind-stat">
        当前场馆「{store.venue.name}」：{store.venue.stops.length} 个音栓组，
        {pendingCount} 组待复测锁定；状态按场馆分别保存，刷新后仍可读。
      </p>

      {banner && (
        <div
          className={
            banner.tone === "warn" ? "wind-banner wind-banner-warn" : "wind-banner"
          }
        >
          {banner.text}
        </div>
      )}

      {mode && (
        <EntryForm
          key={formKey}
          mode={mode}
          onModeChange={setMode}
          venueName={store.venue.name}
          onClose={closeForm}
          submit={submit}
        />
      )}

      <div className="wind-stops">
        {store.venue.stops.map((stop) => (
          <StopCard key={stop.id} stop={stop} onOpen={openForm} />
        ))}
        {store.venue.stops.length === 0 && (
          <p className="wind-empty">该场馆尚无音栓组，先进行一次维护登记。</p>
        )}
        <button
          className="wind-new-stop"
          onClick={() =>
            openForm({
              kind: "maintenance",
              stopId: null,
              stopName: "",
              tuningConclusion: "",
            })
          }
        >
          + 新音栓首次维护登记
        </button>
      </div>
    </section>
  );
}
