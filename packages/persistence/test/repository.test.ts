import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteRepository } from "../src/repository.js";
import { canTransition, canPauseTransition, TERMINAL_STATUSES } from "../src/types.js";

let repo: SqliteRepository;
function fresh() {
  repo = new SqliteRepository(":memory:");
  repo.migrate();
  return repo;
}

test("state machine: full happy path", () => {
  assert.equal(canTransition("DRAFT", "READY"), true);
  assert.equal(canTransition("READY", "PREPARING"), true);
  assert.equal(canTransition("PREPARING", "STARTING_THREAD"), true);
  assert.equal(canTransition("STARTING_THREAD", "RUNNING"), true);
  assert.equal(canTransition("RUNNING", "VERIFYING"), true);
  assert.equal(canTransition("VERIFYING", "COMPLETED"), true);
  assert.equal(canTransition("RUNNING", "COMPLETED"), false);
});

test("state machine: WAITING_QUOTA -> READY", () => {
  assert.equal(canTransition("WAITING_QUOTA", "READY"), true);
});

test("state machine: pause semantics", () => {
  assert.equal(canPauseTransition("RUNNING"), true);
  assert.equal(canPauseTransition("COMPLETED"), false);
  assert.equal(canPauseTransition("FAILED_FINAL"), false);
  assert.equal(canPauseTransition("PAUSED"), false);
});

test("state machine: terminal set", () => {
  assert.ok(TERMINAL_STATUSES.has("COMPLETED"));
  assert.ok(!TERMINAL_STATUSES.has("RUNNING"));
});

test("repository: createTask + get + list", () => {
  const r = fresh();
  const t = r.createTask({ title: "T1", projectPath: "D:\\proj", originalGoal: "do thing", priority: 75 });
  assert.equal(r.getTask(t.id)?.title, "T1");
  assert.equal(r.getTask(t.id)?.status, "READY");
  assert.equal(r.listTasks().length, 1);
  r.close();
});

test("repository: claimNextRunnable selects highest priority + single concurrency", () => {
  const r = fresh();
  r.createTask({ title: "low", projectPath: "D:\\p1", originalGoal: "g", priority: 10 });
  r.createTask({ title: "high", projectPath: "D:\\p2", originalGoal: "g", priority: 80 });
  const claimed = r.claimNextRunnable();
  assert.equal(claimed?.title, "high");
  assert.equal(claimed?.status, "PREPARING");
  assert.equal(r.claimNextRunnable(), undefined);
  r.close();
});

test("repository: transitionInTx blocks illegal transitions", () => {
  const r = fresh();
  const t = r.createTask({ title: "T", projectPath: "D:\\p", originalGoal: "g" });
  assert.equal(r.transitionInTx(t.id, "READY", "RUNNING"), false);
  assert.equal(r.getTask(t.id)?.status, "READY");
  assert.equal(r.transitionInTx(t.id, "READY", "PREPARING"), true);
  r.close();
});

test("repository: project lock acquire/release", () => {
  const r = fresh();
  const t1 = r.createTask({ title: "T", projectPath: "D:\\p", originalGoal: "g" });
  const t2 = r.createTask({ title: "T2", projectPath: "D:\\p", originalGoal: "g" });
  assert.equal(r.acquireProjectLock("D:\\p", t1.id, null), true);
  assert.equal(r.acquireProjectLock("D:\\p", t2.id, null), false);
  assert.equal(r.isProjectLocked("D:\\p"), true);
  r.releaseProjectLock("D:\\p");
  assert.equal(r.isProjectLocked("D:\\p"), false);
  assert.equal(r.acquireProjectLock("D:\\p", t2.id, null), true);
  r.close();
});

test("repository: patch writes whitelisted columns", () => {
  const r = fresh();
  const t = r.createTask({ title: "T", projectPath: "D:\\p", originalGoal: "g" });
  r.patch(t.id, { threadId: "th-123", runCycleCount: 2 });
  const got = r.getTask(t.id);
  assert.equal(got?.threadId, "th-123");
  assert.equal(got?.runCycleCount, 2);
  r.close();
});

test("repository: scanAbnormalRunning marks RECOVERING", () => {
  const r = fresh();
  const t = r.createTask({ title: "T", projectPath: "D:\\p", originalGoal: "g" });
  r.forceStatus(t.id, "RUNNING");
  const abn = r.scanAbnormalRunning();
  assert.equal(abn.length, 1);
  assert.equal(r.getTask(t.id)?.status, "RECOVERING");
  r.close();
});

test("repository: thread unique constraint", () => {
  const r = fresh();
  r.createTask({ title: "T", projectPath: "D:\\p", originalGoal: "g", threadId: "THX" });
  assert.throws(() => r.createTask({ title: "T2", projectPath: "D:\\p2", originalGoal: "g", threadId: "THX" }));
  r.close();
});