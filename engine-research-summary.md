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

## Hypertrophy rebuild — exercise selection, volume, effort

**Design intent.** The program was rebuilt as a pure hypertrophy program from a
fixed list of athlete-approved exercises, with the mandatory squat/bench/deadlift
skeleton removed. The notes below record the evidence each design decision rests
on, so the numbers in `PATTERNS` / `ACC_REP_TIERS` / `ROTATION` aren't left
looking arbitrary.

**Volume is the primary driver, with diminishing returns.** Pelland, Remmert,
Robinson, Hinson & Zourdos, *The Resistance Training Dose Response:
Meta-Regressions Exploring the Effects of Weekly Volume and Frequency on Muscle
Hypertrophy and Strength Gains* (Sports Medicine, 2026; 67 studies, 2058
participants) finds a positive weekly-volume dose-response for hypertrophy that
flattens as volume rises. The companion per-session analysis (*Is There Too Much
of a Good Thing?*) puts the point of undetectable outcome superiority at **~11
fractional sets per muscle per session** — this is what `SAME_DAY_GROUP_CAP`
(10) and `ACC_SET_CAP` (6) encode.

**Frequency distributes volume; it is not independently anabolic.** Volume-
equated comparisons of 2x vs 3x per week find no meaningful hypertrophy
difference (effect-size differences around 0.02). Frequency earns its place only
because per-session volume saturates — so the rotation gives every muscle 2-3
exposures per pass specifically to keep each session under the per-session
ceiling, not because more sessions are better per se. This is also why the
rebuilt rotation pairs an upper and a lower half on every day rather than
splitting upper/lower across days: it was the only way to get chest and back to
two exposures without doubling session length.

**Load/rep range is close to irrelevant when sets are near failure.** Meta-
analyses spanning roughly 3 to 35 reps find equivalent hypertrophy (pooled heavy
8.3% vs light 7.0%, a gap smaller than chance). Rep targets in `ACC_REP_TIERS`
are therefore chosen for practicality — load-progression granularity on
compounds, rep headroom for double progression on isolation — not because a
"hypertrophy rep range" exists. Load still matters for strength, which this
program no longer optimises for.

**Proximity to failure has a real dose-response — for hypertrophy specifically.**
Robinson et al. (2024) meta-regressions find hypertrophy improves as reps-in-
reserve approach 0, degrading more steeply past ~5 RIR, while *strength* is
largely insensitive to RIR. Absolute failure is not required: 1-2 RIR matches
training to failure in trained lifters. Hence the block ramps ~3 RIR → ~0-1 RIR,
with compounds capped at RPE 9 (failure on multi-joint work costs more systemic
fatigue than the last half-rep returns) and isolation at 9.5.

**Long-muscle-length training is the exercise-selection variable with the
clearest evidence.** A 2025 systematic review of partial-ROM training at long vs
short muscle lengths found greater hypertrophy at long lengths in 7 of 8
included studies. Specific choices this drove, all from the approved list:
overhead cable triceps extension over any pressdown (Maeo et al. 2022 — roughly
40% greater triceps growth, long head loaded overhead), seated over lying leg
curl (hip flexion lengthens the hamstring), machine lat pullover, Bayesian cable
curl, and the deep positions of RDL and Bulgarian split squat.

**MAV, not MRV, is the ramp's endpoint.** RP's textbook mesocycle ramps a muscle
from MEV toward MRV, but that model is written per-muscle. This program tracks
ten landmark groups and ramps them on one schedule, and MRV is by definition the
volume a muscle can *barely* recover from — so hitting ten MRVs at once is one
athlete well past their systemic limit, not ten muscles at theirs. Measured on
this rotation an MRV endpoint delivered 175 sets/rotation with a 47-set peak
session; the MAV endpoint delivers ~148 with a peak in the high 30s, every group
still inside the 10-20 sets/week band where the dose-response evidence is
strongest. MRV keeps three jobs: bounding MAV's auto-tuned growth, feeding the
schedule-capacity math, and being what the athlete sees as their ceiling.

**Caveats.** Volume/frequency meta-regressions are dominated by relatively
untrained, mostly male samples and short interventions; the per-session ceiling
in particular rests on sparse data at high per-session volumes, and the authors
say explicitly that it is unclear whether more sets beyond it are harmful or
merely not better. The landmark table is RP's published guidance, which is
practitioner consensus rather than a meta-analysis. Treat every specific number
here as a defensible starting point that the per-athlete auto-tune then moves.
