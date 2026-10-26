// Shared test setup: isolated DATA_DIR, no real providers, request helper, sample product photo.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

export function isolate(extraEnv: Record<string, string> = {}) {
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "studio-test-"));
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.HF_API_KEY_ID;
  delete process.env.HF_API_KEY_SECRET;
  delete process.env.APP_TOKEN;
  Object.assign(process.env, extraEnv);
  return process.env.DATA_DIR;
}

export function client(app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> }) {
  const headers = { host: "localhost:8787", "x-studio": "1" };
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body instanceof FormData ? headers : { ...headers, "content-type": "application/json" },
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    const json: any = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    return { status: res.status, json, res };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, b?: unknown) => call("POST", u, b ?? {}),
    put: (u: string, b: unknown) => call("PUT", u, b),
    del: (u: string) => call("DELETE", u),
  };
}

/** A simple synthetic "product" (bottle with label) so tests never need real photos. */
export async function productPhoto() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000">
    <rect width="100%" height="100%" fill="#f4f1ec"/>
    <rect x="300" y="180" width="200" height="620" rx="40" fill="#1d3b2f"/>
    <rect x="345" y="110" width="110" height="90" rx="12" fill="#c8a97e"/>
    <rect x="320" y="420" width="160" height="180" fill="#f4f1ec"/>
    <text x="400" y="520" text-anchor="middle" font-family="Helvetica" font-size="34" font-weight="700" fill="#1d3b2f">VERDE</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

export async function upload(api: ReturnType<typeof client>, pid: string, kind: string, name: string, data: Buffer, type = "image/jpeg") {
  const fd = new FormData();
  fd.set("kind", kind);
  fd.append("files", new File([new Uint8Array(data)], name, { type }));
  return api.post(`/api/projects/${pid}/uploads`, fd);
}

export const BUDGET = {
  max_usd: 5, images_per_slot: 1, image_aspect: "3:4", image_resolution: "2k", image_quality: "high",
  max_video_shots: 3, video_seconds: 9, video_resolution: "1080p", native_audio: true, max_retries: 2,
  allow_keyframes: false, auto_qc: false,
};

/** Create a project and walk it to the budget stage (offline templates, mock models). */
export async function toBudgetStage(api: ReturnType<typeof client>, name = "Verde Serum") {
  const { json } = await api.post("/api/projects", { name });
  const pid = json.project.id as string;
  await upload(api, pid, "reference", "front.jpg", await productPhoto());
  let r = await api.post(`/api/projects/${pid}/analyze`, { notes: "Verde Serum\nPlant-based face serum." });
  if (r.status !== 200) throw new Error(JSON.stringify(r.json));
  const brief = { ...r.json.project.spec.brief, platforms: ["instagram_feed", "tiktok"], benefits: ["Lightweight texture"] };
  brief.product = { ...brief.product, name: "Verde Serum", category: "skincare", must_preserve: ["dark green bottle", "gold cap", "VERDE label"] };
  brief.brand = { ...brief.brand, name: "Verde", colors: ["#1D3B2F", "#C8A97E"] };
  r = await api.put(`/api/projects/${pid}/brief`, { brief });
  if (r.status !== 200) throw new Error(JSON.stringify(r.json));
  const d = r.json.project.spec.directions.directions[0];
  r = await api.put(`/api/projects/${pid}/direction`, { direction: d, notes: "" });
  r = await api.put(`/api/projects/${pid}/models`, { image: "mock:image", edit: "mock:image", video: "mock:video" });
  if (r.json.project.stage !== "budget") throw new Error(JSON.stringify(r.json));
  return pid;
}
