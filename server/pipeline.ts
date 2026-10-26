// Workflow orchestration: explicit stages, approval gates and every user action.
// State lives in SQLite (projects.spec + jobs + assets), so any step can resume after a restart.
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import {
  DATA_DIR, getAsset, getJob, getProject, insertAsset, listAssets, listJobs, log, now, saveProject, updateAsset, updateJob,
  type Asset, type Job, type Project,
} from "./db.ts";
import { BudgetError, enqueueJobs, ledger, planHash, type NewJob } from "./budget.ts";
import { findModel, clampDuration, type GenInput } from "./providers/index.ts";
import { analyzeProduct, claudeConfigured, estimateLlmUsd, proposeDirections, reviewVisual, writeImagePrompts, writeStoryboard } from "./llm.ts";
import { ASPECT_SIZES, assemble, coverImage, extractFrames, probe, ratio, renderOverlay } from "./media.ts";
import {
  STAGES, SLOTS, type Brief, type Budget, type Direction, type EditSettings, type Models, type Plan, type PlanItem, type Slot, type Stage, type Storyboard,
} from "./schemas.ts";

export class FlowError extends Error {
  status = 409;
}

export const SLOT_PURPOSE: Record<Slot, string> = {
  hero: "Hero product shot — immediate attention and premium presentation",
  lifestyle: "Lifestyle / context — the product in believable real-world use",
  benefit: "Benefit-focused ad — one verified selling point, space for copy",
};

export const abs = (rel: string) => path.join(DATA_DIR, rel);
export const relPath = (p: string) => path.relative(DATA_DIR, p);
export const projectDir = (pid: string) => path.join(DATA_DIR, "projects", pid);

const IN_FLIGHT = ["queued", "submitting", "submitted"];
const stageIndex = (s: Stage) => STAGES.indexOf(s);
const round = (n: number) => Math.round(n * 10000) / 10000;

function need(p: Project, ...stages: Stage[]) {
  if (p.status !== "active") throw new FlowError(`Project is ${p.status}. Resume it first.`);
  if (!stages.includes(p.stage)) throw new FlowError(`This action isn't available in stage "${p.stage}".`);
}
const inFlight = (pid: string) => listJobs(pid).filter((j) => IN_FLIGHT.includes(j.status));
const references = (pid: string) => listAssets(pid, "reference");
const reload = (pid: string) => getProject(pid)!;

function resolveModel(id: string | undefined, kind: "image" | "video") {
  const found = id ? findModel(id) : undefined;
  if (!found) throw new FlowError(`Model ${id ?? "(none)"} is not available. Configure its provider or choose another model; there is no automatic fallback.`);
  if (found.model.kind !== kind) throw new FlowError(`${found.model.name} is not a ${kind} model.`);
  return found;
}

// ---------------- Claude cost estimates for the next pre-production step ----------------

export function llmEstimates(p: Project) {
  if (!claudeConfigured()) return { analysis: 0, directions: 0 };
  const refs = Math.min(6, references(p.id).length);
  return {
    analysis: estimateLlmUsd("analysis", refs, 2500 + (p.spec.notes?.length ?? 0)),
    directions: estimateLlmUsd("directions", Math.min(3, refs), 3500 + JSON.stringify(p.spec.brief ?? {}).length),
  };
}

// ---------------- intake → analysis → directions → models ----------------

export async function analyze(p: Project, notes: string, confirmUsd?: number) {
  need(p, "intake", "analysis");
  const refs = references(p.id);
  if (!refs.length) throw new FlowError("Upload at least one product photo first.");
  saveProject({ id: p.id, spec: { ...p.spec, notes } });
  const analysis = await analyzeProduct(p.id, refs.map((a) => abs(a.path)), notes, confirmUsd);
  saveProject({ id: p.id, stage: "analysis", spec: { ...reload(p.id).spec, analysis, brief: analysis.brief } });
  log(p.id, "info", `analysis complete (${analysis.source})`);
}

