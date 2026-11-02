// Pure functions over a client's Iron Log data. No network, no storage — easy to test.
import LIB from "./library.mjs";

export const MUSCLES = Object.fromEntries(LIB.musc);
const DAY = 864e5;
const KG_TO_LB = 2.20462;

const parseMW = (s) => {
  const [p, q] = (s || "|").split("|");
  return { p: (p || "").split(",").filter(Boolean), s: (q || "").split(",").filter(Boolean) };
};

// Built-in exercises merged with the client's own edits and custom exercises.
export function buildLibrary(custom = {}) {
  const lib = {};
  for (const b of LIB.builtin) lib[b.id] = { ...b, builtin: true };
  for (const [id, e] of Object.entries(custom || {})) {
    if (!e || e.deleted) { delete lib[id]; continue; }
    lib[id] = { ...(lib[id] || {}), ...e, id };
  }
  for (const e of Object.values(lib)) {
    e.cardio = !!(e.cardio || LIB.cardio[e.id] || (e.muscle === "Cardio" && e.metric === "time"));
    e.mw = e.muscles && Array.isArray(e.muscles.p) ? { p: e.muscles.p, s: e.muscles.s || [] }
      : LIB.mw[e.id] != null ? parseMW(LIB.mw[e.id]) : parseMW(LIB.mwGroup[e.muscle] || "");
    delete e.imgData;
  }
  return lib;
}

const toLb = (w, u) => (u === "kg" ? (+w || 0) * KG_TO_LB : +w || 0);
export const e1rm = (w, r) => (w > 0 && r > 0 ? (r === 1 ? w : w * (1 + r / 30)) : 0);
const round = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d;

