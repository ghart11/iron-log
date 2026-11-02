# Iron Log

**A workout tracker for gym clients, with an AI Coach and a weekly check-in for their trainers.**

Personal trainers lose hours every week reading client logs, spotting who has stalled or stopped showing up, and rewriting programs by hand. Iron Log gives clients a fast logging app and gives trainers an AI agent that drafts next week's program from the data, plus an automation that checks every client each Monday.

| Part | What it is | Where |
|---|---|---|
| Client app | Log sets, supersets, drop sets, cardio, rest timer, PRs, muscle heat map, progress | `public/index.html` (`/`) |
| Coach dashboard | Client roster, per-client data, AI Coach, approvals, weekly reports | `public/coach.html` (`/coach.html`) |
| **AI agent** — AI Coach | Claude decides which tools to call to plan a client's next week | `netlify/lib/agent.mjs`, `/api/coach/agent` |
| **Automation** — Weekly check-in | Scheduled 6-step workflow every Monday 7:00 a.m. MT | `netlify/functions/weekly-checkin.mjs`, `netlify/lib/weekly.mjs` |

## AI agent: AI Coach

The trainer picks a client and asks for next week's plan. The agent (Claude through Netlify AI Gateway) works in a loop: the model chooses a tool, the server runs it against the client's real log, and the result goes back to the model until it calls `finish`.

Tools: `get_client_profile`, `get_training_summary`, `get_muscle_balance`, `find_plateaus`, `search_exercises`, `create_workout`, `finish`.

* The model decides the order and what to do with what it finds (for example: bench stalled → switch variation and rep range; hamstrings under 6 sets a week → add RDLs and leg curls).
* `create_workout` rejects exercise IDs that aren't in the gym's library, and the model has to search and retry.
* Output is a **draft**. The trainer sees every step the agent took, its note and any flags (injuries, missing data), edits the client message, and approves. Only then does it reach the client's app.
* Guards: at most 14 model turns and a 52-second deadline (the function limit is 60 s).

## Automation: weekly check-in

Triggered by a schedule (`0 14 * * 1`, Mondays 14:00 UTC), or with **Run check-in now** on the dashboard for demos. It doesn't use the LLM, which keeps it separate from the agent.

1. **Collect** every client's synced log from Netlify Blobs
2. **Score** each client: sessions vs. plan, days since last workout, PRs, sets per muscle
3. **Flag** each client as at risk, slipping or on track, and sort by priority
4. **Save** the report (shown on the dashboard's Weekly check-ins tab)
5. **Nudge** at-risk clients with a message that appears in their app on next sync
6. **Notify** the coach by email (Netlify Forms `coach-report`) and optionally Slack

## Data flow

```
Client app ──POST /api/sync──▶ Netlify Blobs  ◀── weekly-checkin (schedule)
     ▲   (log up; programs + messages down)        │
     │                                             ▼
     └──── approved program ◀── Coach dashboard ──▶ /api/coach/agent ──▶ Claude (AI Gateway)
```

## Setup on Netlify

1. Link this repo to the Netlify project (Project configuration → Build & deploy → Link repository).
2. Environment variables:
   * `GYM_CODE`: code clients enter to join (default `IRONDEMO`)
   * `COACH_PIN`: dashboard PIN (default `1234`; **change it**)
   * `COACH_MODEL` (optional): pin a Claude model ID; otherwise the newest Sonnet on the gateway is used
   * `COACH_SLACK_WEBHOOK` (optional): also post check-ins to Slack
3. Deploy to production once. This switches on AI Gateway (credit-based plans).
4. Forms → `coach-report` → add an email notification so check-ins reach your inbox.

## Develop and test

```
npm test          # 17 checks: analysis, sync, auth, agent loop (scripted model), approval, automation
npm run dev       # local server on :8888 with in-memory storage and a scripted model
```

Netlify runs `npm test` on every deploy; a failing check stops the deploy.