export async function confirmBrief(p: Project, brief: Brief, confirmUsd?: number) {
  need(p, "analysis", "directions");
  if (!brief.product.name.trim()) throw new FlowError("Product name is required.");
  saveProject({ id: p.id, spec: { ...p.spec, brief, brief_confirmed_at: now() } });
  const directions = await proposeDirections(p.id, brief, references(p.id).map((a) => abs(a.path)), confirmUsd);
  saveProject({ id: p.id, stage: "directions", spec: { ...reload(p.id).spec, directions } });
}

export function approveDirection(p: Project, chosen: Direction, notes: string) {
  need(p, "directions", "models");
  if (!p.spec.directions) throw new FlowError("No directions proposed yet.");
  saveProject({ id: p.id, stage: "models", spec: { ...p.spec, direction: { ...chosen, notes }, direction_approved_at: now() } });
}

export function selectModels(p: Project, models: Models) {
  need(p, "models", "budget");
  resolveModel(models.image, "image");
  const edit = resolveModel(models.edit, "image");
  if (edit.model.max_refs < 2) throw new FlowError("The edit model must accept at least 2 reference images.");
  resolveModel(models.video, "video");
  saveProject({ id: p.id, stage: "budget", spec: { ...p.spec, models, plan: undefined } });
}

// ---------------- budget & production plan ----------------

const placeholderRefs = (n: number) => Array.from({ length: n }, (_, i) => `https://example.com/ref-${i}.jpg`);

function imageInput(b: Budget, prompt = "estimate", negative = ""): GenInput {
  return { prompt, negative, aspect: b.image_aspect, resolution: b.image_resolution, quality: b.image_quality };
}

export async function buildPlan(p: Project, budget: Budget): Promise<Plan> {
  need(p, "budget");
  const models = p.spec.models!;
  const img = resolveModel(models.image, "image");
  const edit = resolveModel(models.edit, "image");
  const vid = resolveModel(models.video, "video");
  const nRefs = references(p.id).length;
  const imgEst = await img.provider.estimate(img.model, { ...imageInput(budget), refs: placeholderRefs(Math.min(nRefs, img.model.max_refs)) });
  const editEst = await edit.provider.estimate(edit.model, { ...imageInput(budget), refs: placeholderRefs(Math.min(nRefs + 1, edit.model.max_refs)) });
  const shots = Math.min(5, budget.max_video_shots);
  const shotSeconds = clampDuration(vid.model, budget.video_seconds / shots);
  const shotEst = await vid.provider.estimate(vid.model, { prompt: "estimate", duration: shotSeconds, audio: budget.native_audio, resolution: budget.video_resolution });

  const items: PlanItem[] = [];
  for (const slot of SLOTS) for (let v = 1; v <= budget.images_per_slot; v++)
    items.push({ kind: "image", slot, model: img.model.id, label: `${slot} image v${v} · ${budget.image_aspect} ${budget.image_resolution}`, est_usd: imgEst });
  for (let s = 1; s <= shots; s++)
    items.push({ kind: "shot", slot: `s${s}`, model: vid.model.id, label: `video shot ${s} · ${shotSeconds}s generated (re-quoted after storyboard)`, est_usd: shotEst });
  if (budget.allow_keyframes)
    items.push({ kind: "keyframe", slot: "reserve", model: edit.model.id, label: `keyframe reserve · up to ${shots} extra reference frames`, est_usd: editEst == null ? null : editEst * shots });

  const reserve = budget.max_retries * Math.max(imgEst ?? 0, editEst ?? 0, shotEst ?? 0);
  const reviews = budget.auto_qc && claudeConfigured() ? (SLOTS.length * budget.images_per_slot + shots) * estimateLlmUsd("review", 4, 1200) : 0;
  const llm = claudeConfigured() ? estimateLlmUsd("prompts", 0, 6000) + estimateLlmUsd("storyboard", 3, 8000) + reviews : 0;
  if (imgEst == null || editEst == null || shotEst == null) log(p.id, "warn", "some estimates unavailable; plan can't be approved until they are");
  const total = items.reduce((s, i) => s + (i.est_usd ?? 0), 0) + reserve + llm;
  const plan: Plan = { items, reserve_usd: round(reserve), llm_usd: round(llm), total_usd: round(total), hash: "", created_at: now() };
  plan.hash = planHash({ plan, budget, models });
  saveProject({ id: p.id, spec: { ...p.spec, budget, plan } });
  return plan;
}

