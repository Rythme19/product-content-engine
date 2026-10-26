// HTTP API + static UI. Secrets stay server-side; the browser only ever sees
// "configured: true/false". Paid actions are POSTs behind explicit approval gates.
import "./env.ts";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { z, ZodError } from "zod";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import * as db from "./db.ts";
import { BudgetError, ledger } from "./budget.ts";
import { activeProviders, catalog, findModel, ProviderError } from "./providers/index.ts";
import { claudeConfigured, CLAUDE_MODEL } from "./llm.ts";
import { sanitizeAudio, sanitizeImage } from "./media.ts";
import * as pipeline from "./pipeline.ts";
import { exportCampaign } from "./export.ts";
import { startWorker } from "./jobs.ts";
import * as S from "./schemas.ts";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const APP_TOKEN = process.env.APP_TOKEN ?? "";
const LOOPBACK = ["127.0.0.1", "localhost", "::1"].includes(HOST);
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, "localhost:5173", ...(process.env.ALLOWED_HOSTS ?? "").split(",").filter(Boolean)]);

export const app = new Hono();

app.use("*", secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"], imgSrc: ["'self'", "data:", "blob:"], mediaSrc: ["'self'", "blob:"],
    styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"],
  },
  referrerPolicy: "no-referrer",
}));

// DNS-rebinding guard: on loopback, only answer to the expected Host headers.
app.use("*", async (c, next) => {
  if (LOOPBACK && !ALLOWED_HOSTS.has(c.req.header("host") ?? "")) return c.text("Forbidden host", 403);
  await next();
});

const tokenOk = (t: string | undefined) => {
  if (!APP_TOKEN) return true;
  if (!t) return false;
  return timingSafeEqual(createHash("sha256").update(t).digest(), createHash("sha256").update(APP_TOKEN).digest());
};

app.post("/api/login", async (c) => {
  const { token } = z.object({ token: z.string().max(200) }).parse(await c.req.json());
  if (!tokenOk(token)) return c.json({ error: "Invalid token" }, 401);
  setCookie(c, "studio_token", token, { httpOnly: true, sameSite: "Strict", path: "/", secure: !LOOPBACK, maxAge: 60 * 60 * 24 * 7 });
  return c.json({ ok: true });
});

// Auth, CSRF and rate limiting for the API.
const hits = new Map<string, number[]>();
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/login" || c.req.path === "/api/health") return next();
  const bearer = c.req.header("authorization")?.replace(/^Bearer /, "");
  if (!tokenOk(bearer ?? getCookie(c, "studio_token"))) return c.json({ error: "Unauthorized", login: true }, 401);
  if (c.req.method !== "GET") {
    // A custom header can't be sent cross-site without a CORS preflight, which is never granted.
    if (c.req.header("x-studio") !== "1") return c.json({ error: "Missing X-Studio header" }, 403);
    const origin = c.req.header("origin");
    if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ""))) return c.json({ error: "Cross-origin request refused" }, 403);
    const ip = c.req.header("x-forwarded-for") ?? "local";
    const t = Date.now();
    const recent = (hits.get(ip) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= 120) return c.json({ error: "Too many requests; slow down." }, 429);
    hits.set(ip, [...recent, t]);
  }
  await next();
});
app.use("/api/*", bodyLimit({ maxSize: 120 * 1024 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }));

app.onError((err, c) => {
  const msg = db.redact(err.message);
  if (err instanceof ZodError) return c.json({ error: "Invalid input", issues: err.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
  if (err instanceof BudgetError) return c.json({ error: msg, budget: true }, 402);
  if (err instanceof pipeline.FlowError) return c.json({ error: msg }, 409);
  if (err instanceof ProviderError) return c.json({ error: msg }, 502);
  db.log(null, "error", `unhandled: ${msg}`, { stack: db.redact(err.stack ?? "") });
  return c.json({ error: msg || "Internal error" }, 500);
});

// ---------------- helpers ----------------

function project(c: Context) {
  const p = db.getProject(c.req.param("id") ?? "");
  if (!p) throw new pipeline.FlowError("Project not found.");
  return p;
}

const body = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> => schema.parse(await c.req.json());

function view(id: string) {
  const p = db.getProject(id)!;
  return {
    project: p,
    assets: db.listAssets(id).map(({ remote_url, ...a }) => ({ ...a, url: `/api/projects/${id}/files/${a.id}` })),
    jobs: db.listJobs(id).map(({ idempotency_key, input, ...j }) => ({ ...j, prompt: input.gen?.prompt ?? "", duration: input.gen?.duration })),
    ledger: ledger(id),
    llm_estimates: pipeline.llmEstimates(p),
    plan_problems: p.stage === "budget" && p.spec.plan ? pipeline.planProblems(p) : [],
    events: db.db.prepare("SELECT ts, level, message FROM events WHERE project_id = ? ORDER BY id DESC LIMIT 40").all(id),
  };
}

async function sendFile(c: Context, file: string, mime: string, downloadName?: string) {
  if (!file.startsWith(db.DATA_DIR + path.sep) || !existsSync(file)) return c.json({ error: "Not found" }, 404);
  const size = (await stat(file)).size;
  const headers: Record<string, string> = { "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300" };
  if (downloadName) headers["Content-Disposition"] = `attachment; filename="${downloadName.replace(/"/g, "")}"`;
  const m = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return c.body(null, 416, { "Content-Range": `bytes */${size}` });
    return c.body(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, 206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) });
  }
  return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream, 200, { ...headers, "Content-Length": String(size) });
}

