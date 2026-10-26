// Higgsfield REST adapter, built from https://docs.higgsfield.ai (verified 2026-10-26):
// auth "Authorization: Key ID:SECRET", async queue (request_id + /requests/{id}/status),
// Idempotency-Key on submissions, POST /estimate/{endpoint} -> {"usd": "..."},
// presigned uploads via POST /files/generate-upload-url. Failed/nsfw/canceled requests are not charged.
import { readFile } from "node:fs/promises";
import { type GenInput, type ModelInfo, type PollResult, type Provider, ProviderError, clampDuration, pick, safeDownload, withAvoid } from "./types.ts";

const BASE = "https://api.higgsfield.ai";
const auth = () => `Key ${process.env.HF_API_KEY_ID}:${process.env.HF_API_KEY_SECRET}`;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { Authorization: auth(), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e: any) {
    throw new ProviderError(`Higgsfield unreachable: ${e?.message ?? e}`, 0, true); // ambiguous: caller retries with same idempotency key
  }
  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok) {
    const d = json?.detail;
    const msg = typeof d === "string" ? d : d?.message ?? (Array.isArray(d) ? d.map((x: any) => x.msg ?? JSON.stringify(x)).join("; ") : text.slice(0, 300));
    const retryable = res.status === 429 || res.status >= 500 || d?.retryable === true;
    throw new ProviderError(`Higgsfield ${res.status}: ${msg}${res.status === 403 ? " (insufficient balance?)" : ""}`, res.status, retryable);
  }
  return json;
}

const safeJson = (t: string) => { try { return JSON.parse(t); } catch { return null; } };

const IMAGE_ASPECTS = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"];

