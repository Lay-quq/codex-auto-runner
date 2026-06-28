/**
 * 调用 `codex app-server generate-json-schema --out <dir>` 生成当前版本协议
 * JSON Schema，并保存到 schemas/generated/<version>/，记录兼容清单。
 *
 * 运行：pnpm schema:gen
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { resolveCodex } from "@car/codex-resolver";
import { createLogger } from "@car/logger";

function schemaRoot(): string {
  // 仓库内 schemas/generated（相对此脚本文件解析，避免 cwd 依赖）
  const here = new URL(".", import.meta.url);
  const herePath = here.pathname.replace(/^\//, "").replace(/\//g, "\\");
  const repoRoot = join(herePath, "..");
  const root = join(repoRoot, "schemas", "generated");
  mkdirSync(root, { recursive: true });
  return root;
}

async function main(): Promise<void> {
  const log = createLogger({ level: "info" });
  const codex = await resolveCodex(log);
  const version = codex.version ?? "unknown";
  const dest = join(schemaRoot(), version);
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(dest, { recursive: true });

  log.info("generating json schema", { version, dest });
  const r = spawnSync(codex.path, ["app-server", "generate-json-schema", "--out", dest], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (r.status !== 0) {
    log.error("generate-json-schema failed", { status: r.status, stderr: r.stderr?.slice(-1000) });
    process.exit(2);
  }

  // 收集生成文件 + 哈希
  const files: { name: string; sha256: string; bytes: number }[] = [];
  function walk(dir: string, base = ""): void {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, rel);
      else if (e.isFile() && /\.(json|ts)$/i.test(e.name)) {
        const data = readFileSync(p);
        files.push({ name: rel, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length });
      }
    }
  }
  walk(dest);

  const manifest = {
    codexVersion: version,
    generatedAt: Date.now(),
    codexPath: codex.path,
    fileCount: files.length,
    files,
  };
  writeFileSync(join(dest, "manifest.json"), JSON.stringify(manifest, null, 2));

  log.info("schema generated", { version, files: files.length });
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 80)) {
    process.stdout.write(`  ${f.name}  (${f.bytes}B  ${f.sha256.slice(0, 12)})\n`);
  }

  // 兼容性核验：必需方法必须在 schema 中出现
  const required = [
    "initialize",
    "initialized",
    "account/read",
    "account/rateLimits/read",
    "account/rateLimits/updated",
    "thread/start",
    "thread/resume",
    "thread/read",
    "thread/list",
    "turn/start",
    "turn/interrupt",
    "turn/started",
    "turn/completed",
  ];
  const allText = files.map((f) => f.name).join("\n");
  // 简单核验：方法名至少作为子串出现在生成的 schema 文件名中（并不等于完整校验）
  const missing: string[] = [];
  for (const m of required) {
    const esc = m.replace(/\//g, "_");
    const found =
      files.some((f) => f.name.includes(m) || f.name.includes(esc)) ||
      files.some((f) => {
        // 进一步：打开文件内容检查方法名是否出现
        try {
          return readFileSync(join(dest, f.name)).toString().includes(`"${m}"`);
        } catch {
          return false;
        }
      });
    if (!found) missing.push(m);
  }
  const ok = missing.length === 0;
  const verdict = { ok, missing };
  writeFileSync(join(dest, "compatibility.json"), JSON.stringify(verdict, null, 2));
  log.info("compatibility verdict", verdict);

  // 在 data 目录写入 schema_versions 当前活跃版本
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const dataDir = join(local, "CodexAutoRunner", "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "schema_version.json"),
    JSON.stringify({ codexVersion: version, schemaDir: dest, compatible: ok, checkedAt: Date.now() }, null, 2),
  );

  process.exit(ok ? 0 : 3);
}

main().catch((e) => {
  process.stderr.write("schema-gen fatal: " + (e?.stack ?? String(e)) + "\n");
  process.exit(1);
});