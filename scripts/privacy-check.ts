import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";

interface Finding {
  file: string;
  line: number;
  rule: string;
  sample: string;
}

const ROOT = process.cwd();
const SELF = "scripts/privacy-check.ts";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "logs",
  ".cache",
  "tools/fixtures/app-server",
  "tools/fixtures/live-test-repo",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".exe",
  ".dll",
  ".node",
]);

const PRIVATE_RUNTIME_FILES = new Set([
  "api.json",
  "car-api.token",
  "runner.db",
  "events.jsonl",
  "status.json",
  "settings.json",
]);

const RULES: { name: string; regex: RegExp }[] = [
  { name: "OpenAI-style API key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "GitHub OAuth token", regex: /\bgho_[A-Za-z0-9_]{20,}\b/g },
  { name: "GitHub fine-grained token", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "Bearer token literal", regex: /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { name: "OpenAI API key assignment", regex: /\bOPENAI_API_KEY\s*=\s*[^"\s]+/gi },
  { name: "x-api-key literal", regex: /\bx-api-key\s*[:=]\s*[^"\s]+/gi },
  { name: "Windows user profile path", regex: /C:\\Users\\(?!Public\\|Default\\|Default User\\|All Users\\)[^"'`\r\n]+/gi },
  { name: "Codex private session path", regex: /(?:^|[\\/])\.codex[\\/]sessions[\\/][^"'`\r\n]+/gi },
  { name: "Codex private attachment path", regex: /(?:^|[\\/])\.codex[\\/]attachments[\\/][^"'`\r\n]+/gi },
];

function main(): void {
  const files = listProjectFiles();
  const findings: Finding[] = [];

  for (const file of files) {
    const normalized = normalize(file);
    if (normalized === SELF) continue;
    if (shouldSkipFile(normalized)) continue;
    if (PRIVATE_RUNTIME_FILES.has(fileName(normalized))) {
      findings.push({
        file: normalized,
        line: 1,
        rule: "Tracked user-local runtime file",
        sample: "This runtime file should be generated per user and ignored by Git.",
      });
      continue;
    }

    const abs = join(ROOT, file);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      for (const rule of RULES) {
        rule.regex.lastIndex = 0;
        if (!rule.regex.test(line)) continue;
        findings.push({
          file: normalized,
          line: i + 1,
          rule: rule.name,
          sample: line.trim().slice(0, 180),
        });
      }
    }
  }

  if (findings.length > 0) {
    process.stderr.write("Privacy check failed. Remove or ignore the following private data before publishing:\n");
    for (const f of findings) {
      process.stderr.write(`- ${f.file}:${f.line} [${f.rule}] ${f.sample}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`Privacy check passed (${files.length} files scanned).\n`);
}

function listProjectFiles(): string[] {
  const git = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (git.status === 0 && git.stdout.trim()) {
    return git.stdout.split(/\r?\n/).filter(Boolean);
  }
  return walk(ROOT);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, item.name);
    const rel = normalize(relative(ROOT, abs));
    if (item.isDirectory()) {
      if (shouldSkipDir(rel)) continue;
      out.push(...walk(abs));
    } else if (item.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function shouldSkipDir(rel: string): boolean {
  return [...SKIP_DIRS].some((dir) => rel === dir || rel.startsWith(dir + "/"));
}

function shouldSkipFile(rel: string): boolean {
  if (shouldSkipDir(rel.split("/").slice(0, -1).join("/"))) return true;
  return BINARY_EXTENSIONS.has(extname(rel).toLowerCase());
}

function normalize(path: string): string {
  return path.split(sep).join("/");
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

main();
