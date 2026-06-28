import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { EventRow } from "../types.js";
import { useI18n } from "../i18n.js";

export function Events() {
  const { t } = useI18n();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [filter, setFilter] = useState("");
  const [taskId, setTaskId] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      try { const e = await api.events(taskId || undefined, 300); if (active) setEvents(e); } catch { /* ignore */ }
    };
    void load();
    const t = setInterval(load, 3000);
    return () => { active = false; clearInterval(t); };
  }, [taskId]);

  const filtered = filter ? events.filter((e) => e.method.includes(filter) || e.payload_json.includes(filter)) : events;

  return (
    <div>
      <div className="page-header">
        <h2 className="page-title">{t("logs")}</h2>
        <p className="page-subtitle">{t("records", { count: filtered.length })}</p>
      </div>
      <div className="toolbar">
        <input placeholder={t("searchLogs")} value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} />
        <input placeholder={t("filterTask")} value={taskId} onChange={(e) => setTaskId(e.target.value)} style={{ width: 200 }} className="mono" />
      </div>
      <div className="card" style={{ padding: 0, maxHeight: "70vh", overflow: "auto" }}>
        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📝</div>
            <p className="empty-state-text">{t("noLogs")}</p>
          </div>
        ) : (
          filtered.map((e) => (
            <div key={e.id} className="log-line">
              <span style={{ color: "var(--fg-muted)" }}>{new Date(e.at).toLocaleTimeString()}</span>{" "}
              <span style={{ color: "var(--accent)", fontWeight: 500 }}>{e.method}</span>
              {e.task_id && <span style={{ color: "var(--warning)" }}> [{t("taskPrefix")} {e.task_id.slice(0, 12)}]</span>}
              {e.payload_json && e.payload_json !== "null" && (
                <div style={{ color: "var(--fg-muted)", marginTop: 2 }}>{truncate(e.payload_json, 500)}</div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}
