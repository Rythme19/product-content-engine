// Provider adapter contract + shared helpers. The workflow only talks to Provider.
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

export type GenInput = {
  prompt: string;
  negative?: string;
  refs?: string[];        // provider-accessible reference image URLs (product photos / generated stills)
  aspect?: string;
  resolution?: string;
  quality?: string;
  first_frame?: string;   // video: provider-accessible URL of the first frame
  duration?: number;      // video seconds (already clamped to the model's range)
  audio?: boolean;
};

export type ModelInfo = {
  id: string;             // "<provider>:<endpoint>"
  provider: string;
  endpoint: string;
  name: string;
  kind: "image" | "video";
  use: string;
  inputs: string;
  outputs: string;
  aspects: string[];
  resolutions: string[];
  qualities?: string[];
  durations?: [number, number];
  max_refs: number;       // 0 = no reference-image support
  audio?: boolean;
  limitations: string;
  quality_note: string;
  docs: string;
  body: (i: GenInput) => Record<string, unknown>;
};

export type PollResult = { status: "queued" | "in_progress" | "completed" | "failed" | "nsfw" | "canceled"; outputs: string[]; error?: string };

export interface Provider {
  id: string;
  label: string;
  configured(): boolean;
  models: ModelInfo[];
  /** USD for this exact request, or null when the provider can't say. */
  estimate(m: ModelInfo, input: GenInput): Promise<number | null>;
  /** Submit with an idempotency key; returns the provider request id. */
  submit(m: ModelInfo, input: GenInput, idempotencyKey: string): Promise<string>;
  poll(requestId: string): Promise<PollResult>;
  cancel(requestId: string): Promise<boolean>;
  /** Make a local file reachable by the provider; returns its URL. */
  upload(file: string, mime: string): Promise<string>;
  uploadTtlHours: number;
  download(url: string, dest: string): Promise<void>;
}

export class ProviderError extends Error {
  status: number;
  retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

/** Pick the closest supported value instead of sending something the model rejects. */
export const pick = (value: string | undefined, allowed: string[], fallback: string) =>
  value && allowed.includes(value) ? value : fallback;

export const clampDuration = (m: ModelInfo, seconds: number) =>
  m.durations ? Math.min(m.durations[1], Math.max(m.durations[0], Math.ceil(seconds))) : Math.ceil(seconds);

/** Prompts for models without a negative-prompt field get the constraints appended. */
export const withAvoid = (i: GenInput) => (i.negative?.trim() ? `${i.prompt}\n\nAvoid: ${i.negative.trim()}` : i.prompt);

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd])/i;

/**
 * Download a provider output (untrusted URL from an API response): https only, no
 * private/loopback hosts, never sends credentials, size-capped, content-type checked.
 */
export async function safeDownload(url: string, dest: string, maxBytes = 300 * 1024 * 1024) {
  const u = new URL(url);
  if (u.protocol !== "https:" || PRIVATE_HOST.test(u.hostname)) throw new ProviderError(`refusing to download from ${u.protocol}//${u.hostname}`, 0, false);
  const res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok || !res.body) throw new ProviderError(`download failed: HTTP ${res.status}`, res.status, res.status >= 500);
  const type = res.headers.get("content-type") ?? "";
  if (type && !/^(image|video|audio)\/|^application\/octet-stream|^binary\//.test(type)) throw new ProviderError(`unexpected content-type ${type}`, 0, false);
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new ProviderError("output larger than allowed", 0, false);
  await mkdir(path.dirname(dest), { recursive: true });
  let seen = 0;
  const body = Readable.fromWeb(res.body as any);
  body.on("data", (chunk: Buffer) => { seen += chunk.length; if (seen > maxBytes) body.destroy(new Error("output larger than allowed")); });
  await pipeline(body, createWriteStream(dest));
}
