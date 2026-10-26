// One component per workflow stage. Each paid action shows its estimate and needs an explicit click.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, usd, type Asset, type Job, type ModelInfo, type View } from "./api.ts";
import type { Ctx } from "./App.tsx";

const base = (v: View) => `/api/projects/${v.project.id}`;
const SLOTS = [["hero", "Hero product shot"], ["lifestyle", "Lifestyle / context"], ["benefit", "Benefit-focused ad"]] as const;
const PLATFORMS: [string, string][] = [["instagram_feed", "Instagram feed"], ["instagram_stories", "Instagram Stories"], ["tiktok", "TikTok"], ["facebook", "Facebook"], ["website", "Website"], ["paid_ads", "Paid ads"]];
const RUNNING = ["queued", "submitting", "submitted"];

export function StepView({ ctx }: { ctx: Ctx }) {
  switch (ctx.view.project.stage) {
    case "intake": return <Intake ctx={ctx} />;
    case "analysis": return <BriefStep ctx={ctx} />;
    case "directions": return <DirectionsStep ctx={ctx} />;
    case "models": return <ModelsStep ctx={ctx} />;
    case "budget": return <BudgetStep ctx={ctx} />;
    case "image_production": case "image_review": return <ImagesStep ctx={ctx} />;
    case "storyboard": case "video_approval": return <StoryboardStep ctx={ctx} />;
    case "video_production": case "editing": return <ShotsStep ctx={ctx} />;
    case "final_qc": return <FinalStep ctx={ctx} />;
    default: return <ExportStep ctx={ctx} />;
  }
}

// ---------------- shared bits ----------------

function Head({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="head">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {children && <p className="lede">{children}</p>}
    </div>
  );
}

