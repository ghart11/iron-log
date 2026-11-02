// Coach dashboard API, including the AI Coach agent: /api/coach/*
import { getStore } from "@netlify/blobs";
import { handleCoach } from "../lib/api.mjs";
import { makeModelCaller } from "../lib/model.mjs";
import { makeNotifier } from "../lib/weekly.mjs";

export default async (req) => {
  const env = process.env;
  const store = getStore({ name: "iron-log", consistency: "strong" });
  return handleCoach(req, {
    store, env, path: new URL(req.url).pathname,
    callModel: makeModelCaller(env),
    notify: makeNotifier({ siteUrl: env.URL, slackWebhook: env.COACH_SLACK_WEBHOOK }),
  });
};

export const config = { path: "/api/coach/*" };
