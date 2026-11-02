// Client app sync: saves the client's log and returns programs and messages from their coach.
import { getStore } from "@netlify/blobs";
import { handleSync } from "../lib/api.mjs";

export default async (req) => handleSync(req, { store: getStore({ name: "iron-log", consistency: "strong" }), env: process.env });

export const config = { path: "/api/sync" };