export function planProblems(p: Project): string[] {
  const plan = p.spec.plan;
  if (!plan || !p.spec.budget) return ["No plan yet."];
  const out: string[] = [];
  if (plan.items.some((i) => i.est_usd == null)) out.push("Some costs could not be estimated by the provider; re-run the estimate.");
  const spent = ledger(p.id).committed_usd;
  if (plan.total_usd + spent > p.spec.budget.max_usd + 1e-9)
    out.push(`Plan ($${plan.total_usd.toFixed(2)}) plus spend so far ($${spent.toFixed(2)}) exceeds the budget ($${p.spec.budget.max_usd.toFixed(2)}). Raise the budget or reduce counts/quality.`);
  return out;
}

export async function approvePlan(p: Project, hash: string) {
  need(p, "budget");
  const plan = p.spec.plan;
  if (!plan || plan.hash !== hash) throw new FlowError("The plan changed since you reviewed it. Review the new estimate and approve again.");
  if (plan.approved_at) throw new FlowError("This plan is already approved.");
  const problems = planProblems(p);
  if (problems.length) throw new BudgetError(problems.join(" "));
  saveProject({ id: p.id, spec: { ...p.spec, plan: { ...plan, approved_at: now() } } });
  const spec = reload(p.id).spec;
  const img = resolveModel(spec.models!.image, "image");
  const imagePlan = await writeImagePrompts(p.id, spec.brief!, spec.direction!, { name: img.model.name, max_refs: img.model.max_refs, negative_field: img.model.endpoint.includes("qwen") }, spec.budget!.image_aspect);
  const refIds = references(p.id).map((a) => a.id).slice(0, img.model.max_refs);
  const jobs: NewJob[] = plan.items.filter((i) => i.kind === "image").map((item) => {
    const s = imagePlan.images.find((x) => x.slot === item.slot) ?? imagePlan.images[0];
    return {
      kind: "image", slot: item.slot, provider: img.provider.id, model: img.model.id, est_usd: item.est_usd,
      input: { gen: imageInput(spec.budget!, s.prompt, s.negative), ref_assets: refIds },
      meta: { purpose: SLOT_PURPOSE[item.slot as Slot], copy_space: s.copy_space, benefit_focus: s.benefit_focus },
    };
  });
  enqueueJobs(p.id, jobs);
  saveProject({ id: p.id, stage: "image_production", spec: { ...reload(p.id).spec, image_plan: imagePlan, retries_used: 0 } });
}

// ---------------- review, QC and controlled regeneration ----------------

export function decide(p: Project, assetId: string, decision: "approve" | "reject", note: string) {
  const a = getAsset(assetId);
  if (!a || a.project_id !== p.id || !["image", "keyframe", "shot", "video"].includes(a.kind)) throw new FlowError("Asset not found.");
  updateAsset(a.id, { status: decision === "approve" ? "approved" : "rejected", meta: { ...a.meta, decision_note: note, decided_at: now() } });
  if (a.kind === "keyframe" && decision === "approve" && p.spec.storyboard) {
    const keyframes = { ...(p.spec.storyboard.keyframes ?? {}), [a.slot!]: a.id };
    saveProject({ id: p.id, spec: { ...p.spec, storyboard: { ...p.spec.storyboard, keyframes }, video_plan: undefined } });
  }
}

