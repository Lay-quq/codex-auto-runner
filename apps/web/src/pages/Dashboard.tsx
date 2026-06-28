import type { StatusResp } from "../types.js";
import { useNow } from "../util.js";
import { useI18n } from "../i18n.js";

export function Dashboard({ status }: { status: StatusResp }) {
  const { lang, t, statusText } = useI18n();
  const now = useNow(1000);
  const q = status.quota;
  const remaining = q?.nextEligibleAt ? Math.max(0, q.nextEligibleAt - now) : 0;
  const bucket = q?.buckets[0];
  const used = bucket?.primary?.usedPercent ?? null;
  const remainingPercent = used == null ? null : percentRemaining(used);

  return (
    <div>
      <div className="page-header">
        <h2 className="page-title">{t("dashboard")}</h2>
        <p className="page-subtitle">{t("dashboardSubtitle")}</p>
      </div>

      <div className="grid4" style={{ marginBottom: 24 }}>
        <div className="stat">
          <span className="label">{t("running")}</span>
          <span className="value accent">{status.runningCount}</span>
        </div>
        <div className="stat">
          <span className="label">{t("queued")}</span>
          <span className="value success">{status.readyCount}</span>
        </div>
        <div className="stat">
          <span className="label">{t("totalTasks")}</span>
          <span className="value">{status.taskCount}</span>
        </div>
        <div className="stat">
          <span className="label">{t("autoSchedule")}</span>
          <span className="value" style={{ color: status.autoRun ? "var(--success)" : "var(--fg-muted)" }}>
            {status.autoRun ? t("enabled") : t("disabled")}
          </span>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">{t("quotaOverview")}</h3>
            {q && <span className={"badge " + q.status}>{statusText(q.status)}</span>}
          </div>

          {q ? (
            <>
              <div style={{ marginBottom: 16 }}>
                <div className="hint" style={{ marginBottom: 8 }}>
                  {t("billingMode")}{q.mode === "chatgpt" ? t("chatgptSub") : q.mode === "api_billing" ? t("apiBilling") : q.mode}
                </div>
              </div>

              {remainingPercent != null && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span className="hint">{t("remainingQuota")}</span>
                    <span style={{ fontWeight: 600 }}>{remainingPercent.toFixed(0)}%</span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${remainingPercent}%` }} />
                  </div>
                </div>
              )}

              {q.status === "exhausted" && q.nextEligibleAt && (
                <div style={{ marginTop: 20, padding: 16, background: "var(--accent-bg)", borderRadius: "var(--radius)", textAlign: "center" }}>
                  <div className="hint" style={{ marginBottom: 8 }}>{t("quotaRefreshIn")}</div>
                  <div className="countdown">{fmtDur(remaining, lang)}</div>
                  <div className="hint" style={{ marginTop: 8 }}>{new Date(q.nextEligibleAt * 1000).toLocaleString()}</div>
                </div>
              )}

              {bucket && (
                <div style={{ marginTop: 20 }}>
                  <div className="hint" style={{ marginBottom: 8, fontWeight: 600 }}>
                    {t("quotaDetails")}{bucket.limitId} · {bucket.planType}
                  </div>
                  <BucketRow name={t("fiveHours")} w={bucket.primary} />
                  {bucket.secondary && <BucketRow name={t("oneWeek")} w={bucket.secondary} />}
                  {q.resetCreditsAvailable != null && (
                    <div className="hint" style={{ marginTop: 12 }}>
                      {t("resetCredits")}<strong>{q.resetCreditsAvailable}</strong>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon">📊</div>
              <p className="empty-state-text">{t("noQuotaData")}</p>
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="card-title">{t("activeTasks")}</h3>
          {status.tasks.length > 0 ? (
            <div>
              {status.tasks.slice(0, 6).map((t) => (
                <div key={t.id} style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "12px 0",
                  borderBottom: "1px solid var(--border-light)"
                }}>
                  <div>
                    <div style={{ fontWeight: 500 }}>{t.title}</div>
                    <div className="mono hint" style={{ marginTop: 4 }}>{t.id.slice(0, 12)}</div>
                  </div>
                  <span className={"badge " + t.status.toLowerCase()}>{statusText(t.status)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon">📋</div>
              <p className="empty-state-text">{t("noActiveTasks")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BucketRow({ name, w }: {
  name: string;
  w: { usedPercent: number | null; windowDurationMins: number | null; resetsAt: number | null } | null
}) {
  const { t } = useI18n();
  if (!w) return null;
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      padding: "8px 0",
      borderBottom: "1px solid var(--border-light)"
    }}>
      <span style={{ fontWeight: 500 }}>{name}</span>
      <span className="mono">
        {w.usedPercent != null ? percentRemaining(w.usedPercent).toFixed(0) + `% ${t("remaining")}` : t("unavailable")}
        {w.resetsAt && <span className="hint"> · {new Date(w.resetsAt * 1000).toLocaleString()}</span>}
      </span>
    </div>
  );
}

function percentRemaining(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

function fmtDur(ms: number, lang: "zh" | "en"): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (lang === "en") {
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }
  if (h > 0) return `${h}小时 ${m}分 ${sec}秒`;
  if (m > 0) return `${m}分 ${sec}秒`;
  return `${sec}秒`;
}
