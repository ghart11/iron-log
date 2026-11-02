// Calls Claude through Netlify AI Gateway (credentials are injected at runtime).
// Set COACH_MODEL to pin a model; otherwise the newest available Sonnet is picked from the gateway's live list.
import Anthropic from "@anthropic-ai/sdk";

let cachedModel = null;

async function pickModel(env) {
  if (env.COACH_MODEL) return env.COACH_MODEL;
  if (cachedModel) return cachedModel;
  try {
    const r = await fetch("https://api.netlify.com/api/v1/ai-gateway/providers/detailed");
    const text = await r.text();
    const ids = [...new Set(text.match(/claude-[a-z0-9.-]+/g) || [])];
    const pick = (re) => ids.filter((m) => re.test(m)).sort().reverse()[0];
    cachedModel = pick(/sonnet/) || pick(/haiku/) || pick(/opus/) || null;
  } catch { /* fall through */ }
  return cachedModel || "claude-sonnet-4-5-20250929";
}

export function makeModelCaller(env) {
  if (!env.ANTHROPIC_API_KEY && !env.NETLIFY_AI_GATEWAY_KEY) return null;
  const client = new Anthropic();
  return async ({ system, tools, messages }) => {
    const model = await pickModel(env);
    return client.messages.create({ model, max_tokens: 2500, system, tools, messages });
  };
}
