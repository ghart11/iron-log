// Local stand-in for Netlify: serves public/ and the API with in-memory storage and a scripted model.
// node test/dev-server.mjs  →  http://localhost:8888  (coach PIN 1234, gym code IRONDEMO)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { handleSync, handleCoach } from "../netlify/lib/api.mjs";

const mem = new Map();
const store = {
  async get(k) { return mem.has(k) ? structuredClone(mem.get(k)) : null; },
  async setJSON(k, v) { mem.set(k, structuredClone(v)); },
  async delete(k) { mem.delete(k); },
  async list({ prefix = "" } = {}) { return { blobs: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
};
// Scripted stand-in for Claude: gathers data, searches, drafts one workout per training day, finishes.
let calls = 0;
async function fakeModel({ messages }) {
  calls++;
  const n = messages.filter((m) => m.role === "assistant").length;
  const results = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === "tool_result");
  const profile = JSON.parse(results[0]?.content || "{}");
  const days = +profile.daysPerWeek || 3;
  if (n === 0) return { content: [{ type: "text", text: "Starting with the client's profile." }, { type: "tool_use", id: "a", name: "get_client_profile", input: {} }] };
  if (n === 1) return { content: [{ type: "tool_use", id: "b", name: "get_training_summary", input: { weeks: 6 } }, { type: "tool_use", id: "c", name: "find_plateaus", input: {} }, { type: "tool_use", id: "d", name: "get_muscle_balance", input: { days: 14 } }] };
  if (n === 2) return { content: [{ type: "text", text: "Bench has stalled and hamstrings are under-trained; I'll look for options." }, { type: "tool_use", id: "e", name: "search_exercises", input: { muscle: "hamstrings" } }, { type: "tool_use", id: "f", name: "search_exercises", input: { muscle: "chest", equipment: "Dumbbell" } }] };
  if (n < 3 + days) {
    const k = n - 3, upper = k % 2 === 0;
    return { content: [{ type: "tool_use", id: "w" + k, name: "create_workout", input: { name: `${upper ? "Upper" : "Lower"} ${String.fromCharCode(65 + Math.floor(k / 2))}`, focus: upper ? "Press and pull, swap stalled bench for DB press" : "Squat pattern plus extra hamstring volume",
      exercises: upper ? [{ exercise_id: "c_dbb", sets: 4, reps: "6-8", target_weight_lb: 50, rest_seconds: 150 }, { exercise_id: "b_row", sets: 3, reps: "8-10", target_weight_lb: 115, superset_with_next: true }, { exercise_id: "s_lat", sets: 3, reps: "12-15", target_weight_lb: 15 }, { exercise_id: "a_push", sets: 3, reps: "10-12" }]
        : [{ exercise_id: "b_squat", sets: 4, reps: "5", target_weight_lb: 210, rest_seconds: 180 }, { exercise_id: "b_rdl", sets: 3, reps: "8", target_weight_lb: 135 }, { exercise_id: "l_lcurl", sets: 3, reps: "10-12", superset_with_next: true }, { exercise_id: "l_scalf", sets: 3, reps: "12" }] } }] };
  }
  return { content: [{ type: "tool_use", id: "z", name: "finish", input: { coach_note: "- Bench press stalled for 3 weeks: switched to dumbbell bench at 6-8 reps\n- Hamstrings under 6 sets/week: added RDL and lying leg curl\n- Squat still climbing: +5 lb", client_message: "Great work staying consistent! This week we're switching up your pressing and adding some hamstring work.", flags: [] } }] };
}
const env = { GYM_CODE: "IRONDEMO", COACH_PIN: "1234" };
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = async (r) => { res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); };
  const chunks = []; for await (const c of req) chunks.push(c);
  const request = new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
  if (url.pathname === "/api/sync") return send(await handleSync(request, { store, env }));
  if (url.pathname.startsWith("/api/coach/")) return send(await handleCoach(request, { store, env, path: url.pathname, callModel: fakeModel, notify: async () => ({ sent: ["dev log"] }) }));
  try { const f = join("public", url.pathname === "/" ? "index.html" : url.pathname); res.writeHead(200, { "Content-Type": types[extname(f)] || "application/octet-stream" }); res.end(await readFile(f)); }
  catch { res.writeHead(404); res.end("Not found"); }
}).listen(8888, () => console.log("Iron Log dev server on http://localhost:8888"));
