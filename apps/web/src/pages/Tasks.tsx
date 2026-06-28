import type { StatusResp, TaskSummary } from "../types.js";
import { api } from "../api.js";
import { useI18n } from "../i18n.js";

const canContinueGoal = (t: TaskSummary) => (
  t.status === "READY" ||
  t.status === "PAUSED" ||
  t.status === "WAITING_QUOTA" ||
  t.status === "WAITING_USER" ||
  t.status === "FAILED_RETRYABLE"
);

export function Tasks({ status, onOpen, onChanged }: { status: StatusResp; onOpen: (id: string) => void; onChanged: () => void }) {
  const { t, statusText } = useI18n();
  const tasks = status.tasks;
  const act = async (fn: (id: string) => Promise<unknown>, t: TaskSummary) => { await fn(t.id); onChanged(); };

  return (
    <div>
      <div className="page-header">
        <h2 className="page-title">{t("tasks")}</h2>
        <p className="page-subtitle">{t("taskCountLine", { tasks: tasks.length, running: status.runningCount, ready: status.readyCount })}</p>
      </div>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {tasks.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <p className="empty-state-text">{t("noTasks")}</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("taskName")}</th>
                <th>{t("status")}</th>
                <th>{t("priority")}</th>
                <th>{t("thread")}</th>
                <th>{t("runCount")}</th>
                <th>{t("quotaWait")}</th>
                <th>{t("nextRun")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td>
                    <a onClick={() => onOpen(task.id)} style={{ fontWeight: 500 }}>{task.title}</a>
                    <div className="mono hint" style={{ marginTop: 2 }}>{task.id.slice(0, 12)}</div>
                  </td>
                  <td><span className={"badge " + task.status.toLowerCase()}>{statusText(task.status)}</span></td>
                  <td className="mono">{task.priority}</td>
                  <td className="mono">{task.threadId ? task.threadId.slice(0, 8) : "—"}</td>
                  <td className="mono">{task.runCycleCount}/{task.maxRunCycles}</td>
                  <td className="mono">{task.quotaCycleCount}/{task.maxQuotaCycles}</td>
                  <td className="mono">{task.nextRunAt ? new Date(task.nextRunAt).toLocaleTimeString() : "—"}</td>
                  <td>
                    <div className="row-actions">
                      {!task.terminal && task.status !== "PAUSED" && <button onClick={() => act(api.pause, task)}>{t("pause")}</button>}
                      {canContinueGoal(task) && <button className="primary continue-goal-btn" onClick={() => act(api.runNow, task)}>{t("continueGoal")}</button>}
                      {!task.terminal && <button className="danger" onClick={() => act(api.cancel, task)}>{t("cancel")}</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
