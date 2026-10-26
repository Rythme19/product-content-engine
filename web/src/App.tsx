import { useCallback, useEffect, useState } from "react";
import { api, ApiError, usd, type ModelInfo, type Settings, type View } from "./api.ts";
import { StepView } from "./steps.tsx";

export const STAGES: [string, string][] = [
  ["intake", "Upload"], ["analysis", "Brief"], ["directions", "Direction"], ["models", "Models"], ["budget", "Budget"],
  ["image_production", "Images"], ["image_review", "Review"], ["storyboard", "Storyboard"], ["video_approval", "Approve video"],
  ["video_production", "Shots"], ["editing", "Edit"], ["final_qc", "Final QC"], ["export", "Export"], ["done", "Done"],
];
const BACK: Record<string, string[]> = {
  analysis: [], directions: ["analysis"], models: ["analysis", "directions"], budget: ["analysis", "directions", "models"],
  storyboard: ["image_review"], video_approval: ["image_review", "storyboard"], export: ["final_qc"],
};

export type Ctx = {
  view: View;
  settings: Settings;
  models: ModelInfo[];
  busy: string | null;
  run: (label: string, fn: () => Promise<any>) => Promise<any>;
};

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string; stage: string; status: string }[]>([]);
  const [pid, setPid] = useState<string | null>(location.hash.startsWith("#/p/") ? location.hash.slice(4) : null);
  const [view, setView] = useState<View | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ msg: string; budget?: boolean; issues?: string[] } | null>(null);

  const run = useCallback(async (label: string, fn: () => Promise<any>) => {
    setBusy(label);
    setError(null);
    try {
      const out = await fn();
      if (out?.project) setView(out);
      return out;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedLogin(true);
      setError({ msg: (e as Error).message, budget: e instanceof ApiError && e.status === 402, issues: e instanceof ApiError ? e.data?.issues : undefined });
    } finally {
      setBusy(null);
    }
  }, []);

  const boot = useCallback(async () => {
    try {
      const [s, m, p] = await Promise.all([api.get<Settings>("/api/settings"), api.get<{ models: ModelInfo[] }>("/api/models"), api.get<{ projects: any[] }>("/api/projects")]);
      setSettings(s); setModels(m.models); setProjects(p.projects); setNeedLogin(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedLogin(true);
      else setError({ msg: (e as Error).message });
    }
  }, []);
  useEffect(() => { void boot(); }, [boot]);

  useEffect(() => {
    location.hash = pid ? `/p/${pid}` : "";
    setView(null);
    if (pid) void run("Loading", () => api.get(`/api/projects/${pid}`));
  }, [pid, run]);

  const stage = view?.project.stage;
  const status = view?.project.status;
  useEffect(() => { window.scrollTo({ top: 0 }); }, [stage]); // braces: scrollTo may return a Promise
  useEffect(() => { void api.get<{ projects: any[] }>("/api/projects").then((r) => setProjects(r.projects)).catch(() => {}); }, [stage, status]);

  // Poll while work is running.
  const live = !!view && (view.ledger.in_flight > 0 || ["image_production", "video_production"].includes(view.project.stage));
  useEffect(() => {
    if (!live || !pid) return;
    const t = setInterval(() => void api.get<View>(`/api/projects/${pid}`).then(setView).catch(() => {}), 2500);
    return () => clearInterval(t);
  }, [live, pid]);

  if (needLogin) return <Login onDone={boot} />;
  if (!settings) return <div className="boot">{error ? error.msg : "Loading studio…"}</div>;

  const newProject = async (name: string) => {
    const v = await run("Creating project", () => api.post<View>("/api/projects", { name }));
    if (v) { setPid(v.project.id); void boot(); }
  };

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><span className="mark" />Creative Studio</div>
        <button className="btn ghost wide" onClick={() => setPid(null)}>+ New campaign</button>
        <nav className="projects" aria-label="Campaigns">
          {projects.map((p) => (
            <button key={p.id} className={`proj ${p.id === pid ? "on" : ""}`} onClick={() => setPid(p.id)}>
              <span>{p.name}</span>
              <small>{STAGES.find(([s]) => s === p.stage)?.[1]} · {p.status}</small>
            </button>
          ))}
        </nav>
        <Connections settings={settings} />
      </aside>

      <main className="main">
        {!view ? (
          <Welcome settings={settings} onNew={newProject} />
        ) : (
          <>
            <header className="top">
              <div>
                <h1>{view.project.name}</h1>
                <Rail stage={view.project.stage} />
              </div>
              <Controls view={view} run={run} />
            </header>
            {error && (
              <div className={`alert ${error.budget ? "budget" : ""}`} role="alert">
                <strong>{error.budget ? "Budget guard" : "Couldn't do that"}:</strong> {error.msg}
                {error.issues?.map((i) => <div key={i} className="mono small">{i}</div>)}
                <button className="x" onClick={() => setError(null)} aria-label="Dismiss">×</button>
              </div>
            )}
            {view.upload_errors?.length ? <div className="alert">{view.upload_errors.join(" · ")}</div> : null}
            <div className="work">
              <section className="stage">
                <StepView ctx={{ view, settings, models, busy, run }} />
              </section>
              <aside className="rail-right">
                <CostMeter view={view} />
                <Activity view={view} />
              </aside>
            </div>
          </>
        )}
      </main>
      {busy && <div className="busy" aria-live="polite"><span className="spinner" />{busy}…</div>}
    </div>
  );
}

function Rail({ stage }: { stage: string }) {
  const idx = STAGES.findIndex(([s]) => s === stage);
  return (
    <ol className="steps">
      {STAGES.slice(0, -1).map(([s, label], i) => (
        <li key={s} className={i < idx ? "done" : i === idx ? "now" : ""} aria-current={i === idx ? "step" : undefined}>{label}</li>
      ))}
    </ol>
  );
}

