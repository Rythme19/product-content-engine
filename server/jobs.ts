// Background worker: submits approved jobs, polls providers, downloads and verifies
// outputs. Fully DB-driven, so a restart resumes where it stopped:
//  - "submitting" jobs are resent with the SAME idempotency key (provider dedupes; no double charge)
//  - "submitted" jobs are only polled, never resubmitted.
import path from "node:path";
import { rename } from "node:fs/promises";
import sharp from "sharp";
import { getAsset, getJob, getProject, insertAsset, jobsWithStatus, log, now, updateAsset, updateJob, redact, type Job } from "./db.ts";
import { findModel, providerById, ProviderError, type Provider } from "./providers/index.ts";
import { probe } from "./media.ts";
import { abs, afterJob, projectDir, relPath } from "./pipeline.ts";

const MAX_IN_FLIGHT = Number(process.env.MAX_IN_FLIGHT ?? 4);
const MAX_SUBMIT_ATTEMPTS = 5;
const MAX_DOWNLOAD_ATTEMPTS = 5;
const later = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const errText = (e: unknown) => redact(e instanceof Error ? e.message : String(e)).slice(0, 500);

let busy = false;

export function startWorker(intervalMs = 2000) {
  const t = setInterval(() => void tick(), intervalMs);
  t.unref();
  return t;
}

export async function tick() {
  if (busy) return;
  busy = true;
  try {
    await submitReady();
    await pollSubmitted();
  } catch (e) {
    log(null, "error", `worker tick failed: ${errText(e)}`);
  } finally {
    busy = false;
  }
}

/** Ensure an asset has a URL the provider can fetch (re-upload when the old one may have expired). */
async function remoteUrl(assetId: string, provider: Provider): Promise<string> {
  const a = getAsset(assetId);
  if (!a) throw new ProviderError(`input asset ${assetId} missing`, 0, false);
  const fresh = a.remote_url && a.meta.remote_provider === provider.id && a.remote_at && Date.now() - Date.parse(a.remote_at) < provider.uploadTtlHours * 3600_000;
  if (fresh) return a.remote_url!;
  const url = await provider.upload(abs(a.path), a.mime);
  updateAsset(a.id, { remote_url: url, remote_at: now(), meta: { ...a.meta, remote_provider: provider.id } });
  return url;
}

async function submitReady() {
  let slots = MAX_IN_FLIGHT - jobsWithStatus("submitted").length;
  // Interrupted submissions first: they may already be at the provider, so resending
  // (same idempotency key) adds no load and must not wait behind new work.
  for (const job of [...jobsWithStatus("submitting"), ...jobsWithStatus("queued")]) {
    if (slots <= 0 && job.status === "queued") return;
    if (job.next_poll_at && job.next_poll_at > now()) continue; // backoff after a retryable error
    const p = getProject(job.project_id);
    if (!p || p.status === "cancelled") {
      if (job.status === "queued") updateJob(job.id, { status: "canceled", actual_usd: 0, error: "project cancelled" });
      continue;
    }
    if (p.status !== "active" && job.status === "queued") continue; // paused: hold new submissions
    const found = findModel(job.model);
    if (!found || found.provider.id !== job.provider) {
      updateJob(job.id, { status: "failed", actual_usd: 0, error: `provider/model ${job.model} not configured; not substituting another model` });
      continue;
    }
    updateJob(job.id, { status: "submitting", attempts: job.attempts + 1 });
    try {
      const gen = { ...job.input.gen };
      if (job.input.ref_assets?.length) gen.refs = await Promise.all(job.input.ref_assets.map((id: string) => remoteUrl(id, found.provider)));
      if (job.input.first_frame_asset) gen.first_frame = await remoteUrl(job.input.first_frame_asset, found.provider);
      const requestId = await found.provider.submit(found.model, gen, job.idempotency_key);
      updateJob(job.id, { status: "submitted", request_id: requestId, next_poll_at: later(3), error: null });
      log(job.project_id, "info", `submitted ${job.kind} ${job.slot} → ${found.provider.id} ${requestId}`);
      slots--;
    } catch (e) {
      if (e instanceof ProviderError && e.retryable && job.attempts + 1 < MAX_SUBMIT_ATTEMPTS) {
        // Ambiguous/transient: keep "submitting" and resend later with the same idempotency key.
        updateJob(job.id, { error: errText(e), next_poll_at: later(5 * 2 ** job.attempts) });
      } else {
        updateJob(job.id, { status: "failed", actual_usd: 0, error: errText(e) });
        log(job.project_id, "error", `submit failed (${job.kind} ${job.slot}): ${errText(e)}`);
        await afterJob(getJob(job.id)!).catch(() => {});
      }
    }
  }
}

