// Budget guard, approval enforcement, duplicate submissions, failures, resume, pause/cancel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { BUDGET, client, isolate, toBudgetStage } from "./helpers.ts";

const DATA = isolate();
const { app } = await import("../server/main.ts");
const { tick } = await import("../server/jobs.ts");
const { enqueueJobs, checkLlmSpend, BudgetError } = await import("../server/budget.ts");
const db = await import("../server/db.ts");
const api = client(app);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(pid: string) {
  for (let i = 0; i < 60; i++) {
    await tick();
    await sleep(250);
    if (!db.listJobs(pid).some((j) => ["queued", "submitting", "submitted"].includes(j.status))) return;
  }
  throw new Error("jobs did not settle");
}

test("plan over budget is refused and nothing is queued", async () => {
  const pid = await toBudgetStage(api);
  let r = await api.post(`/api/projects/${pid}/plan`, { ...BUDGET, max_usd: 0.1 });
  assert.equal(r.status, 200);
  assert.ok(r.json.plan_problems.length > 0);
  r = await api.post(`/api/projects/${pid}/plan/approve`, { hash: r.json.project.spec.plan.hash });
  assert.equal(r.status, 402);
  assert.equal(db.listJobs(pid).length, 0);
});

test("approval binds to the reviewed plan and can't be replayed", async () => {
  const pid = await toBudgetStage(api);
  let r = await api.post(`/api/projects/${pid}/plan`, BUDGET);
  const hash = r.json.project.spec.plan.hash;
  r = await api.post(`/api/projects/${pid}/plan`, { ...BUDGET, images_per_slot: 2 }); // plan changed after review
  assert.equal((await api.post(`/api/projects/${pid}/plan/approve`, { hash })).status, 409);
  const fresh = r.json.project.spec.plan.hash;
  const [a, b] = await Promise.all([
    api.post(`/api/projects/${pid}/plan/approve`, { hash: fresh }),
    api.post(`/api/projects/${pid}/plan/approve`, { hash: fresh }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], "double-click approves once");
  assert.equal(db.listJobs(pid).length, 6);
});

test("enqueue is all-or-nothing against the remaining budget", async () => {
  const pid = await toBudgetStage(api);
  await api.post(`/api/projects/${pid}/plan`, { ...BUDGET, max_usd: 1 });
  const job = { kind: "image", slot: "hero", provider: "mock", model: "mock:image", input: { gen: { prompt: "x" } }, est_usd: 0.4 };
  assert.throws(() => enqueueJobs(pid, [job, job, job]), BudgetError);
  assert.equal(db.listJobs(pid).length, 0);
  assert.throws(() => enqueueJobs(pid, [{ ...job, est_usd: null }]), /No price estimate/);
  enqueueJobs(pid, [job, job]);
  assert.throws(() => enqueueJobs(pid, [job]), BudgetError, "reserved estimates count against the budget");
});

test("Claude spend before a budget needs explicit confirmation", async () => {
  const pid = await toBudgetStage(api);
  assert.throws(() => checkLlmSpend(pid, 0.2), BudgetError);
  assert.throws(() => checkLlmSpend(pid, 0.2, 0.1), BudgetError);
  checkLlmSpend(pid, 0.2, 0.2);
});

test("failures are not charged; retries are capped and price-checked", { timeout: 60_000 }, async () => {
  const pid = await toBudgetStage(api);
  let r = await api.post(`/api/projects/${pid}/plan`, { ...BUDGET, max_retries: 1 });
  await api.post(`/api/projects/${pid}/plan/approve`, { hash: r.json.project.spec.plan.hash });
  await settle(pid);
  const hero = db.listAssets(pid, "image").find((a) => a.slot === "hero")!;
  r = await api.post(`/api/projects/${pid}/retry/preview`, { asset_id: hero.id, mode: "regenerate", prompt: "x [mock:fail]" });
  assert.equal(r.json.est_usd, 0.04);
  assert.equal((await api.post(`/api/projects/${pid}/retry`, { asset_id: hero.id, mode: "regenerate", prompt: "x [mock:fail]", expected_usd: 0.01 })).status, 409, "stale price refused");
  assert.equal((await api.post(`/api/projects/${pid}/retry`, { asset_id: hero.id, mode: "regenerate", prompt: "x [mock:fail]", expected_usd: 0.04 })).status, 200);
  await settle(pid);
  const failed = db.listJobs(pid).find((j) => j.status === "failed")!;
  assert.equal(failed.actual_usd, 0);
  const view = (await api.get(`/api/projects/${pid}`)).json;
  assert.equal(view.ledger.failed, 1);
  assert.equal(view.ledger.failed_not_charged_usd, 0.04);
  assert.equal(view.ledger.generation_spent_usd, 0.12, "only the 3 delivered images are charged");
  r = await api.post(`/api/projects/${pid}/retry`, { job_id: failed.id, mode: "regenerate", prompt: "x", expected_usd: 0.04 });
  assert.equal(r.status, 402, "retry allowance exhausted");
});

test("resume after crash re-sends with the same idempotency key (no duplicate)", { timeout: 60_000 }, async () => {
  const pid = await toBudgetStage(api);
  await api.post(`/api/projects/${pid}/plan`, BUDGET);
  const [id] = enqueueJobs(pid, [{ kind: "image", slot: "hero", provider: "mock", model: "mock:image", input: { gen: { prompt: "resume" }, ref_assets: [] }, est_usd: 0.04 }]);
  await tick();
  const first = db.getJob(id)!;
  assert.equal(first.status, "submitted");
  db.updateJob(id, { status: "submitting", request_id: null, next_poll_at: null }); // crash after sending, before the response was stored
  await tick();
  assert.equal(db.getJob(id)!.request_id, first.request_id);
  assert.equal(readdirSync(path.join(DATA, "mock")).filter((f) => f.startsWith(first.request_id!)).length, 2, "one json + one png: no second generation");
});

test("pause holds submissions; cancel cancels queued jobs at no cost", async () => {
  const pid = await toBudgetStage(api);
  let r = await api.post(`/api/projects/${pid}/plan`, BUDGET);
  await api.post(`/api/projects/${pid}/plan/approve`, { hash: r.json.project.spec.plan.hash });
  await api.post(`/api/projects/${pid}/status`, { status: "paused" });
  await tick();
  assert.ok(db.listJobs(pid).every((j) => j.status === "queued"));
  assert.equal((await api.post(`/api/projects/${pid}/storyboard`, { seconds: 9, shots: 3, aspect: "9:16", style: "" })).status, 409, "paused project rejects actions");
  await api.post(`/api/projects/${pid}/status`, { status: "cancelled" });
  assert.ok(db.listJobs(pid).every((j) => j.status === "canceled" && j.actual_usd === 0));
  r = await api.get(`/api/projects/${pid}`);
  assert.equal(r.json.ledger.committed_usd, 0);
});
