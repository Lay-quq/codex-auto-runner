import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { TaskSummary } from "../types.js";
import { useI18n } from "../i18n.js";

const canContinueGoal = (task: TaskSummary | null) => task && (
  task.status === "READY" ||
  task.status === "PAUSED" ||
  task.status === "WAITING_QUOTA" ||
  task.status === "WAITING_USER" ||
  task.status === "FAILED_RETRYABLE"
);

export function TaskDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, statusText } = useI18n();
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const t = await api.task(id);
        if (active) {
          setTask(t);
          setErr(null);
        }
      } catch (e) {
        if (active) setErr(String(e));
      }
    };
    void load();
    const t = setInterval(load, 3000);
    return () => { active = false; clearInterval(t); };
  }, [id]);

  const act = async (fn: (id: string) => Promise<unknown>) => {
    try {
      await fn(id);
      const t = await api.task(id);
      setTask(t);
    } catch (e) {
      setErr(String(e));
    }
  };
  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 16 }}>← {t("backToList")}</button>
      <div className="page-header">
        <h2 className="page-title">{task?.title}</h2>
        <p className="page-subtitle">{t("taskDetail")}</p>
      </div>

      <div style={{ marginBottom: 20 }}>
        <span className={"badge " + task?.status.toLowerCase()} style={{ fontSize: 14, padding: "6px 12px" }}>
          {statusText(task?.status || "")}
        </span>
      </div>

      <div className="grid2">
        <div className="card">
          <h3 className="card-title">{t("basicInfo")}</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div className="hint">{t("taskId")}</div>
              <div className="mono">{task?.id}</div>
            </div>
            <div>
              <div className="hint">{t("mode")}</div>
              <div>{task?.mode}</div>
            </div>
            <div>
              <div className="hint">{t("projectPath")}</div>
              <div className="mono" style={{ fontSize: 13 }}>{task?.projectPath}</div>
            </div>
            {task?.threadId && (
              <div>
                <div className="hint">{t("threadId")}</div>
                <div className="mono">{task.threadId}</div>
              </div>
            )}
            <div>
              <div className="hint">{t("priority")}</div>
              <div>{task?.priority}</div>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 className="card-title">{t("execution")}</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div className="hint">{t("runCount")}</div>
              <div>{task?.runCycleCount} / {task?.maxRunCycles}</div>
            </div>
            <div>
              <div className="hint">{t("quotaWait")}</div>
              <div>{task?.quotaCycleCount} / {task?.maxQuotaCycles}</div>
            </div>
            <div>
              <div className="hint">{t("retryCount")}</div>
              <div>{task?.retryCount} / {task?.maxRetryCount}</div>
            </div>
            {task?.nextRunAt && (
              <div>
                <div className="hint">{t("nextRunTime")}</div>
                <div>{new Date(task.nextRunAt).toLocaleString()}</div>
              </div>
            )}
            {task?.lastError && (
              <div>
                <div className="hint">{t("lastError")}</div>
                <div style={{ color: "var(--error)" }}>{task.lastError}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">{t("taskGoal")}</h3>
        <p style={{ lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{task?.originalGoal}</p>
      </div>

      {task?.acceptanceCriteria && task.acceptanceCriteria.length > 0 && (
        <div className="card">
          <h3 className="card-title">{t("acceptance")}</h3>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {task.acceptanceCriteria.map((c, i) => (
              <li key={i} style={{ marginBottom: 8 }}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {task?.validationCommands && task.validationCommands.length > 0 && (
        <div className="card">
          <h3 className="card-title">{t("validations")}</h3>
          <pre style={{
            background: "var(--bg)",
            padding: 12,
            borderRadius: "var(--radius)",
            overflow: "auto",
            fontSize: 13
          }}>
            {task.validationCommands.map((cmd, i) => (
              <div key={i}>
                <span className="hint">$ </span>{cmd.command}
                {cmd.required && <span style={{ color: "var(--warning)", marginLeft: 8 }}>({t("required")})</span>}
              </div>
            ))}
          </pre>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
        {task?.status === "RUNNING" && (
          <button onClick={() => act(api.pause)}>{t("pause")}</button>
        )}
        {canContinueGoal(task) && (
          <button className="primary continue-goal-btn" onClick={() => act(api.runNow)}>{t("continueGoal")}</button>
        )}
        {!["COMPLETED", "CANCELLED", "FAILED_FINAL"].includes(task?.status || "") && (
          <button className="danger" onClick={() => act(api.cancel)}>{t("cancel")}</button>
        )}
      </div>
    </div>
  );
}