function Controls({ view, run }: { view: View; run: Ctx["run"] }) {
  const p = view.project;
  const back = BACK[p.stage] ?? [];
  return (
    <div className="controls">
      {back.length > 0 && p.status === "active" && (
        <select aria-label="Go back to stage" value="" onChange={(e) => e.target.value && run("Going back", () => api.post(`/api/projects/${p.id}/back`, { stage: e.target.value }))}>
          <option value="">↩ Back to…</option>
          {back.map((s) => <option key={s} value={s}>{STAGES.find(([x]) => x === s)?.[1]}</option>)}
        </select>
      )}
      {p.status === "active" && p.stage !== "done" && <button className="btn ghost" onClick={() => run("Pausing", () => api.post(`/api/projects/${p.id}/status`, { status: "paused" }))}>Pause</button>}
      {p.status === "paused" && <button className="btn" onClick={() => run("Resuming", () => api.post(`/api/projects/${p.id}/status`, { status: "active" }))}>Resume</button>}
      {["active", "paused"].includes(p.status) && p.stage !== "done" && (
        <button className="btn ghost danger" onClick={() => confirm("Cancel this campaign? Queued generations are cancelled (not charged); ones already running finish and are billed.") && run("Cancelling", () => api.post(`/api/projects/${p.id}/status`, { status: "cancelled" }))}>Cancel</button>
      )}
      {p.status !== "active" && <span className={`pill ${p.status}`}>{p.status}</span>}
    </div>
  );
}

function CostMeter({ view }: { view: View }) {
  const l = view.ledger;
  const pct = l.max_usd ? Math.min(100, (l.committed_usd / l.max_usd) * 100) : 0;
  return (
    <div className="panel meter">
      <h3>Budget</h3>
      {l.max_usd == null ? <p className="muted small">No budget yet. Each Claude call before the budget step asks for your confirmation.</p> : (
        <>
          <div className="big">{usd(l.remaining_usd)} <small>left of {usd(l.max_usd)}</small></div>
          <div className="bar" role="meter" aria-label="Budget used" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} className={pct > 85 ? "hot" : ""} /></div>
        </>
      )}
      <dl>
        <dt>Generation, billed</dt><dd>{usd(l.generation_spent_usd)}</dd>
        <dt>Reserved, in flight</dt><dd>{usd(l.reserved_usd)}</dd>
        <dt>Claude · {l.llm_calls} calls</dt><dd>{usd(l.llm_spent_usd)} <small className="muted">est {usd(l.llm_estimated_usd)}</small></dd>
        <dt>Failed, not charged</dt><dd>{usd(l.failed_not_charged_usd)}</dd>
        <dt>Jobs</dt><dd>{l.completed} done · {l.in_flight} running · {l.failed} failed</dd>
      </dl>
    </div>
  );
}

function Activity({ view }: { view: View }) {
  return (
    <div className="panel log">
      <h3>Activity</h3>
      <ul>{view.events.slice(0, 14).map((e, i) => <li key={i} className={e.level}><time>{e.ts.slice(11, 19)}</time>{e.message}</li>)}</ul>
    </div>
  );
}

function Connections({ settings }: { settings: Settings }) {
  return (
    <div className="conn">
      <h4>Connections</h4>
      {settings.providers.map((p) => (
        <div key={p.id} className="row"><span className={`dot ${p.configured ? "ok" : ""}`} />{p.label}{!p.configured && <small className="muted"> · set {p.env.join(", ")}</small>}</div>
      ))}
      <div className="row"><span className={`dot ${settings.claude.configured ? "ok" : ""}`} />Claude{settings.claude.configured ? <small className="muted"> · {settings.claude.model}</small> : <small className="muted"> · set ANTHROPIC_API_KEY</small>}</div>
    </div>
  );
}

function Welcome({ settings, onNew }: { settings: Settings; onNew: (name: string) => void }) {
  const hf = settings.providers.find((p) => p.id === "higgsfield")?.configured;
  const [name, setName] = useState("");
  return (
    <div className="welcome">
      <p className="eyebrow">AI product creative studio</p>
      <h1>From product photos to a finished campaign, on a budget you set.</h1>
      <p className="lede">Upload a few photos. Confirm the brief, pick a creative direction and models, and approve a costed plan. Then review three campaign images and a cut product film before export. Nothing paid runs without your approval.</p>
      <form className="start" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onNew(name.trim()); }}>
        <input aria-label="Campaign name" placeholder="Campaign name, e.g. Verde Serum launch" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <button className="btn primary lg" disabled={!name.trim()}>Start a campaign</button>
      </form>
      {!hf && <p className="note">Higgsfield isn't connected, so only the free offline <b>mock</b> provider is available (it makes placeholders, not AI images). Add <code>HF_API_KEY_ID</code> and <code>HF_API_KEY_SECRET</code> to <code>.env</code> and restart to generate for real.</p>}
      {!settings.claude.configured && <p className="note">Claude isn't connected, so analysis, directions and prompts fall back to editable templates. Add <code>ANTHROPIC_API_KEY</code> for AI creative direction and QC.</p>}
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  return (
    <form className="login" onSubmit={async (e) => {
      e.preventDefault();
      try { await api.post("/api/login", { token }); onDone(); } catch (x) { setErr((x as Error).message); }
    }}>
      <h1>Creative Studio</h1>
      <label>Access token<input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus /></label>
      {err && <p className="err">{err}</p>}
      <button className="btn primary">Sign in</button>
    </form>
  );
}
