/**
 * 线程/回合探针：调用 thread/list、thread/read、thread/start、turn/start、turn/interrupt，
 * 验证真实参数与返回结构，并给出最小可运行配置。不消耗额度（仅 listing & 1 秒后中断 turn），
 * 但账号当前若 exhausted 仍可能失败——脚本会捕获并报告。
 */

import { AppServerClient } from "@car/app-server-client";
import { resolveCodex } from "@car/codex-resolver";
import { createLogger } from "@car/logger";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

async function main(): Promise<void> {
  const log = createLogger({ level: "info" });
  // 始终落在仓库根 fixtures/app-server，避免 pnpm--filter 切 cwd 影响
  const here = new URL(".", import.meta.url).pathname.replace(/^\//, "").replace(/\//g, "\\");
  const repoRoot = join(here, "..", "..");
  const outDir = join(repoRoot, "fixtures", "app-server");
  mkdirSync(outDir, { recursive: true });
  const codex = await resolveCodex(log);
  const client = new AppServerClient({ codexPath: codex.path, logger: log, requestTimeoutMs: 60_000 });
  await client.start();

  const dump: Record<string, unknown> = { codex: { ...codex } };

  // 1) thread/list
  try {
    const list = await client.request("thread/list", { limit: 5, sortDirection: "desc" });
    dump["thread/list"] = list;
    log.info("thread/list ok", { keys: Object.keys(list as object) });
    write(join(outDir, "thread-list.json"), list);
  } catch (e) {
    dump["thread/list_error"] = String(e);
    log.error("thread/list failed", { err: String(e) });
  }

  // 2) try thread/start + turn/start in a temp cwd
  const cwd = join(repoRoot, "fixtures", "live-test-repo");
  mkdirSync(cwd, { recursive: true });
  try {
    const startResp = await client.request("thread/start", {
      cwd,
      sandbox: "workspace-write",
      approvalPolicy: "never",
    });
    dump["thread/start"] = startResp;
    write(join(outDir, "thread-start.json"), startResp);
    const threadId = (startResp as { thread?: { id?: string }; id?: string }).thread?.id ?? (startResp as { id?: string }).id;
    log.info("thread/start ok", { threadId });

    if (threadId) {
      // try thread/read
      try {
        const readResp = await client.request("thread/read", { threadId, includeTurns: false });
        dump["thread/read"] = readResp;
        write(join(outDir, "thread-read.json"), readResp);
      } catch (e) {
        dump["thread/read_error"] = String(e);
      }

      // try turn/start with benign prompt
      try {
        const turnResp = await client.request("turn/start", {
          threadId,
          input: [{ type: "text", text: "Echo back the single word 'pong'. Do not make any file changes." }],
          cwd,
          sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
          approvalPolicy: "never",
        });
        dump["turn/start"] = turnResp;
        write(join(outDir, "turn-start.json"), turnResp);
        const turnId = (turnResp as { turn?: { id?: string }; id?: string }).turn?.id ?? (turnResp as { id?: string }).id;
        log.info("turn/start ok", { turnId });

        // wait 1.5s then interrupt to avoid wasting quota
        await sleep(1500);
        try {
          const intResp = await client.request("turn/interrupt", { threadId, turnId: turnId ?? "" });
          dump["turn/interrupt"] = intResp;
          write(join(outDir, "turn-interrupt.json"), intResp);
        } catch (e) {
          dump["turn/interrupt_error"] = String(e);
        }
      } catch (e) {
        dump["turn/start_error"] = String(e);
        log.error("turn/start failed", { err: String(e) });
      }
    }
  } catch (e) {
    dump["thread/start_error"] = String(e);
    log.error("thread/start failed", { err: String(e) });
  }

  write(join(outDir, "thread-turn-probe-dump.json"), dump);
  await client.close();
  process.stdout.write("\nDUMP written to fixtures/app-server/\n");
  process.exit(0);
}

function write(path: string, obj: unknown): void {
  writeFileSync(path, JSON.stringify(obj, null, 2));
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => {
  process.stderr.write("probe fatal: " + (e?.stack ?? String(e)) + "\n");
  process.exit(1);
});