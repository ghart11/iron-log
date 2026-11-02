// Automation: every Monday at 7:00 a.m. Mountain (14:00 UTC) run the weekly client check-in.
import { getStore } from "@netlify/blobs";
import { runWeeklyCheckin, makeNotifier } from "../lib/weekly.mjs";

export default async () => {
  const report = await runWeeklyCheckin({
    store: getStore({ name: "iron-log", consistency: "strong" }),
    notify: makeNotifier({ siteUrl: process.env.URL, slackWebhook: process.env.COACH_SLACK_WEBHOOK }),
    trigger: "schedule",
  });
  console.log(`Weekly check-in ${report.id}:`, JSON.stringify(report.counts));
};

export const config = { schedule: "0 14 * * 1" };