export async function runQc(p: Project, assetId: string) {
  const a = getAsset(assetId);
  if (!a || a.project_id !== p.id) throw new FlowError("Asset not found.");
  if (!claudeConfigured()) throw new FlowError("AI review needs ANTHROPIC_API_KEY. Review visually instead.");
  const files = a.mime.startsWith("video/")
    ? await extractFrames(abs(a.path), [0.2, (a.duration ?? 2) / 2, Math.max(0.2, (a.duration ?? 2) - 0.3)], path.join(projectDir(p.id), "frames", a.id))
    : [abs(a.path)];
  const purpose = a.meta.purpose ?? (a.kind === "video" ? "Final edited ad video" : a.kind);
  try {
    const review = await reviewVisual(p.id, p.spec.brief!, purpose, references(p.id).map((r) => abs(r.path)), files);
    updateAsset(a.id, { meta: { ...getAsset(a.id)!.meta, review, review_at: now(), review_error: undefined } });
  } catch (e: any) {
    updateAsset(a.id, { meta: { ...getAsset(a.id)!.meta, review_error: e.message } });
    throw e;
  }
}

type RetrySource = { asset_id?: string; job_id?: string };

function retrySource(p: Project, src: RetrySource): Job {
  const job = src.asset_id ? getJob(getAsset(src.asset_id)?.job_id ?? "") : src.job_id ? getJob(src.job_id) : undefined;
  if (!job || job.project_id !== p.id) throw new FlowError("Nothing to regenerate from.");
  return job;
}

/** Build (but don't submit) a regeneration, so the change and its price are shown before any paid attempt. */
async function retryDraft(p: Project, src: RetrySource, mode: "regenerate" | "edit", prompt: string) {
  const base = retrySource(p, src);
  const used = p.spec.retries_used ?? 0;
  const max = p.spec.budget!.max_retries;
  if (base.kind === "shot" || mode === "regenerate") {
    const found = resolveModel(base.model, base.kind === "shot" ? "video" : "image");
    const input: Record<string, any> = { ...base.input, gen: { ...base.input.gen, prompt } };
    const est = await found.provider.estimate(found.model, { ...input.gen, refs: placeholderRefs((input.ref_assets ?? []).length) });
    const job: NewJob = { kind: base.kind, slot: base.slot, provider: found.provider.id, model: found.model.id, input, est_usd: est, meta: { ...base.meta, retry_of: base.id, mode } };
    return { job, used, max };
  }
  // edit: targeted fix of a generated still, using the still + product photos as references.
  const asset = getAsset(src.asset_id ?? "");
  if (!asset) throw new FlowError("Edit mode needs a generated image to fix.");
  const found = resolveModel(p.spec.models!.edit, "image");
  const refs = [asset.id, ...references(p.id).map((a) => a.id)].slice(0, found.model.max_refs);
  const input = { gen: { ...base.input.gen, prompt }, ref_assets: refs };
  const est = await found.provider.estimate(found.model, { ...input.gen, refs: placeholderRefs(refs.length) });
  const job: NewJob = { kind: base.kind, slot: base.slot, provider: found.provider.id, model: found.model.id, input, est_usd: est, meta: { ...base.meta, retry_of: base.id, mode, fixes_asset: asset.id } };
  return { job, used, max };
}

export async function retryPreview(p: Project, src: RetrySource, mode: "regenerate" | "edit", prompt: string) {
  const d = await retryDraft(p, src, mode, prompt);
  return { model: d.job.model, est_usd: d.job.est_usd, retries_used: d.used, retries_max: d.max, remaining_usd: ledger(p.id).remaining_usd };
}

