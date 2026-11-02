// AI Coach agent: the LLM decides which tools to call, in what order, until it has built a program.
import { buildLibrary, trainingSummary, muscleBalance, findPlateaus, searchExercises, MUSCLES } from "./analysis.mjs";

const MUSCLE_IDS = Object.keys(MUSCLES).concat("cardio");
const EQUIPMENT = ["Barbell", "Dumbbell", "Machine", "Plate-loaded", "Smith machine", "Cable", "Bodyweight", "Kettlebell", "Band", "Other"];

export const TOOLS = [
  { name: "get_client_profile", description: "Read the client's goal, experience, training days per week, available equipment and any injury notes from their trainer.",
    input_schema: { type: "object", properties: {} } },
  { name: "get_training_summary", description: "Sessions per week, adherence to the planned days, and recent best sets with estimated 1RM change for every exercise the client has done.",
    input_schema: { type: "object", properties: { weeks: { type: "integer", minimum: 1, maximum: 16, description: "How many weeks back to look. Default 6." } } } },
  { name: "get_muscle_balance", description: "Hard sets per week for 19 muscles over a recent window, with under- and over-trained muscles listed.",
    input_schema: { type: "object", properties: { days: { type: "integer", minimum: 7, maximum: 56, description: "Window in days. Default 14." } } } },
  { name: "find_plateaus", description: "Lifts whose best set has not improved in the last 3 sessions.",
    input_schema: { type: "object", properties: {} } },
  { name: "search_exercises", description: "Search the gym's exercise library. Use it to get valid exercise_id values before creating workouts.",
    input_schema: { type: "object", properties: {
      muscle: { type: "string", enum: MUSCLE_IDS, description: "Main muscle worked" },
      equipment: { type: "string", enum: EQUIPMENT },
      query: { type: "string", description: "Words in the exercise name, e.g. 'row' or 'press'" },
      limit: { type: "integer", minimum: 1, maximum: 25 } } } },
  { name: "create_workout", description: "Save one workout day of next week's program as a draft for the trainer to review. Call once per training day.",
    input_schema: { type: "object", required: ["name", "exercises"], properties: {
      name: { type: "string", description: "Short day name, e.g. 'Upper A'" },
      focus: { type: "string", description: "One line on what this day is for" },
      exercises: { type: "array", minItems: 2, maxItems: 9, items: { type: "object", required: ["exercise_id", "sets", "reps"], properties: {
        exercise_id: { type: "string" }, sets: { type: "integer", minimum: 1, maximum: 6 },
        reps: { type: "string", description: "e.g. '8-10', '5', '30-45s', '20 min'" },
        target_weight_lb: { type: "number", description: "Suggested load in lb, based on recent best sets. Omit if unknown." },
        rest_seconds: { type: "integer", minimum: 0, maximum: 300 },
        superset_with_next: { type: "boolean" }, note: { type: "string" } } } } } } },
  { name: "finish", description: "Finish the run once every training day has been created.",
    input_schema: { type: "object", required: ["coach_note", "client_message"], properties: {
      coach_note: { type: "string", description: "For the trainer: what the data showed, what you changed and why, and anything the trainer should check in person. 4-8 short bullet lines." },
      client_message: { type: "string", description: "A short, encouraging message to the client about next week (2-3 sentences)." },
      flags: { type: "array", items: { type: "string" }, description: "Concerns needing a human: injuries, very low adherence, missing data." } } } },
];

export const SYSTEM = `You are an assistant strength coach working for a gym's personal trainers.
Your job: plan next week's training for one client and hand it to their trainer for review.

Work like a coach:
1. Read the client profile first.
2. Look at their training data (summary, muscle balance, plateaus) before deciding anything.
3. Decide what next week needs: progress lifts that are moving, change rep ranges or swap variations on lifts that have stalled, add volume for under-trained muscles, and keep the number of training days equal to the profile.
4. Use search_exercises to pick exercises that match the client's equipment. Only use exercise_id values returned by search_exercises or seen in their history.
5. Call create_workout once for each training day. Suggest target_weight_lb from recent best sets (about 2-5% more for lifts that are progressing; the same or 5-10% less with more reps for stalled lifts).
6. Call finish with a note for the trainer and a message for the client.

Rules: never diagnose or work around pain or injury — list it in flags for the trainer. If there is very little data, say so in flags and write a conservative beginner program. Keep each workout to 4-8 exercises and about 60 minutes.`;

const err = (message) => ({ error: message });

