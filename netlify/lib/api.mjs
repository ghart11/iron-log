// Request handling shared by the Netlify Functions. Storage and the model are injected, so tests can run without Netlify.
import { startRun, stepRun, runView } from "./agent.mjs";
import { runWeeklyCheckin } from "./weekly.mjs";
import { weeklyStatus, buildLibrary, trainingSummary, muscleBalance, findPlateaus } from "./analysis.mjs";
import { demoClients } from "./seed.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const clean = (s, n = 200) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

// Strip photos and anything huge before storing a client's log
function slimData(d = {}) {
  const exercises = {};
  for (const [id, e] of Object.entries(d.exercises || {})) { const { imgData, ...rest } = e || {}; exercises[id] = rest; }
  return { sessions: d.sessions || {}, workouts: d.workouts || {}, exercises, unit: d.unit === "kg" ? "kg" : "lb" };
}
// Sessions from every device are kept (merged by id), so a new phone can't wipe a client's history.
function mergeData(prev = {}, incoming) {
  if (!incoming) return prev;
  const d = slimData(incoming);
  return { ...d, sessions: { ...(prev.sessions || {}), ...d.sessions }, exercises: { ...(prev.exercises || {}), ...d.exercises } };
}
const profileOf = (p = {}) => ({ goal: clean(p.goal, 80), daysPerWeek: Math.max(1, Math.min(7, +p.daysPerWeek || 3)), experience: clean(p.experience, 60), equipment: clean(p.equipment || "Full commercial gym", 80) });

/* ---------- Client app: /api/sync ---------- */
export async function handleSync(req, { store, env }) {
  if (req.method !== "POST") return bad("Use POST", 405);
  let body; try { body = await req.json(); } catch { return bad("Body must be JSON."); }
  const code = String(body.code || "").trim().toUpperCase();
  if (code !== String(env.GYM_CODE || "IRONDEMO").toUpperCase()) return bad("That gym code isn't right. Ask your trainer for it.", 403);
  const id = clean(body.clientId, 64).replace(/[^a-zA-Z0-9_-]/g, "");
  if (id.length < 8) return bad("Missing client id.");
  const key = `clients/${id}`;
  const prev = (await store.get(key, { type: "json" })) || {};
  const rec = { ...prev, clientId: id, name: clean(body.name, 60) || prev.name || "Client",
    profile: { ...profileOf(body.profile), notes: prev.profile?.notes || "" }, data: mergeData(prev.data, body.data), updatedAt: new Date().toISOString() };
  const size = JSON.stringify(rec).length;
  if (size > 4_500_000) return bad("Your log is too large to sync. Export a backup and remove old sessions.", 413);
  await store.setJSON(key, rec);
  const assigned = (await store.get(`assign/${id}`, { type: "json" })) || [];
  const inbox = (await store.get(`inbox/${id}`, { type: "json" })) || [];
  return json({ ok: true, syncedAt: rec.updatedAt, assigned, inbox });
}