async function deleteAsset(assetId: string) {
  const a = db.getAsset(assetId)!;
  await rm(pipeline.abs(a.path), { force: true });
  db.db.prepare("DELETE FROM assets WHERE id = ?").run(assetId);
}

// ---------------- settings / models ----------------

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/settings", (c) => c.json({
  providers: [
    { id: "higgsfield", label: "Higgsfield", configured: !!findModel("higgsfield:marketing-studio/image"), env: ["HF_API_KEY_ID", "HF_API_KEY_SECRET"] },
    { id: "mock", label: "Mock (offline, free)", configured: !!findModel("mock:image"), env: ["ENABLE_MOCK_PROVIDER"] },
  ],
  claude: { configured: claudeConfigured(), model: CLAUDE_MODEL },
  upscaling: "Not available: no verified upscaling endpoint in the configured providers. Use the image model's 2k/4k tier instead.",
  audio: "Native model audio (Kling / Seedance) or your own licensed track. No voice-over (TTS) provider is integrated.",
  auth_required: !!APP_TOKEN,
}));

app.get("/api/models", (c) => c.json({ models: catalog() }));

// Free connectivity check: a price estimate validates credentials without generating anything.
app.post("/api/settings/test/:provider", async (c) => {
  const p = activeProviders().find((x) => x.id === c.req.param("provider"));
  if (!p) return c.json({ ok: false, error: "Provider not configured" }, 400);
  const m = p.models.find((x) => x.kind === "image")!;
  const usd = await p.estimate(m, { prompt: "connection test", aspect: "1:1", resolution: "1k", quality: "low" });
  return c.json({ ok: usd != null, sample: usd == null ? null : { model: m.name, usd } });
});

// ---------------- projects & files ----------------

app.get("/api/projects", (c) => c.json({ projects: db.listProjects() }));

app.post("/api/projects", async (c) => {
  const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(80) }));
  const id = db.uid();
  db.db.prepare("INSERT INTO projects (id, name, stage, status, spec, created_at, updated_at) VALUES (?, ?, 'intake', 'active', '{}', ?, ?)").run(id, name, db.now(), db.now());
  return c.json(view(id));
});

app.get("/api/projects/:id", (c) => c.json(view(project(c).id)));