// Runs one tool against the client's record. `state` collects drafts and the final note.
export function runTool(name, input, client, state, now = Date.now()) {
  const data = { ...(client.data || {}), profile: client.profile };
  const lib = state.lib || (state.lib = buildLibrary(client.data?.exercises));
  switch (name) {
    case "get_client_profile":
      return { name: client.name, unit_preference: client.data?.unit || "lb", ...client.profile };
    case "get_training_summary":
      return trainingSummary(data, lib, { weeks: input.weeks || 6, now });
    case "get_muscle_balance":
      return muscleBalance(data, lib, { days: input.days || 14, now });
    case "find_plateaus":
      return findPlateaus(data, lib, { now });
    case "search_exercises": {
      const r = searchExercises(lib, input);
      return r.length ? { results: r } : { results: [], hint: "Nothing matched. Try fewer filters or a different muscle." };
    }
    case "create_workout": {
      const bad = (input.exercises || []).filter((x) => !lib[x.exercise_id]).map((x) => x.exercise_id);
      if (bad.length) return err(`Unknown exercise_id: ${bad.join(", ")}. Use search_exercises to find valid ids, then call create_workout again.`);
      if ((input.exercises || []).length < 2) return err("A workout needs at least 2 exercises.");
      const w = {
        name: String(input.name || "Workout").slice(0, 40), focus: String(input.focus || "").slice(0, 160),
        exercises: input.exercises.map((x) => ({
          exercise_id: x.exercise_id, name: lib[x.exercise_id].name, sets: Math.max(1, Math.min(6, x.sets | 0 || 3)),
          reps: String(x.reps || "8-10").slice(0, 20), target_weight_lb: x.target_weight_lb > 0 ? Math.round(x.target_weight_lb) : null,
          rest_seconds: x.rest_seconds ?? lib[x.exercise_id].rest ?? 90, superset_with_next: !!x.superset_with_next, note: (x.note || "").slice(0, 140),
        })),
      };
      const i = state.workouts.findIndex((d) => d.name.toLowerCase() === w.name.toLowerCase());
      if (i >= 0) state.workouts[i] = w; else state.workouts.push(w);
      return { saved: w.name, workouts_so_far: state.workouts.map((d) => d.name), days_needed: +client.profile?.daysPerWeek || 3 };
    }
    case "finish":
      if (!state.workouts.length) return err("Create at least one workout with create_workout before finishing.");
      state.final = { coach_note: input.coach_note || "", client_message: input.client_message || "", flags: input.flags || [] };
      return { ok: true };
    default:
      return err(`Unknown tool ${name}`);
  }
}

const brief = (name, input, out) => {
  if (out?.error) return `Error: ${out.error}`;
  switch (name) {
    case "get_client_profile": return `${out.goal || "No goal set"} · ${out.daysPerWeek || "?"} days/week · ${out.experience || ""}`;
    case "get_training_summary": return `${out.total_sessions} sessions in ${out.weeks} weeks (${out.adherence_pct}% of plan), ${out.exercises.length} exercises`;
    case "get_muscle_balance": return out.under_trained.length ? `Under-trained: ${out.under_trained.map((m) => MUSCLES[m] || m).join(", ")}` : "No under-trained muscles";
    case "find_plateaus": return out.plateaus.length ? `Stalled: ${out.plateaus.map((p) => p.name).join(", ")}` : "No stalled lifts";
    case "search_exercises": return `${out.results.length} matches${input.muscle ? ` for ${MUSCLES[input.muscle] || input.muscle}` : ""}${input.equipment ? ` (${input.equipment})` : ""}${input.query ? ` "${input.query}"` : ""}`;
    case "create_workout": return `Drafted ${out.saved} (${input.exercises.length} exercises)`;
    case "finish": return "Wrote trainer note and client message";
    default: return "";
  }
};

/** callModel({system, tools, messages}) must return an Anthropic Messages response. */
export async function runCoachAgent(client, callModel, { maxTurns = 14, deadlineMs = 52000, now = Date.now() } = {}) {
  const started = Date.now();
  const state = { workouts: [], final: null };
  const trace = [];
  const messages = [{ role: "user", content: `Plan next week for client "${client.name}". Trainer's request: ${client.request || "Build next week's program from their recent training."}` }];
  let stopped = "done";
  for (let turn = 0; turn < maxTurns; turn++) {
    if (Date.now() - started > deadlineMs) { stopped = "time"; break; }
    const res = await callModel({ system: SYSTEM, tools: TOOLS, messages });
    messages.push({ role: "assistant", content: res.content });
    const thoughts = res.content.filter((b) => b.type === "text").map((b) => b.text.trim()).filter(Boolean).join(" ");
    if (thoughts) trace.push({ type: "thought", text: thoughts.slice(0, 600) });
    const calls = res.content.filter((b) => b.type === "tool_use");
    if (!calls.length) { stopped = state.final ? "done" : "no_finish"; break; }
    const results = [];
    for (const c of calls) {
      let out;
      try { out = runTool(c.name, c.input || {}, client, state, now); } catch (e) { out = err(String(e.message || e)); }
      trace.push({ type: "tool", tool: c.name, input: c.input, result: brief(c.name, c.input || {}, out), ok: !out?.error });
      results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out).slice(0, 12000), ...(out?.error ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
    if (state.final) break;
  }
  if (!state.final && state.workouts.length) {
    state.final = { coach_note: "The agent stopped before writing its note. Review the drafted workouts carefully.", client_message: "", flags: [stopped === "time" ? "Run hit the time limit" : "Run ended early"] };
  }
  return { ok: !!state.workouts.length, stopped, steps: trace.filter((t) => t.type === "tool").length, trace, workouts: state.workouts, ...(state.final || {}), seconds: Math.round((Date.now() - started) / 100) / 10 };
}
