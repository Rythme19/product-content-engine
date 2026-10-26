// Budget guard + cost ledger. Every paid operation (generation job or Claude call)
// passes through here; nothing is submitted whose estimate exceeds what remains.
import { createHash } from "node:crypto";
import { db, getProject, log, now, tx, uid } from "./db.ts";

export class BudgetError extends Error {
  status = 402;
}

const RESERVED = "('queued','submitting','submitted')";
const CHARGED = "('completed','download_failed')";

export function ledger(projectId: string) {
  const g = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status IN ${CHARGED} THEN COALESCE(actual_usd, est_usd) END), 0) AS spent,
      COALESCE(SUM(CASE WHEN status IN ${CHARGED} THEN est_usd END), 0) AS spent_est,
      COALESCE(SUM(CASE WHEN status IN ${RESERVED} THEN est_usd END), 0) AS reserved,
      COALESCE(SUM(CASE WHEN status IN ('failed','nsfw','canceled') THEN est_usd END), 0) AS failed_est,
      COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed,
      COUNT(CASE WHEN status IN ('failed','nsfw','canceled','download_failed') THEN 1 END) AS failed,
      COUNT(CASE WHEN status IN ${RESERVED} THEN 1 END) AS in_flight
    FROM jobs WHERE project_id = ?`).get(projectId) as Record<string, number>;
  const l = db.prepare("SELECT COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(est_usd), 0) AS est, COUNT(*) AS n FROM llm_calls WHERE project_id = ?")
    .get(projectId) as Record<string, number>;
  const max = getProject(projectId)?.spec.budget?.max_usd ?? null;
  const committed = g.spent + g.reserved + l.usd;
  return {
    max_usd: max,
    generation_spent_usd: round(g.spent),
    generation_estimated_usd: round(g.spent_est),
    reserved_usd: round(g.reserved),
    failed_not_charged_usd: round(g.failed_est),
    llm_spent_usd: round(l.usd),
    llm_estimated_usd: round(l.est),
    llm_calls: l.n,
    committed_usd: round(committed),
    remaining_usd: max == null ? null : round(max - committed),
    completed: g.completed,
    failed: g.failed,
    in_flight: g.in_flight,
  };
}

const round = (n: number) => Math.round(n * 10000) / 10000;

export type NewJob = { kind: string; slot: string; provider: string; model: string; input: Record<string, unknown>; est_usd: number | null; meta?: Record<string, unknown> };

/**
 * Atomically check the budget and enqueue jobs. All-or-nothing: if the batch
 * doesn't fit in the remaining budget, nothing is queued.
 */
export function enqueueJobs(projectId: string, jobs: NewJob[]): string[] {
  return tx(() => {
    const unknown = jobs.filter((j) => j.est_usd == null);
    if (unknown.length) throw new BudgetError(`No price estimate for ${unknown.map((j) => j.slot).join(", ")}; nothing was submitted. Retry the estimate or approve a manual cap.`);
    const total = jobs.reduce((s, j) => s + j.est_usd!, 0);
    const { remaining_usd } = ledger(projectId);
    if (remaining_usd == null) throw new BudgetError("No budget approved for this project.");
    if (total > remaining_usd + 1e-9) {
      throw new BudgetError(`Estimated $${total.toFixed(2)} exceeds remaining budget $${remaining_usd.toFixed(2)}; nothing was submitted.`);
    }
    const ins = db.prepare(`INSERT INTO jobs (id, project_id, kind, slot, provider, model, input, est_usd, status, idempotency_key, meta, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`);
    const ids = jobs.map((j) => {
      const id = uid();
      ins.run(id, projectId, j.kind, j.slot, j.provider, j.model, JSON.stringify(j.input), j.est_usd!, uid(), JSON.stringify(j.meta ?? {}), now(), now());
      return id;
    });
    log(projectId, "info", `queued ${jobs.length} job(s), est $${total.toFixed(2)}`, { ids });
    return ids;
  });
}

/** Guard for a Claude call. Before a budget exists the caller must pass the user's explicit confirmation. */
export function checkLlmSpend(projectId: string, estUsd: number, confirmedUsd?: number) {
  const { remaining_usd } = ledger(projectId);
  if (remaining_usd == null) {
    if (confirmedUsd == null || confirmedUsd + 1e-9 < estUsd) {
      throw new BudgetError(`This Claude call costs about $${estUsd.toFixed(3)}; confirm it first.`);
    }
    return;
  }
  if (estUsd > remaining_usd + 1e-9) throw new BudgetError(`Claude call (~$${estUsd.toFixed(3)}) exceeds remaining budget $${remaining_usd.toFixed(2)}.`);
}

/** Stable hash of a plan so approval only applies to exactly what the user saw. */
export function planHash(obj: unknown) {
  const canon = (v: any): any => Array.isArray(v) ? v.map(canon) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().filter((k) => !["hash", "created_at", "approved_at"].includes(k)).map((k) => [k, canon(v[k])]))
    : v;
  return createHash("sha256").update(JSON.stringify(canon(obj))).digest("hex").slice(0, 16);
}
