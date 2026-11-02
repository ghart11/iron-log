// Calls Claude through Netlify AI Gateway (credentials are injected at runtime), or ANTHROPIC_API_KEY if you set one.
// COACH_MODEL pins a model. Otherwise the first model the gateway accepts from CANDIDATES is used and remembered.
import Anthropic from "@anthropic-ai/sdk";

const CANDIDATES = ["claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-sonnet-4-5-20250929", "claude-sonnet-4-5"];
let working = null;

const isModelError = (e) => (e?.status === 404 || e?.status === 400) && /model/i.test(String(e?.message || ""));

export function makeModelCaller(env) {
  if (!env.ANTHROPIC_API_KEY && !env.NETLIFY_AI_GATEWAY_KEY) return null;
  // Short timeout and no retries: a slow call fails fast and the next request retries it.
  const client = new Anthropic({ timeout: 14000, maxRetries: 0 });
  const list = env.COACH_MODEL ? [env.COACH_MODEL] : CANDIDATES;
  return async ({ system, tools, messages }) => {
    const order = working ? [working, ...list.filter((m) => m !== working)] : list;
    let last;
    for (const model of order) {
      try {
        const res = await client.messages.create({ model, max_tokens: 2000, system, tools, messages });
        working = model;
        return res;
      } catch (e) {
        last = e;
        if (!isModelError(e)) throw e; // only try another model when this one isn't available
      }
    }
    throw last || new Error("No Claude model available on the gateway. Set COACH_MODEL.");
  };
}
