// Thin API client. Every mutating call carries X-Studio (server-side CSRF check).
export type Asset = {
  id: string; kind: string; slot: string | null; url: string; mime: string; path: string; status: string;
  width: number | null; height: number | null; duration: number | null; job_id: string | null; meta: any; created_at: string;
};
export type Job = {
  id: string; kind: string; slot: string; provider: string; model: string; status: string; est_usd: number;
  actual_usd: number | null; error: string | null; prompt: string; duration?: number; meta: any; created_at: string;
};
export type Ledger = {
  max_usd: number | null; generation_spent_usd: number; reserved_usd: number; failed_not_charged_usd: number;
  llm_spent_usd: number; llm_estimated_usd: number; llm_calls: number; committed_usd: number; remaining_usd: number | null;
  completed: number; failed: number; in_flight: number;
};
export type View = {
  project: { id: string; name: string; stage: string; status: string; spec: any; updated_at: string };
  assets: Asset[]; jobs: Job[]; ledger: Ledger; llm_estimates: { analysis: number; directions: number };
  plan_problems: string[]; events: { ts: string; level: string; message: string }[]; upload_errors?: string[];
};
export type ModelInfo = {
  id: string; provider: string; provider_label: string; name: string; kind: "image" | "video"; use: string; inputs: string; outputs: string;
  aspects: string[]; resolutions: string[]; qualities?: string[]; durations?: [number, number]; max_refs: number; audio?: boolean;
  limitations: string; quality_note: string; docs: string;
};
export type Settings = {
  providers: { id: string; label: string; configured: boolean; env: string[] }[];
  claude: { configured: boolean; model: string }; upscaling: string; audio: string; auth_required: boolean;
};

export class ApiError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data: any) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: { "X-Studio": "1", ...(body && !isForm ? { "Content-Type": "application/json" } : {}) },
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(data?.error ?? `HTTP ${res.status}`, res.status, data);
  return data as T;
}

export const api = {
  get: <T,>(u: string) => call<T>("GET", u),
  post: <T,>(u: string, b: unknown = {}) => call<T>("POST", u, b),
  put: <T,>(u: string, b: unknown) => call<T>("PUT", u, b),
  del: <T,>(u: string) => call<T>("DELETE", u),
};

export const usd = (n: number | null | undefined, digits = 2) => (n == null ? "—" : `$${n.toFixed(n !== 0 && Math.abs(n) < 0.1 ? 3 : digits)}`);
