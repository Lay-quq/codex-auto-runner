import { run } from "node:test";
import { spec } from "node:test/reporters.js";
import { SqliteRepository } from "./src/repository.js";
import { canTransition } from "./src/types.js";
import assert from "node:assert/strict";

const repo = new SqliteRepository(":memory:");
repo.migrate();
assert.equal(canTransition("READY", "PREPARING"), true);
const t = repo.createTask({ title: "T", projectPath: "D:\\p", originalGoal: "g" });
assert.equal(repo.getTask(t.id)?.title, "T");
const claimed = repo.claimNextRunnable();
assert.equal(claimed?.id, t.id);
assert.equal(claimed?.status, "PREPARING");
repo.close();
console.log("OK persistence smoke");
process.exit(0);