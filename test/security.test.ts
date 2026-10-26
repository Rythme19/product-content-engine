// Security: auth token, CSRF header, host/origin checks, upload validation,
// cross-project file access, secret leakage, and untrusted download URLs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isolate, productPhoto } from "./helpers.ts";

const TOKEN = "test-token-0123456789abcdefghij";
const SECRET = "hf-secret-should-never-leak-42";
isolate({ APP_TOKEN: TOKEN, HF_API_KEY_ID: "hf-key-id-test", HF_API_KEY_SECRET: SECRET });
const { app } = await import("../server/main.ts");
const { safeDownload } = await import("../server/providers/types.ts");
const { redact } = await import("../server/db.ts");

const H = { host: "localhost:8787", "x-studio": "1", authorization: `Bearer ${TOKEN}` };
const req = (url: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  app.request(url, { ...init, headers: { ...H, ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}), ...init.headers } });

async function newProject(name: string) {
  return (await (await req("/api/projects", { method: "POST", body: JSON.stringify({ name }) })).json()).project.id as string;
}

test("API requires the app token when one is configured", async () => {
  assert.equal((await app.request("/api/projects", { headers: { host: "localhost:8787" } })).status, 401);
  assert.equal((await req("/api/projects")).status, 200);
  const login = await app.request("/api/login", { method: "POST", headers: { host: "localhost:8787", "content-type": "application/json" }, body: JSON.stringify({ token: "wrong" }) });
  assert.equal(login.status, 401);
});

test("state-changing requests need X-Studio and a same-origin Origin", async () => {
  assert.equal((await req("/api/projects", { method: "POST", body: JSON.stringify({ name: "x" }), headers: { "x-studio": "" } })).status, 403);
  assert.equal((await req("/api/projects", { method: "POST", body: JSON.stringify({ name: "x" }), headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await req("/api/projects", { method: "POST", body: JSON.stringify({ name: "x" }), headers: { origin: "http://localhost:8787" } })).status, 200);
});

test("unexpected Host header is refused (DNS rebinding)", async () => {
  assert.equal((await req("/api/projects", { headers: { host: "attacker.example:8787" } })).status, 403);
});

test("uploads are decoded: non-images rejected, names never used as paths", async () => {
  const pid = await newProject("uploads");
  const fd = new FormData();
  fd.set("kind", "reference");
  fd.append("files", new File([new TextEncoder().encode("#!/bin/sh\necho pwned")], "../../evil.jpg", { type: "image/jpeg" }));
  fd.append("files", new File([new Uint8Array(await productPhoto())], "../../ok photo.jpg", { type: "image/jpeg" }));
  const r = await (await req(`/api/projects/${pid}/uploads`, { method: "POST", body: fd })).json();
  assert.equal(r.upload_errors.length, 1);
  const refs = r.assets.filter((a: any) => a.kind === "reference");
  assert.equal(refs.length, 1);
  assert.match(refs[0].path, /^projects\/[0-9a-f-]+\/uploads\/[0-9a-f-]+\.jpg$/);
  assert.equal(refs[0].meta.original_name, ".._.._ok photo.jpg");
  const bad = new FormData();
  bad.set("kind", "../../etc");
  bad.append("files", new File([new Uint8Array(await productPhoto())], "a.jpg"));
  assert.equal((await req(`/api/projects/${pid}/uploads`, { method: "POST", body: bad })).status, 409);
});

test("files are only served within their own project", async () => {
  const a = await newProject("A");
  const b = await newProject("B");
  const fd = new FormData();
  fd.set("kind", "reference");
  fd.append("files", new File([new Uint8Array(await productPhoto())], "p.jpg", { type: "image/jpeg" }));
  const asset = (await (await req(`/api/projects/${a}/uploads`, { method: "POST", body: fd })).json()).assets[0];
  assert.equal((await req(`/api/projects/${a}/files/${asset.id}`)).status, 200);
  assert.equal((await req(`/api/projects/${b}/files/${asset.id}`)).status, 404);
});

test("secrets never reach the client and are redacted from messages", async () => {
  for (const url of ["/api/settings", "/api/models", "/api/projects"]) {
    const text = await (await req(url)).text();
    assert.ok(!text.includes(SECRET) && !text.includes("hf-key-id-test"), url);
  }
  assert.equal(redact(`Authorization: Key hf-key-id-test:${SECRET}`), "Authorization: Key [redacted]:[redacted]");
});

test("provider output URLs are untrusted: https only, no private hosts", async () => {
  for (const url of ["http://cdn.example.com/a.png", "https://127.0.0.1/a.png", "https://localhost/a.png", "https://10.0.0.5/a.png", "https://169.254.169.254/latest"])
    await assert.rejects(safeDownload(url, "/tmp/never"), /refusing/);
});