export async function retry(p: Project, src: RetrySource, mode: "regenerate" | "edit", prompt: string, expectedUsd: number) {
  need(p, "image_production", "image_review", "storyboard", "video_production");
  const slot = retrySource(p, src).slot;
  if (inFlight(p.id).some((j) => j.slot === slot)) throw new FlowError("A job for this slot is still running.");
  const d = await retryDraft(p, src, mode, prompt);
  if (d.used >= d.max) throw new BudgetError(`Retry allowance used (${d.used}/${d.max}). Approve a higher allowance to continue.`);
  if (d.job.est_usd == null || Math.abs(d.job.est_usd - expectedUsd) > 0.005)
    throw new FlowError(`Price changed to ${d.job.est_usd == null ? "unknown" : "$" + d.job.est_usd.toFixed(3)}; review and confirm again.`);
  enqueueJobs(p.id, [d.job]);
  const cur = reload(p.id);
  const stage: Stage = d.job.kind === "shot" ? "video_production" : cur.stage === "image_review" ? "image_production" : cur.stage;
  saveProject({ id: p.id, stage, spec: { ...cur.spec, retries_used: d.used + 1 } });
}

/** Called by the worker after each job reaches a terminal state. */
export async function afterJob(job: Job, asset?: Asset) {
  const p = getProject(job.project_id);
  if (!p) return;
  if (asset && p.spec.budget?.auto_qc && claudeConfigured()) {
    await runQc(p, asset.id).catch((e) => log(p.id, "warn", `auto QC skipped: ${e.message}`));
  }
  if (p.stage === "image_production" && !inFlight(p.id).some((j) => j.kind === "image")) saveProject({ id: p.id, stage: "image_review" });
}

// ---------------- storyboard & video ----------------

export const approvedFor = (pid: string, kind: string, slot: string) =>
  listAssets(pid, kind).filter((a) => a.slot === slot && a.status === "approved").at(-1);

export async function makeStoryboard(p: Project, o: { seconds: number; shots: number; aspect: string; style: string }) {
  need(p, "image_review", "storyboard");
  if (inFlight(p.id).length) throw new FlowError("Wait for running jobs to finish.");
  const stills = SLOTS.map((slot) => ({ slot, asset: approvedFor(p.id, "image", slot) }));
  const missing = stills.filter((s) => !s.asset).map((s) => s.slot);
  if (missing.length) throw new FlowError(`Approve one image for: ${missing.join(", ")}.`);
  const b = p.spec.budget!;
  if (o.shots > b.max_video_shots) throw new BudgetError(`Budget allows at most ${b.max_video_shots} shots.`);
  const vid = resolveModel(p.spec.models!.video, "video");
  const sb = await writeStoryboard(p.id, p.spec.brief!, p.spec.direction!, {
    ...o, min_shot: vid.model.durations?.[0] ?? 1,
    images: stills.map((s) => ({ slot: s.slot, prompt: s.asset!.meta.prompt ?? "" })),
  }, stills.map((s) => abs(s.asset!.path)));
  saveProject({ id: p.id, stage: "storyboard", spec: { ...reload(p.id).spec, storyboard: { ...sb, keyframes: {}, trims: {} }, video_plan: undefined } });
}

export function saveStoryboard(p: Project, sb: Storyboard & { trims?: Record<string, number> }) {
  need(p, "storyboard", "video_approval");
  if (!sb.shots.length) throw new FlowError("A storyboard needs at least one shot.");
  if (sb.shots.length > p.spec.budget!.max_video_shots) throw new BudgetError(`Budget allows at most ${p.spec.budget!.max_video_shots} shots.`);
  if (new Set(sb.shots.map((s) => s.id)).size !== sb.shots.length) throw new FlowError("Shot ids must be unique.");
  const prev = p.spec.storyboard;
  saveProject({ id: p.id, stage: "storyboard", spec: { ...p.spec, storyboard: { ...sb, source: prev?.source ?? "template", keyframes: prev?.keyframes ?? {}, trims: sb.trims ?? prev?.trims ?? {} }, video_plan: undefined } });
}

