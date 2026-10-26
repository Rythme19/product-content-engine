# AI Product Creative Studio

Turns product photos into a coherent social campaign: **three images** (hero, lifestyle, benefit) and a **cut, branded product video** in your platform formats. Every paid step has an explicit approval gate and runs under a strict budget guard.

```
INTAKE → ANALYSIS (brief) → DIRECTIONS → MODELS → BUDGET APPROVAL → IMAGE PRODUCTION → IMAGE REVIEW
→ STORYBOARD → VIDEO APPROVAL → VIDEO PRODUCTION → EDITING → FINAL QC → EXPORT
```

## Quick start

Requirements: Node ≥ 24 (uses built-in `node:sqlite` and native TypeScript), FFmpeg + ffprobe on `PATH` (`brew install ffmpeg`), and `zip` (optional, for the archive).

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm run build
```

```bash
npm start
```

Open http://localhost:8787. With no keys configured, everything works end to end using the free **mock** provider (placeholder images and clips, clearly marked `MOCK`) and editable templates instead of Claude.

Development with hot reload: run `npm run dev:server` and `npm run dev:web` in two terminals, then open http://localhost:5173 (the API is proxied).

## Configuring providers

All secrets live in `.env` on the server only. The browser only ever receives "configured: yes/no".

| Variable | Purpose |
|---|---|
| `HF_API_KEY_ID`, `HF_API_KEY_SECRET` | Higgsfield image + video generation. Create them at https://console.higgsfield.ai |
| `ANTHROPIC_API_KEY` | Claude: photo analysis, creative directions, prompts, storyboard, visual QC |
| `CLAUDE_MODEL` | Optional, default `claude-opus-5-5` |
| `ENABLE_MOCK_PROVIDER` | `false` hides the offline mock models |
| `PORT`, `HOST`, `APP_TOKEN`, `ALLOWED_HOSTS`, `DATA_DIR`, `MAX_IN_FLIGHT` | See *Security* and *Operations* |

Restart after editing `.env`. In the Models step, **Test Higgsfield connection** fetches a free price quote to confirm the credentials work.

### Verified integrations

| Provider | Status | How it's used |
|---|---|---|
| **Higgsfield** REST API (`api.higgsfield.ai`) | Implemented from the official docs (docs.higgsfield.ai, checked 2026-10-26). Endpoint paths, the `Authorization: Key ID:SECRET` scheme and error format were confirmed against the live API with invalid credentials. **Not yet exercised with a real key.** | Per-request USD quotes (`POST /estimate/{model}`), queued generation with `Idempotency-Key`, status polling, cancel, presigned uploads for reference photos |
| **Anthropic Claude** (`@anthropic-ai/sdk`) | Implemented with structured outputs; server-side refusal fallback enabled (`fallbacks: "default"`). Not exercised with a real key in this environment. | Analysis, directions, prompts, storyboard, QC |
| **Mock** | Fully tested | Offline pipeline testing at zero cost |

Higgsfield models wired in (each card in the UI lists inputs, outputs, aspect ratios, resolutions, reference support and limitations):

- **Images:** Marketing Studio Image 2.0 (up to 16 references, 1k/2k/4k), Grok Image 2.0 (up to 10 references), Qwen Image 3 Edit (1–3 references with a true negative prompt; the default edit/fix model).
- **Video (image-to-video):** Kling 3.0 Standard, Kling 3.0 Pro, Seedance 2.0 (480p–4k), MiniMax H3 (2K).

Not available, by design rather than faked:

- **Upscaling:** Higgsfield's REST catalogue has no documented upscaler. Use the 2k/4k tier instead; export crops are local resamples.
- **Voice-over / TTS:** Claude proposes a script for approval, but nothing is generated. Record it yourself and add it as the audio track.
- **4:5 images:** no Higgsfield image model outputs 4:5, so the default is 3:4 with a saliency-aware crop to 4:5 at export.

Adding a provider: implement the `Provider` interface in `server/providers/types.ts` (capabilities, `estimate`, `submit`, `poll`, `cancel`, `upload`, `download`) and register it in `server/providers/index.ts`. The workflow never calls a provider directly.

## How the budget guard works

- **Before any budget exists**, every Claude call shows its estimated cost and runs only when you click it. The server rejects it unless your confirmation covers the estimate.
- **Budget step:** set the maximum spend, variations, aspect, quality, shot count and length, retry allowance, keyframe permission and AI QC. Live provider quotes produce a plan: each job, a retry reserve and Claude token estimates. You approve that exact plan; it is hash-bound, so any change requires approving again.
- **Enforcement** (`server/budget.ts`): jobs are queued in one SQLite transaction that checks *spent + reserved (in-flight estimates) + Claude spend* against the cap. A batch that doesn't fit is rejected whole; nothing is partially queued. A job with no price estimate is never submitted.
- **No silent retries.** A rejected asset only regenerates after you see the proposed prompt and its price, within the retry allowance. If the price changed since you looked, the request is refused.
- **Never more expensive by surprise.** There is no automatic model fallback, and a job whose model or provider disappears fails instead of switching.
- **Costs:** Higgsfield bills the quoted amount on success, and failed, NSFW or cancelled requests are not charged. It exposes no per-request charge lookup, so "actual" equals the quote, labelled as such. Claude cost is computed from real token usage. Reconcile against the Higgsfield and Anthropic consoles.

## Resumability and safety of paid jobs

All state lives in `data/studio.db` (projects, jobs, assets, Claude calls, events). The worker (`server/jobs.ts`) polls every 2 s:

- `queued` jobs are submitted, up to `MAX_IN_FLIGHT` at a time. A paused project holds new submissions.
- `submitting` jobs (crash mid-request) are re-sent with the **same idempotency key**. Higgsfield returns the original request, so nothing is charged twice.
- `submitted` jobs are only polled, never resubmitted. Outputs are downloaded immediately (providers delete them after 7 days), then decoded and verified before they're stored.
- Cancel marks queued jobs cancelled (free). Jobs already processing at the provider finish and are billed.

## Security

- Binds to `127.0.0.1` by default. Starting on any other `HOST` is refused unless `APP_TOKEN` (≥ 24 chars) is set; users then sign in with that token (HttpOnly, SameSite=Strict cookie).
- Host-header allowlist (DNS-rebinding protection), a required `X-Studio` header and Origin check on every mutating request (CSRF), rate limiting (120 writes/min), body size limits, strict CSP.
- Uploads are decoded and re-encoded: images with sharp (EXIF/GPS stripped), audio with FFmpeg. Anything else is rejected. Stored names are random UUIDs; original names are kept only as sanitised metadata.
- Files are served by asset id within their own project; no request ever supplies a path.
- Provider output URLs are untrusted: HTTPS only, no private or loopback hosts, size-capped, and credentials are never sent with downloads.
- Secret values are redacted from logs, events and error messages and never written to exports.
- For multi-user or internet-facing deployment, put the app behind TLS (a reverse proxy), set `APP_TOKEN` and `ALLOWED_HOSTS`, and treat it as single-tenant: one token, one team.

## Campaign export

`data/exports/<product>-<id>/<direction>_<date>/` (plus a `.zip`, downloadable from the UI):

```
images/   <product>_<slot>_original.png, _4x5_1080x1350.jpg, _9x16_1080x1920.jpg, …, *_with-copy.jpg
video/    <product>_<len>s_<aspect>_branded.mp4, …_clean.mp4, shots/shot01_<title>.mp4 …
docs/     storyboard.md, prompts.json, campaign.json, cost-report.md, cost-report.csv, export-specs.md
README.md
```

Typography and logos are always composited locally (sharp, then FFmpeg overlay), never rendered by a model, and a clean no-text version of every cut is kept for repurposing.

## Tests

```bash
npm test
```

15 tests run against the mock provider in an isolated temp `DATA_DIR`, with no network and no spend:

- **e2e:** intake → export through the HTTP API; real images, keyframes, shots, a two-format edit and the export folder are produced and verified.
- **budget:** over-budget plans refused with nothing queued; stale or double approvals refused; all-or-nothing enqueue; Claude confirmation before a budget exists; failures not charged; retry cap and price-change check; crash-resume reuses the idempotency key; pause and cancel.
- **security:** token auth, CSRF header, Origin and Host checks, upload decoding and path safety, cross-project file isolation, secret redaction, SSRF-safe downloads.

Type check: `npm run typecheck`.

### First real-provider run (recommended)

1. Add Higgsfield and Anthropic keys and restart.
2. Click **Test Higgsfield connection** (free).
3. Create a campaign with a **small budget** (e.g. $5): 1 variation per slot, 1k resolution, low quality, 2–3 shots, Kling 3.0 Standard, max 1 retry.
4. Review the estimate before approving.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Only "Mock" models listed | `HF_API_KEY_ID` / `HF_API_KEY_SECRET` missing in `.env`, or the server wasn't restarted |
| Plan shows "unknown" costs / can't approve | The provider estimate failed (bad credentials, network, model not enabled for your account). Use **Test Higgsfield connection** and check the server log |
| `Higgsfield 403 (insufficient balance?)` | Top up in the Higgsfield console; the job is marked failed and not charged |
| `Higgsfield 429` | Account queue full; submission is retried with the same idempotency key and backoff |
| Job stuck in "submitted" | The worker keeps polling with backoff; check the Activity panel. Restarting the server is safe |
| `Budget guard: …` banner | Working as intended: raise the budget in a new plan or reduce counts or quality |
| Claude steps produce generic text | `ANTHROPIC_API_KEY` not set, so templates are used |
| `ffmpeg failed` | Install FFmpeg with libx264 and AAC (`ffmpeg -encoders`), or set `FFMPEG_PATH` / `FFPROBE_PATH` |
| "Forbidden host" | Accessing through a hostname not in `ALLOWED_HOSTS` |
| Logo or text looks wrong in the video | It's composited from your uploaded PNG; upload a transparent PNG and pick another position in Edit |

## Project layout

```
server/
  main.ts        HTTP API, security middleware, uploads, file serving
  pipeline.ts    stages, approval gates, plans, retries, storyboard, edit
  jobs.ts        resumable worker: submit / poll / download / verify
  budget.ts      ledger + budget guard + plan hashing
  llm.ts         Claude calls (structured outputs) + offline templates
  media.ts       sharp / FFmpeg: sanitising, crops, overlays, assembly
  export.ts      campaign folder + zip
  schemas.ts     zod schemas: campaign spec, LLM outputs, request bodies
  db.ts          SQLite schema, helpers, redaction, event log
  providers/     types.ts (adapter contract), higgsfield.ts, mock.ts, index.ts
web/src/         React UI (App.tsx shell, steps.tsx stages, styles.css)
test/            node:test suites
```

## Known limitations

- Single process and single tenant; the job queue is in-process (SQLite-backed). Run one server per data directory.
- AI QC samples three frames per clip, so it can't judge flicker or motion; the UI says so, and human approval is required.
- Text wrapping in overlays uses width estimates; very long headlines are cut at three lines.
- Brand fonts are used only if installed on the server.
