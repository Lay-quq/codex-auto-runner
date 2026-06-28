import { defaultStagingDir, redactLocalPath, resolveCodex } from "@car/codex-resolver";
import { createLogger } from "@car/logger";

async function main(): Promise<void> {
  const log = createLogger({ level: "warn" });
  const codex = await resolveCodex(log);

  const report = {
    ok: true,
    codex: {
      source: codex.source,
      version: codex.version,
      staged: codex.staged,
      executable: redactLocalPath(codex.path),
    },
    localRuntime: {
      stagingDir: redactLocalPath(defaultStagingDir()),
      dataDir: "%LOCALAPPDATA%\\CodexAutoRunner\\data",
    },
    privacy: [
      "Codex is discovered on this machine at runtime.",
      "No user-specific Codex executable path is stored in the repository.",
      "Runtime API tokens, database files, logs, and probe dumps stay in the user-local data directory.",
    ],
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write("doctor failed: " + (err?.stack ?? String(err)) + "\n");
  process.exit(1);
});