const models: ModelInfo[] = [
  {
    id: "higgsfield:marketing-studio/image", provider: "higgsfield", endpoint: "marketing-studio/image",
    name: "Marketing Studio Image 2.0 (Alpha)", kind: "image",
    use: "Campaign and product images; generation or editing from up to 16 ordered reference photos.",
    inputs: "prompt, up to 16 reference image URLs", outputs: "image(s)",
    aspects: [...IMAGE_ASPECTS, "21:9"], resolutions: ["1k", "2k", "4k"], qualities: ["low", "medium", "high"], max_refs: 16,
    limitations: "Alpha. No 4:5 output (generate 3:4, crop to 4:5 at export). Label text may drift; check logos.",
    quality_note: "Built for commercial product scenes; highest reference capacity.",
    docs: "https://docs.higgsfield.ai/docs/models/marketing-studio-image/generate-and-edit.md",
    body: (i) => ({
      prompt: withAvoid(i), image_urls: (i.refs ?? []).slice(0, 16), enhance_prompt: false,
      resolution: pick(i.resolution, ["1k", "2k", "4k"], "2k"), aspect_ratio: pick(i.aspect, [...IMAGE_ASPECTS, "21:9"], "auto"),
      quality: pick(i.quality, ["low", "medium", "high"], "high"),
    }),
  },
  {
    id: "higgsfield:xai/grok-imagine-image-2.0", provider: "higgsfield", endpoint: "xai/grok-imagine-image-2.0",
    name: "Grok Image 2.0", kind: "image",
    use: "Generation and editing with up to 10 references.",
    inputs: "prompt, up to 10 reference image URLs", outputs: "1 image",
    aspects: [...IMAGE_ASPECTS, "1:2", "2:1"], resolutions: ["1k", "2k"], qualities: ["low", "medium"], max_refs: 10,
    limitations: "Max 2k and 'medium' quality. References may be resized before submission.",
    quality_note: "Fast, good general realism; less specialised for product fidelity.",
    docs: "https://docs.higgsfield.ai/docs/models/grok-image-2/generate-and-edit.md",
    body: (i) => ({
      prompt: withAvoid(i), image_urls: (i.refs ?? []).slice(0, 10),
      resolution: pick(i.resolution, ["1k", "2k"], "2k"), aspect_ratio: pick(i.aspect, [...IMAGE_ASPECTS, "1:2", "2:1"], "auto"),
      quality: pick(i.quality, ["low", "medium"], "medium"),
    }),
  },
  {
    id: "higgsfield:alibaba/qwen-image-3/edit", provider: "higgsfield", endpoint: "alibaba/qwen-image-3/edit",
    name: "Qwen Image 3 Edit", kind: "image",
    use: "Reference-based editing of 1–3 images (product preservation, targeted fixes).",
    inputs: "prompt, 1–3 reference image URLs (required), negative prompt", outputs: "1 PNG image",
    aspects: [...IMAGE_ASPECTS, "7:9", "9:7", "21:9"], resolutions: ["1k", "2k"], max_refs: 3,
    limitations: "Requires at least one reference; max 3. Prompt rewriting disabled here to protect product details.",
    quality_note: "Strong instruction-following edits; supports a true negative prompt.",
    docs: "https://docs.higgsfield.ai/docs/models/qwen-image-3/edit.md",
    body: (i) => ({
      prompt: i.prompt, negative_prompt: i.negative ?? "", image_urls: (i.refs ?? []).slice(0, 3),
      resolution: pick(i.resolution, ["1k", "2k"], "2k"), aspect_ratio: pick(i.aspect, [...IMAGE_ASPECTS, "7:9", "9:7", "21:9"], "1:1"),
      prompt_extend: false, enable_thinking: false,
    }),
  },
  {
    id: "higgsfield:kling-video/v3.0/std/image-to-video", provider: "higgsfield", endpoint: "kling-video/v3.0/std/image-to-video",
    name: "Kling 3.0 Standard · image-to-video", kind: "video",
    use: "Animate an approved still into a shot; first frame locks product identity.",
    inputs: "first-frame image URL, prompt, 3–15 s, optional native sound", outputs: "MP4 (aspect follows the image)",
    aspects: ["follows first frame"], resolutions: ["standard"], durations: [3, 15], max_refs: 1, audio: true,
    limitations: "Aspect follows the input frame. Fine label text can warp under motion.",
    quality_note: "Good motion coherence at lower cost.",
    docs: "https://docs.higgsfield.ai/docs/models/kling-3/standard-image-to-video.md",
    body: (i) => ({ prompt: withAvoid(i).slice(0, 2500), image_url: i.first_frame, duration: i.duration, sound: i.audio ? "on" : "off", cfg_scale: 0.5 }),
  },
  {
    id: "higgsfield:kling-video/v3.0/pro/image-to-video", provider: "higgsfield", endpoint: "kling-video/v3.0/pro/image-to-video",
    name: "Kling 3.0 Pro · image-to-video", kind: "video",
    use: "Premium cinematic shots from an approved still.",
    inputs: "first-frame image URL, prompt, 3–15 s, optional native sound", outputs: "MP4 (aspect follows the image)",
    aspects: ["follows first frame"], resolutions: ["pro"], durations: [3, 15], max_refs: 1, audio: true,
    limitations: "Aspect follows the input frame. Higher cost than Standard.",
    quality_note: "Higher detail and steadier products than Standard.",
    docs: "https://docs.higgsfield.ai/docs/models/kling-3/pro-image-to-video.md",
    body: (i) => ({ prompt: withAvoid(i).slice(0, 2500), image_url: i.first_frame, duration: i.duration, sound: i.audio ? "on" : "off", cfg_scale: 0.5 }),
  },
  {
    id: "higgsfield:bytedance/seedance-2.0/image-to-video", provider: "higgsfield", endpoint: "bytedance/seedance-2.0/image-to-video",
    name: "Seedance 2.0 · image-to-video", kind: "video",
    use: "Image-to-video with selectable output resolution.",
    inputs: "first-frame image URL, prompt, 4–15 s, resolution, optional audio", outputs: "MP4 (framing follows the image)",
    aspects: ["follows first frame"], resolutions: ["480p", "720p", "1080p", "4k"], durations: [4, 15], max_refs: 1, audio: true,
    limitations: "Minimum 4 s per shot (trimmed in the edit).",
    quality_note: "Explicit 1080p/4k output.",
    docs: "https://docs.higgsfield.ai/docs/models/seedance-2/image-to-video.md",
    body: (i) => ({ prompt: withAvoid(i), image_url: i.first_frame, duration: i.duration, resolution: pick(i.resolution, ["480p", "720p", "1080p", "4k"], "1080p"), generate_audio: !!i.audio }),
  },
  {
    id: "higgsfield:minimax/h3/image-to-video", provider: "higgsfield", endpoint: "minimax/h3/image-to-video",
    name: "MiniMax H3 · image-to-video", kind: "video",
    use: "Image-to-video at fixed 2K resolution.",
    inputs: "first-frame image URL, prompt, 5–15 s", outputs: "MP4 2K (aspect follows the image)",
    aspects: ["follows first frame"], resolutions: ["2K"], durations: [5, 15], max_refs: 1, audio: false,
    limitations: "Minimum 5 s per shot; no audio parameter.",
    quality_note: "High resolution output.",
    docs: "https://docs.higgsfield.ai/docs/models/minimax-h3/image-to-video.md",
    body: (i) => ({ prompt: withAvoid(i).slice(0, 7000), image_url: i.first_frame, duration: i.duration, resolution: "2K", aspect_ratio: "auto" }),
  },
];

