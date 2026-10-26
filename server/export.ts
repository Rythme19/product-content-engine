// Campaign folder export: approved images (platform crops + copy variant), final
// videos, individual shots, storyboard, prompts, spec, cost report, export specs.
import path from "node:path";
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DATA_DIR, db, listAssets, listJobs, log, now, saveProject, type Project } from "./db.ts";
import { ledger } from "./budget.ts";
import { ASPECT_SIZES, compositeStill, coverImage, renderOverlay } from "./media.ts";
import { SLOTS } from "./schemas.ts";
import { abs, approvedFor, FlowError } from "./pipeline.ts";

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "campaign";

const PLATFORM_FORMATS: Record<string, string[]> = {
  instagram_feed: ["4:5", "1:1"], instagram_stories: ["9:16"], tiktok: ["9:16"], facebook: ["4:5", "1:1"], website: ["16:9", "1:1"], paid_ads: ["1:1", "4:5", "9:16"],
};

export async function exportCampaign(p: Project) {
  if (p.status !== "active" || p.stage !== "export") throw new FlowError("Approve the final QC first.");
  const spec = p.spec;
  const brief = spec.brief!;
  const name = slug(brief.product.name);
  const root = path.join(DATA_DIR, "exports", `${name}-${p.id.slice(0, 8)}`, `${slug(spec.direction?.name ?? "campaign")}_${now().slice(0, 10)}`);
  await rm(root, { recursive: true, force: true });
  for (const d of ["images", "video/shots", "docs"]) await mkdir(path.join(root, d), { recursive: true });

  // Images: original + one crop per format the chosen platforms need; hero/benefit also with exact typography.
  const formats = [...new Set((brief.platforms.length ? brief.platforms : ["instagram_feed"]).flatMap((pl) => PLATFORM_FORMATS[pl] ?? []))];
  const logo = listAssets(p.id, "logo").at(-1);
  const headline = spec.edit?.headline ?? spec.storyboard?.headline ?? "";
  const cta = spec.edit?.cta ?? spec.storyboard?.cta ?? "";
  const imageRows: string[] = [];
  for (const slot of SLOTS) {
    const a = approvedFor(p.id, "image", slot);
    if (!a) continue;
    const orig = path.join(root, "images", `${name}_${slot}_original${path.extname(a.path)}`);
    await copyFile(abs(a.path), orig);
    imageRows.push(`| ${slot} | original | ${a.width}×${a.height} | ${path.basename(orig)} |`);
    for (const f of formats) {
      const [w, h] = ASPECT_SIZES[f];
      const out = path.join(root, "images", `${name}_${slot}_${f.replace(":", "x")}_${w}x${h}.jpg`);
      await coverImage(abs(a.path), out, w, h);
      imageRows.push(`| ${slot} | ${f} | ${w}×${h} | ${path.basename(out)} |`);
      if (slot !== "lifestyle" && headline) {
        const ovl = await renderOverlay({
          width: w, height: h, headline, cta, font: brief.brand.typography, accent: brief.brand.colors[0],
          logo: logo ? abs(logo.path) : undefined, logoPosition: spec.edit?.logo_position,
        }, path.join(root, ".tmp", `ovl_${f.replace(":", "x")}.png`));
        const withCopy = out.replace(/\.jpg$/, "_with-copy.jpg");
        await compositeStill(out, ovl, withCopy);
        imageRows.push(`| ${slot} | ${f} + copy | ${w}×${h} | ${path.basename(withCopy)} |`);
      }
    }
  }
  await rm(path.join(root, ".tmp"), { recursive: true, force: true });

  // Video: final edits (branded + clean) and each approved shot.
  const videoRows: string[] = [];
  for (const v of listAssets(p.id, "video").filter((a) => !a.meta.superseded)) {
    const slot = v.slot ?? "";
    const fmt = slot.slice(0, slot.lastIndexOf(":")); // slot is "<aspect>:<variant>", e.g. "9:16:branded"
    const variant = slot.slice(slot.lastIndexOf(":") + 1);
    const out = path.join(root, "video", `${name}_${Math.round(v.duration ?? 0)}s_${fmt.replace(":", "x")}_${variant}.mp4`);
    await copyFile(abs(v.path), out);
    videoRows.push(`| ${fmt} | ${variant} | ${v.width}×${v.height} | ${(v.duration ?? 0).toFixed(2)} s | ${path.basename(out)} |`);
  }
  for (const [i, s] of (spec.storyboard?.shots ?? []).entries()) {
    const a = approvedFor(p.id, "shot", s.id);
    if (a) await copyFile(abs(a.path), path.join(root, "video", "shots", `shot${String(i + 1).padStart(2, "0")}_${slug(s.title)}.mp4`));
  }

  // Documents.
  const jobs = listJobs(p.id);
  const llm = db.prepare("SELECT purpose, model, est_usd, usd, ok, created_at FROM llm_calls WHERE project_id = ? ORDER BY created_at").all(p.id) as any[];
  const l = ledger(p.id);
  const csv = ["type,kind,slot,provider,model,status,estimated_usd,actual_usd,created_at",
    ...jobs.map((j) => ["generation", j.kind, j.slot, j.provider, j.model, j.status, j.est_usd.toFixed(4), (j.actual_usd ?? 0).toFixed(4), j.created_at].join(",")),
    ...llm.map((c) => ["claude", c.purpose, "", "anthropic", c.model, c.ok ? "ok" : "error", c.est_usd.toFixed(4), c.usd.toFixed(4), c.created_at].join(",")),
  ].join("\n");
  await writeFile(path.join(root, "docs", "cost-report.csv"), csv + "\n");
  await writeFile(path.join(root, "docs", "cost-report.md"), `# Cost report — ${brief.product.name}

| | USD |
|---|---|
| Authorised budget | ${l.max_usd?.toFixed(2)} |
| Generation (billed on success) | ${l.generation_spent_usd.toFixed(4)} |
| Failed / moderated / cancelled (not charged) | ${l.failed_not_charged_usd.toFixed(4)} |
| Claude (actual, from token usage) | ${l.llm_spent_usd.toFixed(4)} (estimated ${l.llm_estimated_usd.toFixed(4)}) |
| **Total committed** | **${l.committed_usd.toFixed(4)}** |
| Remaining | ${l.remaining_usd?.toFixed(4)} |

Generations: ${l.completed} completed, ${l.failed} failed or not delivered. Retries used: ${spec.retries_used ?? 0}/${spec.budget?.max_retries}.
Generation "actual" equals the provider's per-request quote: Higgsfield bills that amount on success and exposes no per-request charge lookup. Reconcile against your Higgsfield console.
`);
  const prompts = {
    images: jobs.filter((j) => j.kind !== "shot").map((j) => ({ slot: j.slot, kind: j.kind, model: j.model, status: j.status, prompt: j.input.gen?.prompt, negative: j.input.gen?.negative })),
    shots: jobs.filter((j) => j.kind === "shot").map((j) => ({ shot: j.slot, model: j.model, status: j.status, prompt: j.input.gen?.prompt, duration: j.input.gen?.duration })),
  };
  await writeFile(path.join(root, "docs", "prompts.json"), JSON.stringify(prompts, null, 2));
  await writeFile(path.join(root, "docs", "campaign.json"), JSON.stringify({ id: p.id, name: p.name, exported_at: now(), ...spec, export: undefined }, null, 2));
  const sb = spec.storyboard;
  await writeFile(path.join(root, "docs", "storyboard.md"), sb ? `# Storyboard — ${sb.concept}

Aspect ${sb.aspect_ratio} · ${sb.shots.reduce((n, s) => n + s.duration, 0)} s · headline "${headline}" · CTA "${cta}"

${sb.shots.map((s, i) => `## Shot ${i + 1} — ${s.title} (${s.duration}s)
- Purpose: ${s.purpose}
- Composition: ${s.composition}
- Camera: ${s.camera_movement}
- Subject motion: ${s.subject_motion}
- Lighting: ${s.lighting}
- Environment: ${s.environment}
- First frame: approved ${s.reference_slot} still
- Transition out: ${s.transition}
- Prompt: ${s.prompt}`).join("\n\n")}

Voice-over (proposed, not generated): ${sb.voiceover_script || "none"}
Music direction: ${sb.music_direction}
` : "No storyboard.\n");
  await writeFile(path.join(root, "docs", "export-specs.md"), `# Export specifications

## Images
| Slot | Format | Size | File |
|---|---|---|---|
${imageRows.join("\n")}

Crops use saliency-aware cover cropping from the approved original. "with-copy" variants composite exact typography and logo locally (never rendered by the image model).

## Video
| Format | Variant | Size | Duration | File |
|---|---|---|---|---|
${videoRows.join("\n")}

H.264 (yuv420p, CRF 18, 30 fps) + AAC 192 kbps 48 kHz, loudness normalised to −16 LUFS, faststart. "clean" = no text or logo overlay.
`);
  await writeFile(path.join(root, "README.md"), `# ${brief.product.name} — ${spec.direction?.name ?? "campaign"}

Exported ${now()} from AI Product Creative Studio (project ${p.id}).

- \`images/\` approved hero, lifestyle and benefit images: originals, platform crops (${formats.join(", ")}), and with-copy variants
- \`video/\` final edits per format (branded + clean) and \`shots/\` with each approved take
- \`docs/\` storyboard, prompts, campaign spec, cost report (md + csv), export specs

All assets are AI-generated from the supplied product photos. Check product fidelity, claims and any regulated wording before publishing. Music, if included, was supplied by the user, who confirmed usage rights.
`);

  const files = await walk(root);
  let zip: string | undefined = root + ".zip";
  try {
    await rm(zip, { force: true });
    await promisify(execFile)("zip", ["-r", "-q", zip, path.basename(root)], { cwd: path.dirname(root), timeout: 300_000 });
  } catch {
    zip = undefined; // zip CLI unavailable: the folder export is still complete
  }
  saveProject({ id: p.id, stage: "done", status: "done", spec: { ...spec, export: { dir: path.relative(DATA_DIR, root), files: files.map((f) => path.relative(root, f)), zip: zip && path.relative(DATA_DIR, zip), at: now() } } });
  log(p.id, "info", `exported ${files.length} files to ${root}`);
  return { dir: root, files: files.length };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(f)));
    else if ((await stat(f)).size > 0) out.push(f);
  }
  return out;
}