/** Free local keyframe: crop the shot's approved still to the video aspect. */
async function cropKeyframe(p: Project, shotId: string, slot: Slot, aspect: string) {
  const still = approvedFor(p.id, "image", slot);
  if (!still) throw new FlowError(`No approved ${slot} image.`);
  const [w, h] = ASPECT_SIZES[aspect];
  const dest = path.join(projectDir(p.id), "keyframes", `${shotId}_${slot}_${aspect.replace(":", "x")}.jpg`);
  await coverImage(abs(still.path), dest, w, h);
  return insertAsset({ project_id: p.id, kind: "keyframe", slot: shotId, path: relPath(dest), mime: "image/jpeg", width: w, height: h, status: "approved", meta: { source: "crop", from_asset: still.id, purpose: `Keyframe for shot ${shotId}` } });
}

/** Optional paid keyframe at the video aspect, generated from the approved still + product photos. */
export async function generateKeyframe(p: Project, shotId: string, expectedUsd: number | null) {
  need(p, "storyboard");
  const b = p.spec.budget!;
  if (!b.allow_keyframes) throw new BudgetError("Extra keyframes are not authorised in this budget.");
  const shot = p.spec.storyboard?.shots.find((s) => s.id === shotId);
  if (!shot) throw new FlowError("Unknown shot.");
  const still = approvedFor(p.id, "image", shot.reference_slot);
  if (!still) throw new FlowError(`No approved ${shot.reference_slot} image.`);
  const found = resolveModel(p.spec.models!.edit, "image");
  const refs = [still.id, ...references(p.id).map((a) => a.id)].slice(0, found.model.max_refs);
  const gen: GenInput = {
    prompt: `Recompose the first reference image as a ${p.spec.storyboard!.aspect_ratio} frame for: ${shot.composition}. Keep the same scene, light and palette. The product must exactly match the other reference photos. No text.`,
    negative: "altered label text, extra logos, warped product, duplicate products", aspect: p.spec.storyboard!.aspect_ratio, resolution: b.image_resolution, quality: b.image_quality,
  };
  const est = await found.provider.estimate(found.model, { ...gen, refs: placeholderRefs(refs.length) });
  if (expectedUsd == null) return { est_usd: est }; // preview only
  if (est == null || Math.abs(est - expectedUsd) > 0.005) throw new FlowError("Price changed; review again.");
  enqueueJobs(p.id, [{ kind: "keyframe", slot: shotId, provider: found.provider.id, model: found.model.id, input: { gen, ref_assets: refs }, est_usd: est, meta: { purpose: `Keyframe for shot ${shotId}` } }]);
  return { est_usd: est };
}

export async function buildVideoPlan(p: Project) {
  need(p, "storyboard", "video_approval");
  if (inFlight(p.id).length) throw new FlowError("Wait for running jobs to finish.");
  const sb = p.spec.storyboard!;
  const vid = resolveModel(p.spec.models!.video, "video");
  const b = p.spec.budget!;
  const keyframes = { ...(sb.keyframes ?? {}) };
  for (const s of sb.shots) {
    const kf = keyframes[s.id] ? getAsset(keyframes[s.id]) : undefined;
    if (!kf || kf.status !== "approved" || Math.abs(ratio(sb.aspect_ratio) - kf.width! / kf.height!) > 0.02)
      keyframes[s.id] = (await cropKeyframe(p, s.id, s.reference_slot, sb.aspect_ratio)).id;
  }
  const items: PlanItem[] = [];
  for (const s of sb.shots) {
    const seconds = clampDuration(vid.model, s.duration + (sb.trims?.[s.id] ?? 0));
    const est = await vid.provider.estimate(vid.model, { prompt: s.prompt, duration: seconds, audio: b.native_audio, resolution: b.video_resolution });
    items.push({ kind: "shot", slot: s.id, model: vid.model.id, label: `${s.id} ${s.title} · ${seconds}s generated, ${s.duration}s used`, est_usd: est });
  }
  const total = items.reduce((n, i) => n + (i.est_usd ?? 0), 0);
  const video_plan: Plan = { items, reserve_usd: 0, llm_usd: 0, total_usd: round(total), hash: "", created_at: now() };
  video_plan.hash = planHash({ video_plan, shots: sb.shots, keyframes });
  saveProject({ id: p.id, stage: "video_approval", spec: { ...reload(p.id).spec, storyboard: { ...sb, keyframes }, video_plan } });
  return video_plan;
}

