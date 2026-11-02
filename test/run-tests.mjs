// node test/run-tests.mjs — exercises the server logic without Netlify or a real model.
import assert from "node:assert/strict";
import { handleSync, handleCoach } from "../netlify/lib/api.mjs";
import { demoClients } from "../netlify/lib/seed.mjs";
import { buildLibrary, findPlateaus, muscleBalance, weeklyStatus, searchExercises } from "../netlify/lib/analysis.mjs";

function memStore() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : null; },
    async setJSON(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = "" } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
  };
}
const env = { GYM_CODE: "IRONDEMO", COACH_PIN: "4321" };
const req = (path, method, body, headers = {}) => new Request("https://x.test" + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
const coach = (store, path, method, body, extra = {}) => handleCoach(req(path, method, body, { "x-coach-pin": "4321" }), { store, env, path, ...extra });
let passed = 0; const ok = (name) => { passed++; console.log("  ✓", name); };

// --- analysis
const clients = demoClients();
const maya = clients.find((c) => c.name === "Maya Chen"), lib = buildLibrary({});
const pl = findPlateaus(maya.data, lib);
assert.ok(pl.plateaus.some((p) => p.exercise_id === "b_bench"), "Maya's bench should be flagged as stalled");
ok("plateau detection flags Maya's bench press");
const bal = muscleBalance(maya.data, lib, { days: 14 });
assert.ok(bal.under_trained.includes("hamstrings"), "Maya should be low on hamstrings");
ok("muscle balance flags Maya's hamstrings");
const st = clients.map((c) => weeklyStatus(c));
assert.equal(st.find((s) => s.name === "Jordan Ruiz").status, "at_risk"); ok("Jordan (9 days off) is at risk");
assert.ok(st.find((s) => s.name === "Alex Kim").neglected.length >= 2); ok("Alex's neglected back/legs are flagged");
assert.ok(searchExercises(lib, { muscle: "hamstrings", equipment: "Machine" }).some((e) => e.exercise_id === "l_lcurl")); ok("exercise search by muscle + equipment");

// --- sync
const store = memStore();
let r = await handleSync(req("/api/sync", "POST", { code: "wrong", clientId: "abcdefgh12", name: "Test", data: {} }), { store, env });
assert.equal(r.status, 403); ok("sync rejects a wrong gym code");
r = await handleSync(req("/api/sync", "POST", { code: "irondemo", clientId: "abcdefgh12", name: "Test Client", profile: { goal: "Strength", daysPerWeek: 3 }, data: { sessions: maya.data.sessions, exercises: { x1: { name: "My Ex", imgData: "data:image/png;base64,AAAA" } } } }), { store, env });
assert.equal(r.status, 200); const sj = await r.json(); assert.deepEqual(sj.assigned, []);
assert.ok(!JSON.stringify(store.m.get("clients/abcdefgh12")).includes("base64")); ok("sync saves the log and strips photos");

// --- coach auth + seed
r = await handleCoach(req("/api/coach/clients", "GET"), { store, env, path: "/api/coach/clients" }); assert.equal(r.status, 401); ok("coach API needs the PIN");
r = await coach(store, "/api/coach/seed", "POST"); assert.equal((await r.json()).added.length, 4); ok("demo clients load");
r = await coach(store, "/api/coach/clients", "GET"); const cl = (await r.json()).clients; assert.equal(cl.length, 5); ok("client list returns all 5 clients with status");

// --- agent with a scripted model: profile → summary → plateaus → balance → bad id → search → 4 workouts → finish
const script = [
  [{ type: "text", text: "I'll start with Maya's profile." }, { type: "tool_use", id: "t1", name: "get_client_profile", input: {} }],
  [{ type: "tool_use", id: "t2", name: "get_training_summary", input: { weeks: 6 } }, { type: "tool_use", id: "t3", name: "find_plateaus", input: {} }, { type: "tool_use", id: "t4", name: "get_muscle_balance", input: {} }],
  [{ type: "tool_use", id: "t5", name: "create_workout", input: { name: "Upper A", exercises: [{ exercise_id: "made_up", sets: 3, reps: "8" }, { exercise_id: "b_row", sets: 3, reps: "8" }] } }],
  [{ type: "tool_use", id: "t6", name: "search_exercises", input: { muscle: "hamstrings" } }],
  ...["Upper A", "Lower A", "Upper B", "Lower B"].map((n, i) => [{ type: "tool_use", id: `w${i}`, name: "create_workout", input: { name: n, focus: "test", exercises: [{ exercise_id: i % 2 ? "b_rdl" : "c_dbb", sets: 3, reps: "6-8", target_weight_lb: 120 }, { exercise_id: i % 2 ? "l_lcurl" : "b_row", sets: 3, reps: "10-12", superset_with_next: true }, { exercise_id: "a_push", sets: 2, reps: "12" }] } }]),
  [{ type: "tool_use", id: "f", name: "finish", input: { coach_note: "- Bench stalled 3 weeks: switched to DB bench 6-8\n- Added hamstring work", client_message: "Great consistency, Maya!", flags: [] } }],
];
const seen = [];
let turn = 0;
const fakeModel = async ({ messages, tools, system }) => {
  assert.ok(system.includes("strength coach") && tools.length === 7);
  const last = messages[messages.length - 1];
  if (Array.isArray(last.content)) seen.push(...last.content.filter((c) => c.type === "tool_result"));
  return { content: script[turn++], stop_reason: "tool_use" };
};
r = await coach(store, "/api/coach/agent", "POST", { clientId: "demo-maya", request: "Next week please" }, { callModel: fakeModel });
const run = await r.json();
assert.equal(r.status, 200, JSON.stringify(run));
assert.equal(run.workouts.length, 4); assert.equal(run.stopped, "done"); assert.ok(run.coach_note.includes("Bench"));
assert.ok(seen.some((x) => x.is_error && x.content.includes("made_up")), "bad exercise id should come back as a tool error");
assert.ok(run.trace.some((t) => t.tool === "find_plateaus" && t.result.includes("Bench Press")));
ok(`agent ran ${run.steps} tool steps, recovered from a bad exercise id, drafted 4 workouts`);

r = await coach(store, "/api/coach/agent", "POST", { clientId: "demo-maya" }); assert.equal(r.status, 503); ok("agent reports a clear error when no model is configured");

// --- trainer approves → client receives on next sync
r = await coach(store, "/api/coach/assign", "POST", { clientId: "demo-maya", runId: run.id });
assert.equal((await r.json()).sent, 4);
r = await handleSync(req("/api/sync", "POST", { code: "IRONDEMO", clientId: "demo-maya", name: "Maya Chen", profile: maya.profile, data: maya.data }), { store, env });
const back = await r.json();
assert.equal(back.assigned.length, 4); assert.deepEqual(back.assigned[0].groups, [null, "g1", "g1"]); assert.equal(back.assigned[0].plan.c_dbb.weight, 120);
assert.ok(back.inbox.some((m) => m.text.includes("Great consistency"))); ok("approved program and message reach the client on sync");
r = await handleSync(req("/api/sync", "POST", { code: "IRONDEMO", clientId: "demo-maya", name: "Maya Chen", profile: maya.profile, data: { sessions: {} } }), { store, env });
assert.ok(Object.keys(store.m.get("clients/demo-maya").data.sessions).length > 10); ok("a sync from an empty new device keeps the stored history");

// --- automation
const notes = [];
r = await coach(store, "/api/coach/checkin", "POST", null, { notify: async (n) => { notes.push(n); return { sent: ["test channel"] }; } });
const rep = await r.json();
assert.equal(rep.steps.length, 6); assert.ok(rep.counts.at_risk >= 1); assert.equal(notes.length, 1); assert.ok(notes[0].subject.includes("at risk"));
assert.equal(rep.clients[0].status, "at_risk"); ok(`weekly check-in ran 6 steps: ${rep.steps.map((s) => s.name).join(" → ")}`);
const jordanInbox = store.m.get("inbox/demo-jordan"); assert.ok(jordanInbox?.[0]?.text.includes("missed you")); ok("at-risk client gets a nudge in their inbox");
r = await coach(store, "/api/coach/reports", "GET"); assert.equal((await r.json()).reports.length, 1); ok("report is saved and listed");

console.log(`\n${passed} checks passed`);
