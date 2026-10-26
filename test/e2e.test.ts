// Full workflow through the HTTP API with the mock provider and offline templates:
// intake → … → export, asserting real files are produced and costs are recorded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { BUDGET, client, isolate, toBudgetStage, upload } from "./helpers.ts";

const DATA = isolate();
const { app } = await import("../server/main.ts");
const { tick } = await import("../server/jobs.ts");
const api = client(app);

async function drain(pid: string) {
  for (let i = 0; i < 80; i++) {
    await tick();
    await new Promise((r) => setTimeout(r, 250)); // worker waits ~3 s before the first status poll
    const { json } = await api.get(`/api/projects/${pid}`);
    if (!json.jobs.some((j: any) => ["queued", "submitting", "submitted"].includes(j.status))) return json;
  }
  throw new Error("jobs did not finish");
}

test("end-to-end campaign with mock provider", { timeout: 240_000 }, async () => {
  const pid = await toBudgetStage(api);

  // Budget + plan approval gate.
  let r = await api.post(`/api/projects/${pid}/plan`, BUDGET);
  assert.equal(r.status, 200);
  const plan = r.json.project.spec.plan;
  assert.ok(plan.total_usd > 0 && plan.total_usd <= BUDGET.max_usd, `plan ${plan.total_usd}`);
  assert.equal(r.json.jobs.length, 0, "nothing generated before approval");
  r = await api.post(`/api/projects/${pid}/plan/approve`, { hash: plan.hash });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.project.stage, "image_production");
  assert.equal(r.json.jobs.length, 3);

  // Images.
  let v = await drain(pid);
  assert.equal(v.project.stage, "image_review");
  const images = v.assets.filter((a: any) => a.kind === "image");
  assert.equal(images.length, 3);
  for (const img of images) assert.ok(existsSync(path.join(DATA, img.path)));
  for (const img of images) assert.equal((await api.post(`/api/projects/${pid}/assets/${img.id}/decision`, { decision: "approve" })).status, 200);

  // Storyboard → video plan → approval → shots.
  r = await api.post(`/api/projects/${pid}/storyboard`, { seconds: 9, shots: 3, aspect: "9:16", style: "calm, premium" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.project.spec.storyboard.shots.length, 3);
  r = await api.post(`/api/projects/${pid}/video/plan`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const keyframes = r.json.assets.filter((a: any) => a.kind === "keyframe");
  assert.equal(keyframes.length, 3);
  assert.ok(keyframes.every((k: any) => k.width === 1080 && k.height === 1920), "keyframes cropped to 9:16");
  r = await api.post(`/api/projects/${pid}/video/approve`, { hash: r.json.project.spec.video_plan.hash });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  v = await drain(pid);
  const shots = v.assets.filter((a: any) => a.kind === "shot");
  assert.equal(shots.length, 3);
  for (const s of shots) await api.post(`/api/projects/${pid}/assets/${s.id}/decision`, { decision: "approve" });

  // Edit with logo + native audio in two formats.
  const logo = await sharp({ create: { width: 300, height: 120, channels: 4, background: { r: 200, g: 169, b: 126, alpha: 1 } } }).png().toBuffer();
  await upload(api, pid, "logo", "logo.png", logo, "image/png");
  r = await api.post(`/api/projects/${pid}/edit`, {
    formats: ["9:16", "1:1"], headline: "Light that lasts", cta: "Shop now", show_logo: true, logo_position: "top-left",
    end_card_seconds: 2.5, audio: "native", music_rights_confirmed: false,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.project.stage, "final_qc");
  const finals = r.json.assets.filter((a: any) => a.kind === "video" && !a.meta.superseded);
  assert.equal(finals.length, 4, "branded + clean for two formats");
  for (const f of finals) {
    assert.deepEqual(f.meta.checks, [], `${f.slot} technical checks`);
    assert.ok(Math.abs(f.duration - 8) < 0.6, `${f.slot} duration ${f.duration}`); // 9 s minus two 0.5 s fades
  }
  const vert = finals.find((f: any) => f.slot === "9:16:branded");
  assert.equal(vert.width, 1080);
  assert.equal(vert.height, 1920);

  // Video files are served with Range support (needed for seeking).
  const ranged = await app.request(`/api/projects/${pid}/files/${vert.id}`, { headers: { host: "localhost:8787", range: "bytes=0-99" } });
  assert.equal(ranged.status, 206);

  // Final QC → export.
  assert.equal((await api.post(`/api/projects/${pid}/final/approve`)).status, 200);
  r = await api.post(`/api/projects/${pid}/export`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const exp = r.json.project.spec.export;
  assert.equal(r.json.project.stage, "done");
  const root = path.join(DATA, exp.dir);
  for (const f of ["README.md", "docs/storyboard.md", "docs/prompts.json", "docs/campaign.json", "docs/cost-report.csv", "docs/cost-report.md", "docs/export-specs.md"])
    assert.ok(existsSync(path.join(root, f)), f);
  assert.ok(exp.files.filter((f: string) => f.startsWith("images/")).length >= 9, "originals + platform crops");
  assert.ok(exp.files.some((f: string) => f.includes("_9x16_branded.mp4")));
  assert.ok(exp.files.some((f: string) => f.includes("_9x16_clean.mp4")));
  assert.equal(exp.files.filter((f: string) => f.startsWith("video/shots/")).length, 3);
  const csv = readFileSync(path.join(root, "docs/cost-report.csv"), "utf8").trim().split("\n");
  assert.equal(csv.length, 1 + 6, "header + 3 image + 3 shot jobs");

  const final = (await api.get(`/api/projects/${pid}`)).json;
  assert.ok(final.ledger.generation_spent_usd > 0);
  assert.ok(final.ledger.remaining_usd >= 0);
  assert.equal(final.ledger.in_flight, 0);
});