export async function approveVideoPlan(p: Project, hash: string) {
  need(p, "video_approval");
  const plan = p.spec.video_plan;
  if (!plan || plan.hash !== hash) throw new FlowError("The video plan changed since you reviewed it. Review and approve again.");
  if (plan.approved_at) throw new FlowError("This video plan is already approved.");
  if (plan.items.some((i) => i.est_usd == null)) throw new BudgetError("Some shot costs could not be estimated.");
  const sb = p.spec.storyboard!;
  const b = p.spec.budget!;
  const vid = resolveModel(p.spec.models!.video, "video");
  const jobs: NewJob[] = sb.shots.map((s, i) => ({
    kind: "shot", slot: s.id, provider: vid.provider.id, model: vid.model.id, est_usd: plan.items[i].est_usd,
    input: {
      gen: { prompt: s.prompt, negative: "morphing product, warped label, new text, duplicate objects, flicker", duration: clampDuration(vid.model, s.duration + (sb.trims?.[s.id] ?? 0)), audio: b.native_audio, resolution: b.video_resolution },
      first_frame_asset: sb.keyframes![s.id],
    },
    meta: { purpose: `Shot ${s.id}: ${s.purpose}`, title: s.title },
  }));
  enqueueJobs(p.id, jobs);
  saveProject({ id: p.id, stage: "video_production", spec: { ...p.spec, video_plan: { ...plan, approved_at: now() } } });
}

// ---------------- edit, final QC ----------------

