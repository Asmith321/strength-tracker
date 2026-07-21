# Engine research summary

Living rationale reference for design decisions in `src/engine.js` that are
grounded in sport-science literature or deliberate methodology choices, so a
future session (or a future you) doesn't have to re-derive *why* something
is built the way it is from the code alone.

## Readiness (Garmin Training Readiness Score)

**Design intent.** Readiness is a **bounded, secondary, same-day modifier**
on the day's prescription — never a primary driver of the program. This is a
deliberate scoping decision: the evidence for HRV-guided programming is
strong for endurance training (where daily readiness meaningfully predicts
adaptive capacity), but no identifiable difference has been found between
HRV-guided and fixed resistance-training programming in strength/hypertrophy
outcomes specifically. Given that gap, readiness is used here as it can be
defended — softening a single day's effort/volume when the athlete's own
Garmin-reported readiness is low — and never as the thing that decides block
length, volume landmarks, or long-run programming on its own. Multi-session
training stress (RPE creep, missed sets, e1RM trend) remains the primary
signal for block transitions and landmark auto-tuning; readiness only ever
contributes a bounded slice of the composite fatigue index alongside them.

**The two decoupled roles, and the constants behind each** (see
`src/engine.js`, the block of comments and named constants directly above
`readinessScore()`):

1. **Same-day prescription softening** — `READINESS_RPE_ADJ` / `READINESS_SET_MULT`,
   consumed in `prescribe()`. A red-band day currently cuts up to **-1.5 RPE**
   off the day's target and reduces prescribed sets by up to **40%**
   (`setMult: 0.6`); amber is a smaller **-0.5 RPE** / **15%** cut. Reads
   *today's* live readiness reading directly, every session — nothing here
   is smoothed or remembered across sessions.
2. **Multi-session fatigue-index contribution** — `READINESS_FATIGUE_WEIGHT`,
   consumed in `ingest()`. An EWMA of `(1 - today's score)` accumulates into
   `fatigue.readSupp`, which carries a fixed **0.3** weight in the composite
   fatigue index alongside RPE-creep (0.5) and missed-set frequency (0.2).
   This is the *only* place readiness feeds block-transition/deload timing.

These are structurally independent code paths on purpose — `prescribe()`
never reads `fatigue.readSupp`, and `ingest()`'s EWMA never reads
`rpeAdj`/`setMult` — so a run of noisy wearable readings can soften isolated
sessions without necessarily nudging the athlete toward an early deload for
reasons that were never about accumulated training stress, and tuning one
role can never accidentally move the other.

**Status of the specific numbers.** The -1.5 RPE / 40% cut, the -0.5 RPE /
15% cut, and the 0.3 fatigue-index weight are **a reasonable starting
parameterization intended to be tuned against actual logged sessions over
time, not a proven-optimal set of constants.** They were chosen to keep
readiness bounded and secondary (matching the design intent above), not
derived from this athlete's own training data — there wasn't any yet.

**How to validate or adjust them, once there's data to look at.** As of this
note, every ingested session records the readiness band and adjustment that
were actually applied (`rx.band`/`rx.rpeAdj`/`rx.setMult`, captured at
prescribe-time) alongside the real outcome `ingest()` already computes
(RPE overshoot vs. target, missed-set frequency, backoff RPE drift) — see
`readinessOutcome` on each session record in `src/App.jsx`'s `handleLog`.
Run `readiness_analysis.mjs` against a few weeks of real exported session
history (`Settings → Export my data`, then
`node readiness_analysis.mjs path/to/the-export.json`) to see, per band,
whether amber/red days are actually landing lighter than green days by
roughly the intended margin, or whether the athlete is still overshooting
(adjustment undersized) or ending up with a meaningfully easier session than
intended (adjustment oversized). The script explicitly refuses to draw a
conclusion from a band with too few sessions — read its "not enough data"
flags rather than over-reading an early run. **This script — run against
real accumulated history, not this note or a synthetic demo — is the
intended mechanism for ever changing `READINESS_RPE_ADJ`, `READINESS_SET_MULT`,
or `READINESS_FATIGUE_WEIGHT`. It hasn't been run against real data yet.**
