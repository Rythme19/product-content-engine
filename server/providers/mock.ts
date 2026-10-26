// Offline mock provider: renders real files locally (sharp + ffmpeg) so every stage
// — budget guard, jobs, review, assembly, export — runs end to end without spending.
// Outputs are clearly watermarked "MOCK". Prompt markers [mock:fail] / [mock:nsfw] simulate failures.
import sharp, { type OverlayOptions } from "sharp";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, uid } from "../db.ts";
import { ASPECT_SIZES, readJson, stillToClip, writeJson } from "../media.ts";
import { type ModelInfo, type Provider, ProviderError, clampDuration } from "./types.ts";

const DIR = path.join(DATA_DIR, "mock");
const PREFIX = "mock-file:";
const ASPECTS = ["1:1", "3:4", "9:16", "16:9", "4:5"];

const models: ModelInfo[] = [
  {
    id: "mock:image", provider: "mock", endpoint: "image", name: "Mock image (offline)", kind: "image",
    use: "Pipeline testing. Composites your reference photo on a backdrop — not AI.", inputs: "prompt, references", outputs: "1 image",
    aspects: ASPECTS, resolutions: ["1k", "2k", "4k"], qualities: ["low", "medium", "high"], max_refs: 8,
    limitations: "Not generative. For testing workflow, budget and export only.", quality_note: "Placeholder.",
    docs: "local", body: (i) => ({ ...i }),
  },
  {
    id: "mock:video", provider: "mock", endpoint: "video", name: "Mock image-to-video (offline)", kind: "video",
    use: "Pipeline testing. Slow push-in on the first frame.", inputs: "first frame, prompt, 2–15 s", outputs: "MP4",
    aspects: ["follows first frame"], resolutions: ["720p", "1080p"], durations: [2, 15], max_refs: 1, audio: true,
    limitations: "Not generative.", quality_note: "Placeholder.", docs: "local", body: (i) => ({ ...i }),
  },
];

/** Resolve a mock-file: URL back to a path, refusing anything outside DATA_DIR. */
function localPath(url: string) {
  if (!url.startsWith(PREFIX)) throw new ProviderError("mock provider only accepts its own uploads", 0, false);
  const p = path.resolve(url.slice(PREFIX.length));
  if (!p.startsWith(DATA_DIR + path.sep)) throw new ProviderError("path outside data dir", 0, false);
  return p;
}

async function renderImage(prompt: string, refs: string[], aspect: string, out: string) {
  const [w, h] = (ASPECT_SIZES[aspect] ?? ASPECT_SIZES["1:1"]).map((v) => Math.round(v / 2));
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><radialGradient id="g" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#3a3f4b"/><stop offset="1" stop-color="#121418"/></radialGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <text x="${w / 2}" y="${h - 24}" text-anchor="middle" font-family="Helvetica, Arial" font-size="${Math.round(w / 28)}" fill="#ffffff" opacity="0.55">MOCK · ${prompt.slice(0, 48).replace(/[<&>"']/g, "")}</text></svg>`);
  const layers: OverlayOptions[] = [];
  if (refs[0]) {
    const prod = await sharp(localPath(refs[0])).resize(Math.round(w * 0.62), Math.round(h * 0.62), { fit: "inside" }).toBuffer({ resolveWithObject: true });
    layers.push({ input: prod.data, left: Math.round((w - prod.info.width) / 2), top: Math.round((h - prod.info.height) / 2.4) });
  }
  await sharp(bg).composite(layers).png().toFile(out);
}

export const mock: Provider = {
  id: "mock",
  label: "Mock (offline, free)",
  configured: () => process.env.ENABLE_MOCK_PROVIDER !== "false",
  models,
  uploadTtlHours: 24 * 365,

  async estimate(m, input) {
    return m.kind === "image" ? 0.04 : Number((0.05 * clampDuration(m, input.duration ?? 5)).toFixed(2));
  },

  async submit(m, input, idempotencyKey) {
    // Same key -> same request, like Higgsfield, so a crash-resubmit never duplicates work.
    const id = idempotencyKey.replace(/[^a-zA-Z0-9-]/g, "") || uid();
    if (await stat(path.join(DIR, `${id}.json`)).catch(() => null)) return id;
    await mkdir(DIR, { recursive: true });
    const status = input.prompt.includes("[mock:fail]") ? "failed" : input.prompt.includes("[mock:nsfw]") ? "nsfw" : "completed";
    let output: string | undefined;
    if (status === "completed") {
      if (m.kind === "image") {
        output = path.join(DIR, `${id}.png`);
        await renderImage(input.prompt, input.refs ?? [], input.aspect ?? "1:1", output);
      } else {
        if (!input.first_frame) throw new ProviderError("first_frame required", 400, false);
        const meta = await sharp(localPath(input.first_frame)).metadata();
        const scale = 720 / Math.max(meta.width ?? 720, meta.height ?? 720);
        const even = (v: number) => Math.max(2, Math.round((v * scale) / 2) * 2);
        output = path.join(DIR, `${id}.mp4`);
        await stillToClip(localPath(input.first_frame), output, clampDuration(m, input.duration ?? 5), even(meta.width ?? 720), even(meta.height ?? 720), !!input.audio);
      }
    }
    await writeJson(path.join(DIR, `${id}.json`), { status, output, error: status === "completed" ? undefined : `simulated ${status}` });
    return id;
  },

  async poll(requestId) {
    const r = await readJson(path.join(DIR, `${path.basename(requestId)}.json`)).catch(() => null);
    if (!r) return { status: "failed", outputs: [], error: "unknown mock request" };
    return { status: r.status, outputs: r.output ? [PREFIX + r.output] : [], error: r.error };
  },

  async cancel() {
    return false;
  },

  async upload(file) {
    await stat(file);
    return PREFIX + path.resolve(file);
  },

  async download(url, dest) {
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(localPath(url), dest);
  },
};
