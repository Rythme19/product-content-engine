// SQLite persistence (node:sqlite, no ORM). All workflow state lives here so the
// app can resume after a restart without repeating paid work.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Spec, Stage } from "./schemas.ts";

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "studio.db"));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',          -- active | paused | cancelled | done
  spec TEXT NOT NULL DEFAULT '{}',                -- persistent campaign specification (JSON)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,       -- reference | logo | music | image | keyframe | shot | video | frame
  slot TEXT,                -- hero | lifestyle | benefit | shot id | format
  path TEXT NOT NULL,       -- relative to DATA_DIR
  mime TEXT NOT NULL,
  width INTEGER, height INTEGER, duration REAL,
  status TEXT NOT NULL DEFAULT 'ready',            -- ready | approved | rejected
  job_id TEXT,
  remote_url TEXT, remote_at TEXT,                 -- provider-accessible copy (references / first frames)
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,       -- image | keyframe | shot
  slot TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input TEXT NOT NULL,      -- adapter input (JSON)
  est_usd REAL NOT NULL,
  actual_usd REAL,
  status TEXT NOT NULL,     -- queued | submitting | submitted | completed | failed | nsfw | canceled | download_failed
  idempotency_key TEXT NOT NULL UNIQUE,
  request_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_poll_at TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  est_usd REAL NOT NULL,
  usd REAL NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS assets_project ON assets(project_id, kind);
`);

export const now = () => new Date().toISOString();
export const uid = () => randomUUID();

/** Run fn in an IMMEDIATE transaction (serialises writers so budget checks can't race). */
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ---------- secrets redaction + structured log ----------

const secretValues = () =>
  [process.env.HF_API_KEY_ID, process.env.HF_API_KEY_SECRET, process.env.ANTHROPIC_API_KEY, process.env.APP_TOKEN]
    .filter((v): v is string => !!v && v.length >= 6);

/** Strip any configured secret value from text before it is logged or returned to a client. */
export function redact(text: string): string {
  let out = text;
  for (const s of secretValues()) out = out.split(s).join("[redacted]");
  return out;
}

export function log(projectId: string | null, level: "info" | "warn" | "error", message: string, data?: unknown) {
  const msg = redact(message);
  const json = data === undefined ? null : redact(JSON.stringify(data));
  db.prepare("INSERT INTO events (project_id, ts, level, message, data) VALUES (?, ?, ?, ?, ?)").run(projectId, now(), level, msg, json);
  if (process.env.NODE_ENV !== "test") console[level === "info" ? "log" : level](`[${level}] ${projectId ? projectId.slice(0, 8) + " " : ""}${msg}`);
}

// ---------- typed row helpers ----------

export type Project = { id: string; name: string; stage: Stage; status: string; spec: Spec; created_at: string; updated_at: string };
export type Asset = {
  id: string; project_id: string; kind: string; slot: string | null; path: string; mime: string;
  width: number | null; height: number | null; duration: number | null; status: string; job_id: string | null;
  remote_url: string | null; remote_at: string | null; meta: Record<string, any>; created_at: string;
};
export type Job = {
  id: string; project_id: string; kind: string; slot: string; provider: string; model: string; input: Record<string, any>;
  est_usd: number; actual_usd: number | null; status: string; idempotency_key: string; request_id: string | null;
  error: string | null; attempts: number; next_poll_at: string | null; meta: Record<string, any>; created_at: string; updated_at: string;
};

const parse = <T>(row: any, ...jsonCols: string[]): T => {
  const out = { ...row };
  for (const c of jsonCols) out[c] = JSON.parse(row[c] ?? "{}");
  return out as T;
};

export function getProject(id: string): Project | undefined {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  return row ? parse<Project>(row, "spec") : undefined;
}

export function listProjects() {
  return db.prepare("SELECT id, name, stage, status, updated_at FROM projects ORDER BY updated_at DESC").all();
}

export function saveProject(p: Pick<Project, "id"> & Partial<Pick<Project, "stage" | "status" | "spec" | "name">>) {
  const cur = getProject(p.id);
  if (!cur) throw new Error("project not found");
  db.prepare("UPDATE projects SET name = ?, stage = ?, status = ?, spec = ?, updated_at = ? WHERE id = ?").run(
    p.name ?? cur.name, p.stage ?? cur.stage, p.status ?? cur.status, JSON.stringify(p.spec ?? cur.spec), now(), p.id,
  );
}

export function getAsset(id: string): Asset | undefined {
  const row = db.prepare("SELECT * FROM assets WHERE id = ?").get(id);
  return row ? parse<Asset>(row, "meta") : undefined;
}

export function listAssets(projectId: string, kind?: string): Asset[] {
  const rows = kind
    ? db.prepare("SELECT * FROM assets WHERE project_id = ? AND kind = ? ORDER BY created_at").all(projectId, kind)
    : db.prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_at").all(projectId);
  return rows.map((r) => parse<Asset>(r, "meta"));
}

export function insertAsset(a: Pick<Asset, "project_id" | "kind" | "path" | "mime"> & Partial<Asset>): Asset {
  const id = a.id ?? uid();
  db.prepare(
    `INSERT INTO assets (id, project_id, kind, slot, path, mime, width, height, duration, status, job_id, remote_url, remote_at, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, a.project_id, a.kind, a.slot ?? null, a.path, a.mime, a.width ?? null, a.height ?? null, a.duration ?? null,
    a.status ?? "ready", a.job_id ?? null, a.remote_url ?? null, a.remote_at ?? null, JSON.stringify(a.meta ?? {}), now());
  return getAsset(id)!;
}

export function updateAsset(id: string, patch: Partial<Pick<Asset, "status" | "remote_url" | "remote_at" | "meta" | "slot">>) {
  const next = { ...getAsset(id)!, ...patch };
  db.prepare("UPDATE assets SET status = ?, remote_url = ?, remote_at = ?, meta = ?, slot = ? WHERE id = ?")
    .run(next.status, next.remote_url, next.remote_at, JSON.stringify(next.meta), next.slot, id);
}

export function getJob(id: string): Job | undefined {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  return row ? parse<Job>(row, "input", "meta") : undefined;
}

export function listJobs(projectId: string): Job[] {
  return db.prepare("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at").all(projectId).map((r) => parse<Job>(r, "input", "meta"));
}

export function jobsWithStatus(...statuses: string[]): Job[] {
  const q = `SELECT * FROM jobs WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at`;
  return db.prepare(q).all(...statuses).map((r) => parse<Job>(r, "input", "meta"));
}

export function updateJob(id: string, patch: Partial<Omit<Job, "id" | "project_id" | "input">>) {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  const vals = cols.map((c) => (c === "meta" ? JSON.stringify((patch as any)[c]) : (patch as any)[c] ?? null));
  db.prepare(`UPDATE jobs SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, now(), id);
}