export function doneSessions(data) {
  return Object.entries(data?.sessions || {})
    .map(([id, s]) => ({ ...s, id }))
    .filter((s) => s.done && s.startedAt)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

// Best working set per session for each exercise, oldest first.
function exerciseHistory(data, lib) {
  const hist = {};
  for (const s of doneSessions(data)) {
    for (const en of s.entries || []) {
      const e = lib[en.exId];
      if (!e) continue;
      const sets = (en.sets || []).filter((x) => !x.drop);
      if (!sets.length) continue;
      let best = null;
      for (const st of sets) {
        const w = toLb(st.w, st.u), r = +st.r || 0;
        const score = e.cardio ? (st.d || 0) + r / 1e4 : e.metric === "time" ? r : e1rm(w, r) || w + r / 1000;
        if (!best || score > best.score) best = { w: round(w, 1), r, score, d: st.d, secs: e.cardio || e.metric === "time" ? r : undefined };
      }
      (hist[en.exId] ||= []).push({ date: s.startedAt.slice(0, 10), sets: sets.length, best });
    }
  }
  return hist;
}

export function trainingSummary(data, lib, { weeks = 6, now = Date.now() } = {}) {
  const since = now - weeks * 7 * DAY;
  const sessions = doneSessions(data).filter((s) => new Date(s.startedAt).getTime() >= since);
  const target = +data?.profile?.daysPerWeek || 3;
  const perWeek = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const a = now - (w + 1) * 7 * DAY, b = now - w * 7 * DAY;
    perWeek.push(sessions.filter((s) => { const t = new Date(s.startedAt).getTime(); return t >= a && t < b; }).length);
  }
  const hist = exerciseHistory(data, lib);
  const exercises = Object.entries(hist)
    .map(([id, h]) => {
      const recent = h.filter((x) => new Date(x.date).getTime() >= since);
      if (!recent.length) return null;
      const e = lib[id], first = recent[0].best, last = recent[recent.length - 1].best;
      const change = e.cardio || e.metric === "time" ? null : first.score > 0 ? round((last.score / first.score - 1) * 100, 1) : null;
      return {
        exercise_id: id, name: e.name, muscle: e.muscle, times_done: recent.length, last_done: recent[recent.length - 1].date,
        recent_best_sets: recent.slice(-4).map((x) => ({ date: x.date, sets: x.sets, best: e.cardio ? `${round((x.best.secs || 0) / 60, 1)} min${x.best.d ? `, ${round(x.best.d)} m` : ""}` : e.metric === "time" ? `${x.best.r}s` : `${x.best.w} lb x ${x.best.r}` })),
        est_1rm_change_pct: change,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.times_done - a.times_done);
  return {
    weeks, target_sessions_per_week: target, sessions_per_week_oldest_first: perWeek,
    total_sessions: sessions.length, adherence_pct: round((sessions.length / (target * weeks)) * 100),
    exercises,
  };
}

export function muscleBalance(data, lib, { days = 14, now = Date.now() } = {}) {
  const since = now - days * DAY, load = {};
  for (const m of Object.keys(MUSCLES)) load[m] = 0;
  for (const s of doneSessions(data)) {
    if (new Date(s.startedAt).getTime() < since) continue;
    for (const en of s.entries || []) {
      const e = lib[en.exId];
      if (!e || e.cardio) continue;
      const n = (en.sets || []).length;
      for (const m of e.mw.p) if (m in load) load[m] += n;
      for (const m of e.mw.s) if (m in load) load[m] += n / 2;
    }
  }
  const weeks = days / 7;
  const rows = Object.entries(load).map(([m, v]) => ({ muscle: m, label: MUSCLES[m], sets_per_week: round(v / weeks, 1) }));
  return {
    days,
    under_trained: rows.filter((r) => r.sets_per_week < 6).map((r) => r.muscle),
    over_trained: rows.filter((r) => r.sets_per_week > 22).map((r) => r.muscle),
    sets_per_week: rows,
    guide: "10-20 hard sets per muscle per week is a common hypertrophy target; under 6 is low.",
  };
}

// Lifts whose best set has not improved over the last 3 exposures.
export function findPlateaus(data, lib, { now = Date.now() } = {}) {
  const hist = exerciseHistory(data, lib), out = [];
  for (const [id, h] of Object.entries(hist)) {
    const e = lib[id];
    if (!e || e.cardio || e.metric === "time" || h.length < 4) continue;
    if (now - new Date(h[h.length - 1].date).getTime() > 42 * DAY) continue;
    const prior = Math.max(...h.slice(0, -3).map((x) => x.best.score));
    const recent = Math.max(...h.slice(-3).map((x) => x.best.score));
    if (recent <= prior * 1.005) {
      out.push({ exercise_id: id, name: e.name, muscle: e.muscle, sessions_without_progress: 3,
        best_ever: `${h.find((x) => x.best.score === prior)?.best.w} lb x ${h.find((x) => x.best.score === prior)?.best.r}`,
        last_three: h.slice(-3).map((x) => `${x.best.w} lb x ${x.best.r}`) });
    }
  }
  return { plateaus: out, rule: "Flagged when the best set of the last 3 sessions does not beat the earlier best." };
}

export function searchExercises(lib, { muscle, equipment, query, limit = 12 } = {}) {
  const q = (query || "").toLowerCase();
  return Object.values(lib)
    .filter((e) => {
      if (muscle === "cardio") return e.cardio;
      if (e.cardio) return !!q && !muscle;
      if (!muscle) return true;
      return e.mw.p.includes(muscle) || (e.muscle || "").toLowerCase() === muscle.toLowerCase();
    })
    .filter((e) => !equipment || (e.equip || "").toLowerCase() === equipment.toLowerCase())
    .filter((e) => !q || e.name.toLowerCase().includes(q))
    .slice(0, Math.min(25, limit || 12))
    .map((e) => ({ exercise_id: e.id, name: e.name, equipment: e.equip, main_muscles: e.mw.p, helper_muscles: e.mw.s, default_rest_s: e.rest, tracks: e.cardio ? "cardio" : e.metric }));
}

// Used by the weekly automation.
export function weeklyStatus(client, { now = Date.now() } = {}) {
  const data = client.data || {}, lib = buildLibrary(data.exercises);
  const sessions = doneSessions(data);
  const target = +client.profile?.daysPerWeek || 3;
  const week = sessions.filter((s) => now - new Date(s.startedAt).getTime() < 7 * DAY);
  const last = sessions[sessions.length - 1];
  const daysSince = last ? Math.floor((now - new Date(last.startedAt).getTime()) / DAY) : null;
  // PRs this week: a set beating every earlier best for that exercise
  const best = {}, prs = [];
  for (const s of sessions) {
    for (const en of s.entries || []) {
      const e = lib[en.exId];
      if (!e || e.cardio || e.metric === "time") continue;
      for (const st of en.sets || []) {
        if (st.drop) continue;
        const v = e1rm(toLb(st.w, st.u), +st.r);
        if (best[en.exId] != null && v > best[en.exId] * 1.001 && now - new Date(s.startedAt).getTime() < 7 * DAY) prs.push(`${e.name} ${round(toLb(st.w, st.u))} lb x ${st.r}`);
        best[en.exId] = Math.max(best[en.exId] || 0, v);
      }
    }
  }
  const bal = muscleBalance({ ...data, profile: client.profile }, lib, { days: 14, now });
  const big = ["chest", "lats", "upperBack", "quads", "hamstrings", "glutes", "frontDelt", "sideDelt"];
  // The check-in flags only clearly neglected muscles (under 4 sets a week); the AI Coach plans against the stricter 6.
  const neglected = sessions.length ? bal.sets_per_week.filter((r) => big.includes(r.muscle) && r.sets_per_week < 4).map((r) => r.label) : [];
  const adherence = round((week.length / target) * 100);
  let status = "on_track";
  const reasons = [];
  if (!sessions.length) { status = "at_risk"; reasons.push("No workouts logged yet"); }
  else if (daysSince >= 7) { status = "at_risk"; reasons.push(`No workout in ${daysSince} days`); }
  else if (adherence < 50) { status = "at_risk"; reasons.push(`${week.length} of ${target} planned sessions this week`); }
  else if (adherence < 100) { status = "slipping"; reasons.push(`${week.length} of ${target} planned sessions this week`); }
  if (neglected.length >= 3 && status === "on_track") { status = "slipping"; }
  if (neglected.length) reasons.push(`Low volume: ${neglected.slice(0, 3).join(", ")}`);
  return {
    clientId: client.clientId, name: client.name, goal: client.profile?.goal || "",
    sessions_this_week: week.length, target, adherence_pct: adherence, days_since_last: daysSince,
    prs_this_week: [...new Set(prs)].slice(0, 5), neglected, status, reasons,
  };
}