async function pollSubmitted() {
  for (const job of jobsWithStatus("submitted")) {
    if (job.next_poll_at && job.next_poll_at > now()) continue;
    const provider = providerById(job.provider);
    if (!provider) {
      updateJob(job.id, { next_poll_at: later(60), error: "provider not configured; cannot check status (job may still be billed)" });
      continue;
    }
    const age = (Date.now() - Date.parse(job.created_at)) / 1000;
    try {
      const r = await provider.poll(job.request_id!);
      if (r.status === "completed") await finish(job, provider, r.outputs);
      else if (r.status === "failed" || r.status === "nsfw" || r.status === "canceled") {
        // Provider documents these terminal states as not charged.
        updateJob(job.id, { status: r.status, actual_usd: 0, error: redact(r.error ?? r.status) });
        log(job.project_id, "warn", `${job.kind} ${job.slot} ${r.status}: ${r.error ?? ""}`);
        await afterJob(getJob(job.id)!);
      } else updateJob(job.id, { next_poll_at: later(Math.min(20, 3 + age / 10)) });
    } catch (e) {
      updateJob(job.id, { next_poll_at: later(30), meta: { ...job.meta, last_poll_error: errText(e) } });
    }
  }
}

const KIND_DIR: Record<string, string> = { image: "images", keyframe: "keyframes", shot: "shots" };

async function finish(job: Job, provider: Provider, outputs: string[]) {
  if (!outputs.length) {
    updateJob(job.id, { status: "download_failed", actual_usd: job.est_usd, error: "provider reported completion without outputs" });
    await afterJob(getJob(job.id)!);
    return;
  }
  const dir = path.join(projectDir(job.project_id), KIND_DIR[job.kind] ?? "outputs");
  try {
    const assets = [];
    for (const [i, url] of outputs.entries()) {
      const tmp = path.join(dir, `${job.slot}_${job.id.slice(0, 8)}_${i}.download`);
      await provider.download(url, tmp);
      assets.push(await verifyAndStore(job, tmp, url, i));
    }
    // Higgsfield has no per-request charge lookup; it bills the quoted estimate on success.
    updateJob(job.id, { status: "completed", actual_usd: job.est_usd, error: null, meta: { ...job.meta, cost_source: "provider estimate (billed on success)" } });
    log(job.project_id, "info", `${job.kind} ${job.slot} completed (${assets.length} file(s))`);
    for (const a of assets) await afterJob(getJob(job.id)!, a);
  } catch (e) {
    const attempts = (job.meta.download_attempts ?? 0) + 1;
    if (attempts >= MAX_DOWNLOAD_ATTEMPTS) {
      updateJob(job.id, { status: "download_failed", actual_usd: job.est_usd, error: `output could not be downloaded/verified: ${errText(e)}` });
      await afterJob(getJob(job.id)!);
    } else updateJob(job.id, { next_poll_at: later(15 * attempts), meta: { ...job.meta, download_attempts: attempts, last_download_error: errText(e) } });
  }
}

/** Treat downloaded bytes as untrusted: decode them, and keep only real images/videos. */
async function verifyAndStore(job: Job, tmp: string, url: string, i: number) {
  const base = tmp.replace(/\.download$/, "");
  const common = { project_id: job.project_id, kind: job.kind, slot: job.slot, job_id: job.id, remote_url: url.startsWith("https://") ? url : null, remote_at: now() };
  const meta = { ...job.meta, prompt: job.input.gen?.prompt, model: job.model, provider: job.provider, est_usd: job.est_usd, remote_provider: job.provider, variant: i };
  if (job.kind === "shot") {
    const info = await probe(tmp).catch(() => null);
    if (!info || !info.width || info.duration <= 0) throw new Error("downloaded file is not a playable video");
    await rename(tmp, base + ".mp4");
    return insertAsset({ ...common, path: relPath(base + ".mp4"), mime: "video/mp4", width: info.width, height: info.height, duration: info.duration, meta: { ...meta, has_audio: info.hasAudio } });
  }
  const m = await sharp(tmp).metadata().catch(() => null);
  if (!m?.format || !["png", "jpeg", "webp"].includes(m.format)) throw new Error("downloaded file is not an image");
  const ext = m.format === "jpeg" ? "jpg" : m.format;
  await rename(tmp, `${base}.${ext}`);
  return insertAsset({ ...common, path: relPath(`${base}.${ext}`), mime: `image/${m.format}`, width: m.width, height: m.height, meta });
}
