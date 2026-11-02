// Demo clients with six weeks of realistic training, so the dashboard has something to show on day one.
const DAY = 864e5;

function rng(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }
const r5 = (x) => Math.round(x / 5) * 5;

function makeSession(dateMs, name, items, wid) {
  const at = new Date(dateMs).toISOString();
  return { name, startedAt: at, finishedAt: new Date(dateMs + 55 * 60e3).toISOString(), done: true, ...(wid ? { workoutId: wid } : {}),
    entries: items.map(([exId, sets]) => ({ exId, sets: sets.map((s) => ({ u: "lb", at, ...s })) })) };
}
const S = (w, r, n = 3) => Array.from({ length: n }, () => ({ w, r }));

export function demoClients(now = Date.now()) {
  const rand = rng(42);
  const out = [];

  // Maya: consistent 4-day upper/lower; bench stalled, squat climbing, almost no hamstring work
  {
    const sessions = {}; let k = 0;
    for (let w = 5; w >= 0; w--) {
      const base = now - w * 7 * DAY - 6 * DAY;
      const bench = w >= 3 ? 115 + (5 - w) * 5 : 125; // stalls at 125 for the last 3+ weeks
      const squat = 155 + (5 - w) * 10;
      const days = [[0, "Upper A", [["b_bench", S(bench, w < 3 ? 6 : 8)], ["b_row", S(95 + (5 - w) * 5, 10)], ["s_sdbp", S(30, 10)], ["a_push", S(40, 12)]]],
        [1, "Lower A", [["b_squat", S(squat, 5)], ["l_ext", S(70, 12)], ["l_scalf", S(120, 12)]]],
        [3, "Upper B", [["c_incbb", S(bench - 20, 8)], ["k_lpd", S(85 + (5 - w) * 5, 10)], ["s_lat", S(12, 15)], ["b_curl", S(20, 12)]]],
        [4, "Lower B", [["l_hthrust", S(135 + (5 - w) * 10, 10)], ["l_lp", S(250 + (5 - w) * 20, 10)], ["b_plank", [{ w: 0, r: 60 }, { w: 0, r: 60 }]]]]];
      for (const [d, n, items] of days) sessions[`m${k++}`] = makeSession(base + d * DAY + 17 * 3600e3, n, items);
    }
    out.push({ clientId: "demo-maya", name: "Maya Chen", profile: { goal: "Build muscle", daysPerWeek: 4, experience: "Intermediate (2 years)", equipment: "Full commercial gym", notes: "" }, data: { sessions, exercises: {}, unit: "lb" } });
  }

  // Jordan: fat loss, 3 days with cardio, has not trained in 9 days
  {
    const sessions = {}; let k = 0;
    for (let w = 5; w >= 1; w--) {
      const base = now - w * 7 * DAY - 6 * DAY;
      for (const d of [0, 2, 4]) {
        const run = 1500 + (5 - w) * 60 + Math.round(rand() * 60);
        sessions[`j${k++}`] = makeSession(base + d * DAY + 7 * 3600e3, "Full Body + Cardio", [
          ["l_gob", S(35 + (5 - w) * 5, 12)], ["c_mcp", S(70 + (5 - w) * 5, 12)], ["k_msr", S(80, 12)],
          ["r_tread", [{ w: 0, r: run, d: Math.round(run * 2.9), cardio: 1, du: "road", pk: "pace", inc: 2, hr: 148 + Math.round(rand() * 8), cal: Math.round(run / 5.5) }]]]);
      }
    }
    out.push({ clientId: "demo-jordan", name: "Jordan Ruiz", profile: { goal: "Lose fat and get fitter", daysPerWeek: 3, experience: "Beginner (6 months)", equipment: "Full commercial gym", notes: "Mild lower-back tightness after deadlifts last month" }, data: { sessions, exercises: {}, unit: "lb" } });
  }

  // Alex: 4 days a week, heavy on chest and arms, very little back or legs
  {
    const sessions = {}; let k = 0;
    for (let w = 3; w >= 0; w--) {
      const base = now - w * 7 * DAY - 5 * DAY;
      for (const d of [0, 1, 3, 4]) {
        if (w === 0 && d > 3) continue;
        sessions[`a${k++}`] = makeSession(base + d * DAY + 18 * 3600e3, d % 2 ? "Arms" : "Chest", d % 2
          ? [["b_curl", S(35, 10, 4)], ["a_push", S(60, 12, 4)], ["a_hammer", S(35, 10)], ["a_skull", S(60, 10)], ["s_lat", S(20, 15)]]
          : [["b_bench", S(r5(185 + (3 - w) * 5), 6, 4)], ["c_incbb", S(155, 8, 4)], ["c_dbfly", S(35, 12)], ["c_cross", S(30, 15)], ["c_dip", S(0, 12)]]);
      }
    }
    out.push({ clientId: "demo-alex", name: "Alex Kim", profile: { goal: "Get stronger and look better", daysPerWeek: 4, experience: "Intermediate (3 years)", equipment: "Full commercial gym", notes: "" }, data: { sessions, exercises: {}, unit: "lb" } });
  }

  // Sam: new client, two weeks in, 3 days a week
  {
    const sessions = {}; let k = 0;
    for (let w = 1; w >= 0; w--) {
      const base = now - w * 7 * DAY - 6 * DAY;
      for (const d of [0, 2, 4]) {
        sessions[`s${k++}`] = makeSession(base + d * DAY + 12 * 3600e3, "Full Body", [["l_gob", S(25 + (1 - w) * 5, 10)], ["c_pu", S(0, 8 + (1 - w) * 2)], ["k_lpd", S(70, 10)], ["l_bridge", S(0, 15)]]);
      }
    }
    out.push({ clientId: "demo-sam", name: "Sam Patel", profile: { goal: "Learn the basics and build strength", daysPerWeek: 3, experience: "New to lifting", equipment: "Full commercial gym", notes: "" }, data: { sessions, exercises: {}, unit: "lb" } });
  }

  return out.map((c) => ({ ...c, demo: true, updatedAt: new Date(now).toISOString() }));
}