// Uploads: product photos, logo, licensed music. Bytes are decoded and re-encoded; stored names are ours.
const UPLOAD_LIMIT = { reference: 8, logo: 1, music: 1 } as const;
app.post("/api/projects/:id/uploads", async (c) => {
  const p = project(c);
  const form = await c.req.formData();
  const kind = String(form.get("kind")) as keyof typeof UPLOAD_LIMIT;
  if (!(kind in UPLOAD_LIMIT)) throw new pipeline.FlowError("Unknown upload kind.");
  if (kind === "reference" && !["intake", "analysis"].includes(p.stage)) throw new pipeline.FlowError("Reference photos are locked after the brief.");
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) throw new pipeline.FlowError("No files received.");
  if (kind === "reference" && db.listAssets(p.id, kind).length + files.length > UPLOAD_LIMIT.reference) throw new pipeline.FlowError(`At most ${UPLOAD_LIMIT.reference} reference photos.`);
  const dir = path.join(pipeline.projectDir(p.id), "uploads");
  await mkdir(dir, { recursive: true });
  const errors: string[] = [];
  for (const f of files.slice(0, UPLOAD_LIMIT[kind])) {
    const original = f.name.replace(/[^\w.\- ]+/g, "_").slice(0, 80);
    try {
      if (f.size > (kind === "music" ? 30 : 25) * 1024 * 1024) throw new Error("file too large");
      const id = db.uid();
      if (kind === "music") {
        const tmp = path.join(dir, `${id}.upload`);
        await writeFile(tmp, Buffer.from(await f.arrayBuffer()));
        try {
          const out = path.join(dir, `${id}.m4a`);
          const { duration } = await sanitizeAudio(tmp, out);
          for (const old of db.listAssets(p.id, "music")) await deleteAsset(old.id);
          db.insertAsset({ id, project_id: p.id, kind, path: pipeline.relPath(out), mime: "audio/mp4", duration, meta: { original_name: original } });
        } finally {
          await rm(tmp, { force: true });
        }
      } else {
        const img = await sanitizeImage(Buffer.from(await f.arrayBuffer()), kind === "logo");
        const out = path.join(dir, `${id}.${img.ext}`);
        await writeFile(out, img.data);
        if (kind === "logo") for (const old of db.listAssets(p.id, "logo")) await deleteAsset(old.id);
        db.insertAsset({ id, project_id: p.id, kind, path: pipeline.relPath(out), mime: img.mime, width: img.width, height: img.height, meta: { original_name: original } });
      }
    } catch (e: any) {
      errors.push(`${original}: ${e.message}`);
    }
  }
  return c.json({ ...view(p.id), upload_errors: errors });
});

app.delete("/api/projects/:id/assets/:assetId", async (c) => {
  const p = project(c);
  const a = db.getAsset(c.req.param("assetId"));
  if (!a || a.project_id !== p.id || !["reference", "logo", "music"].includes(a.kind)) throw new pipeline.FlowError("Only uploaded files can be deleted.");
  if (a.kind === "reference" && !["intake", "analysis"].includes(p.stage)) throw new pipeline.FlowError("Reference photos are locked after the brief.");
  await deleteAsset(a.id);
  return c.json(view(p.id));
});

// Files are addressed by asset id only (never by user-supplied path).
app.get("/api/projects/:id/files/:assetId", async (c) => {
  const p = project(c);
  const a = db.getAsset(c.req.param("assetId"));
  if (!a || a.project_id !== p.id) return c.json({ error: "Not found" }, 404);
  return sendFile(c, pipeline.abs(a.path), a.mime);
});

app.get("/api/projects/:id/export.zip", async (c) => {
  const zip = project(c).spec.export?.zip;
  if (!zip) return c.json({ error: "No export archive" }, 404);
  return sendFile(c, pipeline.abs(zip), "application/zip", path.basename(zip));
});

// ---------------- workflow actions ----------------

const Confirm = z.object({ confirm_usd: z.number().nonnegative().optional() });

app.post("/api/projects/:id/analyze", async (c) => {
  const { notes, confirm_usd } = await body(c, Confirm.extend({ notes: z.string().max(4000) }));
  await pipeline.analyze(project(c), notes, confirm_usd);
  return c.json(view(project(c).id));
});

app.put("/api/projects/:id/brief", async (c) => {
  const { brief, confirm_usd } = await body(c, Confirm.extend({ brief: S.Brief }));
  await pipeline.confirmBrief(project(c), brief, confirm_usd);
  return c.json(view(project(c).id));
});

app.put("/api/projects/:id/direction", async (c) => {
  const { direction, notes } = await body(c, z.object({ direction: S.Direction, notes: z.string().max(2000) }));
  pipeline.approveDirection(project(c), direction, notes);
  return c.json(view(project(c).id));
});

app.put("/api/projects/:id/models", async (c) => {
  pipeline.selectModels(project(c), await body(c, S.Models));
  return c.json(view(project(c).id));
});

app.post("/api/projects/:id/plan", async (c) => {
  await pipeline.buildPlan(project(c), await body(c, S.Budget));
  return c.json(view(project(c).id));
});

app.post("/api/projects/:id/plan/approve", async (c) => {
  const { hash } = await body(c, z.object({ hash: z.string() }));
  await pipeline.approvePlan(project(c), hash);
  return c.json(view(project(c).id));
});

app.post("/api/projects/:id/assets/:assetId/decision", async (c) => {
  const { decision, note } = await body(c, z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(1000).default("") }));
  pipeline.decide(project(c), c.req.param("assetId"), decision, note);
  return c.json(view(project(c).id));
});

