// Weekly check-in automation. Runs on a schedule (Mondays) or from the coach dashboard's "Run now".
// Step 1 collect client logs → 2 score each client → 3 classify and prioritise → 4 save report
// → 5 send nudges to at-risk clients → 6 notify the coach.
import { weeklyStatus } from "./analysis.mjs";

export async function runWeeklyCheckin({ store, now = Date.now(), notify = async () => ({ sent: [] }), trigger = "schedule" }) {
  const steps = [];
  const t0 = Date.now();
  const step = (name, detail) => steps.push({ name, detail, ms: Date.now() - t0 });

  // 1. Collect
  const { blobs } = await store.list({ prefix: "clients/" });
  const clients = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
  step("Collected client logs", `${clients.length} client${clients.length === 1 ? "" : "s"}`);

  // 2. Score
  const rows = clients.map((c) => weeklyStatus(c, { now }));
  step("Scored attendance, PRs and muscle balance", rows.map((r) => `${r.name}: ${r.sessions_this_week}/${r.target}`).join(", ") || "nothing to score");

  // 3. Classify
  const order = { at_risk: 0, slipping: 1, on_track: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status] || (b.days_since_last ?? 99) - (a.days_since_last ?? 99));
  const counts = { at_risk: 0, slipping: 0, on_track: 0 };
  rows.forEach((r) => counts[r.status]++);
  step("Flagged clients", `${counts.at_risk} at risk, ${counts.slipping} slipping, ${counts.on_track} on track`);

  // 4. Save
  const date = new Date(now).toISOString().slice(0, 10);
  const report = { id: `${date}-${now}`, date, createdAt: new Date(now).toISOString(), trigger, counts, clients: rows, steps };
  await store.setJSON(`reports/${report.id}`, report);
  step("Saved weekly report", `reports/${report.id}`);

  // 5. Nudge at-risk clients (shown in their app on next sync)
  let nudged = 0;
  for (const r of rows.filter((x) => x.status === "at_risk")) {
    const key = `inbox/${r.clientId}`;
    const inbox = (await store.get(key, { type: "json" })) || [];
    const first = (r.name || "there").split(" ")[0];
    inbox.push({ id: `n-${now}-${r.clientId}`, at: new Date(now).toISOString(), from: "Your coach",
      text: r.days_since_last == null ? `Hi ${first}, welcome to Iron Log! Log your first workout this week and I'll build your plan from there.`
        : `Hi ${first}, we missed you this week. A short session still counts — even 30 minutes keeps your progress going. Your next workout is ready on the Train tab.` });
    await store.setJSON(key, inbox.slice(-20));
    nudged++;
  }
  step("Sent check-in nudges", `${nudged} at-risk client${nudged === 1 ? "" : "s"}`);

  // 6. Notify coach
  const lines = rows.map((r) => `${r.status === "at_risk" ? "AT RISK" : r.status === "slipping" ? "SLIPPING" : "ON TRACK"} · ${r.name}: ${r.sessions_this_week}/${r.target} sessions${r.prs_this_week.length ? ` · PRs: ${r.prs_this_week.join("; ")}` : ""}${r.reasons.length ? ` · ${r.reasons.join("; ")}` : ""}`);
  const subject = `Iron Log weekly check-in ${date}: ${counts.at_risk} at risk, ${counts.slipping} slipping, ${counts.on_track} on track`;
  let sent = [];
  try { sent = (await notify({ subject, message: lines.join("\n") || "No clients yet.", report })).sent || []; }
  catch (e) { sent = [`failed: ${e.message || e}`]; }
  step("Notified coach", sent.length ? sent.join(", ") : "no channel configured");

  report.steps = steps;
  await store.setJSON(`reports/${report.id}`, report);
  return report;
}

// Email via a Netlify Forms submission (turn on email notifications for the "coach-report" form), plus optional Slack.
export function makeNotifier({ siteUrl, slackWebhook, fetchImpl = fetch }) {
  return async ({ subject, message }) => {
    const sent = [];
    if (siteUrl) {
      const body = new URLSearchParams({ "form-name": "coach-report", subject, message });
      const r = await fetchImpl(`${siteUrl.replace(/\/$/, "")}/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
      sent.push(r.ok ? "Netlify Forms (email)" : `Netlify Forms HTTP ${r.status}`);
    }
    if (slackWebhook) {
      const r = await fetchImpl(slackWebhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `*${subject}*\n${message}` }) });
      sent.push(r.ok ? "Slack" : `Slack HTTP ${r.status}`);
    }
    return { sent };
  };
}
