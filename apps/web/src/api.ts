import type { StatusResp, TaskSummary, EventRow, CodexSession, CodexGoal } from "./types";

function token(): string | null {
  try { return localStorage.getItem("car-token"); } catch { return null; }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init?.headers as Record<string, string>) };
  const t = token();
  if (t) headers["X-Car-Token"] = t;
  const r = await fetch(path, { ...init, headers });
  if (r.status === 401) {
    const tok = prompt("未授权。请粘贴 daemon 的 car-api.token 内容：");
    if (tok) { localStorage.setItem("car-token", tok.trim()); return req(path, init); }
    throw new Error("unauthorized");
  }
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.status === 204 ? (undefined as T) : ((await r.json()) as T);
}

export const api = {
  status: () => req<StatusResp>("/api/status"),
  quota: () => req<{ current: unknown; history: unknown[] }>("/api/quota"),
  tasks: () => req<TaskSummary[]>("/api/tasks"),
  task: (id: string) => req<TaskSummary & { runs: unknown[] }>(`/api/tasks/${id}`),
  createTask: (body: unknown) => req<TaskSummary>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  pause: (id: string) => req(`/api/tasks/${id}/pause`, { method: "POST" }),
  resume: (id: string) => req(`/api/tasks/${id}/resume`, { method: "POST" }),
  runNow: (id: string) => req(`/api/tasks/${id}/run-now`, { method: "POST" }),
  cancel: (id: string) => req(`/api/tasks/${id}/cancel`, { method: "POST" }),
  events: (taskId?: string, limit = 200) => req<EventRow[]>(`/api/events?${taskId ? "taskId=" + taskId + "&" : ""}limit=${limit}`),
  settings: () => req<{ autoRunEnabled: boolean }>("/api/settings"),
  setAutoRun: (v: boolean) => req("/api/settings", { method: "POST", body: JSON.stringify({ autoRunEnabled: v }) }),
  codexSessions: (limit = 20) => req<{ sessions: CodexSession[] }>(`/api/codex/sessions?limit=${limit}`),
  activateGoal: (threadId: string) => req<{ goal: CodexGoal }>("/api/codex/goal/activate", { method: "POST", body: JSON.stringify({ threadId }) }),
};
