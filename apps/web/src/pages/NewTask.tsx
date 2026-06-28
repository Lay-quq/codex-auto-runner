import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import type { CodexSession } from "../types.js";
import { useI18n } from "../i18n.js";

type ViewMode = "auto" | "pro";
type AutoPriority = "highest" | "high" | "medium" | "low";
type AutoRunLimit = "8" | "20" | "50" | "weeklyQuota";

const stoppedGoalStatuses = new Set(["paused", "blocked", "usageLimited", "budgetLimited", "complete"]);
const priorityOptions: Array<{ value: AutoPriority; labelKey: string; score: number }> = [
  { value: "highest", labelKey: "highest", score: 100 },
  { value: "high", labelKey: "high", score: 80 },
  { value: "medium", labelKey: "medium", score: 50 },
  { value: "low", labelKey: "low", score: 20 },
];
const runLimitOptions: Array<{ value: AutoRunLimit; labelKey: string; cycles: number }> = [
  { value: "8", labelKey: "upTo8", cycles: 8 },
  { value: "20", labelKey: "upTo20", cycles: 20 },
  { value: "50", labelKey: "upTo50", cycles: 50 },
  { value: "weeklyQuota", labelKey: "untilWeeklyQuota", cycles: 1_000_000 },
];

export function NewTask({ onCreated }: { onCreated: () => void }) {
  const { t, goalText } = useI18n();
  const [view, setView] = useState<ViewMode>("auto");
  const [form, setForm] = useState({
    title: "", projectPath: "", originalGoal: "", acceptanceCriteria: "",
    priority: 50, sandboxMode: "workspaceWrite", approvalMode: "safe_autonomous",
    networkAccess: false, workspaceMode: "direct", maxRunCycles: 5, maxQuotaCycles: 10,
    validationCommands: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<CodexSession[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [sessionBusy, setSessionBusy] = useState(false);
  const [autoOptions, setAutoOptions] = useState({
    activateStoppedGoal: true,
    priority: "highest" as AutoPriority,
    runLimit: "8" as AutoRunLimit,
    maxQuotaCycles: 20,
    networkAccess: false,
    useResetCreditOnWeeklyLimit: false,
  });

  const upd = (k: string, v: unknown) => setForm({ ...form, [k]: v });
  const selectedSession = useMemo(() => sessions.find((s) => s.id === sessionId) ?? null, [sessions, sessionId]);

  const refreshSessions = async () => {
    setSessionBusy(true);
    setErr(null);
    try {
      const resp = await api.codexSessions(30);
      setSessions(resp.sessions);
      setSessionId((cur) => {
        if (cur && resp.sessions.some((s) => s.id === cur && s.goal)) return cur;
        return resp.sessions.find((s) => s.goal)?.id || "";
      });
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setSessionBusy(false);
    }
  };

  useEffect(() => {
    void refreshSessions();
  }, []);

  const submit = async () => {
    setErr(null);
    if (!form.title.trim()) return setErr(t("titleRequired"));
    if (!form.projectPath.trim()) return setErr(t("pathRequired"));
    if (!form.originalGoal.trim()) return setErr(t("goalRequired"));
    setBusy(true);
    try {
      await api.createTask({
        title: form.title,
        projectPath: form.projectPath,
        originalGoal: form.originalGoal,
        acceptanceCriteria: form.acceptanceCriteria.split("\n").map((s) => s.trim()).filter(Boolean),
        priority: Number(form.priority) || 50,
        sandboxMode: form.sandboxMode,
        approvalMode: form.approvalMode,
        networkAccess: form.networkAccess,
        workspaceMode: form.workspaceMode,
        maxRunCycles: Number(form.maxRunCycles) || 5,
        maxQuotaCycles: Number(form.maxQuotaCycles) || 10,
        validationCommands: form.validationCommands.split("\n").map((s) => s.trim()).filter(Boolean).map((c, i) => ({ id: `val${i}`, command: c, required: true, timeoutMs: 600000 })),
      });
      onCreated();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const submitAuto = async () => {
    setErr(null);
    if (!selectedSession) return setErr(t("chooseSession"));
    if (!selectedSession.goal) return setErr(t("sessionNeedsGoal"));
    if (!selectedSession.cwd) return setErr(t("sessionNoCwd"));
    setBusy(true);
    try {
      const goal = selectedSession.goal;
      const shouldActivate = goal && autoOptions.activateStoppedGoal && stoppedGoalStatuses.has(goal.status);
      const activeGoal = shouldActivate ? (await api.activateGoal(selectedSession.id)).goal : goal;
      const objective = activeGoal?.objective || selectedSession.preview || selectedSession.name || t("unnamedSession");
      const runLimit = runLimitOptions.find((o) => o.value === autoOptions.runLimit) ?? runLimitOptions[0]!;
      const priority = priorityOptions.find((o) => o.value === autoOptions.priority) ?? priorityOptions[0]!;
      const runUntilWeeklyQuota = autoOptions.runLimit === "weeklyQuota";
      await api.createTask({
        title: titleFrom(selectedSession, objective),
        projectPath: selectedSession.cwd,
        originalGoal: objective,
        resumeInstruction: "",
        acceptanceCriteria: [],
        priority: priority.score,
        mode: "resume_thread",
        threadId: selectedSession.id,
        sandboxMode: "workspaceWrite",
        approvalMode: "safe_autonomous",
        networkAccess: autoOptions.networkAccess,
        useResetCreditOnWeeklyLimit: autoOptions.useResetCreditOnWeeklyLimit,
        workspaceMode: "direct",
        maxRunCycles: runLimit.cycles,
        maxQuotaCycles: runUntilWeeklyQuota ? 1_000_000 : Number(autoOptions.maxQuotaCycles) || 20,
        validationCommands: [],
      });
      onCreated();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h2 className="page-title">{t("newTask")}</h2>
        <p className="page-subtitle">{t("createTaskSubtitle")}</p>
      </div>
      <div className="mode-tabs" role="tablist" aria-label={t("newTask")}>
        <button className={view === "auto" ? "active" : ""} onClick={() => setView("auto")}>{t("autoVersion")}</button>
        <button className={view === "pro" ? "active" : ""} onClick={() => setView("pro")}>{t("proVersion")}</button>
      </div>

      {view === "auto" ? (
        <div className="task-layout">
          <section className="card session-panel">
            <div className="card-header">
              <div>
                <h3 className="card-title">{t("codexSession")}</h3>
                <p className="card-desc">{t("codexSessionDesc")}</p>
              </div>
              <button onClick={refreshSessions} disabled={sessionBusy}>{sessionBusy ? t("refreshing") : t("refresh")}</button>
            </div>
            <div className="session-list">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  className={"session-item" + (s.id === sessionId ? " active" : "")}
                  disabled={!s.goal}
                  onClick={() => setSessionId(s.id)}
                >
                  <div className="session-main">
                    <span className="session-title">{s.name || s.preview || t("unnamedSession")}</span>
                    <span className="session-badges">
                      <span className={"badge " + (s.loaded ? "ready" : "unknown")}>{s.loaded ? t("currentLoaded") : s.status}</span>
                      <span className={"badge " + (s.goal ? goalBadgeClass(s.goal.status) : "unknown")}>{s.goal ? goalText(s.goal.status) : t("selectGoalSession")}</span>
                    </span>
                  </div>
                  <div className="session-meta mono">{s.cwd || t("noCwd")}</div>
                  <div className="session-preview">{s.goal?.objective || t("noGoalSession")}</div>
                </button>
              ))}
              {!sessions.length && !sessionBusy && (
                <div className="empty-state">
                  <p className="empty-state-text">{t("noSessions")}</p>
                </div>
              )}
            </div>
          </section>

          <section className="card auto-panel">
            <div className="card-header">
              <div>
                <h3 className="card-title">{t("autoTakeover")}</h3>
                <p className="card-desc">{t("resumeTaskDesc")}</p>
              </div>
              {selectedSession?.goal && <span className={"badge " + goalBadgeClass(selectedSession.goal.status)}>{selectedSession.goal.status}</span>}
            </div>

            <div className="inspect-block">
              <label>{t("goal")}</label>
              <p>{selectedSession?.goal?.objective || t("selectGoalSession")}</p>
            </div>
            <div className="inspect-grid">
              <div className="inspect-block">
                <label>{t("projectPath")}</label>
                <p className="mono">{selectedSession?.cwd || "-"}</p>
              </div>
              <div className="inspect-block">
                <label>{t("threadId")}</label>
                <p className="mono">{selectedSession?.id || "-"}</p>
              </div>
            </div>

            <div className="grid2 compact-grid">
              <div className="form-row">
                <label>{t("priority")}</label>
                <div className="segmented-control" aria-label={t("priority")}>
                  {priorityOptions.map((option) => (
                    <button
                      key={option.value}
                      className={autoOptions.priority === option.value ? "active" : ""}
                      onClick={() => setAutoOptions({ ...autoOptions, priority: option.value })}
                    >
                      {t(option.labelKey)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="form-row">
                <label>{t("maxRuns")}</label>
                <select value={autoOptions.runLimit} onChange={(e) => setAutoOptions({ ...autoOptions, runLimit: e.target.value as AutoRunLimit })}>
                  {runLimitOptions.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
                </select>
              </div>
              <div className="form-row">
                <label>{t("maxQuotaWaits")}</label>
                <input
                  type="number"
                  min={1}
                  disabled={autoOptions.runLimit === "weeklyQuota"}
                  value={autoOptions.runLimit === "weeklyQuota" ? 1_000_000 : autoOptions.maxQuotaCycles}
                  onChange={(e) => setAutoOptions({ ...autoOptions, maxQuotaCycles: Number(e.target.value) })}
                />
                {autoOptions.runLimit === "weeklyQuota" && <span className="hint">{t("weeklyQuotaHint")}</span>}
              </div>
              <div className="form-row toggle-row">
                <SwitchControl
                  checked={autoOptions.networkAccess}
                  label={t("networkAccess")}
                  onChange={(checked) => setAutoOptions({ ...autoOptions, networkAccess: checked })}
                />
              </div>
            </div>

            <SwitchControl
              checked={autoOptions.activateStoppedGoal}
              className="option-line"
              label={t("activateStoppedGoal")}
              onChange={(checked) => setAutoOptions({ ...autoOptions, activateStoppedGoal: checked })}
            />
            <SwitchControl
              checked={autoOptions.useResetCreditOnWeeklyLimit}
              className="option-line"
              label={t("resetCreditAfterWeekly")}
              onChange={(checked) => setAutoOptions({ ...autoOptions, useResetCreditOnWeeklyLimit: checked })}
            />

            {err && <div className="err">{err}</div>}
            <div className="toolbar">
              <button className="primary" disabled={busy || !selectedSession?.goal} onClick={submitAuto}>
                {busy ? t("creating") : t("takeoverCreate")}
              </button>
              <span className="hint">{t("autoKeepsContext")}</span>
            </div>
          </section>
        </div>
      ) : (
        <div className="card task-form-card">
        <div className="form-row">
          <label>{t("taskTitle")}</label>
          <input value={form.title} onChange={(e) => upd("title", e.target.value)} placeholder={t("taskTitlePh")} />
        </div>
        <div className="form-row">
          <label>{t("projectPath")} *</label>
          <input value={form.projectPath} onChange={(e) => upd("projectPath", e.target.value)} placeholder={t("projectPathPh")} />
        </div>
        <div className="form-row">
          <label>{t("originalGoal")}</label>
          <textarea value={form.originalGoal} onChange={(e) => upd("originalGoal", e.target.value)} placeholder={t("originalGoalPh")} />
        </div>
        <div className="form-row">
          <label>{t("acceptanceEachLine")}</label>
          <textarea value={form.acceptanceCriteria} onChange={(e) => upd("acceptanceCriteria", e.target.value)} placeholder={"测试通过\nlint 无错误"} />
        </div>
        <div className="form-row">
          <label>{t("validationEachLine")}</label>
          <textarea value={form.validationCommands} onChange={(e) => upd("validationCommands", e.target.value)} placeholder={"npm test\nnpm run lint"} />
        </div>
        <div className="grid2">
          <div className="form-row">
            <label>{t("priorityNumeric")}</label>
            <input type="number" min={0} max={100} value={form.priority} onChange={(e) => upd("priority", e.target.value)} />
          </div>
          <div className="form-row">
            <label>{t("sandboxMode")}</label>
            <select value={form.sandboxMode} onChange={(e) => upd("sandboxMode", e.target.value)}>
              <option value="workspaceWrite">{t("workspaceWrite")}</option>
              <option value="readOnly">{t("readOnly")}</option>
            </select>
          </div>
          <div className="form-row">
            <label>{t("approvalMode")}</label>
            <select value={form.approvalMode} onChange={(e) => upd("approvalMode", e.target.value)}>
              <option value="safe_autonomous">{t("autonomous")}</option>
              <option value="interactive">{t("interactive")}</option>
            </select>
          </div>
          <div className="form-row">
            <label>{t("workspaceMode")}</label>
            <select value={form.workspaceMode} onChange={(e) => upd("workspaceMode", e.target.value)}>
              <option value="direct">{t("directMode")}</option>
              <option value="worktree">{t("worktreeMode")}</option>
            </select>
          </div>
          <div className="form-row">
            <label>{t("maxRuns")}</label>
            <input type="number" min={1} value={form.maxRunCycles} onChange={(e) => upd("maxRunCycles", e.target.value)} />
          </div>
          <div className="form-row">
            <label>{t("maxQuotaWaits")}</label>
            <input type="number" min={1} value={form.maxQuotaCycles} onChange={(e) => upd("maxQuotaCycles", e.target.value)} />
          </div>
        </div>
        <div className="form-row">
          <SwitchControl
            checked={form.networkAccess}
            label={t("networkAccessRisk")}
            onChange={(checked) => upd("networkAccess", checked)}
          />
        </div>
        {err && <div className="err">{err}</div>}
        <div className="toolbar">
          <button className="primary" disabled={busy} onClick={submit}>{busy ? t("creating") : t("createTask")}</button>
          <span className="hint">{t("createHint")}</span>
        </div>
      </div>
      )}
    </div>
  );
}

function SwitchControl({
  checked,
  label,
  onChange,
  className = "",
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <label className={["switch-control", className].filter(Boolean).join(" ")}>
      <span className="uiverse-switch">
        <input className="uiverse-cb" type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="uiverse-toggle" aria-hidden="true">
          <span className="uiverse-left">{t("off")}</span>
          <span className="uiverse-right">{t("on")}</span>
        </span>
      </span>
      <span>{label}</span>
    </label>
  );
}

function titleFrom(session: CodexSession, objective: string): string {
  const raw = session.name || objective || "继续 Codex 会话";
  return raw.length > 42 ? raw.slice(0, 42) + "..." : raw;
}

function goalBadgeClass(status: string): string {
  if (status === "active") return "running";
  if (status === "complete") return "completed";
  if (status === "paused" || status === "budgetLimited" || status === "usageLimited") return "paused";
  if (status === "blocked") return "failed";
  return "unknown";
}
