import { useEffect, useState, useCallback } from "react";
import { api } from "./api.js";
import type { StatusResp } from "./types.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Tasks } from "./pages/Tasks.js";
import { NewTask } from "./pages/NewTask.js";
import { TaskDetail } from "./pages/TaskDetail.js";
import { Events } from "./pages/Events.js";
import { I18nProvider, useI18n } from "./i18n.js";

type Page = { name: "dashboard" } | { name: "tasks" } | { name: "new" } | { name: "task"; id: string } | { name: "events" };

// 从 URL hash 读取 token（#token=xxx）自动保存，免手动粘贴
function bootstrapToken(): void {
  try {
    const m = window.location.hash.match(/token=([a-f0-9]+)/i);
    if (m && m[1]) {
      localStorage.setItem("car-token", m[1]);
      // 清掉 hash，避免泄露在地址栏
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  } catch { /* ignore */ }
}

export default function App() {
  return (
    <I18nProvider>
      <AppShell />
    </I18nProvider>
  );
}

function AppShell() {
  const { lang, setLang, t } = useI18n();
  const [page, setPage] = useState<Page>({ name: "dashboard" });
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [autoRun, setAutoRun] = useState<boolean>(true);

  const refresh = useCallback(async () => {
    bootstrapToken();
    try {
      const s = await api.status();
      setStatus(s);
      setAutoRun(s.autoRun);
      setErr(null);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const toggleAutoRun = async () => {
    const v = !autoRun;
    await api.setAutoRun(v);
    setAutoRun(v);
  };

  const nav = (p: Page) => { setPage(p); };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1 className="sidebar-logo">
            <span className="codex-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" role="img" focusable="false">
                <path d="M12 2.8 19.9 7.4v9.2L12 21.2l-7.9-4.6V7.4L12 2.8Z" />
                <path d="M12 6.4 16.7 9.1v5.8L12 17.6l-4.7-2.7V9.1L12 6.4Z" />
                <path d="M7.4 9.2 12 11.8l4.6-2.6M12 11.8v5.5" />
              </svg>
            </span>
            <span>{t("appName")}</span>
          </h1>
          <p className="sidebar-subtitle">{t("appSubtitle")}</p>
          <div className="language-switch" aria-label={t("language")}>
            <button className={lang === "zh" ? "active" : ""} onClick={() => setLang("zh")}>{t("zh")}</button>
            <button className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>{t("en")}</button>
          </div>
        </div>
        <nav style={{ flex: 1 }}>
          <a className={"nav-item" + (page.name === "dashboard" ? " active" : "")} onClick={() => nav({ name: "dashboard" })}>
            {t("dashboard")}
          </a>
          <a className={"nav-item" + (page.name === "tasks" ? " active" : "")} onClick={() => nav({ name: "tasks" })}>
            {t("tasks")}
          </a>
          <a className={"nav-item" + (page.name === "new" ? " active" : "")} onClick={() => nav({ name: "new" })}>
            {t("newTask")}
          </a>
          <a className={"nav-item" + (page.name === "events" ? " active" : "")} onClick={() => nav({ name: "events" })}>
            {t("logs")}
          </a>
        </nav>
        <div className="sidebar-footer">
          <label className="switch-control">
            <span className="uiverse-switch">
              <input className="uiverse-cb" type="checkbox" checked={autoRun} onChange={() => { void toggleAutoRun(); }} />
              <span className="uiverse-toggle" aria-hidden="true">
                <span className="uiverse-left">{t("off")}</span>
                <span className="uiverse-right">{t("on")}</span>
              </span>
            </span>
            <span className="hint">{t("autoRun")}</span>
          </label>
        </div>
      </aside>
      <main className="content">
        {err && (
          <div className="card err">
            <div style={{ marginBottom: 8 }}>{t("backendError")}{err}</div>
            <span className="hint">
              {t("daemonHint")}<code style={{ background: 'rgba(0,0,0,0.1)', padding: '2px 6px', borderRadius: '3px' }}>pnpm --filter @car/daemon start</code>
              <br />
              401 <a onClick={() => { localStorage.removeItem("car-token"); void refresh(); }} style={{ marginLeft: 4 }}>{t("resetToken")}</a>
            </span>
          </div>
        )}
        {!err && page.name === "dashboard" && status && <Dashboard status={status} />}
        {!err && page.name === "tasks" && status && <Tasks status={status} onOpen={(id) => nav({ name: "task", id })} onChanged={refresh} />}
        {!err && page.name === "new" && <NewTask onCreated={() => { void refresh(); nav({ name: "tasks" }); }} />}
        {!err && page.name === "task" && <TaskDetail id={page.id} onBack={() => nav({ name: "tasks" })} />}
        {!err && page.name === "events" && <Events />}
      </main>
    </div>
  );
}