function Field({ label, hint, flag, children }: { label: string; hint?: string; flag?: boolean; children: ReactNode }) {
  return (
    <label className={`field ${flag ? "flag" : ""}`}>
      <span>{label}{flag && <em title="Guessed or missing: please check"> check</em>}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

const Lines = ({ value, onChange, rows = 3, placeholder }: { value: string[]; onChange: (v: string[]) => void; rows?: number; placeholder?: string }) => (
  <textarea rows={rows} value={value.join("\n")} placeholder={placeholder} onChange={(e) => onChange(e.target.value.split("\n"))} onBlur={(e) => onChange(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))} />
);

const Pill = ({ status }: { status: string }) => <span className={`pill ${status}`}>{status.replace("_", " ")}</span>;

function Upload({ label, accept, multiple, onFiles }: { label: string; accept: string; multiple?: boolean; onFiles: (f: File[]) => void }) {
  const [over, setOver] = useState(false);
  return (
    <label className={`drop ${over ? "over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]); }}>
      <input type="file" accept={accept} multiple={multiple} onChange={(e) => { onFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
      <span>{label}</span>
    </label>
  );
}

function sendFiles(ctx: Ctx, kind: string, files: File[]) {
  if (!files.length) return;
  const fd = new FormData();
  fd.set("kind", kind);
  files.forEach((f) => fd.append("files", f));
  return ctx.run("Uploading", () => api.post(`${base(ctx.view)}/uploads`, fd));
}

function ReviewPanel({ a }: { a: Asset }) {
  const r = a.meta.review;
  if (a.meta.review_error) return <p className="small err">AI review failed: {a.meta.review_error}</p>;
  if (!r) return null;
  return (
    <details className="review" open={r.recommendation !== "approve"}>
      <summary>
        AI review: <b className={`rec ${r.recommendation}`}>{r.recommendation.replace("_", " ")}</b>
        {r.artifact_severity !== "none" && <span className="muted"> · {r.artifact_severity} artifacts</span>}
        {r.logo_or_text_problems && <span className="warn"> · logo/text issue</span>}
      </summary>
      <div className="scores">{Object.entries(r.scores).map(([k, v]) => <span key={k}><i>{k.replace(/_/g, " ")}</i><b>{String(v)}</b></span>)}</div>
      {r.issues.length > 0 && <ul>{r.issues.map((x: string) => <li key={x}>{x}</li>)}</ul>}
      {r.suggested_change && <p className="small"><b>Suggested change:</b> {r.suggested_change}</p>}
      <p className="small muted">Advisory only. An AI score isn't evidence of commercial performance.</p>
    </details>
  );
}

function RetryDialog({ ctx, source, prompt, allowEdit, onClose }: { ctx: Ctx; source: { asset_id?: string; job_id?: string }; prompt: string; allowEdit: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<"regenerate" | "edit">("regenerate");
  const [text, setText] = useState(prompt);
  const [quote, setQuote] = useState<{ est_usd: number | null; retries_used: number; retries_max: number; remaining_usd: number | null; model: string } | null>(null);
  useEffect(() => { setQuote(null); }, [mode, text]);
  const left = quote ? quote.retries_max - quote.retries_used : 0;
  return (
    <div className="dialog" role="dialog" aria-label="Regenerate">
      <h4>Regenerate</h4>
      {allowEdit && (
        <div className="seg">
          <button className={mode === "regenerate" ? "on" : ""} onClick={() => setMode("regenerate")}>New take</button>
          <button className={mode === "edit" ? "on" : ""} onClick={() => { setMode("edit"); setText("Keep this exact scene, composition and lighting. Correct the product so it exactly matches the other reference photos (shape, colours, label text and logo). Change nothing else."); }}>Targeted fix (edit model)</button>
        </div>
      )}
      <Field label="Prompt (the proposed change)"><textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      {quote && (
        <p className="quote">
          {quote.model.split(":")[1]} · <b>{usd(quote.est_usd)}</b> · retries left {left}/{quote.retries_max} · budget left {usd(quote.remaining_usd)}
        </p>
      )}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Close</button>
        {!quote ? (
          <button className="btn" onClick={async () => setQuote(await ctx.run("Pricing", () => api.post(`${base(ctx.view)}/retry/preview`, { ...source, mode, prompt: text })))}>Get price</button>
        ) : (
          <button className="btn primary" disabled={quote.est_usd == null || left <= 0} onClick={async () => {
            const ok = await ctx.run("Submitting", () => api.post(`${base(ctx.view)}/retry`, { ...source, mode, prompt: text, expected_usd: quote.est_usd }));
            if (ok) onClose();
          }}>Confirm · {usd(quote.est_usd)}</button>
        )}
      </div>
    </div>
  );
}

/** One generated output (image / shot / keyframe / final video) with its review actions. */
function AssetCard({ ctx, a, job, canRetry, allowEdit }: { ctx: Ctx; a: Asset; job?: Job; canRetry: boolean; allowEdit?: boolean }) {
  const [retry, setRetry] = useState(false);
  const v = ctx.view;
  const decide = (decision: string) => ctx.run(decision === "approve" ? "Approving" : "Rejecting", () => api.post(`${base(v)}/assets/${a.id}/decision`, { decision, note: "" }));
  return (
    <div className={`asset ${a.status}`}>
      {a.mime.startsWith("video/") ? <video src={a.url} controls muted playsInline preload="metadata" /> : <a href={a.url} target="_blank" rel="noreferrer"><img src={a.url} alt={a.meta.purpose ?? a.slot ?? "asset"} loading="lazy" /></a>}
      <div className="meta">
        <Pill status={a.status === "ready" ? "to review" : a.status} />
        <span className="muted small">{(a.meta.model ?? job?.model ?? "").split(":")[1] ?? "local"} · {a.width}×{a.height}{a.duration ? ` · ${a.duration.toFixed(1)}s` : ""} · {usd(job?.actual_usd ?? job?.est_usd ?? 0)}</span>
      </div>
      {a.meta.checks?.length > 0 && <p className="small warn">{a.meta.checks.join(" · ")}</p>}
      <ReviewPanel a={a} />
      <div className="actions">
        {a.status !== "approved" && <button className="btn sm primary" onClick={() => decide("approve")}>Approve</button>}
        {a.status !== "rejected" && <button className="btn sm ghost" onClick={() => decide("reject")}>Reject</button>}
        {ctx.settings.claude.configured && <button className="btn sm ghost" onClick={() => ctx.run("AI review", () => api.post(`${base(v)}/assets/${a.id}/qc`))}>AI review</button>}
        {canRetry && a.job_id && <button className="btn sm ghost" onClick={() => setRetry(true)}>Regenerate…</button>}
      </div>
      {retry && <RetryDialog ctx={ctx} source={{ asset_id: a.id }} allowEdit={!!allowEdit} onClose={() => setRetry(false)}
        prompt={`${job?.prompt ?? a.meta.prompt ?? ""}${a.meta.review?.suggested_change ? `\n\nChange: ${a.meta.review.suggested_change}` : ""}`} />}
    </div>
  );
}

function JobRow({ ctx, j, canRetry }: { ctx: Ctx; j: Job; canRetry: boolean }) {
  const [retry, setRetry] = useState(false);
  if (j.status === "completed") return null;
  return (
    <div className={`job ${j.status}`}>
      <Pill status={j.status} />
      <span className="small">{j.model.split(":")[1]} · est {usd(j.est_usd)}{RUNNING.includes(j.status) ? " · generating…" : ""}</span>
      {j.error && <p className="small err">{j.error}{["failed", "nsfw", "canceled"].includes(j.status) ? " (not charged)" : ""}</p>}
      {canRetry && ["failed", "nsfw", "download_failed"].includes(j.status) && <button className="btn sm ghost" onClick={() => setRetry(true)}>Retry…</button>}
      {retry && <RetryDialog ctx={ctx} source={{ job_id: j.id }} allowEdit={false} prompt={j.prompt} onClose={() => setRetry(false)} />}
    </div>
  );
}

function PlanTable({ plan, max }: { plan: any; max?: number }) {
  return (
    <table className="plan">
      <thead><tr><th>Item</th><th>Model</th><th className="num">Estimate</th></tr></thead>
      <tbody>
        {plan.items.map((i: any, n: number) => <tr key={n}><td>{i.label}</td><td className="muted">{i.model.split(":")[1]}</td><td className="num">{i.est_usd == null ? <span className="err">unknown</span> : usd(i.est_usd)}</td></tr>)}
        {plan.reserve_usd > 0 && <tr><td>Retry reserve</td><td className="muted">max allowance</td><td className="num">{usd(plan.reserve_usd)}</td></tr>}
        {plan.llm_usd > 0 && <tr><td>Claude: prompts, storyboard, reviews</td><td className="muted">token estimate</td><td className="num">{usd(plan.llm_usd)}</td></tr>}
      </tbody>
      <tfoot><tr><td colSpan={2}>Total estimate{max != null && <span className="muted"> · budget {usd(max)}</span>}</td><td className="num">{usd(plan.total_usd)}</td></tr></tfoot>
    </table>
  );
}

// ---------------- 1. intake ----------------

function Intake({ ctx }: { ctx: Ctx }) {
  const v = ctx.view;
  const refs = v.assets.filter((a) => a.kind === "reference");
  const logo = v.assets.find((a) => a.kind === "logo");
  const [notes, setNotes] = useState(v.project.spec.notes ?? "");
  const est = v.llm_estimates.analysis;
  return (
    <>
      <Head eyebrow="Step 1 · Upload" title="Show us the product">
        Add 1–8 clear photos (front, side, label close-up). They're the source of truth: nothing about the product is invented beyond them.
      </Head>
      <div className="thumbs">
        {refs.map((a) => (
          <figure key={a.id}>
            <img src={a.url} alt={a.meta.original_name} />
            <button className="x" aria-label="Remove photo" onClick={() => ctx.run("Removing", () => api.del(`${base(v)}/assets/${a.id}`))}>×</button>
          </figure>
        ))}
        {refs.length < 8 && <Upload label="Drop product photos or click to browse · JPEG, PNG, WebP" accept="image/jpeg,image/png,image/webp" multiple onFiles={(f) => sendFiles(ctx, "reference", f)} />}
      </div>
      <div className="grid2">
        <Field label="Tell us about it (optional)" hint="Name, what it does, who it's for, the goal. We'll only ask about what's missing.">
          <textarea rows={6} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={"Verde Serum — lightweight plant-based face serum for 25–40 year-olds. Launching on Instagram and TikTok."} />
        </Field>
        <Field label="Logo (optional, PNG with transparency is best)" hint="Composited in post-production, never redrawn by AI.">
          {logo ? <div className="logo"><img src={logo.url} alt="Logo" /><button className="btn sm ghost" onClick={() => ctx.run("Removing", () => api.del(`${base(v)}/assets/${logo.id}`))}>Remove</button></div>
            : <Upload label="Upload logo" accept="image/png,image/jpeg,image/webp" onFiles={(f) => sendFiles(ctx, "logo", f)} />}
        </Field>
      </div>
      <div className="cta-row">
        <button className="btn primary lg" disabled={!refs.length || !!ctx.busy} onClick={() => ctx.run(ctx.settings.claude.configured ? "Claude is studying your photos" : "Preparing brief", () => api.post(`${base(v)}/analyze`, { notes, confirm_usd: est }))}>
          {ctx.settings.claude.configured ? <>Analyse photos with Claude · ≈{usd(est)}</> : "Continue with a blank brief"}
        </button>
        {!ctx.settings.claude.configured && <span className="muted small">Claude isn't configured, so you'll fill the brief yourself.</span>}
      </div>
    </>
  );
}

// ---------------- 2. brief ----------------

function BriefStep({ ctx }: { ctx: Ctx }) {
  const v = ctx.view;
  const an = v.project.spec.analysis;
  const [b, setB] = useState<any>(() => structuredClone(v.project.spec.brief));
  const unsure = (key: string) => (an?.uncertain_fields ?? []).some((f: string) => f === key || f.startsWith(key + ".") || key.startsWith(f + "."));
  const set = (path: string, value: any) => setB((cur: any) => {
    const next = structuredClone(cur);
    const keys = path.split(".");
    let o = next;
    keys.slice(0, -1).forEach((k) => (o = o[k]));
    o[keys.at(-1)!] = value;
    return next;
  });
  const est = v.llm_estimates.directions;
  return (
    <>
      <Head eyebrow="Step 2 · Brief" title="Confirm what we know">
        {an?.source === "claude" ? "Claude drafted this from your photos and notes. Fields marked “check” were guessed or missing." : "Fill in the essentials. Everything here becomes the campaign's source of truth."}
      </Head>
      {an?.observations && <p className="callout">{an.observations}</p>}
      {an?.questions?.length > 0 && (
        <div className="questions">
          {an.questions.map((q: any) => <p key={q.question}><span className="q">?</span>{q.question}</p>)}
        </div>
      )}
      <div className="form">
        <fieldset>
          <legend>Product</legend>
          <div className="grid2">
            <Field label="Product name" flag={unsure("product.name")}><input value={b.product.name} onChange={(e) => set("product.name", e.target.value)} required /></Field>
            <Field label="Category" flag={unsure("product.category")}><input value={b.product.category} onChange={(e) => set("product.category", e.target.value)} /></Field>
          </div>
          <Field label="Description" flag={unsure("product.description")}><textarea rows={2} value={b.product.description} onChange={(e) => set("product.description", e.target.value)} /></Field>
          <div className="grid2">
            <Field label="Main benefits (one per line)" hint="Only verified claims. These are the only benefits ads may state." flag={unsure("benefits")}><Lines value={b.benefits} onChange={(x) => set("benefits", x)} /></Field>
            <Field label="Unique selling points" flag={unsure("usps")}><Lines value={b.usps} onChange={(x) => set("usps", x)} /></Field>
          </div>
        </fieldset>
        <fieldset>
          <legend>Campaign</legend>
          <div className="grid2">
            <Field label="Target audience" flag={unsure("audience")}><textarea rows={2} value={b.audience} onChange={(e) => set("audience", e.target.value)} /></Field>
            <Field label="Objective" hint="Sales, brand awareness, product launch, engagement…" flag={unsure("objective")}>
              <input list="objectives" value={b.objective} onChange={(e) => set("objective", e.target.value)} />
              <datalist id="objectives">{["sales", "brand awareness", "product launch", "engagement"].map((o) => <option key={o} value={o} />)}</datalist>
            </Field>
          </div>
          <Field label="Platforms" flag={unsure("platforms")}>
            <div className="checks">{PLATFORMS.map(([id, label]) => (
              <label key={id} className="check"><input type="checkbox" checked={b.platforms.includes(id)} onChange={(e) => set("platforms", e.target.checked ? [...b.platforms, id] : b.platforms.filter((x: string) => x !== id))} />{label}</label>
            ))}</div>
          </Field>
          <Field label="Language for on-screen copy" flag={unsure("language")}><input value={b.language} onChange={(e) => set("language", e.target.value)} /></Field>
        </fieldset>
        <fieldset>
          <legend>Brand</legend>
          <div className="grid2">
            <Field label="Brand name" flag={unsure("brand.name")}><input value={b.brand.name} onChange={(e) => set("brand.name", e.target.value)} /></Field>
            <Field label="Brand colours (hex, comma-separated)" flag={unsure("brand.colors")}>
              <input value={b.brand.colors.join(", ")} onChange={(e) => set("brand.colors", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
              <div className="swatches">{b.brand.colors.map((c: string) => <i key={c} style={{ background: c }} title={c} />)}</div>
            </Field>
            <Field label="Typography" hint="Font family used for overlays if installed."><input value={b.brand.typography} onChange={(e) => set("brand.typography", e.target.value)} /></Field>
            <Field label="Slogan"><input value={b.brand.slogan} onChange={(e) => set("brand.slogan", e.target.value)} /></Field>
            <Field label="Tone of voice"><input value={b.brand.tone} onChange={(e) => set("brand.tone", e.target.value)} /></Field>
            <Field label="Reference campaign"><input value={b.brand.reference_campaign} onChange={(e) => set("brand.reference_campaign", e.target.value)} /></Field>
          </div>
        </fieldset>
        <fieldset>
          <legend>Fidelity guardrails</legend>
          <div className="grid2">
            <Field label="Must stay unchanged (one per line)" hint="Fed into every prompt and every AI review."><Lines rows={4} value={b.product.must_preserve} onChange={(x) => set("product.must_preserve", x)} /></Field>
            <Field label="Claims to avoid"><Lines rows={4} value={b.claims_to_avoid} onChange={(x) => set("claims_to_avoid", x)} placeholder="e.g. clinically proven, cures, #1" /></Field>
          </div>
          {an?.fidelity_risks?.length > 0 && <p className="small muted">Likely to drift in AI output: {an.fidelity_risks.join(" · ")}</p>}
        </fieldset>
        <details>
          <summary>Product details from the photos</summary>
          <div className="grid2">
            <Field label="Shape & proportions"><textarea rows={2} value={b.product.shape_and_proportions} onChange={(e) => set("product.shape_and_proportions", e.target.value)} /></Field>
            <Field label="Materials, colours, finishes"><textarea rows={2} value={b.product.materials_colors_finishes} onChange={(e) => set("product.materials_colors_finishes", e.target.value)} /></Field>
            <Field label="Logos, labels, packaging"><textarea rows={2} value={b.product.branding_elements} onChange={(e) => set("product.branding_elements", e.target.value)} /></Field>
            <Field label="Visible features"><Lines value={b.product.visible_features} onChange={(x) => set("product.visible_features", x)} /></Field>
            <Field label="Suitable environments"><Lines value={b.product.suitable_environments} onChange={(x) => set("product.suitable_environments", x)} /></Field>
            <Field label="Props"><Lines value={b.product.suggested_props} onChange={(x) => set("product.suggested_props", x)} /></Field>
          </div>
        </details>
      </div>
      <div className="cta-row">
        <button className="btn primary lg" disabled={!b.product.name.trim() || !!ctx.busy} onClick={() => ctx.run(ctx.settings.claude.configured ? "Claude is developing three directions" : "Saving brief", () => api.put(`${base(v)}/brief`, { brief: b, confirm_usd: est }))}>
          Confirm brief & propose directions{ctx.settings.claude.configured && <> · ≈{usd(est)}</>}
        </button>
      </div>
    </>
  );
}

// ---------------- 3. directions ----------------

function DirectionsStep({ ctx }: { ctx: Ctx }) {
  const v = ctx.view;
  const ds = v.project.spec.directions;
  const [sel, setSel] = useState<string>(v.project.spec.direction?.id ?? ds.recommended_id);
  const [edit, setEdit] = useState<any>(null);
  const [notes, setNotes] = useState(v.project.spec.direction?.notes ?? "");
  const chosen = edit && edit.id === sel ? edit : ds.directions.find((d: any) => d.id === sel);
  return (
    <>
      <Head eyebrow="Step 3 · Creative direction" title="Three ways to tell it">
        <b>Recommended: {ds.directions.find((d: any) => d.id === ds.recommended_id)?.name}.</b> {ds.recommendation_reason}
      </Head>
      <div className="dirs">
        {ds.directions.map((d: any) => (
          <article key={d.id} className={`dir ${sel === d.id ? "on" : ""}`} onClick={() => setSel(d.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setSel(d.id)}>
            <div className="palette">{d.palette.map((c: string) => <i key={c} style={{ background: c }} />)}</div>
            {d.id === ds.recommended_id && <span className="badge">Recommended</span>}
            <h3>{d.name}</h3>
            <p>{d.concept}</p>
            <dl>
              <dt>Setting</dt><dd>{d.setting}</dd>
              <dt>Light</dt><dd>{d.lighting}</dd>
              <dt>Appeal</dt><dd>{d.audience_appeal}</dd>
              <dt>Composition</dt><dd>{d.composition}</dd>
              <dt>Video</dt><dd>{d.video_sequence}</dd>
              <dt>Why</dt><dd>{d.rationale}</dd>
            </dl>
          </article>
        ))}
      </div>
      <div className="form">
        <fieldset>
          <legend>Refine “{chosen.name}”</legend>
          <div className="grid2">
            {(["setting", "lighting", "composition", "concept"] as const).map((k) => (
              <Field key={k} label={k[0].toUpperCase() + k.slice(1)}><textarea rows={2} value={chosen[k]} onChange={(e) => setEdit({ ...chosen, [k]: e.target.value })} /></Field>
            ))}
          </div>
          <Field label="Combine or adjust (optional)" hint="e.g. “Use the lifestyle setting with the cinematic lighting.”"><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </fieldset>
      </div>
      <div className="cta-row">
        <button className="btn primary lg" onClick={() => ctx.run("Saving direction", () => api.put(`${base(v)}/direction`, { direction: chosen, notes }))}>Approve this direction</button>
      </div>
    </>
  );
}

// ---------------- 4. models ----------------

function recommend(models: ModelInfo[], directionId?: string) {
  const has = (id: string) => models.some((m) => m.id === id);
  const first = (kind: string) => models.find((m) => m.kind === kind)?.id ?? "";
  return {
    image: has("higgsfield:marketing-studio/image") ? "higgsfield:marketing-studio/image" : first("image"),
    edit: has("higgsfield:alibaba/qwen-image-3/edit") ? "higgsfield:alibaba/qwen-image-3/edit" : first("image"),
    video: directionId === "d1" && has("higgsfield:kling-video/v3.0/pro/image-to-video") ? "higgsfield:kling-video/v3.0/pro/image-to-video"
      : has("higgsfield:kling-video/v3.0/std/image-to-video") ? "higgsfield:kling-video/v3.0/std/image-to-video" : first("video"),
  };
}

function ModelsStep({ ctx }: { ctx: Ctx }) {
  const v = ctx.view;
  const rec = useMemo(() => recommend(ctx.models, v.project.spec.direction?.id), [ctx.models, v.project.spec.direction?.id]);
  const [pick, setPick] = useState<Record<string, string>>(v.project.spec.models ?? rec);
  const [test, setTest] = useState<string>("");
  const roles: [string, "image" | "video", string][] = [
    ["image", "image", "Product-scene generation: hero, lifestyle and benefit images from your photos"],
    ["edit", "image", "Reference-based edits: targeted fixes and extra keyframes (needs ≥ 2 references)"],
    ["video", "video", "Image-to-video: each shot starts from an approved still to protect product identity"],
  ];
  return (
    <>
      <Head eyebrow="Step 4 · Models" title="Choose who renders what">
        Only verified integrations with configured credentials are listed. Prices are quoted live by the provider in the next step. There is never an automatic switch to another model.
      </Head>
      {ctx.settings.providers.find((p) => p.id === "higgsfield")?.configured && (
        <p className="small"><button className="btn sm ghost" onClick={async () => {
          const r = await ctx.run("Testing Higgsfield", () => api.post<any>("/api/settings/test/higgsfield"));
          setTest(r?.ok ? `Connected. Sample quote: ${r.sample.model} ${usd(r.sample.usd)}` : "Higgsfield did not return a quote; check credentials and balance.");
        }}>Test Higgsfield connection (free)</button> <span className="muted">{test}</span></p>
      )}
      {roles.map(([role, kind, desc]) => (
        <section key={role} className="role">
          <h3>{role === "image" ? "Image generation" : role === "edit" ? "Image editing & product preservation" : "Video generation"} <small className="muted">{desc}</small></h3>
          <div className="models">
            {ctx.models.filter((m) => m.kind === kind && (role !== "edit" || m.max_refs >= 2)).map((m) => (
              <label key={m.id} className={`model ${pick[role] === m.id ? "on" : ""}`}>
                <input type="radio" name={role} checked={pick[role] === m.id} onChange={() => setPick({ ...pick, [role]: m.id })} />
                <div className="mh"><b>{m.name}</b>{rec[role as keyof typeof rec] === m.id && <span className="badge">Recommended</span>}<span className="muted small">{m.provider_label}</span></div>
                <p className="small">{m.use}</p>
                <ul className="specs small">
                  <li><i>In</i>{m.inputs}</li>
                  <li><i>Out</i>{m.outputs}</li>
                  <li><i>Aspect</i>{m.aspects.join(" · ")}</li>
                  <li><i>Res</i>{m.resolutions.join(" · ")}{m.durations && ` · ${m.durations[0]}–${m.durations[1]} s`}</li>
                  <li><i>Refs</i>{m.max_refs ? `up to ${m.max_refs}` : "none"}{m.audio ? " · native audio" : ""}</li>
                  <li><i>Quality</i>{m.quality_note}</li>
                  <li><i>Limits</i>{m.limitations}</li>
                </ul>
              </label>
            ))}
          </div>
        </section>
      ))}
      <p className="small muted">Upscaling: {ctx.settings.upscaling} · Audio: {ctx.settings.audio}</p>
      <div className="cta-row">
        <button className="btn primary lg" disabled={!pick.image || !pick.edit || !pick.video} onClick={() => ctx.run("Saving models", () => api.put(`${base(v)}/models`, pick))}>Use these models</button>
      </div>
    </>
  );
}

// ---------------- 5. budget ----------------

function defaultBudget(v: View, claude: boolean) {
  const pl: string[] = v.project.spec.brief?.platforms ?? [];
  const verticalOnly = pl.length > 0 && pl.every((p) => ["tiktok", "instagram_stories"].includes(p));
  return {
    max_usd: 25, images_per_slot: 1, image_aspect: verticalOnly ? "9:16" : "3:4", image_resolution: "2k", image_quality: "high",
    max_video_shots: 5, video_seconds: 15, video_resolution: "1080p", native_audio: false, max_retries: 3, allow_keyframes: false, auto_qc: claude,
  };
}

function BudgetStep({ ctx }: { ctx: Ctx }) {
  const v = ctx.view;
  const [b, setB] = useState<any>(v.project.spec.budget ?? defaultBudget(v, ctx.settings.claude.configured));
  const [ok, setOk] = useState(false);
  const plan = v.project.spec.plan;
  const num = (k: string, min: number, max: number, step = 1) => <input type="number" min={min} max={max} step={step} value={b[k]} onChange={(e) => setB({ ...b, [k]: Number(e.target.value) })} />;
  const sel = (k: string, opts: string[]) => <select value={b[k]} onChange={(e) => setB({ ...b, [k]: e.target.value })}>{opts.map((o) => <option key={o}>{o}</option>)}</select>;
  const flag = (k: string, label: string) => <label className="check"><input type="checkbox" checked={b[k]} onChange={(e) => setB({ ...b, [k]: e.target.checked })} />{label}</label>;
  const stale = plan && JSON.stringify(v.project.spec.budget) !== JSON.stringify(b);
  return (
    <>
      <Head eyebrow="Step 5 · Budget" title="Set the limits, see the price">
        The budget guard refuses any generation whose estimate exceeds what's left, never retries paid work on its own, and asks again if the plan changes.
      </Head>
      <div className="form">
        <fieldset>
          <legend>Spend</legend>
          <div className="grid3">
            <Field label="Maximum budget (USD)" hint="Hard cap for everything: generation and Claude.">{num("max_usd", 1, 5000, 0.5)}</Field>
            <Field label="Max regenerations" hint="Total paid retries across the campaign.">{num("max_retries", 0, 20)}</Field>
            <Field label="AI quality review">{flag("auto_qc", ctx.settings.claude.configured ? "Review every output with Claude" : "Unavailable without Claude")}</Field>
          </div>
        </fieldset>
        <fieldset>
          <legend>Images</legend>
          <div className="grid3">
            <Field label="Variations per image" hint="3 images × this many initial generations.">{num("images_per_slot", 1, 4)}</Field>
            <Field label="Aspect" hint="3:4 is cropped to 4:5 for the Instagram feed at export.">{sel("image_aspect", ["3:4", "9:16", "1:1", "16:9"])}</Field>
            <Field label="Resolution / quality"><div className="pair">{sel("image_resolution", ["1k", "2k", "4k"])}{sel("image_quality", ["low", "medium", "high"])}</div></Field>
          </div>
        </fieldset>
        <fieldset>
          <legend>Video</legend>
          <div className="grid3">
            <Field label="Max shots">{num("max_video_shots", 1, 10)}</Field>
            <Field label="Target length (s)">{num("video_seconds", 5, 60)}</Field>
            <Field label="Resolution">{sel("video_resolution", ["720p", "1080p"])}</Field>
          </div>
          <div className="checks">{flag("native_audio", "Generate native model audio (if supported)")}{flag("allow_keyframes", "Allow extra paid keyframes for video")}</div>
        </fieldset>
      </div>
      <div className="cta-row">
        <button className="btn lg" onClick={() => ctx.run("Getting live quotes", () => api.post(`${base(v)}/plan`, b))}>{plan ? "Re-estimate" : "Estimate production plan"}</button>
      </div>
      {plan && (
        <div className={`panel plan-box ${stale ? "stale" : ""}`}>
          <h3>Production estimate {stale && <span className="warn small">· settings changed; re-estimate before approving</span>}</h3>
          <PlanTable plan={plan} max={v.project.spec.budget?.max_usd} />
          <p className="small muted">Video shots are re-quoted from the storyboard and approved separately. Spend so far: {usd(v.ledger.committed_usd)}.</p>
          {v.plan_problems.length > 0 ? v.plan_problems.map((p) => <p key={p} className="err">{p}</p>) : (
            <>
              <label className="check strong"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />I approve this plan and authorise spending up to {usd(v.project.spec.budget.max_usd)} on this campaign.</label>
              <button className="btn primary lg" disabled={!ok || stale || !!ctx.busy} onClick={() => ctx.run("Writing prompts and starting image production", () => api.post(`${base(v)}/plan/approve`, { hash: plan.hash }))}>
                Approve & generate images
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ---------------- 6. images ----------------

function ImagesStep({ ctx }: { ctx: Ctx }) {
  const v = ctx.view;
  const spec = v.project.spec;
  const pl: string[] = spec.brief?.platforms ?? [];
  const [sb, setSb] = useState({ seconds: spec.budget?.video_seconds ?? 15, shots: Math.min(5, spec.budget?.max_video_shots ?? 5), aspect: pl.some((p) => ["tiktok", "instagram_stories"].includes(p)) || !pl.length ? "9:16" : "1:1", style: "" });
  const running = v.jobs.some((j) => RUNNING.includes(j.status));
  const ready = SLOTS.every(([s]) => v.assets.some((a) => a.kind === "image" && a.slot === s && a.status === "approved"));
  const retriesLeft = (spec.budget?.max_retries ?? 0) - (spec.retries_used ?? 0);
  return (
    <>
      <Head eyebrow="Step 6 · Images" title={running ? "Generating your campaign images" : "Review the images"}>
        Approve one image per slot. Rejecting never triggers a new paid attempt: regenerate shows the change and its price first. Retries left: {retriesLeft}.
      </Head>
      <div className="slots">
        {SLOTS.map(([slot, label]) => {
          const plan = spec.image_plan?.images.find((i: any) => i.slot === slot);
          const jobs = v.jobs.filter((j) => j.kind === "image" && j.slot === slot);
          const assets = v.assets.filter((a) => a.kind === "image" && a.slot === slot);
          return (
            <section key={slot} className="slot">
              <h3>{label}</h3>
              {plan && <p className="small muted">{plan.purpose}{plan.benefit_focus && <> · benefit: <b>{plan.benefit_focus}</b></>}</p>}
              {plan && <details className="prompt"><summary>Prompt</summary><p>{plan.prompt}</p><p className="muted">Avoid: {plan.negative}</p></details>}
              {jobs.map((j) => <JobRow key={j.id} ctx={ctx} j={j} canRetry={retriesLeft > 0} />)}
              {assets.map((a) => <AssetCard key={a.id} ctx={ctx} a={a} job={jobs.find((j) => j.id === a.job_id)} canRetry={retriesLeft > 0 && !running} allowEdit />)}
            </section>
          );
        })}
      </div>
      <div className="panel next">
        <h3>Next: video storyboard</h3>
        <div className="grid4">
          <Field label="Length (s)"><input type="number" min={5} max={60} value={sb.seconds} onChange={(e) => setSb({ ...sb, seconds: Number(e.target.value) })} /></Field>
          <Field label={`Shots (max ${spec.budget?.max_video_shots})`}><input type="number" min={1} max={spec.budget?.max_video_shots} value={sb.shots} onChange={(e) => setSb({ ...sb, shots: Number(e.target.value) })} /></Field>
          <Field label="Aspect"><select value={sb.aspect} onChange={(e) => setSb({ ...sb, aspect: e.target.value })}>{["9:16", "1:1", "16:9"].map((a) => <option key={a}>{a}</option>)}</select></Field>
          <Field label="Style notes"><input value={sb.style} placeholder="slow, premium, no fast cuts" onChange={(e) => setSb({ ...sb, style: e.target.value })} /></Field>
        </div>
        <button className="btn primary" disabled={!ready || running || !!ctx.busy} onClick={() => ctx.run("Writing the storyboard", () => api.post(`${base(v)}/storyboard`, sb))}>
          {ready ? "Write storyboard" : "Approve one image per slot first"}
        </button>
      </div>
    </>
  );
}

// ---------------- 7. storyboard + video approval ----------------

function StoryboardStep({ ctx }: { ctx: Ctx }) {
  const v = ctx.view;
  const spec = v.project.spec;
  const [sb, setSb] = useState<any>(() => structuredClone(spec.storyboard));
  const [ok, setOk] = useState(false);
  const [kfQuote, setKfQuote] = useState<Record<string, number | null>>({});
  const editable = (x: any) => JSON.stringify([x.aspect_ratio, x.headline, x.cta, x.voiceover_script, x.music_direction, x.trims ?? {}, x.shots.map((s: any) => [s.id, s.title, s.duration, s.reference_slot, s.transition, s.camera_movement, s.subject_motion, s.prompt])]);
  const dirty = editable(sb) !== editable(spec.storyboard);
  const total = sb.shots.reduce((n: number, s: any) => n + Number(s.duration), 0);
  const setShot = (i: number, k: string, val: any) => setSb((cur: any) => ({ ...cur, shots: cur.shots.map((s: any, n: number) => (n === i ? { ...s, [k]: val } : s)) }));
  const vp = spec.video_plan;
  const save = () => ctx.run("Saving storyboard", () => api.put(`${base(v)}/storyboard`, { ...sb, source: undefined, keyframes: undefined }));
  const videoModel = ctx.models.find((m) => m.id === spec.models?.video);
  return (
    <>
      <Head eyebrow="Step 7 · Storyboard" title={sb.concept}>
        {sb.aspect_ratio} · {total.toFixed(1)} s · {sb.shots.length} shots · {videoModel?.name}{videoModel?.durations && ` (generates ≥ ${videoModel.durations[0]} s per shot; the edit trims)`}
      </Head>
      <div className="form">
        <div className="grid2">
          <Field label="Headline (end card)"><input value={sb.headline} onChange={(e) => setSb({ ...sb, headline: e.target.value })} /></Field>
          <Field label="Call to action"><input value={sb.cta} onChange={(e) => setSb({ ...sb, cta: e.target.value })} /></Field>
          <Field label="Aspect"><select value={sb.aspect_ratio} onChange={(e) => setSb({ ...sb, aspect_ratio: e.target.value })}>{["9:16", "1:1", "16:9"].map((a) => <option key={a}>{a}</option>)}</select></Field>
          <Field label="Music direction" hint="Add your own licensed track at the edit step."><input value={sb.music_direction} onChange={(e) => setSb({ ...sb, music_direction: e.target.value })} /></Field>
        </div>
        {sb.voiceover_script && <Field label="Proposed voice-over script" hint="Not generated: no voice provider is integrated. Record it yourself and add it as the track, or leave it out."><textarea rows={3} value={sb.voiceover_script} onChange={(e) => setSb({ ...sb, voiceover_script: e.target.value })} /></Field>}
      </div>
      <ol className="shots">
        {sb.shots.map((s: any, i: number) => {
          const kf = spec.storyboard?.keyframes?.[s.id] && v.assets.find((a) => a.id === spec.storyboard.keyframes[s.id]);
          const still = kf ?? v.assets.filter((a) => a.kind === "image" && a.slot === s.reference_slot && a.status === "approved").at(-1);
          const kfJobs = v.jobs.filter((j) => j.kind === "keyframe" && j.slot === s.id);
          const kfAssets = v.assets.filter((a) => a.kind === "keyframe" && a.slot === s.id && a.meta.source !== "crop");
          return (
            <li key={s.id} className="shot">
              <div className="frame">{still && <img src={still.url} alt={`First frame for ${s.title}`} />}<span>{s.id}</span></div>
              <div className="shot-body">
                <div className="grid4">
                  <Field label="Title"><input value={s.title} onChange={(e) => setShot(i, "title", e.target.value)} /></Field>
                  <Field label="Seconds"><input type="number" step={0.5} min={0.5} max={15} value={s.duration} onChange={(e) => setShot(i, "duration", Number(e.target.value))} /></Field>
                  <Field label="First frame"><select value={s.reference_slot} onChange={(e) => setShot(i, "reference_slot", e.target.value)}>{SLOTS.map(([x, l]) => <option key={x} value={x}>{l}</option>)}</select></Field>
                  <Field label="Transition out"><select value={s.transition} onChange={(e) => setShot(i, "transition", e.target.value)}>{["cut", "fade", "fadeblack", "dissolve", "wipeleft", "slideup"].map((t) => <option key={t}>{t}</option>)}</select></Field>
                </div>
                <div className="grid2">
                  <Field label="Camera"><input value={s.camera_movement} onChange={(e) => setShot(i, "camera_movement", e.target.value)} /></Field>
                  <Field label="Subject motion"><input value={s.subject_motion} onChange={(e) => setShot(i, "subject_motion", e.target.value)} /></Field>
                </div>
                <Field label="Video prompt"><textarea rows={2} value={s.prompt} onChange={(e) => setShot(i, "prompt", e.target.value)} /></Field>
                <p className="small muted">{s.purpose} · {s.composition} · {s.lighting}</p>
                {spec.budget?.allow_keyframes && v.project.stage === "storyboard" && (
                  <div className="kf">
                    {kfJobs.map((j) => <JobRow key={j.id} ctx={ctx} j={j} canRetry={false} />)}
                    {kfAssets.map((a) => <AssetCard key={a.id} ctx={ctx} a={a} canRetry={false} />)}
                    {kfQuote[s.id] === undefined ? (
                      <button className="btn sm ghost" onClick={async () => { const r = await ctx.run("Pricing keyframe", () => api.post<any>(`${base(v)}/keyframes/${s.id}`, { expected_usd: null })); if (r) setKfQuote({ ...kfQuote, [s.id]: r.keyframe.est_usd }); }}>Generate a dedicated {sb.aspect_ratio} keyframe…</button>
                    ) : (
                      <button className="btn sm" disabled={kfQuote[s.id] == null} onClick={() => ctx.run("Generating keyframe", () => api.post(`${base(v)}/keyframes/${s.id}`, { expected_usd: kfQuote[s.id] }))}>Confirm keyframe · {usd(kfQuote[s.id])}</button>
                    )}
                  </div>
                )}
              </div>
              <button className="x" aria-label={`Remove ${s.title}`} disabled={sb.shots.length < 2} onClick={() => setSb({ ...sb, shots: sb.shots.filter((_: any, n: number) => n !== i) })}>×</button>
            </li>
          );
        })}
      </ol>
      {sb.shots.length < (spec.budget?.max_video_shots ?? 5) && (
        <button className="btn ghost" onClick={() => setSb({ ...sb, shots: [...sb.shots, { ...sb.shots.at(-1), id: `s${Date.now() % 100000}`, title: "New shot" }] })}>+ Add shot</button>
      )}
      <div className="cta-row">
        {dirty && <button className="btn" onClick={save}>Save changes</button>}
        <button className="btn primary" disabled={!!ctx.busy} onClick={async () => { if (dirty && !(await save())) return; await ctx.run("Preparing keyframes and quoting shots", () => api.post(`${base(v)}/video/plan`)); }}>
          {vp ? "Re-quote video" : "Quote the video"}
        </button>
      </div>
      {vp && v.project.stage === "video_approval" && !dirty && (
        <div className="panel plan-box">
          <h3>Video production estimate</h3>
          <PlanTable plan={vp} />
          <p className="small muted">Budget left: {usd(v.ledger.remaining_usd)}. Keyframes were cropped locally from your approved stills (free).</p>
          <label className="check strong"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />I approve generating {vp.items.length} shots for about {usd(vp.total_usd)}.</label>
          <button className="btn primary lg" disabled={!ok || !!ctx.busy || (v.ledger.remaining_usd ?? 0) < vp.total_usd} onClick={() => ctx.run("Starting video production", () => api.post(`${base(v)}/video/approve`, { hash: vp.hash }))}>Approve & generate shots</button>
        </div>
      )}
    </>
  );
}

// ---------------- 8. shots + edit ----------------

function EditForm({ ctx }: { ctx: Ctx }) {
  const v = ctx.view;
  const spec = v.project.spec;
  const pl: string[] = spec.brief?.platforms ?? [];
  const logo = v.assets.find((a) => a.kind === "logo");
  const music = v.assets.find((a) => a.kind === "music");
  const defaults = {
    formats: [...new Set([spec.storyboard.aspect_ratio, ...(pl.some((p) => ["instagram_feed", "facebook"].includes(p)) ? ["4:5"] : [])])],
    headline: spec.storyboard.headline, cta: spec.storyboard.cta, show_logo: !!logo, logo_position: "top-left", end_card_seconds: 2.5,
    audio: spec.budget?.native_audio ? "native" : "none", music_rights_confirmed: false,
  };
  const [e, setE] = useState<any>(spec.edit ?? defaults);
  const allApproved = spec.storyboard.shots.every((s: any) => v.assets.some((a) => a.kind === "shot" && a.slot === s.id && a.status === "approved"));
  return (
    <div className="panel next">
      <h3>Edit, brand & export formats <small className="muted">· rendered locally with FFmpeg (free)</small></h3>
      <div className="grid3">
        <Field label="Formats">
          <div className="checks">{["9:16", "4:5", "1:1", "16:9"].map((f) => <label key={f} className="check"><input type="checkbox" checked={e.formats.includes(f)} onChange={(x) => setE({ ...e, formats: x.target.checked ? [...e.formats, f] : e.formats.filter((y: string) => y !== f) })} />{f}</label>)}</div>
        </Field>
        <Field label="Headline"><input value={e.headline} maxLength={120} onChange={(x) => setE({ ...e, headline: x.target.value })} /></Field>
        <Field label="Call to action"><input value={e.cta} maxLength={60} onChange={(x) => setE({ ...e, cta: x.target.value })} /></Field>
        <Field label="Logo">
          {logo ? <div className="pair"><label className="check"><input type="checkbox" checked={e.show_logo} onChange={(x) => setE({ ...e, show_logo: x.target.checked })} />Show</label>
            <select value={e.logo_position} onChange={(x) => setE({ ...e, logo_position: x.target.value })}>{["top-left", "top-right", "bottom-left", "bottom-right", "center"].map((p) => <option key={p}>{p}</option>)}</select></div>
            : <Upload label="Upload logo" accept="image/png,image/jpeg,image/webp" onFiles={(f) => sendFiles(ctx, "logo", f)} />}
        </Field>
        <Field label="End card (s)"><input type="number" min={1} max={5} step={0.5} value={e.end_card_seconds} onChange={(x) => setE({ ...e, end_card_seconds: Number(x.target.value) })} /></Field>
        <Field label="Audio">
          <select value={e.audio} onChange={(x) => setE({ ...e, audio: x.target.value })}>
            <option value="none">Silent</option><option value="native">Model's native audio</option><option value="track">My licensed track</option>
          </select>
        </Field>
      </div>
      {e.audio === "track" && (
        <div className="grid2">
          {music ? <p className="small">Track: {music.meta.original_name} · {music.duration?.toFixed(1)} s</p> : <Upload label="Upload music (MP3, M4A, WAV)" accept="audio/*" onFiles={(f) => sendFiles(ctx, "music", f)} />}
          <label className="check strong"><input type="checkbox" checked={e.music_rights_confirmed} onChange={(x) => setE({ ...e, music_rights_confirmed: x.target.checked })} />I hold the licence to use this track in paid social ads.</label>
        </div>
      )}
      <button className="btn primary" disabled={!allApproved || !e.formats.length || !!ctx.busy} onClick={() => ctx.run("Rendering the edit", () => api.post(`${base(v)}/edit`, { ...e, music_asset_id: music?.id }))}>
        {allApproved ? `Render ${e.formats.length} format(s): branded + clean` : "Approve a take for every shot first"}
      </button>
    </div>
  );
}

function ShotsStep({ ctx }: { ctx: Ctx }) {
  const v = ctx.view;
  const spec = v.project.spec;
  const running = v.jobs.some((j) => j.kind === "shot" && RUNNING.includes(j.status));
  const retriesLeft = (spec.budget?.max_retries ?? 0) - (spec.retries_used ?? 0);
  return (
    <>
      <Head eyebrow="Step 8 · Shots" title={running ? "Animating shots" : "Review each shot"}>
        Check for product deformation, identity drift, flicker, duplicated objects and camera moves that hide the product. Replace any single shot without redoing the rest. Retries left: {retriesLeft}.
      </Head>
      <div className="shotgrid">
        {spec.storyboard.shots.map((s: any) => {
          const jobs = v.jobs.filter((j) => j.kind === "shot" && j.slot === s.id);
          const takes = v.assets.filter((a) => a.kind === "shot" && a.slot === s.id);
          return (
            <section key={s.id} className="slot">
              <h3>{s.title} <small className="muted">{s.duration}s · {s.camera_movement}</small></h3>
              {jobs.map((j) => <JobRow key={j.id} ctx={ctx} j={j} canRetry={retriesLeft > 0} />)}
              {takes.map((a) => <AssetCard key={a.id} ctx={ctx} a={a} job={jobs.find((j) => j.id === a.job_id)} canRetry={retriesLeft > 0 && !running} />)}
            </section>
          );
        })}
      </div>
      {!running && <EditForm ctx={ctx} />}
    </>
  );
}

// ---------------- 9. final QC ----------------

function FinalStep({ ctx }: { ctx: Ctx }) {
  const v = ctx.view;
  const finals = v.assets.filter((a) => a.kind === "video" && !a.meta.superseded);
  const issues = finals.flatMap((a) => a.meta.checks ?? []);
  const [reedit, setReedit] = useState(false);
  return (
    <>
      <Head eyebrow="Step 9 · Final quality control" title="Watch the cut">
        Technical checks ran automatically (resolution, duration, codec, audio). Judge branding, product fidelity and pacing yourself, optionally with an AI review of sampled frames.
      </Head>
      <p className={issues.length ? "err" : "ok"}>{issues.length ? `Technical issues: ${issues.join(" · ")}` : "✓ All technical checks passed."}</p>
      <div className="finals">
        {finals.map((a) => (
          <div key={a.id} className="final">
            <h4>{a.slot?.replace(/:(\w+)$/, " · $1")}</h4>
            <video src={a.url} controls playsInline preload="metadata" />
            <ReviewPanel a={a} />
            {ctx.settings.claude.configured && <button className="btn sm ghost" onClick={() => ctx.run("AI review", () => api.post(`${base(v)}/assets/${a.id}/qc`))}>AI review frames</button>}
          </div>
        ))}
      </div>
      <div className="cta-row">
        <button className="btn ghost" onClick={() => setReedit(!reedit)}>{reedit ? "Hide edit settings" : "Change edit & re-render"}</button>
        <button className="btn primary lg" onClick={() => ctx.run("Approving", () => api.post(`${base(v)}/final/approve`))}>Approve final cut</button>
      </div>
      {reedit && <EditForm ctx={ctx} />}
    </>
  );
}

// ---------------- 10. export ----------------

function ExportStep({ ctx }: { ctx: Ctx }) {
  const v = ctx.view;
  const exp = v.project.spec.export;
  if (!exp) {
    return (
      <>
        <Head eyebrow="Step 10 · Export" title="Package the campaign">
          Writes a campaign folder with the approved images (platform crops + with-copy variants), final videos, individual shots, storyboard, prompts, the campaign spec, a cost report and export specs.
        </Head>
        <button className="btn primary lg" onClick={() => ctx.run("Exporting", () => api.post(`${base(v)}/export`))}>Export campaign folder</button>
      </>
    );
  }
  const groups = exp.files.reduce((m: Record<string, string[]>, f: string) => ((m[f.includes("/") ? f.split("/")[0] : "campaign"] ??= []).push(f), m), {});
  return (
    <>
      <Head eyebrow="Done" title="Campaign exported">
        Folder: <code>data/{exp.dir}</code>
      </Head>
      {exp.zip && <a className="btn primary lg" href={`${base(v)}/export.zip`}>Download .zip</a>}
      <div className="files">
        {Object.entries(groups).map(([g, fs]) => (
          <div key={g}><h4>{g}</h4><ul>{(fs as string[]).map((f) => <li key={f} className="mono small">{f.startsWith(g + "/") ? f.slice(g.length + 1) : f}</li>)}</ul></div>
        ))}
      </div>
    </>
  );
}