function bodyFor(m: ModelInfo, input: GenInput) {
  const i = m.kind === "video" ? { ...input, duration: clampDuration(m, input.duration ?? 5) } : input;
  return m.body(i);
}

export const higgsfield: Provider = {
  id: "higgsfield",
  label: "Higgsfield",
  configured: () => !!(process.env.HF_API_KEY_ID && process.env.HF_API_KEY_SECRET),
  models,
  uploadTtlHours: 6,

  async estimate(m, input) {
    try {
      // Estimates need syntactically valid media URLs; placeholders are fine for pricing.
      const probe = { ...input, first_frame: input.first_frame ?? "https://example.com/frame.jpg" };
      const r = await call("POST", `/estimate/${m.endpoint}`, bodyFor(m, probe));
      const usd = Number.parseFloat(r?.usd);
      return Number.isFinite(usd) ? usd : null;
    } catch {
      return null;
    }
  },

  async submit(m, input, idempotencyKey) {
    const r = await call("POST", `/${m.endpoint}`, bodyFor(m, input), { "Idempotency-Key": idempotencyKey });
    if (!r?.request_id) throw new ProviderError("Higgsfield returned no request_id", 0, false);
    return r.request_id as string;
  },

  async poll(requestId): Promise<PollResult> {
    const r = await call("GET", `/requests/${encodeURIComponent(requestId)}/status`);
    const outputs = [...(r?.images ?? []).map((x: any) => x.url), r?.video?.url].filter((u): u is string => typeof u === "string");
    return { status: r?.status, outputs, error: r?.error };
  },

  async cancel(requestId) {
    try {
      await call("POST", `/requests/${encodeURIComponent(requestId)}/cancel`);
      return true;
    } catch {
      return false; // 400 = already processing (and therefore billable on success)
    }
  },

  async upload(file, mime) {
    const r = await call("POST", "/files/generate-upload-url", { content_type: mime });
    const put = await fetch(r.upload_url, { method: "PUT", headers: r.upload_headers ?? { "Content-Type": mime }, body: await readFile(file), signal: AbortSignal.timeout(120_000) });
    if (!put.ok) throw new ProviderError(`Higgsfield upload failed: HTTP ${put.status}`, put.status, put.status >= 500);
    return r.public_url as string;
  },

  download: (url, dest) => safeDownload(url, dest),
};