export async function renderEdit(p: Project, e: EditSettings) {
  need(p, "video_production", "editing", "final_qc");
  if (inFlight(p.id).length) throw new FlowError("Wait for running jobs to finish.");
  const sb = p.spec.storyboard!;
  const shots = sb.shots.map((s) => ({ s, a: approvedFor(p.id, "shot", s.id) }));
  const missing = shots.filter((x) => !x.a).map((x) => x.s.id);
  if (missing.length) throw new FlowError(`Approve a take for shot(s): ${missing.join(", ")}.`);
  let track: string | undefined;
  if (e.audio === "track") {
    const music = e.music_asset_id ? getAsset(e.music_asset_id) : undefined;
    if (!music || music.project_id !== p.id || music.kind !== "music") throw new FlowError("Upload a music track first.");
    if (!e.music_rights_confirmed) throw new FlowError("Confirm you hold the rights to use this track.");
    track = abs(music.path);
  }
  saveProject({ id: p.id, stage: "editing", spec: { ...p.spec, edit: e } });
  const logo = listAssets(p.id, "logo").at(-1);
  const dir = path.join(projectDir(p.id), "edit");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const old of listAssets(p.id, "video")) updateAsset(old.id, { status: "rejected", meta: { ...old.meta, superseded: true } });
  try {
    const clips = await Promise.all(shots.map(async ({ s, a }) => {
      const info = await probe(abs(a!.path));
      const start = Math.min(sb.trims?.[s.id] ?? 0, Math.max(0, info.duration - 0.5));
      return { path: abs(a!.path), start, duration: Math.max(0.5, Math.min(s.duration, info.duration - start)), transition: s.transition, hasAudio: info.hasAudio };
    }));
    const checks: string[] = [];
    for (const fmt of e.formats) {
      const [W, H] = ASPECT_SIZES[fmt];
      const tag = fmt.replace(":", "x");
      const overlay = await renderOverlay({
        width: W, height: H, headline: e.headline, cta: e.cta, font: p.spec.brief!.brand.typography,
        accent: p.spec.brief!.brand.colors[0], logo: e.show_logo && logo ? abs(logo.path) : undefined, logoPosition: e.logo_position,
      }, path.join(dir, `overlay_${tag}.png`));
      for (const variant of ["branded", "clean"] as const) {
        const out = path.join(dir, `final_${tag}_${variant}.mp4`);
        const r = await assemble({ clips, width: W, height: H, out, overlay: variant === "branded" ? { png: overlay, seconds: e.end_card_seconds } : undefined, audio: { mode: e.audio, track } });
        const info = await probe(out);
        const problems = [
          info.width !== W || info.height !== H ? `resolution ${info.width}x${info.height} ≠ ${W}x${H}` : "",
          Math.abs(info.duration - r.duration) > 0.3 ? `duration ${info.duration.toFixed(2)}s ≠ planned ${r.duration.toFixed(2)}s` : "",
          e.audio !== "none" && !info.hasAudio ? "no audio track" : "",
          info.vcodec !== "h264" ? `codec ${info.vcodec}` : "",
        ].filter(Boolean);
        checks.push(...problems.map((x) => `${fmt} ${variant}: ${x}`));
        insertAsset({
          project_id: p.id, kind: "video", slot: `${fmt}:${variant}`, path: relPath(out), mime: "video/mp4", width: info.width, height: info.height, duration: info.duration,
          meta: { purpose: `Final ${fmt} ${variant} edit`, checks: problems },
        });
      }
    }
    log(p.id, checks.length ? "warn" : "info", `edit rendered: ${e.formats.join(", ")}${checks.length ? ` (${checks.length} check issues)` : ""}`, { checks });
  } finally {
    saveProject({ id: p.id, stage: "final_qc", spec: { ...reload(p.id).spec, final_approved_at: undefined } });
  }
}

export function approveFinal(p: Project) {
  need(p, "final_qc");
  const finals = listAssets(p.id, "video").filter((a) => !a.meta.superseded);
  if (!finals.length) throw new FlowError("Render the edit first.");
  saveProject({ id: p.id, stage: "export", spec: { ...p.spec, final_approved_at: now() } });
}

// ---------------- control: pause / resume / cancel / back ----------------

export function setStatus(p: Project, status: "active" | "paused" | "cancelled") {
  if (p.status === "cancelled" || p.status === "done") throw new FlowError(`Project is ${p.status}.`);
  saveProject({ id: p.id, status });
  if (status === "cancelled") for (const j of inFlight(p.id)) if (j.status === "queued") updateJob(j.id, { status: "canceled", actual_usd: 0, error: "cancelled by user" });
  log(p.id, "info", `project ${status}`);
}

const BACK_TARGETS: Stage[] = ["analysis", "directions", "models", "budget", "image_review", "storyboard", "final_qc"];

export function goBack(p: Project, to: Stage) {
  if (p.status !== "active") throw new FlowError(`Project is ${p.status}.`);
  if (!BACK_TARGETS.includes(to) || stageIndex(to) >= stageIndex(p.stage)) throw new FlowError(`Can't go back to ${to} from ${p.stage}.`);
  if (inFlight(p.id).length) throw new FlowError("Wait for running jobs to finish.");
  if (stageIndex(p.stage) > stageIndex("budget") && stageIndex(to) <= stageIndex("budget"))
    throw new FlowError("Production has started, so planning stages are locked. Start a new project to re-plan.");
  const spec = { ...p.spec };
  if (stageIndex(to) <= stageIndex("budget")) spec.plan = undefined;
  if (stageIndex(to) <= stageIndex("storyboard")) spec.video_plan = undefined;
  saveProject({ id: p.id, stage: to, spec });
}