app.post("/api/projects/:id/assets/:assetId/qc", async (c) => {
  await pipeline.runQc(project(c), c.req.param("assetId"));
  return c.json(view(project(c).id));
});

const Retry = z.object({ asset_id: z.string().optional(), job_id: z.string().optional(), mode: z.enum(["regenerate", "edit"]), prompt: z.string().min(1).max(5000) });
app.post("/api/projects/:id/retry/preview", async (c) => {
  const r = await body(c, Retry);
  return c.json(await pipeline.retryPreview(project(c), r, r.mode, r.prompt));
});
app.post("/api/projects/:id/retry", async (c) => {
  const r = await body(c, Retry.extend({ expected_usd: z.number() }));
  await pipeline.retry(project(c), r, r.mode, r.prompt, r.expected_usd);
  return c.json(view(project(c).id));
});

app.post("/api/projects/:id/storyboard", async (c) => {
  const o = await body(c, z.object({ seconds: z.number().int().min(5).max(60), shots: z.number().int().min(1).max(10), aspect: z.enum(S.VIDEO_ASPECTS), style: z.string().max(1000) }));
  await pipeline.makeStoryboard(project(c), o);
  return c.json(view(project(c).id));
});

app.put("/api/projects/:id/storyboard", async (c) => {
  const sb = await body(c, S.Storyboard.extend({ trims: z.record(z.string(), z.number().min(0).max(10)).optional() }));
  for (const s of sb.shots) if (s.duration < 0.5 || s.duration > 15) throw new pipeline.FlowError(`Shot ${s.id}: duration must be 0.5–15 s.`);
  pipeline.saveStoryboard(project(c), sb);
  return c.json(view(project(c).id));
});

app.post("/api/projects/:id/keyframes/:shotId", async (c) => {
  const { expected_usd } = await body(c, z.object({ expected_usd: z.number().nullable() }));
  const keyframe = await pipeline.generateKeyframe(project(c), c.req.param("shotId"), expected_usd);
  return c.json({ ...view(project(c).id), keyframe });
});

app.post("/api/projects/:id/video/plan", async (c) => {
  await pipeline.buildVideoPlan(project(c));
  return c.json(view(project(c).id));
});

app.post("/api/projects/:id/video/approve", async (c) => {
  const { hash } = await body(c, z.object({ hash: z.string() }));
  await pipeline.approveVideoPlan(project(c), hash);
  return c.json(view(project(c).id));
});

app.post("/api/projects/:id/edit", async (c) => {
  await pipeline.renderEdit(project(c), await body(c, S.EditSettings));
  return c.json(view(project(c).id));
});

app.post("/api/projects/:id/final/approve", (c) => {
  pipeline.approveFinal(project(c));
  return c.json(view(project(c).id));
});

app.post("/api/projects/:id/export", async (c) => {
  await exportCampaign(project(c));
  return c.json(view(project(c).id));
});

app.post("/api/projects/:id/status", async (c) => {
  const { status } = await body(c, z.object({ status: z.enum(["active", "paused", "cancelled"]) }));
  pipeline.setStatus(project(c), status);
  return c.json(view(project(c).id));
});

app.post("/api/projects/:id/back", async (c) => {
  const { stage } = await body(c, z.object({ stage: z.enum(S.STAGES) }));
  pipeline.goBack(project(c), stage);
  return c.json(view(project(c).id));
});

// ---------------- static UI + start ----------------

if (existsSync("web/dist/index.html")) {
  app.use("/*", serveStatic({ root: "web/dist" }));
  app.get("*", serveStatic({ path: "web/dist/index.html" }));
} else app.get("/", (c) => c.text("UI not built. Run `npm run build` (or `npm run dev:web` for the dev server)."));

if (process.env.NODE_ENV !== "test") {
  if (!LOOPBACK && APP_TOKEN.length < 24) {
    console.error("Refusing to listen on a non-loopback HOST without APP_TOKEN (>= 24 chars). See README → Security.");
    process.exit(1);
  }
  startWorker();
  serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
    console.log(`AI Product Creative Studio → http://${LOOPBACK ? "localhost" : HOST}:${PORT}`);
    console.log(`Providers: ${activeProviders().map((p) => p.label).join(", ") || "none"} · Claude: ${claudeConfigured() ? CLAUDE_MODEL : "not configured (templates)"}`);
  });
}
