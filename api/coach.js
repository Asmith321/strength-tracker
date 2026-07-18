// Vercel serverless function: POST /api/coach
// Keeps your Anthropic API key on the server — never shipped to the browser.
// Set ANTHROPIC_API_KEY in Vercel project settings (Environment Variables).
//
// This endpoint is deliberately NOT a general-purpose LLM proxy: it accepts
// only structured session state and builds the coach prompt itself, server-side.
// A caller cannot inject arbitrary text, so the worst it can do is generate a
// coach note from (clamped, whitelisted) numbers — not spend credits on
// free-form completions. A per-IP rate limit closes the obvious abuse path.

const VALID_BLOCKS = ["accumulation", "intensification", "deload", "realization"];

/* ---- per-IP rate limit (in-memory, fixed window) ----
   Generous but bounded. This is per warm serverless instance, so it isn't a
   hard global cap — it just closes the obvious "hammer the URL" abuse path,
   which is all a personal app needs. */
const RATE_LIMIT_MAX = 30;          // requests
const RATE_LIMIT_WINDOW_MS = 60_000; // per 60s per IP
const hits = new Map();             // ip -> { count, resetAt }

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now >= rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_LIMIT_MAX;
}

/* Opportunistically drop expired entries so the Map can't grow unbounded on a
   long-lived warm instance. */
function sweep(now) {
  if (hits.size < 1000) return;
  for (const [ip, rec] of hits) if (now >= rec.resetAt) hits.delete(ip);
}

/* ---- input coercion (never trust the client) ---- */
const num = (v, def = 0) => (typeof v === "number" && Number.isFinite(v) ? v : def);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const str = (v, max = 40) => (typeof v === "string" ? v.slice(0, max) : "");

/* Rebuild `recent` from scratch, keeping only known keys with coerced/clamped
   values. This is what makes prompt-smuggling via the session history
   impossible — no client-supplied string reaches the model except through a
   fixed, capped set of fields. */
function sanitizeRecent(recent) {
  if (!Array.isArray(recent)) return [];
  return recent.slice(0, 6).map((s) => {
    const out = { block: str(s?.block, 20) };
    if (typeof s?.fatigue === "number" && Number.isFinite(s.fatigue)) out.fatigue = clamp(s.fatigue, 0, 1);
    if (typeof s?.trainingReadiness === "number" && Number.isFinite(s.trainingReadiness)) out.trainingReadiness = s.trainingReadiness;
    out.lifts = Array.isArray(s?.lifts)
      ? s.lifts.slice(0, 12).map((l) => {
          const lift = { lift: str(l?.lift, 30) };
          if (typeof l?.w === "number" && Number.isFinite(l.w)) lift.w = l.w;
          if (typeof l?.reps === "number" && Number.isFinite(l.reps)) lift.reps = l.reps;
          if (typeof l?.rpe === "number" && Number.isFinite(l.rpe)) lift.rpe = l.rpe;
          if (typeof l?.target === "number" && Number.isFinite(l.target)) lift.target = l.target;
          if (typeof l?.missed === "number" && Number.isFinite(l.missed)) lift.missed = l.missed;
          return lift;
        })
      : [];
    return out;
  });
}

function sanitizeTransition(t) {
  if (!t || typeof t !== "object") return null;
  return {
    to: str(t.to, 30),
    reason: str(t.reason, 200),
    borderline: !!t.borderline,
  };
}

/* Build the coach prompt from validated state. This template used to live in
   the browser (runCoach); it now lives here so the endpoint's only possible
   output is a coach note grounded in real session numbers. */
function buildPrompt({ block, cycle, fatigueIndex, slope, rScore, transition, recent }) {
  return `You are a strength coach reviewing one session of an autoregulated block-periodization program. The math is already done by deterministic code — do NOT recompute loads or e1RMs. Your job: (1) write a 1-2 sentence plain-language read of how things are trending, and (2) if a block transition is flagged BORDERLINE, decide whether to confirm it.

Computed state this session:
- Current block: ${block} (microcycle ${cycle + 1})
- Fatigue index (0-1, higher = more accumulated fatigue): ${fatigueIndex.toFixed(2)}
- Normalized e1RM trend per session (>0 = gaining): ${(slope * 100).toFixed(2)}%
- Today's readiness score (0-1): ${rScore.toFixed(2)}
- Transition flagged: ${transition ? `${transition.to} — ${transition.reason}${transition.borderline ? " (BORDERLINE — your call)" : ""}` : "none"}

Recent sessions (newest first):
${JSON.stringify(recent, null, 1)}

Respond ONLY with JSON, no prose, no code fences:
{"note":"1-2 sentence read for the athlete","confirmTransition":true,"override":null}
override: only set to a block name (accumulation|intensification|deload|realization) if you'd transition differently than flagged; otherwise null.`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on server" });
    return;
  }

  const now = Date.now();
  sweep(now);
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ error: "Too many requests, slow down" });
    return;
  }

  const body = req.body || {};

  // Require the structured session state. A legacy { prompt } request (or any
  // body missing the real fields) is rejected — the endpoint can no longer be
  // driven with free-form text.
  const { block, cycle, fatigueIndex, slope, rScore } = body;
  if (
    typeof block !== "string" ||
    !VALID_BLOCKS.includes(block) ||
    typeof fatigueIndex !== "number" ||
    typeof slope !== "number" ||
    typeof rScore !== "number"
  ) {
    res.status(400).json({ error: "Missing or invalid session state" });
    return;
  }

  const prompt = buildPrompt({
    block,
    cycle: clamp(Math.trunc(num(cycle, 0)), 0, 999),
    fatigueIndex: clamp(fatigueIndex, 0, 1),
    slope: clamp(slope, -10, 10),
    rScore: clamp(rScore, 0, 1),
    transition: sanitizeTransition(body.transition),
    recent: sanitizeRecent(body.recent),
  });

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      // Log the upstream detail server-side; never echo it to the caller.
      const text = await anthropicRes.text().catch(() => "");
      console.error(`Anthropic API error ${anthropicRes.status}: ${text}`);
      res.status(502).json({ error: "Coach unavailable" });
      return;
    }

    const data = await anthropicRes.json();
    res.status(200).json(data);
  } catch (err) {
    console.error("Coach request failed:", err);
    res.status(500).json({ error: "Coach unavailable" });
  }
}