/* ---------- Coach dashboard: /api/coach/* ---------- */
export async function handleCoach(req, { store, env, callModel, notify, path, stepBudgetMs = 12000 }) {
  const pin = req.headers.get("x-coach-pin") || "";
  if (pin !== String(env.COACH_PIN || "1234")) return bad("Wrong coach PIN.", 401);
  const route = path.replace(/^\/api\/coach\/?/, "").split("?")[0];
  const url = new URL(req.url);

  if (route === "clients" && req.method === "GET") {
    const { blobs } = await store.list({ prefix: "clients/" });
    const all = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
    return json({ clients: all.map((c) => ({ ...weeklyStatus(c), profile: c.profile, updatedAt: c.updatedAt, demo: !!c.demo })) });
  }
  if (route === "client" && req.method === "GET") {
    const id = url.searchParams.get("id") || "";
    const c = await store.get(`clients/${id}`, { type: "json" });
    if (!c) return bad("Client not found.", 404);
    const lib = buildLibrary(c.data?.exercises), data = { ...c.data, profile: c.profile };
    const runs = (await store.get(`runs/${id}`, { type: "json" })) || [];
    const assigned = (await store.get(`assign/${id}`, { type: "json" })) || [];
    return json({ client: { clientId: c.clientId, name: c.name, profile: c.profile, updatedAt: c.updatedAt }, status: weeklyStatus(c),
      summary: trainingSummary(data, lib, { weeks: 6 }), balance: muscleBalance(data, lib, { days: 14 }), plateaus: findPlateaus(data, lib), runs: runs.slice(-5).reverse(), assigned });
  }
  if (route === "notes" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const key = `clients/${clean(b.clientId, 64)}`; const c = await store.get(key, { type: "json" });
    if (!c) return bad("Client not found.", 404);
    c.profile = { ...c.profile, notes: clean(b.notes, 500) }; await store.setJSON(key, c);
    return json({ ok: true });
  }
  if ((route === "agent" || route === "agent-step") && req.method === "POST") {
    // "agent" starts a run; "agent-step" continues it. Each request works for ~12 s (Netlify stops functions at 30 s).
    const b = await req.json().catch(() => ({}));
    const id = clean(b.clientId, 64);
    const c = await store.get(`clients/${id}`, { type: "json" });
    if (!c) return bad("Client not found.", 404);
    if (!callModel) return bad("The AI model isn't available. Netlify AI Gateway needs one production deploy on a credit-based plan, or set ANTHROPIC_API_KEY in Netlify's environment variables.", 503);
    let run, runId;
    if (route === "agent") {
      runId = `run-${Date.now()}`;
      run = startRun({ ...c, request: clean(b.request, 400) });
      run.request = clean(b.request, 400);
    } else {
      runId = clean(b.runId, 40);
      run = await store.get(`agent-state/${id}/${runId}`, { type: "json" });
      if (!run) return bad("That AI Coach run expired. Start it again.", 404);
      if (run.done) return json({ id: runId, ...runView(run) });
    }
    await stepRun(run, { ...c, request: run.request }, callModel, { budgetMs: stepBudgetMs });
    await store.setJSON(`agent-state/${id}/${runId}`, run);
    const view = { id: runId, at: new Date(run.startedAt).toISOString(), request: run.request, ...runView(run) };
    if (run.done) {
      if (!view.ok) return bad(run.error ? `The AI Coach couldn't reach the model: ${run.error}` : "The AI Coach finished without drafting a program. Try again.", 502);
      const key = `runs/${id}`; const runs = (await store.get(key, { type: "json" })) || [];
      runs.push(view); await store.setJSON(key, runs.slice(-10));
      await store.delete(`agent-state/${id}/${runId}`);
    }
    return json(view);
  }
  if (route === "assign" && req.method === "POST") {
    // Trainer approved a run: turn its drafts into workouts the client app will pick up
    const b = await req.json().catch(() => ({}));
    const id = clean(b.clientId, 64), runs = (await store.get(`runs/${id}`, { type: "json" })) || [];
    const run = runs.find((r) => r.id === b.runId);
    if (!run) return bad("Run not found.", 404);
    const workouts = (Array.isArray(b.workouts) ? b.workouts : run.workouts).slice(0, 7);
    const pack = workouts.map((w, i) => {
      const ex = w.exercises || [];
      const groups = []; let g = 0;
      ex.forEach((x, k) => { if (x.superset_with_next && k + 1 < ex.length) { groups[k] = groups[k] || `g${++g}`; groups[k + 1] = groups[k]; } });
      return { id: `${run.id}-${i}`, name: clean(w.name, 40), focus: clean(w.focus, 160), exerciseIds: ex.map((x) => x.exercise_id), groups: ex.map((_, k) => groups[k] || null),
        plan: Object.fromEntries(ex.map((x) => [x.exercise_id, { sets: x.sets, reps: x.reps, weight: x.target_weight_lb, rest: x.rest_seconds, note: x.note }])) };
    });
    const message = clean(b.message ?? run.client_message, 600);
    await store.setJSON(`assign/${id}`, pack.map((p) => ({ ...p, coachMessage: message, assignedAt: new Date().toISOString() })));
    if (message) {
      const inbox = (await store.get(`inbox/${id}`, { type: "json" })) || [];
      inbox.push({ id: `m-${Date.now()}`, at: new Date().toISOString(), from: "Your coach", text: message });
      await store.setJSON(`inbox/${id}`, inbox.slice(-20));
    }
    run.approvedAt = new Date().toISOString(); await store.setJSON(`runs/${id}`, runs);
    return json({ ok: true, sent: pack.length });
  }
  if (route === "reports" && req.method === "GET") {
    const { blobs } = await store.list({ prefix: "reports/" });
    const keys = blobs.map((b) => b.key).sort().reverse().slice(0, 8);
    const reports = (await Promise.all(keys.map((k) => store.get(k, { type: "json" })))).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json({ reports });
  }
  if (route === "checkin" && req.method === "POST") {
    const report = await runWeeklyCheckin({ store, notify, trigger: "manual" });
    return json(report);
  }
  if (route === "invite" && req.method === "GET") {
    return json({ code: String(env.GYM_CODE || "IRONDEMO").toUpperCase() });
  }
  if (route === "seed" && req.method === "POST") {
    const list = demoClients();
    for (const c of list) await store.setJSON(`clients/${c.clientId}`, c);
    return json({ ok: true, added: list.map((c) => c.name) });
  }
  if (route === "seed" && req.method === "DELETE") {
    const { blobs } = await store.list({ prefix: "clients/demo-" });
    for (const b of blobs) await store.delete(b.key);
    return json({ ok: true, removed: blobs.length });
  }
  return bad("Not found.", 404);
}
