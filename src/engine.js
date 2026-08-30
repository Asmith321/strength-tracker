/* ════════════════════════════════════════════════════════════════════════
   PROGRAMMING ENGINE
   ────────────────────────────────────────────────────────────────────────
   All sport-science logic lives here as pure, deterministic functions — no
   React, no DOM, no I/O. This is what makes it importable directly by both
   the app (src/App.jsx) and plain-Node test scripts (stress_test.mjs,
   warmup_report.mjs) with zero bundling step: a plain ESM `import` works
   because this file contains no JSX and no browser-only APIs.
   The LLM only narrates + breaks genuinely borderline transitions (runCoach,
   which stays in App.jsx since it's I/O — a fetch call — not engine math).

   THIS IS A HYPERTROPHY PROGRAM. It was originally a strength program with
   hypertrophy accessories bolted on (squat/bench/deadlift mains, top single
   plus backoffs, blocks that peaked into a 1-2 rep re-test). The athlete asked
   for the most hypertrophic program buildable from a fixed list of approved
   exercises, with the mandatory big-three skeleton removed — so the main-lift
   role, the volume day, the intensification block and the realization re-test
   are all gone. Every exercise is now a ramped accessory chosen for stimulus.
   See the comments on ROTATION, PATTERNS, ACC_REP_TIERS and BLOCKS for the
   reasoning and the evidence behind each piece.

   • Load = autoregulated RPE → estimated-1RM (Zourdos/Helms RPE chart),
     not fixed %1RM or fixed +5lb increments. e1RM is re-read every session
     from weight×reps×RPE, so load floats with daily readiness + adaptation.
     Isolation work additionally runs double progression (hold load, climb
     reps, then step load) because one plate is a huge jump at those loads.
   • Volume periodized between landmarks (MEV/MAV/MRV weekly hard sets per
     MUSCLE). A block ramps from MEV to MAV and deloads; MRV is the recovery
     ceiling that bounds how far MAV may be auto-tuned, NOT a target — ramping
     ten muscle groups to their individual MRVs simultaneously exceeds what any
     athlete recovers from. All three landmarks re-fit every block from the
     athlete's own growth trend and fatigue.
   • Effort periodized alongside volume: ~3 reps in reserve at the start of a
     block to ~0-1 at the end, with multi-joint work capped short of true
     failure. Proximity to failure has a real dose-response for hypertrophy;
     absolute failure on compounds costs more fatigue than it returns.
   • Block periodization without a peak: accumulation → deload → accumulation.
     Block length shortens on a stall or a fatigue spike; a healthy block runs
     its full maxCycles. Do not read that as "auto-detected rather than a fixed
     calendar" — it said exactly that for a long time and it was false for a
     growing athlete, whose every block ends on "max accumulation length
     reached". The adaptive part is real but it is a SAFETY VALVE, not a
     planner: stall and fatigue cut a block short, nothing lengthens it.
   • Readiness (Garmin) is a SECONDARY modifier on daily load + deload timing —
     lifting evidence is preliminary, so it never drives the program alone.
   ════════════════════════════════════════════════════════════════════════ */

/* ---- RPE → %1RM (Helms/Zourdos): rows = reps, cols = RPE ---- */
const RPE_TABLE = {
  1:  {10:100,  9.5:97.8, 9:95.5, 8.5:93.9, 8:92.2, 7.5:90.7, 7:89.2, 6.5:87.8, 6:86.3},
  2:  {10:95.5, 9.5:93.9, 9:92.2, 8.5:90.7, 8:89.2, 7.5:87.8, 7:86.3, 6.5:85.0, 6:83.7},
  3:  {10:92.2, 9.5:90.7, 9:89.2, 8.5:87.8, 8:86.3, 7.5:85.0, 7:83.7, 6.5:82.4, 6:81.1},
  4:  {10:89.2, 9.5:87.8, 9:86.3, 8.5:85.0, 8:83.7, 7.5:82.4, 7:81.1, 6.5:79.9, 6:78.6},
  5:  {10:86.3, 9.5:85.0, 9:83.7, 8.5:82.4, 8:81.1, 7.5:79.9, 7:78.6, 6.5:77.4, 6:76.2},
  6:  {10:83.7, 9.5:82.4, 9:81.1, 8.5:79.9, 8:78.6, 7.5:77.4, 7:76.2, 6.5:75.1, 6:73.9},
  7:  {10:81.1, 9.5:79.9, 9:78.6, 8.5:77.4, 8:76.2, 7.5:75.1, 7:73.9, 6.5:72.3, 6:70.7},
  8:  {10:78.6, 9.5:77.4, 9:76.2, 8.5:75.1, 8:73.9, 7.5:72.3, 7:70.7, 6.5:69.4, 6:68.0},
  9:  {10:76.2, 9.5:75.1, 9:73.9, 8.5:72.3, 8:70.7, 7.5:69.4, 7:68.0, 6.5:66.7, 6:65.3},
  10: {10:73.9, 9.5:72.3, 9:70.7, 8.5:69.4, 8:68.0, 7.5:66.7, 7:65.3, 6.5:64.0, 6:62.6},
  11: {10:70.7, 9.5:69.4, 9:68.0, 8.5:66.7, 8:65.3, 7.5:64.0, 7:62.6, 6.5:61.3, 6:60.0},
  12: {10:68.0, 9.5:66.7, 9:65.3, 8.5:64.0, 8:62.6, 7.5:61.3, 7:60.0, 6.5:58.7, 6:57.4},
};
const clampReps = (r) => Math.max(1, Math.min(12, Math.round(r)));
const clampRpe = (v) => Math.max(6, Math.min(10, Math.round(v * 2) / 2));
function rpePct(reps, rpe) {
  const row = RPE_TABLE[clampReps(reps)];
  return (row[clampRpe(rpe)] || row[8]) / 100;
}
function e1rmFrom(weight, reps, rpe) {
  if (!weight || !reps) return 0;
  return weight / rpePct(reps, rpe);
}
/* Inverse of rpePct: the rep count at which a set of `targetPct` of e1RM sits
   at the given RPE. Used by the bodyweight branch in prescribe() when the
   athlete's own bodyweight is HEAVIER than the prescribed system load — the
   load can't be dialled down on a pull-up, so the REP target moves instead
   (fewer reps at the same intended effort) rather than silently leaving the
   athlete a set that's harder than the RPE it's labelled with.
   Scans the table's integer rep rows rather than interpolating: RPE_TABLE is
   the empirical ground truth and its rows are integers, so the nearest row is
   the answer. Ties resolve to the lower rep count (the harder-per-rep read),
   which is the conservative direction for a set that's already heavier than
   asked for. */
function repsAtPct(targetPct, rpe) {
  let best = 1, bestErr = Infinity;
  for (let r = 1; r <= 12; r++) {
    const err = Math.abs(rpePct(r, rpe) - targetPct);
    if (err < bestErr) { bestErr = err; best = r; }
  }
  return best;
}
/* Applying RPE_TABLE unmodified to unilateral work (repTier:"unilateral", e.g.
   bsplit): the underlying Helms/Zourdos data was validated on bilateral
   barbell compounds, not stability-limited single-leg/arm movements, so this
   is a judgment call, not a proven fit — but a defensible one, and no numeric
   offset is applied.
   THE DEFENSE IS THE NARROW REP WINDOW, not a round-trip argument. An earlier
   version of this comment argued that because every read (e1rmFrom) and every
   prescription (loadFor) passes through the SAME per-exercise e1rm, the table
   only has to model this lift's own decay curve. That defends against error in
   the curve's ANCHOR, which does cancel — but not against error in its SHAPE,
   which doesn't, and shape error is real: reps-achievable-at-a-given-%1RM
   varies substantially by exercise (Hoeger 1990; Richens & Cleather 2014).
   What actually makes it safe here is that bsplit is prescribed at 7-8 reps in
   every block (ACC_REP_TIERS.unilateral), traversing ~2 percentage points of
   the curve where the full 1-12 table spans ~30. Over a two-rep window, even a
   materially wrong curve shape moves the prescription very little. If a
   unilateral movement ever gets a wide rep range, this reasoning expires.
   Note also the direction of the residual risk, which the earlier comment had
   BACKWARDS. e1rmFrom = weight / rpePct(reps, rpe), and rpePct falls as RPE
   falls, so dividing by a smaller number yields a LARGER e1rm: systematically
   under-reported RPE INFLATES the stored e1RM (100 lb x 8 reads as 127 lb at
   RPE 10 but 141 lb at RPE 7), and loadFor then prescribes correspondingly
   HEAVIER — a self-reinforcing drift upward, not the "slower measured e1RM
   climb" the old comment claimed the EWMA would absorb. The EWMA smooths noise
   around the trend; it does not correct a biased trend. This is a live reason
   to keep the rep window narrow, not a solved problem. */
/* ---- bodyweight lifts: e1rm tracked as SYSTEM load (bodyweight + added) ----
   added may be 0 (bodyweight-only) or negative (band/machine assistance),
   so unlike e1rmFrom() we can't gate on truthy weight — only reps + a
   positive system load are required. */
function e1rmFromBW(bodyweight, added, reps, rpe) {
  const sys = (bodyweight || 0) + (added || 0);
  if (!reps || sys <= 0) return 0;
  return sys / rpePct(reps, rpe);
}
function loadFor(e1rm, reps, rpe, unit, step) {
  const raw = e1rm * rpePct(reps, rpe);
  const s = step ?? (unit === "kg" ? 2.5 : 5);
  return Math.max(0, Math.round(raw / s) * s);
}
/* AUDIT 2.7: the load-rounding step was a single global value (5 lb / 2.5 kg)
   applied to every non-barbell exercise regardless of how it's actually
   loaded. That's fine for a dumbbell rack (5 lb is one rack step either way)
   but wrong for cable/pin-stack machines, where the real increment is a
   property of the EQUIPMENT, not the exercise's rep range: a 5 lb step on a
   33 lb-e1RM lateral raise is a 15% jump, and a 10 lb step on a ~100 lb cable
   row is comparatively coarse for a compound pull most stacks let you load
   in smaller plates.
   LIB.increment (optional, in lb) overrides the default for exercises where
   the equipment genuinely supports finer or coarser loading than the
   dumbbell-rack default; unset exercises are byte-identical to before this
   change. kg athletes get the same override halved (matching the existing
   5 lb <-> 2.5 kg ratio used everywhere else) rather than a second field to
   keep in sync per exercise.
   Side benefit flagged in the audit: layoff decay for small isolation loads
   used to round away entirely (round(15 * 0.85 / 5) * 5 = 15 — no visible
   cut) or overshoot it (20 -> 15 is a 25% cut for a 15% decay). A smaller
   step makes that rounding track the real percentage far more closely. */
function stepFor(L, unit) {
  if (!L.increment) return unit === "kg" ? 2.5 : 5;
  return unit === "kg" ? L.increment / 2 : L.increment;
}

/* ---- smoothing + trend ---- */
const ewma = (prev, next, a = 0.34) => (prev == null ? next : prev * (1 - a) + next * a);
function slope(ys) {
  const n = ys.length;
  if (n < 3) return 0;
  const xs = ys.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? 0 : num / den;
}
/* Per-lift e1RM trend, normalized by current e1RM so patterns are comparable
   regardless of absolute load. Generalizes the block-level slope in ingest()
   so the same computation feeds both the fatigue index and the per-pattern
   growth signal used for landmark auto-tuning.
   Fits over RAW session readings (p.raw), not the EWMA-smoothed series — the
   smoothed line already lags by construction, and fitting a trend line to it
   double-lags the signal. The window is also scoped to the trailing run of
   same-block-type entries (hist entries carry `b`): a block transition shifts
   rep ranges, which steps the e1RM estimate for reasons unrelated to real
   strength change, so a window straddling the boundary reads phantom slopes.
   Entries from before `b` existed match any block, so migrated history keeps
   contributing until it naturally ages out of the window. */
function liftSlopeInfo(lift) {
  const h = lift?.hist || [];
  if (!h.length) return { g: 0, n: 0 };
  let lastB = null;
  for (let i = h.length - 1; i >= 0 && !lastB; i--) lastB = h[i].b || null;
  const run = [];
  for (let i = h.length - 1; i >= 0; i--) {
    const p = h[i];
    if (lastB && p.b && p.b !== lastB) break;
    run.unshift(p);
  }
  /* AUDIT 3.2: the window is forced to an ODD length. Squat and bench log TWO
     readings per rotation at different rep targets (heavy day 5 reps; volume
     day 5+VOLUME_DAY_REP_BUMP=8 at a capped RPE — 3 vs 6 in intensification),
     so whenever the athlete's real rep-strength curve differs from RPE_TABLE
     — which this file's own rpePct notes cite Hoeger 1990 / Richens & Cleather
     2014 to say is common — the raw series is a SAWTOOTH, e.g. an actual
     measured run of 388, 375, 388, 373, 395, 379, 395, 379.
     An OLS fit over an EVEN-length window does not cancel that alternating
     component; an odd-length window cancels it exactly. Measured artifact,
     as a multiple of the alternation amplitude: n=4 -> -0.400, n=6 -> -0.171,
     n=8 -> -0.095, every odd n -> exactly 0. It is always NEGATIVE because
     transitions are only evaluated at sessionsInBlock % ROT === 0, i.e.
     always immediately after the volume day, so the window always ends on the
     low reading — a phase-locked bias, not noise. On the series above it put
     squat's slope at 0.000991 against a GROWTH_POS of 0.001: failing the
     growth gate by a hair despite genuine +0.4%/week progress, which
     suppressed that group's landmark raises for an entire simulated year.
     Trimming the OLDEST reading (rather than capping at 7) is what makes this
     correct at every run length: squat's window is structurally even at every
     decision point — it accrues 2 readings per rotation, so a plain slice(-7)
     leaves runs of 4 and 6 untouched, which are exactly the worst cases. */
  const win = run.slice(-8);
  const ys = (win.length % 2 === 0 ? win.slice(1) : win).map((p) => p.raw ?? p.e);
  const base = lift?.e1rm || 1;
  /* n = points the fit actually used (0 when below slope()'s 3-point minimum,
     where the returned slope is a placeholder 0, not evidence of flatness) —
     consumers weight by this so sparse lifts don't dilute pooled signals. */
  return { g: slope(ys) / base, n: ys.length >= 3 ? ys.length : 0 };
}
function liftNormSlope(lift) { return liftSlopeInfo(lift).g; }

/* ---- muscle-group landmark defaults (weekly hard sets) ----
   These baseline MEV/MAV/MRV are the INTERMEDIATE tier; beginner/advanced
   programs are seeded by scaling this table (see landmarksForExperience).
   Landmark groups are keyed by MUSCLE (the single canonical classification —
   see LIB's `volumeGroup`). The four compound groups were renamed from their
   old movement-pattern keys to their primary mover, finishing the migration
   that already muscle-named back/rear_delts/calves:
     squat → quads,  hinge → hamstrings,  horiz_press → chest,  vert_press → front_delts.
   migrateProgram() renames these keys in any already-saved program.

   AUDIT 3.11: quads/hamstrings/chest/back/calves MEV were re-derived against
   RP's actually-published per-muscle landmark table (cross-checked against
   RP's own per-muscle articles, not carried over from an earlier, unsourced
   pass) and found set ~1.3-2x too high — several were sitting at or above
   RP's own MAV floor rather than at MEV. front_delts and rear_delts already
   matched RP's published range closely and are unchanged. side_delts is
   intentionally left below RP's published MRV ceiling (18 here vs RP's
   24-30) — under-programmed relative to RP's stated maximum, but not a
   defect: raising it doesn't fix anything broken, it's a volume preference,
   and this program's schedule capacity (see ACC_SET_CAP) can't deliver
   RP's higher ceiling for side delts anyway without a much larger session-
   length cost than the rest of this correction took on. */
const PATTERNS = {
  quads:       { label: "Quads",               mev: 5,  mav: 14, mrv: 18 },
  /* HYPERTROPHY REBUILD: raised from 3/6/12. The old numbers were sized around
     a program where conventional Deadlift was a main lift contributing 4 fixed
     hamstring sets per rotation; with the strength skeleton removed (see
     ROTATION) every hamstring set is now ramped accessory work, and RDL +
     2x seated leg curl is a genuine hypertrophy allocation rather than
     "whatever is left after the deadlift". Stays inside RP's published
     hamstring range (MEV 2-4, MAV 2-8, MRV 8-14). */
  hamstrings:  { label: "Hamstrings / Post. chain", mev: 4, mav: 8, mrv: 14 },
  chest:       { label: "Chest",               mev: 5,  mav: 14, mrv: 22 },
  /* Front delts get indirect stimulus from chest/triceps pressing already
     covered elsewhere in the program — RP's published landmark table gives
     them MEV 0-2, MAV 4-8, MRV 8-12 for exactly that reason (RP's system
     accounts for indirect stimulus by setting the DIRECT-set target low for
     muscles that reliably get heavy secondary work, not via a separate
     fractional-credit layer — verified against RP's own stated methodology,
     not just its numbers). mev:2 sits at the top of that published range
     rather than at 0, since this program tracks front-delt pressing as a
     whole routine rather than crediting indirect volume anywhere else. */
  front_delts: { label: "Front Delts",         mev: 2,  mav: 7,  mrv: 12 },
  /* Horizontal + vertical pulling are consolidated into ONE 'back' volume pool:
     RP's landmark research treats back as a single muscle group, not two. Every
     pulling exercise carries volumeGroup:'back' so all their volume math
     (PATTERN_FREQ / weeklyTarget / landmark auto-tune) shares this pool. */
  back:        { label: "Back",                mev: 7,  mav: 18, mrv: 25 },
  /* Rear and side delts are SEPARATE pools (split from the old combined
     'rear_delts' pool — different muscles with different jobs: side delts =
     abduction, trained only by lateral raises here; rear delts = horizontal
     extension, trained by the pec deck AND heavily as a secondary in all four
     pulling slots). Pooling them let the fixed 2:1 pec-deck:lateral slot ratio
     silently decide the mix. Rear delts carry a lower direct-set MEV precisely
     because of that pulling overlap; side delts get no such indirect help
     (especially with barbell OHP dropped from the rotation), so their direct
     numbers sit higher. migrateProgram() resets an old combined pool to these
     canonical values — old tuned numbers described a different quantity. */
  /* MAV trimmed 10 -> 9 so that schedule capacity covers it at EVERY experience
     tier, not just at intermediate: rear delts have 2 ramped slots (capacity 12
     sets/rotation), and an advanced athlete's 1.25x MAV scaling turned 10 into
     13 — a target the rotation could never deliver, which is precisely the
     capacity-vs-landmark mismatch AUDIT 3.6/3.8 spent two passes containing.
     9 is comfortably inside RP's published rear-delt MAV range (4-12) and the
     direct number is deliberately modest anyway, because rear delts also take
     heavy secondary work from all four ramped back slots (T-bar row, pull-up,
     2x lat pullover) — the same indirect-stimulus reasoning as front_delts. */
  rear_delts:  { label: "Rear Delts",          mev: 4,  mav: 9,  mrv: 16 },
  /* HYPERTROPHY REBUILD: MAV/MRV raised from 12/18. RP's published side-delt
     range is by far the highest of any group (MEV 6-8, MAV 8-24, MRV 24-30) —
     side delts get essentially no indirect stimulus and tolerate very high
     direct volume. The old ceiling sat deliberately low because the rotation
     only had 2 lateral-raise slots to deliver it; this rebuild carries 3, so
     the landmark no longer has to pretend the capacity isn't there. Still
     below RP's top end, which the schedule genuinely cannot reach. */
  side_delts:  { label: "Side Delts",          mev: 6,  mav: 14, mrv: 22 },
  calves:      { label: "Calves",              mev: 5,  mav: 14, mrv: 20 },
  /* HYPERTROPHY REBUILD: arms are promoted from untracked fixedSets pools to
     full landmark-tracked pools. In the strength-skeleton program a curl was a
     3-set afterthought bolted onto a day built around a barbell main; in a
     program whose entire purpose is hypertrophy, biceps and triceps are
     primary targets with dedicated slots that should ramp MEV->MRV like every
     other muscle. Numbers are RP's published arm landmarks (biceps MEV 8,
     MAV 14-20, MRV 26; triceps MEV 6, MAV 10-14, MRV 18) pulled down at the
     MEV end: RP sets those direct-set targets for programs where arms are
     trained largely in isolation, whereas here biceps sit behind 4 ramped
     back slots and triceps behind 4 ramped pressing slots (bench, incline,
     dip, overhead press) — the same indirect-stimulus reasoning the
     front_delts comment above spells out. */
  biceps:      { label: "Biceps",              mev: 6,  mav: 14, mrv: 20 },
  triceps:     { label: "Triceps",             mev: 5,  mav: 12, mrv: 18 },
};

/* ---- experience-based landmark seeding ----
   Replaces manual per-pattern number entry: the athlete picks a tier and we
   scale the Intermediate baseline table above. Only MEV/MRV scale factors are
   research-anchored (less-trained lifters need less volume and recover from
   less; advanced lifters tolerate more); MAV has no separate spec, so it's
   scaled by the average of the two factors and clamped to stay strictly inside
   the [MEV, MRV] range. */
const EXPERIENCE_TIERS = {
  beginner:     { label: "Beginner",     blurb: "< ~1 yr consistent training",  mev: 0.7, mrv: 0.75 },
  intermediate: { label: "Intermediate", blurb: "~1–3 yrs, steady progression", mev: 1.0, mrv: 1.0 },
  advanced:     { label: "Advanced",     blurb: "3+ yrs, near-maximal recovery", mev: 1.2, mrv: 1.3 },
};
/* INVESTIGATED (post-3.11), NOT A BUG: schedule capacity (ACC_SET_CAP,
   PATTERN_FREQ, fixedSets) doesn't scale by tier the way MEV/MRV above do,
   which looks at first glance like advanced athletes are proportionally
   MORE capacity-starved than beginners — measured at a fixed 4x/week
   cadence, capA/MRV is 123% for beginner, 94% intermediate, only 72%
   advanced. But that measurement assumes a fixed 4x/week frequency, and the
   schedule doesn't actually assume that: weeklyFreqScale already converts
   real logged cadence into a true-weekly rate, and fixedWeeklySets/
   ACC_SET_CAP being deliberately UNSCALED by freqScale (see weeklyTarget's
   comment) means an athlete who trains MORE often gets MORE true-weekly
   volume automatically — the same 4-day rotation just cycles faster,
   delivering each fixed/ramped contribution more times per real week.
   Verified end-to-end through prescribe(): an advanced-tier athlete at
   6x/week reaches chest's MRV (was short 9 sets/week at 4x/week) and comes
   within half a set of quads' MRV. This is also the mechanism the volume/
   frequency literature actually supports for reaching higher volume targets
   — RP's own numbers suggest the productive PER-SESSION set range narrows
   for advanced lifters, not widens, so the fix is more sessions, not a
   higher per-exposure cap; raising ACC_SET_CAP further by tier would have
   been the wrong lever. The one thing frequency genuinely can't fix:
   front/side/rear delts have zero fixed contribution and only 1-2 ramped
   slots, so even at the freqScale clamp's ceiling (0.6) they cap out well
   under an advanced MRV — a slot-count limit, not a frequency one. Left
   alone deliberately: these are exactly the muscles RP's own landmarks say
   need the least direct volume (see the front_delts/rear_delts comments on
   PATTERNS), so under-delivering their MRV specifically isn't the same kind
   of problem as under-delivering back's or chest's. */
function landmarksForExperience(tier) {
  const s = EXPERIENCE_TIERS[tier] || EXPERIENCE_TIERS.intermediate;
  const mavFactor = (s.mev + s.mrv) / 2;
  const out = {};
  Object.entries(PATTERNS).forEach(([p, base]) => {
    const mev = Math.max(2, Math.round(base.mev * s.mev)); // floor MEV at 2
    const mrv = Math.max(4, Math.round(base.mrv * s.mrv));
    const mav = Math.min(mrv - 1, Math.max(mev + 1, Math.round(base.mav * mavFactor)));
    out[p] = { label: base.label, mev, mav, mrv };
  });
  return out;
}

/* ---- exercise library ----
   fixedSets: accessory takes a flat set count (scaled by block volume tier
   + readiness) instead of drawing from the landmark/weeklyTarget pool, and
   is excluded from PATTERN_FREQ since it isn't sharing that pool.
   bodyweight: e1rm is tracked as SYSTEM load (bodyweight + added load); see
   e1rmFromBW() and the bodyweight branch in prescribe().
   repTier (accessories only): drives the per-tier rep+RPE target in
   ACC_REP_TIERS — 'compound' (multi-joint, barbell/machine, biggest loads),
   'unilateral' (single-leg/arm, stability-limited), 'isolation' (single-joint,
   highest safe rep range, pushed to true failure once it hits the top of
   that range in accumulation/intensification).
   volumeGroup: the SINGLE canonical classifier — the exercise's primary mover.
   It drives all volume math (PATTERN_FREQ / weeklyTarget / landmark auto-tune)
   and the warmup muscle-overlap priming check. Every exercise carries one
   explicitly (no more falling back to a movement `pattern`). Several exercises
   can share a pool — e.g. all pulling maps to the single 'back' pool. Groups
   that back a landmark (quads/hamstrings/chest/front_delts/back/rear_delts/
   calves) are looked up in PATTERNS; the isolation-only groups on fixedSets
   accessories (biceps/triceps/forearms/abs/traps) are never landmark-tracked
   and are used only for warmup priming.
   Ambiguous primary movers (flagged in the muscle-volume audit): Deadlift and
   Good Morning are both hip-hinge lifts loading the whole posterior chain
   (glutes/hamstrings/erectors/back). Both are assigned volumeGroup 'hamstrings'
   — consistent with the pre-existing hinge→hamstrings mapping, and it keeps
   Deadlift as the growth driver for the hamstrings landmark (PATTERN_MAIN).
   Entries can exist here WITHOUT a rotation slot (ohp, legext): they keep
   History labels and e1RM records for previously-logged sessions while
   contributing nothing to volume math (fixedWeeklySets/PATTERN_FREQ read the
   ROTATION, and PATTERN_RAMPED_ACC filters to rotation members).
   TODO (macrocycle exercise variation): the rotation trains the same ~20
   movements indefinitely. Standard practice is to swap accessory VARIANTS
   between macrocycles (e.g. incline DB press ⇄ machine press, cable row ⇄
   chest-supported row) while keeping the mains stable, both for connective-
   tissue variety and to re-sensitize stimulus. The clean implementation is a
   per-slot variant list with rotation at realization→accumulation boundaries
   + an e1RM re-seed for the incoming variant — a full pass of its own, since
   every variant needs seeds, rep-tier review, and hist continuity handling. */
const LIB = {
  /* ---- ramped compound accessories (multi-joint, the program's heavy work) ---- */
  squat:        { label: "Back Squat",                     role: "acc",  barbell: true,  repTier: "compound", volumeGroup: "quads" },
  rdl:          { label: "Romanian Deadlift",              role: "acc",  barbell: true,  repTier: "compound", volumeGroup: "hamstrings" },
  bench:        { label: "Barbell Bench Press",            role: "acc",  barbell: true,  repTier: "compound", volumeGroup: "chest" },
  /* Incline DUMBBELL press. Separate exercise from inclinebb, not a label
     variant of it: the dumbbell version allows a deeper bottom position (the
     bar stops the barbell version at chest level) and is logged per dumbbell,
     so it carries a different load scale entirely. Keeping the `inclinebench`
     key on the dumbbell version preserves e1RM history for every program saved
     before the split, since that key has always been the DB press. */
  inclinebench: { label: "Incline DB Press (~30°)",        role: "acc",  barbell: false, perDumbbell: true, repTier: "compound", volumeGroup: "chest" },
  /* Machine dip: chest is the primary mover at the depth this is trained to,
     with the triceps long head loaded heavily as a secondary. volumeGroup is
     the PRIMARY mover by the engine's convention, so this counts to chest —
     the triceps landmark's lowered MEV (see PATTERNS.triceps) is where that
     secondary work is accounted for. */
  dip:          { label: "Dip Machine",                    role: "acc",  barbell: false, repTier: "compound", volumeGroup: "chest", increment: 10 },
  dbshoulderpress: { label: "DB Overhead Press",           role: "acc",  barbell: false, perDumbbell: true, repTier: "compound", volumeGroup: "front_delts" },
  tbarrow:      { label: "T-Bar Row",                      role: "acc",  barbell: false, repTier: "compound", volumeGroup: "back", increment: 10 },
  /* Pull-Up and Lat Pulldown are SEPARATE exercises, not one slot with a
     slash. They were briefly merged and that was a real modelling error, not
     just a naming one: a pull-up is `bodyweight: true`, so its e1RM is tracked
     as SYSTEM load (bodyweight + any added/assisted weight) and prescribe()
     runs the whole added-weight / unloaded-reps / assistance branch on it. A
     pulldown is an ordinary weight stack with none of that. Merging them meant
     one lift's history held two incompatible load scales. */
  pullup:       { label: "Pull-Up",                        role: "acc",  barbell: false, bodyweight: true, repTier: "compound", volumeGroup: "back" },
  pulldown:     { label: "Lat Pulldown",                   role: "acc",  barbell: false, repTier: "compound", volumeGroup: "back", increment: 10 },
  /* LOGGING CONVENTION for this and any future repTier:"unilateral" dumbbell
     exercise: log the weight of ONE dumbbell, assuming a matched pair (one in
     each hand) — the convention lifters already use mentally for split
     squats/lunges, and the one App.jsx's "Weight per dumbbell" field label
     (driven by prescribe()'s `unilateral` flag, not a bsplit-specific check)
     assumes. See ACC_E1RM_MULT.bsplit for how the seed ratio maps to this. */
  bsplit:       { label: "Bulgarian Split Squat",          role: "acc",  barbell: false, repTier: "unilateral", volumeGroup: "quads" },

  /* ---- ramped isolation accessories ----
     Several of these are chosen specifically because they load their target at
     LONG muscle length, which is the exercise-selection variable with the
     clearest recent evidence behind it (see the stretch-mediated hypertrophy
     note above ROTATION): overhead triceps extension, seated leg curl, lat
     pullover, Bayesian curl, and the deep positions of RDL/Bulgarian split
     squat above. */
  cablefly:     { label: "Seated Cable Fly",               role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "chest", increment: 10 },
  latpullover:  { label: "Machine Lat Pullover",           role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "back", increment: 10 },
  /* Machine and dumbbell lateral raises are separate exercises. The resistance
     profiles genuinely differ — a dumbbell's moment arm peaks near the top of
     the raise and vanishes at the bottom, while a machine (or cable) holds
     tension through the stretched position — so running both across the week
     is a real variation, not a relabel. `lateralraise` stays the machine
     version to keep e1RM history on the key that has always carried this slot. */
  /* increment 5, not 2.5: the athlete's machine stacks in clean 5 lb plates, so
     a 2.5 grid prescribed weights the equipment cannot actually be set to. An
     increment is a property of the hardware in the room, not a preference. */
  lateralraise: { label: "Machine Lateral Raise",          role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "side_delts", increment: 5 },
  dblateralraise: { label: "DB Lateral Raise",             role: "acc",  barbell: false, perDumbbell: true, repTier: "isolation", volumeGroup: "side_delts", increment: 2.5 },
  reversepecdeck: { label: "Reverse Pec Deck",             role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "rear_delts", increment: 2.5 },
  triext:       { label: "Overhead Cable Triceps Ext.",    role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "triceps" },
  /* Added at the athlete's request. increment 2.5 because this stack lands on
     half values (47.5, 52.5, ...). Takes over ONE of triext's three slots
     rather than adding a fourth: triceps volume is already tuned to its MAV,
     so an extra slot would only spread the same sets thinner across a longer
     session. Pushdown is elbow extension with the shoulder neutral, against
     triext's overhead position — different long-head length, so the pair is a
     genuine variation rather than a relabel. */
  triceppushdown: { label: "Triceps Pushdown",             role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "triceps", increment: 2.5 },
  bayesiancurl: { label: "Bayesian Cable Curl",            role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "biceps", increment: 2.5 },
  preachercurl: { label: "Preacher Curl",                  role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "biceps", increment: 2.5 },
  /* Promoted from fixedSets to ramped (was a flat 3 sets). With no squat/
     deadlift main lift left to carry quad and hamstring volume, these are the
     pools' primary drivers, not garnish — they ramp MEV->MRV like everything
     else. Seated leg curl specifically: hip flexion puts the hamstrings at
     long length, and Maeo et al. found substantially greater hamstring growth
     seated vs. lying at matched volume. */
  legcurl:      { label: "Seated Leg Curl",                role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "hamstrings", increment: 10 },
  /* Added at the athlete's request. Modelled `bodyweight: true` — the same
     path pull-ups use — because the resistance IS the athlete's own mass and
     progression runs through assistance rather than added plates: a negative
     load means "this much help from a band or partner", which the logging
     screen already labels correctly. Takes over one of legcurl's two slots
     rather than adding a third, for the same volume reason as the pushdown
     above. Knee flexion under a long eccentric, where the seated curl is
     concentric-dominant at a fixed hip angle. */
  nordic:       { label: "Assisted Nordic Curl",           role: "acc",  barbell: false, bodyweight: true, repTier: "isolation", volumeGroup: "hamstrings" },
  /* Leg extension is the one quad exercise that loads rectus femoris (the
     biarticular head) at all — every other quad slot here is simultaneous
     hip+knee extension, which under-stimulates RF specifically. Kassiano et
     al. (JSCR) found leg extension produced substantially greater RF growth
     than squat at all three measured sites (proximal +11.4% vs +2.0%, mid
     +12.3% vs +5.7%, distal +17.5% vs +7.9%); squat still wins on distal VL,
     so the program runs both. Caveat: 8 weeks, untrained women — treat the
     magnitude as suggestive. */
  legext:       { label: "Leg Extension",                  role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "quads", increment: 10 },
  calfraise:    { label: "Standing Calf Raise",            role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "calves" },

  /* ---- fixedSets accessories ----
     Flat set count, excluded from the landmark pools. These back muscles
     (a) receive very heavy indirect work from the ramped slots above and
     (b) have one approved exercise carrying the slot, so there is no second
     slot for a ramp to distribute volume across even if one were warranted. */
  shrug:        { label: "DB Shrug",                       role: "acc",  barbell: false, perDumbbell: true, fixedSets: 3, repTier: "isolation", volumeGroup: "traps" },
  wristcurl:    { label: "DB Wrist Curl",                  role: "acc",  barbell: false, perDumbbell: true, fixedSets: 3, repTier: "isolation", volumeGroup: "forearms" },
  cablecrunch:  { label: "Cable Crunch",                   role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", volumeGroup: "abs" },

  /* ---- defined but OUT OF ROTATION ----
     Kept so History labels and previously-logged e1RM records still resolve,
     and so migrateProgram can seed them if they ever return. They contribute
     nothing to volume math (fixedWeeklySets/PATTERN_FREQ/PATTERN_RAMPED_ACC all
     read the ROTATION, not LIB). All are on the athlete's approved list — the
     list explicitly does not require every entry to be used, and the ROTATION
     comment records why each of these sits out. They are also exactly the pool
     a future macrocycle variant-rotation pass would draw from, since each is a
     like-for-like swap for a slot that IS in the rotation. */
  frontsquat:   { label: "Front Squat",                    role: "acc",  barbell: true,  repTier: "compound", volumeGroup: "quads" },
  deadlift:     { label: "Deadlift",                       role: "acc",  barbell: true,  repTier: "compound", volumeGroup: "hamstrings" },
  dbbench:      { label: "DB Bench Press",                 role: "acc",  barbell: false, perDumbbell: true, repTier: "compound", volumeGroup: "chest" },
  inclinebb:    { label: "Incline Barbell Press (~30°)",   role: "acc",  barbell: true,  repTier: "compound", volumeGroup: "chest" },
  bbwristcurl:  { label: "Barbell Wrist Curl",             role: "acc",  barbell: true,  fixedSets: 3, repTier: "isolation", volumeGroup: "forearms" },
};

/* ---- rotation: which lifts each training day trains ----
   HYPERTROPHY REBUILD. The previous rotation was a strength program with
   accessories attached: three barbell main lifts (squat/bench/deadlift) with
   top-single-plus-backoff structure, block periodization that peaked into a
   1-2 rep re-test, and hypertrophy work filling whatever room was left. The
   athlete asked for the most hypertrophic program buildable from a fixed list
   of approved exercises, with the mandatory squat/bench/deadlift skeleton
   removed. That is what this is — every slot is now a ramped accessory chosen
   for stimulus, not for carrying a strength peak.

   SHAPE: 5 days, on a fixed weekly cycle:
     D0 Push   D1 Pull   D2 Legs   D3 Upper   D4 Lower + Pull

   WHY FIVE AND NOT FOUR. The rotation was 4 days, and it could not satisfy two
   requirements the athlete set explicitly: reach the ADVANCED weekly MAV for
   every muscle, and train every muscle at least 2x per calendar week. Measured
   against the 4-day rotation:
     • at 4x/week — back reached 20 sets against a MAV of 23, biceps 16 against
       18. Neither is fixable by adding sets to an existing day, because
       SAME_DAY_GROUP_CAP already binds at 10 there; back specifically needed a
       THIRD exposure day, which a 4-day rotation carrying two pull days has
       nowhere to put.
     • at every-other-day — a 4-day rotation takes 8 days to complete, so a
       muscle trained on 2 of its days gets 2 exposures per 8 days = 1.75x per
       week. That is arithmetic, not dosing: no amount of volume fixes it.
   Five days completes in exactly 7 at the 1.4-day target gap, so exposures per
   rotation ARE exposures per week, and the extra day gives back, side delts,
   calves, biceps and triceps the third exposure their advanced MAVs require
   under the same-day cap.

   WHY NOT SIMPLY TRAIN THE 4-DAY ROTATION FIVE TIMES A WEEK. It delivers the
   volume, but the rotation stops aligning with the calendar — 4 days consumed
   at 5 sessions/week means the week starts on a different day of the rotation
   each time, so no weekday ever holds the same session twice. A fixed weekly
   split is the thing that makes a 5-day schedule legible.

   BALANCE. The obvious alternative — pure upper/lower — was rejected after
   counting the approved list: 15 of its 23 exercises are upper-body, so an
   upper/lower split concentrates ~2/3 of the program into half the sessions
   (measured at ~49 sets on an upper day against ~20 on a lower one). The days
   below run 6-8 exercises each for the same reason.

   Frequency is used here as a volume-DISTRIBUTION tool, not as a stimulus in
   its own right: frequency is not independently anabolic when weekly volume is
   equated (Schoenfeld/Grgic meta-analyses), but per-SESSION volume does hit
   diminishing returns (~11 fractional sets/muscle; Robinson, Pelland, Zourdos
   et al.). Every muscle above 2 exposures here is there because its MAV does
   not fit under SAME_DAY_GROUP_CAP in fewer, not because more often is better.

   THIS SHAPE ASSUMES THE ATHLETE ACTUALLY TRAINS FIVE TIMES A WEEK. Measured,
   the same rotation at a 1.6-day gap (~4.4x/week) drops 6 groups below their
   MAV and 4 below 2x/week; at 1.75 days (4x/week) it is 9 and 4. A 5-day
   program run 4 days a week is strictly worse than a 4-day program run 4 days
   a week, and capacityShortfalls() will say so on the Status screen rather
   than letting it pass silently.

   EXERCISE SELECTION is biased toward loading at LONG muscle length wherever
   the approved list offers the choice, the one exercise-selection variable
   with clear recent evidence attached: overhead cable triceps extension over
   any pressdown (Maeo et al. 2022 — ~40% greater triceps growth, long head
   loaded overhead), seated leg curl over lying (Maeo et al. — hip flexion
   lengthens the hamstring), machine lat pullover, Bayesian cable curl, plus
   the deep positions of RDL and Bulgarian split squat. A 2025 systematic
   review found longer-muscle-length training produced greater hypertrophy in
   7 of 8 included studies.

   TWO APPROVED EXERCISES CARRY NO SLOT, both deliberately:
     • Deadlift — dropped. It is a poor hypertrophy tool per unit of fatigue:
       enormous systemic and lower-back cost, grip-limited, and no single
       muscle spends much time under tension at long length. RDL delivers the
       hamstring stimulus with a fraction of the recovery debt, and the back
       work is better served by T-bar row / pull-up / pullover. This is the
       one place the rebuild removes something the athlete listed; it is on
       the list and stays in LIB, so re-adding it is a one-line change.
     • Front Squat — redundant here. Back squat, Bulgarian split squat and two
       leg-extension exposures already give quads 4 ramped slots across 2 days
       (20 sets/rotation capacity against an advanced MAV of 18); a fifth quad
       slot would displace volume from a muscle that still needs it. Kept in
       LIB as a ready back-squat variant.

   volumeDay is gone with the main lifts — it existed to give a barbell main a
   differentiated second weekly exposure, and every exercise here now runs the
   same straight-set prescription every time it appears.

   SLOT BUDGET — capacity per rotation (cap-aware, i.e. what maxDeliverable
   actually computes, NOT slots x ACC_SET_CAP: a group landing two ramped slots
   on one day is bounded by SAME_DAY_GROUP_CAP, so two slots on a day are worth
   10 sets and not 12) against the ADVANCED landmarks, which is the tier this
   5-day shape exists to satisfy. At the 1.4-day target gap freqScale is 1.0,
   so per-rotation capacity IS the per-week number the landmarks are in:
     back    3 days (2+2+1) -> 26 (MAV 23)   chest   2 days (2+2) -> 20 (MAV 18)
     quads   2 days (2+2)   -> 20 (MAV 18)   side_delts 3 (1+1+1) -> 18 (MAV 18)
     calves  3 days (1+1+1) -> 18 (MAV 18)   biceps  3 (1+1+1)    -> 18 (MAV 18)
     triceps 3 days (1+1+1) -> 18 (MAV 15)   hamstrings 2 (1+2)   -> 16 (MAV 10)
     rear_delts 2 (1+1)     -> 12 (MAV 11)   front_delts 2 (1+1)  -> 12 (MAV 9)
   Every tracked group clears its ADVANCED MAV and every one is trained at
   least 2x/week. side_delts, calves and biceps sit exactly ON their MAV with
   no headroom — they have 2, 1 and 2 approved exercises respectively, so the
   third exposure is a repeat of a movement already used that week. If the
   landmark auto-tune ever raises one of those, the Status screen's capacity
   warning is what will surface it.

   WHY BACK GETS THREE DAYS AND MOST GROUPS TWO: an advanced back MAV of 23
   cannot be reached in two days. SAME_DAY_GROUP_CAP bounds one day at 10 sets
   however many slots it holds, so two days cap out at 20. Three days (10 + 10
   + 6) reach 26. The third exposure is the lat pullover on the Lower day,
   placed there rather than on a press day because it shares no fatigue with
   squatting or hinging.

   ORDER WITHIN A DAY: compounds before isolation for the same muscle, and no
   isolation exercise that pre-fatigues a later compound's weak link (e.g.
   curls never precede a row, wrist work never precedes a pull). The only
   index-sensitive logic is the earlierPrimed warmup check, which keys off
   volumeGroup. */
/* MOVEMENT PATTERN — a second axis the slot budget above cannot see, and the
   reason this rotation was wrong on its first pass.

   volumeGroup answers "which muscle does this grow". It does NOT answer "is
   this the same movement as the one before it". Pull-Up and Lat Pulldown are
   both volumeGroup "back", so the capacity math treats them as two
   interchangeable back slots and is perfectly happy to put them back to back
   — which is what shipped. They are the same vertical pull twice: the second
   one is the first one pre-fatigued, buying redundant stimulus at full
   recovery cost. Incline DB Press and DB Overhead Press are a subtler version
   of the same error: different volumeGroups (chest / front_delts) but a ~30°
   incline is already heavily front-delt, so stacking them in one session
   trains the same tissue twice while the landmark ledger records it as two
   separate muscles being served.

   The athlete caught both by reading a real session. Slotting exercises to
   satisfy capacity WITHOUT this axis is how it happened, so pattern is now a
   real field, and program_review_tests asserts the pairing rules below.

   WHAT THE RULES ARE, AND ARE NOT. A first pass at this over-corrected into
   "nothing same-pattern adjacent" and "no session repeats a compound pattern",
   which the athlete rejected: two presses or two pulls in a row is ordinary
   training, not a defect. The rules that survived are the ones they actually
   hold, and they are narrower and sharper:
     • Pull-Up and Lat Pulldown never share a session. Not "not adjacent" —
       never together. They are the same movement against the same muscles,
       and doing both in one day is one exercise done twice.
     • No pressing on a lower-body day. Delt work does not get parked on leg
       day just because leg day has room for it.
     • No incline press in the same session as an overhead press. The overlap
       here is the ANGLE, not the implement: swapping incline DB for incline
       BB changes nothing, because a ~30 degree incline loads the front delt
       either way. Only moving to a FLAT press resolves it. */
const PATTERN_OF = {
  bench: "horiz push", dbbench: "horiz push", inclinebench: "incline push", inclinebb: "incline push",
  dip: "decline push", cablefly: "chest iso", dbshoulderpress: "vertical push",
  tbarrow: "horiz pull", pullup: "vertical pull", pulldown: "vertical pull", latpullover: "lat iso",
  lateralraise: "delt iso", dblateralraise: "delt iso", reversepecdeck: "rear delt iso",
  triext: "triceps iso", triceppushdown: "triceps iso",
  bayesiancurl: "biceps iso", preachercurl: "biceps iso",
  squat: "squat", frontsquat: "squat", bsplit: "lunge", legext: "quad iso",
  rdl: "hinge", deadlift: "hinge", legcurl: "ham iso", nordic: "ham iso",
  calfraise: "calf", shrug: "trap", wristcurl: "forearm", bbwristcurl: "forearm",
  cablecrunch: "abs",
};

const ROTATION = [
  { name: "Push · Chest & Delts", items: ["bench", "dbshoulderpress", "cablefly", "lateralraise", "triext", "calfraise", "cablecrunch"] },
  /* triceppushdown lands on the pull day for the same reason triext used to:
     with two approved triceps movements and an advanced MAV of 15, two
     exposures would force 10 and 6 sets into two sessions. A third splits it
     6/6/6, and triceps are fully recovered here precisely because this day's
     work is pulling.
     BACK PAIRING: T-bar row (horizontal) + lat pulldown (vertical). The two
     back slots this day needs are now deliberately DIFFERENT patterns — one
     pulls toward the waist, one overhead — so the second is not the first
     with fatigue on top. */
  { name: "Pull · Back & Arms", items: ["tbarrow", "pulldown", "reversepecdeck", "bayesiancurl", "triceppushdown", "shrug", "wristcurl"] },
  /* NO PRESSING ON THIS DAY. An earlier pass parked the overhead press here on
     the reasoning that leg day is the only session with no other pressing, so
     front delts would arrive fresh. The athlete rejected it outright: a leg
     day is for legs. `lowerBody: true` marks it so the rule is machine-checked
     rather than left to whoever edits this next.
     Lateral raises do stay — side delts need a third exposure, they cost
     almost nothing systemically, and they share no fatigue with squatting.
     They are also not a press. */
  { name: "Legs · Quads", lowerBody: true, items: ["squat", "legext", "legcurl", "lateralraise", "calfraise", "cablecrunch"] },
  /* ORDER ALTERNATES PUSH AND PULL: incline press, pull-up, dip, pullover. The
     two chest compounds and the two back movements are each separated by the
     other pattern, so nothing same-pattern is adjacent and each muscle gets
     the other's working time as recovery. Compounds still precede isolation
     within a muscle (inclinebench before dip, pullup before latpullover), and
     curls still follow every pull. No overhead press on this day. */
  /* THE SECOND OVERHEAD-PRESS EXPOSURE LIVES HERE, and the flat bench is what
     makes that possible. Front delts have exactly one approved exercise and
     need two training days, so the press has to appear twice. It cannot go on
     either lower-body day, which leaves only the two chest days and the pull
     day — and pairing it with an INCLINE press is the overlap the athlete
     rejected. Running a FLAT press on this day resolves it: flat pressing
     loads the front delt far less than an incline, so bench and overhead press
     coexist here the same way they already do on the Push day.
     THE COST, STATED PLAINLY: the program now carries no incline pressing at
     all. Incline DB press stays in LIB and on the approved list, so restoring
     it is a one-line change — but it cannot return to a day that also holds
     the overhead press. */
  { name: "Upper · Full", items: ["bench", "dip", "dbshoulderpress", "pullup", "latpullover", "dblateralraise", "triceppushdown", "preachercurl"] },
  { name: "Lower · Hinge & Pull", lowerBody: true, items: ["rdl", "bsplit", "legext", "nordic", "latpullover", "reversepecdeck", "bayesiancurl", "calfraise"] },
];
const ROT = ROTATION.length;
/* PATTERN_FREQ counts RAMPED ACCESSORY SLOTS per group across the rotation —
   not distinct training days (e.g. both front-delt slots land on the same
   Bench day). That is the intended semantics everywhere it's used: it divides
   the weekly residual across slots in prescribe()/rampedSlotSets, and it
   multiplies the per-slot cap in maxDeliverable. Nothing in the engine reads
   it as "days per week this muscle is trained". */
const PATTERN_FREQ = (() => {
  const f = {};
  ROTATION.forEach((d) => d.items.forEach((k) => {
    if (LIB[k].fixedSets) return;
    const p = LIB[k].volumeGroup; f[p] = (f[p] || 0) + 1;
  }));
  return f;
})();
/* Per-group ramped-slot counts broken out BY DAY, in rotation order — e.g.
   quads -> [2, 0, 2, 0] flattened to the non-zero days [2, 2]. PATTERN_FREQ is
   the sum of these; this keeps the shape, which is what SAME_DAY_GROUP_CAP
   needs to be applied inside the volume math rather than only as a prescribe()
   post-pass (T1-1). Each entry is { day, n }. */
const PATTERN_DAY_SLOTS = (() => {
  const f = {};
  ROTATION.forEach((d, day) => {
    const c = {};
    d.items.forEach((k) => {
      if (LIB[k].fixedSets) return;
      const p = LIB[k].volumeGroup; c[p] = (c[p] || 0) + 1;
    });
    Object.entries(c).forEach(([p, n]) => { (f[p] = f[p] || []).push({ day, n }); });
  });
  return f;
})();
/* Position of one rotation slot within its GROUP's rotation-wide slot ordering,
   keyed `${dayIndex}:${exerciseKey}`. rampedAllocation returns a per-slot array
   in that same ordering, so prescribe() looks up which element belongs to the
   item it is currently prescribing. A key can repeat across days but never
   within one day, so the composite key is unique. */
const SLOT_ORDINAL = (() => {
  const idx = {}, seen = {};
  ROTATION.forEach((d, day) => d.items.forEach((k) => {
    if (LIB[k].fixedSets) return;
    const p = LIB[k].volumeGroup;
    seen[p] = seen[p] || 0;
    idx[`${day}:${k}`] = seen[p]++;
  }));
  return idx;
})();
/* Hard per-exposure set cap: prescribe() never assigns a single ramped-slot
   APPEARANCE more than this many sets, however high the landmark target
   climbs — a lift appearing N times/week can still deliver up to N x this.
   AUDIT 3.11: raised from 4. At 4, this constant sat below the per-session
   ceiling the volume literature actually supports (RP's own stated 8-12
   direct sets/muscle/session before diminishing returns, corroborated by a
   2025 meta-regression — Pelland, Remmert, Zourdos et al., Sports Medicine),
   and combined with the flat per-group exposure counts (PATTERN_FREQ) it
   left total schedule capacity at 94 sets/rotation against landmark demand
   of 149 sets/rotation at this table's own (pre-3.11) intermediate MRVs —
   63% deliverable, worse at higher experience tiers since capacity doesn't
   scale with them (see landmarksForExperience) while MRV does. 6 is a
   deliberate middle point, not the literature's full 8-12 ceiling: pushed to
   7, every group reaches its MAV but peak single-session volume hit 44 sets;
   6 keeps peak session growth to +10 sets (30 -> 40) while still bringing
   7 of 8 muscle groups up to their MAV. The remaining shortfall (front delts
   specifically) is consistent with RP's own numbers — it's the one group
   RP says needs the least direct volume in the first place. */
const ACC_SET_CAP = 6;
/* AUDIT 3.13: session-level cap on same-muscle RAMPED volume. ACC_SET_CAP
   bounds each ramped slot's OWN set count, but several groups land two ramped
   slots on the SAME day — so raising ACC_SET_CAP (audit 3.11) raised
   same-SESSION volume for those groups by 2x the cap, not just weekly volume.
   By late block that reached 12 sets for one muscle — two compound movements —
   in a single session, above the per-session ceiling (~8-12 sets/muscle, audit
   3.11's own research) this program otherwise respects. 10 was chosen by
   checking the alternative: 8 also caps the session correctly but drags the
   affected groups' WEEKLY totals below their own MAV by late block.
   PHASE 4 (T1-1): the groups that stack are quads (D0, D2), chest (D0, D2),
   back (D1, D3), hamstrings (D1) and biceps (D3) — FIVE groups, not just back
   as this comment previously claimed. That stale claim mattered: the choice of
   10 over 8 was justified against back's weekly total alone, and the four other
   stacking groups were never in that analysis. Re-checked at 10 across all
   five, none is dragged below its MAV. Scoped to RAMPED sets only — fixedSets
   accessories are a deliberately stable floor, and no group stacks a fixedSets
   item on top of already-capped ramped volume for the same muscle on one day.
   This cap is applied inside rampedAllocation (NOT only as a prescribe()
   post-pass, which was the T1-1 defect), so the capacity math sees it. */
const SAME_DAY_GROUP_CAP = 10;
/* ---- fixedSets accessories still shrink with block volume tier + readiness ---- */
const VOL_SCALE = { ramp: 1, mev: 0.75, half: 0.5 };
/* Fewest sets a RAMPED slot may be prescribed, by block volume tier. Two in
   accumulation, because a single working set of an exercise is not a
   prescription any coach would write — it is a warm-up with extra steps, and
   with 3-4 slots sharing a pool the MEV end of the ramp lands there by
   arithmetic (chest MEV 5 across 4 slots rounds to 1 apiece). Flooring at 2
   overshoots MEV slightly in the block's opening cycle, which is harmless in
   the direction that matters: MEV is a MINIMUM, and the ramp is climbing away
   from it immediately. Deload keeps a floor of 1 — that block's whole job is
   to be small, and one set there is a genuine movement-maintenance dose.
   KNOWN LIMIT (found verifying the Phase 4 T1-2 fix, not reported by the
   audit): when floor x slot-count already meets a group's scaled MAV, the
   floor consumes the entire ramp and that group is flat for the block no
   matter what the target does. Today that is hamstrings at exactly 5x/week:
   3 slots x floor 2 = 6 sets, against a scaled MAV of round(8 x 0.8) = 6. It
   is a consequence of hamstrings having the narrowest MEV->MAV span of any
   group (4 sets) spread over 3 slots, not of the frequency scaling — the
   group still ramps at 4x and at 6x. Deliberately NOT fixed by lowering the
   floor, which would trade a real problem (1-set prescriptions) for a
   cosmetic one; the structural fixes would be fewer hamstring slots or a
   wider span, both program-design changes rather than volume-math ones.
   engine_fix_tests asserts that every flat group is explained by this exact
   condition, so a flat group WITHOUT it (the T1-2 bug returning) still
   fails. */
const RAMPED_SET_FLOOR = { ramp: 2, mev: 2, half: 1 };

/* ---- full-muscle volume accounting ----
   Landmark MEV/MAV/MRV are RP-style FULL-MUSCLE weekly hard-set counts, so
   every hard set for the muscle counts toward them 1:1 — main-lift sets and
   fixedSets accessories included (volumeGroup is the exercise's PRIMARY mover,
   so full credit; fractional credit for secondary movers is a refinement this
   engine deliberately skips). The landmark ramp therefore prescribes the
   RESIDUAL: ramped accessories fill the gap between the block's weekly target
   and the fixed contribution the schedule already delivers.
   Before this accounting, mains + fixedSets (11 quad / 7 hamstring / 8 chest
   weekly sets in accumulation) counted toward nothing: accessory capacity
   alone could never reach the landmarks, so the volume ramp for those groups
   was pinned flat from cycle 0 and the atVolCeiling transition could
   mathematically never fire. */

/* Weekly sets a group receives from sources that do NOT ramp: fixedSets
   accessories only (scaled by the block's volume tier). Green-readiness
   nominal, same as weeklyTarget. Since the hypertrophy rebuild removed the
   main lifts, the only groups with a non-zero fixed contribution are the three
   fixedSets pools (traps/forearms/abs), and those aren't landmark-tracked — so
   in practice this returns 0 for every landmark group and the ramp carries the
   whole target. Kept general rather than inlined as 0: fixedSets is still a
   supported LIB shape, and a future fixedSets accessory on a tracked pool must
   not silently double-count. */
function fixedWeeklySets(group, blockType) {
  const cfg = BLOCKS[blockType];
  let total = 0;
  ROTATION.forEach((d) => d.items.forEach((k) => {
    const L = LIB[k];
    if (L.volumeGroup !== group) return;
    if (L.fixedSets) total += Math.max(1, Math.round(L.fixedSets * VOL_SCALE[cfg.volLevel]));
  }));
  return total;
}

/* The most weekly sets a group can ACTUALLY receive in a block: its fixed
   contribution plus every ramped slot at ACC_SET_CAP. A weekly target above
   this is a ceiling the ramp can aim at but the schedule can never deliver —
   ceiling/transition and auto-tune decisions clamp to it, so the engine never
   treats undeliverable volume as if it had been trained. blockType defaults to
   accumulation, the only block with a volume ramp. */
function maxDeliverable(group, blockType = "accumulation") {
  /* T1-1: capacity must respect SAME_DAY_GROUP_CAP. A group with two ramped
     slots on one day cannot deliver 2 x ACC_SET_CAP that day — the session cap
     bounds the pair. Computing this as ACC_SET_CAP x PATTERN_FREQ overstated
     capacity by 4 sets for quads/chest/back and 2 for hamstrings/biceps, and
     because the landmark auto-tune's raise gates are computed from it, MAV
     settled 2-3 sets ABOVE anything the schedule could ever prescribe. */
  const ramped = (PATTERN_DAY_SLOTS[group] || []).reduce((s, { n }) =>
    s + (n >= 2 ? Math.min(n * ACC_SET_CAP, SAME_DAY_GROUP_CAP) : n * ACC_SET_CAP), 0);
  return fixedWeeklySets(group, blockType) + ramped;
}

/* ---- per-tier rep + RPE targets ----
   Since the hypertrophy rebuild there is no main-lift path: EVERY exercise is
   prescribed from this table.

   REPS. Load is close to irrelevant for hypertrophy across roughly 5-30 reps
   provided sets are taken near failure — meta-analyses spanning ~3 to ~35 reps
   find effectively identical growth (heavy 8.3% vs light 7.0%, a gap smaller
   than chance). Load matters for STRENGTH, which this program is no longer
   built around. So rep targets here are chosen for practicality inside that
   flat zone, not because a "hypertrophy rep range" exists: compounds carry the
   heaviest absolute load, unilateral sits higher because it is
   stability-limited (load stops being the limiter first), and isolation sits
   highest because single-joint work is the safest place to train near failure
   and the double-progression rule in prescribe() needs rep headroom to climb.
   ATHLETE PREFERENCE: every tier was scaled down by 2 reps (compound 8->6,
   unilateral 10->8, isolation 12->10) at the athlete's request. This is a
   preference call the evidence explicitly permits rather than a correction —
   6 reps sits comfortably inside the flat 5-30 band, so predicted growth is
   unchanged. The real trade is that fewer reps at the same RPE means MORE
   LOAD: measured at cycle 3, bench 210 -> 220 lb, squat 290 -> 310 lb, cable
   fly 50 -> 60 lb, roughly +5-12% across the board. Same stimulus by the
   literature, more absolute tonnage through the joints per set, and fewer reps
   per set in which to accumulate it. If anything starts to nag, this constant
   is the first place to look, not the volume landmarks.

   EFFORT ramps across the mesocycle, all three tiers, which is the other half
   of the RP-style progression the volume ramp implements: rpe is the cycle-0
   base, rpeStep advances it per cycle, rpeCap bounds it. Accumulation opens at
   RPE 7 (~3 reps in reserve) and finishes at RPE 9-10 (~0-1 RIR). This is
   directly supported: proximity to failure has a meaningful dose-response for
   hypertrophy specifically (unlike strength, which is largely insensitive to
   it), with growth improving as RIR falls toward 0 and degrading sharply past
   ~5 RIR (Robinson et al. 2024 meta-regression). Starting the block at 3 RIR
   rather than at failure is what makes the volume ramp survivable — you cannot
   add sets every cycle AND be at 0 RIR from cycle 0.
   Previously only isolation ramped effort; compounds sat flat at 7.5, which
   left the heaviest exercises at ~2.5 RIR for an entire block. */
const ACC_REP_TIERS = {
  accumulation: {
    /* Compounds cap at RPE 9 (~1 RIR) and never at 10. Taking multi-joint work
       to true failure costs far more systemic fatigue per unit of stimulus than
       it returns, and the same meta-analytic evidence that pushes RIR toward 0
       also finds absolute failure unnecessary — 1-2 RIR matches training to
       failure for growth in trained lifters. Isolation caps at 9.5 (~0-1 RIR):
       single-joint work is where near-failure training is cheap and safe. The
       previous table ran isolation to a hard RPE 10 from cycle 4 onward, which
       put EVERY set of EVERY isolation exercise at true failure for the back
       third of a block — that is the fatigue the deload then has to clear, paid
       for with stimulus the last half-rep never delivered. */
    compound:   { reps: 6,  rpe: 7,   rpeStep: 0.5, rpeCap: 9 },
    unilateral: { reps: 8,  rpe: 7,   rpeStep: 0.5, rpeCap: 9 },
    isolation:  { reps: 10, rpe: 7.5, rpeStep: 0.5, rpeCap: 9.5 },
  },
  /* Deload rep targets TRACK the accumulation targets exactly — the deload's
     job is to keep the movement pattern and drop the effort (RPE 6/6.5), not
     to change what the exercise is. Scaled down with them so the two stay
     aligned; a deload prescribing MORE reps than the block it is unloading
     would be a strange thing to hand someone. */
  deload: {
    compound:   { reps: 6,  rpe: 6 },
    unilateral: { reps: 8,  rpe: 6 },
    isolation:  { reps: 10, rpe: 6.5 },
  },
};

/* ---- block configurations ----
   HYPERTROPHY REBUILD: the old four-block strength cycle (accumulation →
   deload → intensification → deload → realization) is gone. Intensification
   (mains at 2-3 reps, RPE ceiling 9.5, volume cut to MEV) and realization (a
   1-2 rep max re-test) are peaking constructs — they exist to express strength
   on a competition lift, and both spend weeks at volumes below what drives
   growth. Neither has a defensible role in a program whose only goal is
   hypertrophy, and there is no evidence that interrupting accumulation to test
   a max improves growth.
   What remains is the RP hypertrophy mesocycle and nothing else:
     accumulation (MEV → MRV over 3-6 cycles, RPE 7 → 9-10) → deload → repeat.
   Volume ramps, effort ramps, then a single low-volume low-effort cycle
   dissipates fatigue and the next block starts over from MEV — at landmarks
   the auto-tune has re-fitted from the block that just happened (see
   adjustLandmarks). backoffDrop/backoffRpeCap are retained on each block only
   because ingest()'s backoff-drift fatigue channel and the logging UI still
   read them; with no main lifts nothing is prescribed a backoff set today
   (backoffSetCount is always 0), so they are inert but harmless. */
const BLOCKS = {
  accumulation: {
    label: "Accumulation", emphasis: "volume",
    backoffRpeCap: 9,
    volLevel: "ramp",
    minCycles: 3, maxCycles: 6,
  },
  deload: {
    label: "Deload", emphasis: "recovery",
    backoffRpeCap: 6,
    volLevel: "half",
    minCycles: 1, maxCycles: 1,
  },
};
/* Block types that existed only in the old strength cycle. migrateProgram()
   maps a saved program sitting in one of these onto a fresh accumulation
   block; this set is what it tests against, and what History rendering falls
   back on for already-logged sessions stamped with an old block name. */
const LEGACY_BLOCK_TYPES = { intensification: "Intensification", realization: "Re-test" };

/* Weekly TOTAL hard-set target for a landmark group this cycle (full-muscle:
   mains + fixedSets + ramped accessories all count — see the accounting note
   above maxDeliverable).
   CALENDAR-TIME ASSUMPTION: "weekly" here means ONE FULL ROTATION (ROT=4
   sessions), not 7 calendar days. `freqScale` (from weeklyFreqScale(), see
   above maxDeliverable) is how many calendar weeks one rotation pass actually
   spans at the athlete's real training frequency — pass it and this scales
   its result accordingly (`freqScale` defaults to 1 = the old 4x/week-only
   assumption, for any caller that hasn't been updated to pass it).
   At 3x/week (freqScale>1) one rotation takes LONGER than a week, so it needs
   MORE than the raw weekly figure to average out to the correct true-weekly
   rate once delivered over that longer span; at 5x/week (freqScale<1) the
   opposite. This return value stays a PER-ROTATION figure — scaled UP or DOWN
   so that dividing it back by the same freqScale reconstructs the true weekly
   rate (see rampedSlotSets/deliveredWeekly below, and the ceilingHit/
   adjustLandmarks call sites that already do that division).

   RAMP ENDPOINT IS MAV, NOT MRV (changed in the hypertrophy rebuild). RP's
   textbook mesocycle ramps a muscle from MEV toward its MRV, and that is what
   this used to do — but that model is written per-muscle, for a program where
   a handful of muscles are being pushed at a time. This program tracks TEN
   landmark groups and ramps all of them on the same schedule, and the sum of
   ten individual MRVs is far more than any athlete systemically recovers from:
   MRV is defined as the volume a muscle can *barely* recover from, so hitting
   ten of them simultaneously is not ten muscles at their limit, it is one
   athlete well past theirs. Measured on this rotation, an MRV endpoint
   delivered 175 sets per rotation and a 47-set peak session; an MAV endpoint
   delivers a peak in the 120s with every group still inside the 10-20
   sets/week band where the volume dose-response evidence is strongest, and MAV
   is in any case the landmark RP itself defines as "the volume that produces
   the best gains over time" — MRV is a recovery boundary, not a target.
   MRV keeps three real jobs: it bounds how far MAV can be auto-tuned upward
   (see adjustLandmarks), it feeds the schedule-capacity math, and it is what
   the athlete sees as the ceiling on the Status screen.
   Progression across mesocycles therefore comes from MAV drifting upward
   block-over-block under the auto-tune, not from the ramp reaching further
   into a fixed range. */
function weeklyTarget(group, blockType, cycleInBlock, landmarks, freqScale = 1) {
  const lm = landmarks[group]; // group is a landmark key (volumeGroup, e.g. 'back')
  const cfg = BLOCKS[blockType];
  let target;
  if (cfg.volLevel === "half") target = lm.mev * 0.5;
  else if (cfg.volLevel === "mev") target = lm.mev;
  else {
    const span = Math.max(1, cfg.maxCycles - 1);
    const frac = Math.min(1, cycleInBlock / span);
    target = lm.mev + (lm.mav - lm.mev) * frac;
  }
  return Math.round(target * freqScale);
}

/* Sets prescribed to ONE ramped accessory slot of `group` this cycle (green
   readiness): the residual left after the fixed contribution, split across the
   group's slots, floored at 1 (a movement-maintenance set — an exercise is
   never dropped to zero mid-block just because mains already cover the
   target) and capped at ACC_SET_CAP. prescribe() and the ceiling math below
   both go through this, so what's checked is exactly what's prescribed.
   `freqScale` passes straight through to weeklyTarget; fixedWeeklySets and
   ACC_SET_CAP are deliberately NOT scaled — fixedWeeklySets is a real
   structural count (mains + fixedSets accessories) delivered exactly once per
   rotation regardless of how long that rotation takes in calendar time, and
   ACC_SET_CAP is a per-exposure schedule-capacity ceiling, not a rate. Only
   the ramped-accessory residual — the part of the volume math that actually
   flexes to hit a weekly landmark target — gets frequency-compensated. */
function rampedAllocation(group, blockType, cycleInBlock, landmarks, freqScale = 1) {
  const wk = weeklyTarget(group, blockType, cycleInBlock, landmarks, freqScale);
  const freq = PATTERN_FREQ[group] || 1;
  const residual = Math.max(0, wk - fixedWeeklySets(group, blockType));
  /* T1-2: the floor is frequency-scaled, like the target it clamps. It is a
     per-exposure count, but weeklyTarget has already been multiplied by
     freqScale, so an UNSCALED floor is being compared against a scaled target —
     and below freqScale 1 (training more than 4x/week) the scaled target fell
     under the raw floor for an entire block, pinning every cycle at the floor.
     At 6x/week that flattened quads, chest and hamstrings completely: identical
     volume in all six cycles, no ramp at all, for exactly the athlete the
     frequency machinery is meant to serve. At freqScale 1 this is unchanged
     (round(2 x 1) = 2), so 4x/week behaviour is byte-identical. */
  const floorRaw = RAMPED_SET_FLOOR[BLOCKS[blockType].volLevel] ?? 1;
  const floor = Math.max(1, Math.round(floorRaw * freqScale));
  /* T1-3: distribute the residual and hand out the remainder one set at a time,
     instead of giving every slot the same Math.round(residual / freq). The
     single-quotient version could only produce per-rotation totals that were
     multiples of PATTERN_FREQ, so the ramp advanced in jumps of 3-4 sets and
     collapsed to two or three distinct levels across a six-cycle block —
     hamstrings got 6,6,6,6,6,9, i.e. no progression at all in any block ending
     before its last cycle. It also overshot: rounding UP at the top of the ramp
     put 8 of 10 groups above their own MAV (quads 16 vs 14). Distributing lands
     the top of the ramp exactly on MAV and roughly doubles the number of
     distinct volume steps. Slots of the same group on the same day can now
     differ by one set, which is ordinary programming, not an artifact. */
  const base = Math.floor(residual / freq);
  const rem = residual - base * freq;
  const alloc = [];
  for (let i = 0; i < freq; i++)
    alloc.push(Math.max(floor, Math.min(ACC_SET_CAP, base + (i < rem ? 1 : 0))));
  /* SAME_DAY_GROUP_CAP applied HERE, not only in prescribe(), so that
     deliveredWeekly/maxDeliverable see the same number the athlete is handed
     (T1-1). */
  let i = 0;
  let freed = 0;
  const dayRanges = [];
  (PATTERN_DAY_SLOTS[group] || []).forEach(({ n }) => {
    if (n >= 2) {
      const tot = alloc.slice(i, i + n).reduce((s, v) => s + v, 0);
      if (tot > SAME_DAY_GROUP_CAP) {
        const sc = SAME_DAY_GROUP_CAP / tot;
        for (let j = i; j < i + n; j++) { const was = alloc[j]; alloc[j] = Math.max(1, Math.round(was * sc)); freed += was - alloc[j]; }
      }
    }
    dayRanges.push({ start: i, n });
    i += n;
  });
  /* RE-OFFER WHAT THE CAP FREED to a day that still has room. The comment that
     stood here said redistributing "would just push those days over the same
     limit" — true of the days that were capped, false of the ones that were
     not. Back is the shape that exposes it: three exposure days, two of them
     carrying a pair of slots and one carrying a single. When the target
     exceeds capacity the even split hands the pair-days 6 each, the cap scales
     them back to 5, and the single-slot day keeps the 5 it was dealt while
     having room for 6 — 25 of 26 available sets, and the missing one sits on a
     day nothing was ever going to overload.
     Bounded by both ACC_SET_CAP per slot and SAME_DAY_GROUP_CAP per day, so a
     recipient day can never be pushed past either. Worth ~1 set/week on back
     and only below the design cadence; at Mon-Fri the target never exceeds
     capacity and nothing is freed at all. */
  for (let pass = 0; pass < 2 && freed > 0; pass++) {
    for (const { start, n } of dayRanges) {
      if (freed <= 0) break;
      const dayTot = () => alloc.slice(start, start + n).reduce((s, v) => s + v, 0);
      for (let j = start; j < start + n && freed > 0; j++) {
        if (alloc[j] >= ACC_SET_CAP) continue;
        if (n >= 2 && dayTot() >= SAME_DAY_GROUP_CAP) break;
        alloc[j] += 1; freed -= 1;
      }
    }
  }
  return alloc;
}

/* Sets for ONE ramped slot. `slotOrdinal` selects which of the group's
   rotation-wide slots this is (see SLOT_ORDINAL); it defaults to 0 so callers
   that only want a representative figure keep working. */
function rampedSlotSets(group, blockType, cycleInBlock, landmarks, freqScale = 1, slotOrdinal = 0) {
  const alloc = rampedAllocation(group, blockType, cycleInBlock, landmarks, freqScale);
  return alloc[slotOrdinal] ?? alloc[0] ?? 1;
}

/* Total weekly sets the schedule actually delivers for `group` this cycle
   (green readiness): fixed contribution + every ramped slot. THIS — not the
   raw weeklyTarget — is what ceiling checks and the landmark auto-tune compare
   against MEV/MAV/MRV, so decisions are made about volume that was really
   prescribed. `freqScale` passes through to rampedSlotSets; callers that need
   a true-weekly RATE (comparable to a weekly-unit landmark) still divide this
   PER-ROTATION return value by the same freqScale externally, exactly as
   before — passing freqScale in here makes that division land on volume that
   ACTUALLY reflects what prescribe() delivers at the real frequency, instead
   of silently drifting stale once prescribe() itself became frequency-aware. */
function deliveredWeekly(group, blockType, cycleInBlock, landmarks, freqScale = 1) {
  /* T1-1: sums the ACTUAL per-slot allocation rather than multiplying one
     representative slot by PATTERN_FREQ. The old form could not see either the
     same-day cap or the uneven remainder distribution, so it reported up to 4
     more sets than prescribe() delivered — and every ceiling check and
     auto-tune gate downstream was reasoning about that phantom volume. */
  return fixedWeeklySets(group, blockType)
    + rampedAllocation(group, blockType, cycleInBlock, landmarks, freqScale)
        .reduce((s, v) => s + v, 0);
}

/* The volume ceiling a block can actually reach for `group`: the top of its
   ramp, unless the schedule saturates first.
   Since the hypertrophy rebuild the ramp tops out at MAV, not MRV (see
   weeklyTarget) — so MAV is what a block can actually reach, and using MRV here
   would report a ceiling the ramp is deliberately never aiming for. MRV remains
   the recovery bound on how far MAV may be auto-tuned. */
function effectiveCeiling(group, blockType, landmarks, freqScale = 1) {
  /* T2-5: takes freqScale so it returns a TRUE WEEKLY rate comparable to the
     landmark it is checked against — capacity is a per-rotation figure, and at
     any cadence other than 4x/week those are different numbers. Defaulting to
     1 keeps every existing caller's meaning intact. */
  return Math.min(landmarks[group].mav, maxDeliverable(group, blockType) / freqScale);
}

/* ---- frequency-aware volume comparison ----
   weeklyTarget/deliveredWeekly/maxDeliverable all count sets per ONE ROTATION
   PASS (ROT sessions). That equals a calendar week only at exactly 4x/week,
   where a rotation takes ~7 days. At other frequencies a rotation spans a
   different number of calendar days, so an identical per-rotation set count is
   a different TRUE weekly training RATE — while the MRV landmark it's judged
   against is a per-calendar-week number. weeklyFreqScale bridges the two: it's
   how many calendar weeks one rotation actually spans, from the athlete's
   tracked mean inter-session gap (ingest()'s avgSessionGapDays):
     rotation length in days = ROT * avgSessionGapDays
     weeks per rotation       = (ROT * avgSessionGapDays) / 7
   so   sets/rotation ÷ weeklyFreqScale = sets/true-week.
   Returns 1 with no gap history yet, so a fresh (or pre-frequency-awareness)
   program behaves exactly as before. Clamped to [0.6, 1.8] — roughly a
   ~6.7x/week…~2.2x/week band — so a stretch of missed or bunched sessions
   can't distort volume decisions past sane frequencies.
   Two, complementary uses, composed at every consumer that needs a true-
   weekly RATE:
     1. weeklyTarget/rampedSlotSets/deliveredWeekly take freqScale as an
        optional param (default 1) and MULTIPLY their MEV/MRV-anchored
        interpolation by it — a rotation spanning MORE than a week needs
        MORE sets scheduled into it to average out to the same true-weekly
        rate once delivered. This is what makes prescribe()'s actual
        per-session accessory set count frequency-aware.
     2. Callers that need a true-weekly rate for comparison against a
        weekly-unit landmark (ingest()'s ceilingHit, adjustLandmarks'
        reachedCeiling) pass the SAME freqScale into deliveredWeekly (so it
        accurately reflects what's actually being delivered) and then
        DIVIDE that result by freqScale again externally, exactly as before
        — converting the now-accurate per-rotation total back into a rate.
        This is not double-counting: (1) makes the per-rotation number
        accurate, (2) converts that accurate number into a comparable rate;
        composed on an unclamped value they're inverse operations and net
        out near the frequency-independent target, which is the intended
        behavior — clamps (ACC_SET_CAP, MRV itself) are exactly where they
        stop netting out, because those are real capacity/landmark limits,
        not something frequency should be able to launder away.
   fixedWeeklySets, maxDeliverable/capA/ACC_SET_CAP are NEVER scaled by
   freqScale anywhere — real structural per-rotation counts and schedule-
   capacity ceilings, not rates (see the comment above weeklyTarget). */
function weeklyFreqScale(avgSessionGapDays) {
  if (avgSessionGapDays == null) return 1;
  return Math.max(0.6, Math.min(1.8, (ROT * avgSessionGapDays) / 7));
}

/* ---- how often the athlete actually trains, measured as a WEEKLY RATE ----

   WHY THE MEAN GAP IS THE WRONG ESTIMATOR. avgSessionGapDays is an EWMA of
   inter-session gaps, which is correct only when the gaps are roughly equal. A
   fixed weekly schedule with a weekend is not: Mon-Fri is gaps of 1,1,1,1,3.
   Those average 1.4 — exactly the design cadence — but an EWMA never SETTLES
   on 1.4, because the input is periodic rather than noisy around a mean. It
   cycles endlessly (measured: 1.173 -> 1.721 -> 1.505 -> 1.353 -> 1.247 ->
   repeat), dragging freqScale between 0.838 and 1.229 and making per-session
   volume depend on which weekday it is. Measured end to end, that cost six of
   the ten tracked groups their advanced MAV (chest 16/18, back 22/23, side
   delts 16/18, calves 16/18, biceps 17/18, front delts 8/9) on a schedule that
   is, by construction, exactly 5 sessions per week.

   A RATE OVER A WHOLE NUMBER OF WEEKS fixes it, and the window has to be whole
   weeks for the same reason the gap average failed: any other span aliases
   against the weekly pattern and lands on a different answer depending on
   which weekday you ask. Counting sessions in the trailing 3 weeks returns
   exactly 5.0 on a Mon-Fri schedule whatever day it is evaluated.

   Falls back to the tracked mean gap when there is not enough history to
   establish a pattern — a new athlete, or one just back from a layoff, where
   the EWMA's faster response is genuinely the better estimate. */
const SESSION_RATE_WINDOW_WEEKS = 3;
/* Enough timestamps to fill the rate window with headroom: 3 weeks of a 6x/week
   athlete is 18. Bounded so stored program state cannot grow without limit. */
const SESSION_LOG_MAX = 24;
/* Below this many sessions in the window there is no weekly pattern to read,
   only a rate that would look like a collapse in frequency. Three weeks of a
   5-day schedule is 15 sessions, so 6 is a comfortably loose floor that still
   excludes a genuine layoff (which layoffFactor and the sessionsSinceLayoff
   return window handle, exactly as AUDIT 3.7 established for the mean gap). */
const SESSION_RATE_MIN_SESSIONS = 6;

/* Calendar day index for a timestamp, in the athlete's own local time. Counting
   DAYS rather than raw timestamps keeps the estimate independent of what time
   of day someone trains: a session at 17:30 three weeks ago and one at 19:00
   today are three weeks apart regardless of the 90 minutes between them. */
function localDayIndex(t) {
  const d = new Date(t);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

/* A gap this much larger than the athlete's own established spacing is an
   ABSENCE, not a change of cadence. Scaled to their rate rather than fixed:
   "abnormally long" means something different at 5x/week (mean gap 1.4 days)
   than at 2x/week (3.5 days), and a fixed threshold would either call a sparse
   athlete's normal week abnormal or fail to notice a dense athlete's holiday.
   Floored so a Mon-Fri weekend (3 days) can never read as abnormal, and
   defaulted generously before any rate is established so a new athlete can
   settle into any legitimate schedule. */
const SESSION_GAP_ABNORMAL_MULT = 2;
const SESSION_GAP_ABNORMAL_FLOOR_DAYS = 4;
const SESSION_GAP_ABNORMAL_DEFAULT_DAYS = 7;

function abnormalGapDays(establishedPerWeek) {
  if (!(establishedPerWeek > 0)) return SESSION_GAP_ABNORMAL_DEFAULT_DAYS;
  return Math.max(SESSION_GAP_ABNORMAL_FLOOR_DAYS, SESSION_GAP_ABNORMAL_MULT * (7 / establishedPerWeek));
}

/* The athlete's training rate, read from the trailing window ONLY when that
   window is representative of how they actually train. Returns null when it is
   not, so the caller holds the last established rate instead.

   WHY THE REPRESENTATIVENESS CHECK EXISTS — this shipped without it and
   reintroduced AUDIT 3.7's exact failure mode, worse. Counting sessions in a
   fixed trailing window means a break inside that window simply removes
   training days from the count. That reads as a collapse in frequency;
   effectiveGapDays returns a longer gap; weeklyFreqScale returns a larger
   number; and weeklyTarget MULTIPLIES by it. Measured on a real Mon-Fri
   athlete taking one 10-day break: freqScale went 1.0 -> 1.5 and stayed there
   for the whole 21-day window, prescribing 44-set sessions with chest and
   quads pinned at SAME_DAY_GROUP_CAP, while the athlete trained exactly
   5x/week throughout. More volume immediately after time off is precisely
   backwards, and precisely what AUDIT 3.7 established must never happen.

   The comment that stood here asserted a layoff "leaves the established rate
   intact". That described the intent; the code did not implement it. It does
   now: a window containing an abnormal gap is not evidence about cadence, so
   it yields nothing. Absence is handled where it belongs — layoffFactor and
   the sessionsSinceLayoff return window. */
function sessionsPerWeekObserved(program) {
  const log = program?.sessionLog;
  if (!Array.isArray(log) || !log.length) return null;
  /* ANCHORED ON THE LAST LOGGED SESSION, NOT ON NOW. The rate describes
     COMPLETED training history, and prescribe() runs before today's session is
     logged — so a window ending at `now` is always one session short of the
     pattern it is reading. On a Mon-Fri schedule that reads 14 sessions in 3
     weeks instead of 15, putting freqScale at 1.071 instead of 1.0 and quietly
     under-dosing every session. */
  const all = [...new Set(log.map(localDayIndex))].sort((a, b) => a - b);
  const end = all[all.length - 1];
  const start = end - SESSION_RATE_WINDOW_WEEKS * 7;
  const days = all.filter((d) => d > start && d <= end);
  if (days.length < SESSION_RATE_MIN_SESSIONS) return null;
  /* THE WINDOW'S LEADING EDGE IS A GAP BOUNDARY TOO. The count is divided by
     the window's nominal width, so the window has to be COVERED, not merely
     non-empty — a window holding only its newest fortnight reports two thirds
     of the true rate. That is exactly the state a returning athlete is in once
     their layoff ages past the far edge: the gap is no longer inside the
     window, so the interior check below sees nothing wrong, while the empty
     leading week silently deflates the rate. Measured on the half-fixed build,
     that read 3.67/week for a 5x/week athlete and put freqScale at 1.364 —
     the same over-dose the gap check prevents during the layoff, arriving a
     week later instead.
     Seeding the walk at `start` treats the distance from the window edge to
     the first session as a gap like any other, so one loop catches both. */
  const limit = abnormalGapDays(program.sessionsPerWeek);
  let prev = start;
  for (const d of days) { if (d - prev > limit) return null; prev = d; }
  /* THE RATE IS THE BEST WHOLE WEEK, NOT THE WINDOW AVERAGE. Dividing a session
     COUNT by the window's nominal width is only exact when the window happens
     to align with the athlete's weekly pattern: a 21-day window holds 14 or 15
     Mon-Fri sessions depending on which weekday it starts on, so the same
     unchanged schedule reads 5.00/week or 4.67/week according to nothing but
     the calendar. That put freqScale at 1.071 on a comeback whose cadence had
     not changed at all.
     ANY 7-consecutive-day window, by contrast, holds exactly 5 sessions of a
     Mon-Fri pattern regardless of alignment. Bucketing the window into whole
     weeks and taking the best one is therefore exact for a periodic schedule,
     and it is the right statistic besides: a partially-covered leading week
     should not drag the estimate below a rate the athlete demonstrably trained
     at. The gap walk above is what guarantees the buckets describe real
     training rather than an absence. */
  let best = 0;
  for (let w = 0; w < SESSION_RATE_WINDOW_WEEKS; w++) {
    const hi = end - w * 7, lo = hi - 7;
    best = Math.max(best, days.filter((d) => d > lo && d <= hi).length);
  }
  return best;
}
function effectiveGapDays(program) {
  const live = sessionsPerWeekObserved(program);
  if (live != null && live > 0) return 7 / live;
  /* The last rate that WAS established, held through absences. This is what
     stops a holiday changing the dose, and without it the layoff case fell
     straight through to the oscillating EWMA this whole mechanism replaced:
     measured, freqScale walked 0.744 -> 1.800 between two consecutive Mon-Fri
     sessions, a 2.4x step in the volume multiplier. */
  const held = program?.sessionsPerWeek;
  if (held > 0) return 7 / held;
  return program?.avgSessionGapDays ?? null;
}
/* The clamp bounds above are the whole reason a capacity shortfall can be
   UNFIXABLE by cadence: freqScale bottoms out at 0.6, so weekly capacity tops
   out at maxDeliverable / 0.6 no matter how often the athlete trains. Named
   here rather than re-deriving 0.6 at the call site — capacityShortfalls
   compares against it and would silently disagree with the clamp if either
   moved. */
const FREQ_SCALE_MIN = 0.6;
/* The lowest freqScale the RATE estimator can actually produce.
   sessionsPerWeekObserved counts distinct calendar days, so it cannot exceed 7
   sessions per week — a gap of exactly one day. Anything below this is only
   reachable through the avgSessionGapDays fallback, so advice computed against
   FREQ_SCALE_MIN alone promises cadences that do not exist. */
const FREQ_SCALE_REACHABLE_MIN = Math.max(FREQ_SCALE_MIN, ROT / 7);

/* ---- schedule-capacity shortfall (MAV the rotation cannot deliver) ----

   WHAT THIS ANSWERS: "am I actually going to hit my MAV at the cadence I
   train?" MAV is the endpoint every accumulation block ramps toward, so a MAV
   the schedule can never deliver is not a stretch goal — it is a target the
   athlete silently never reaches, with nothing in the app saying so.

   WHY IT IS NOT adjustLandmarks' reachedCeiling. That flag computes the same
   comparison, but it is unusable as a warning on three counts: it is gated
   behind `n >= 3` sessions of e1RM history, it only runs at an accumulation→
   deload boundary, and it is consumed as a CONFOUND (a reason to distrust a
   stall signal) rather than reported. A capacity shortfall is a structural
   fact about landmarks x rotation x cadence — it is true from the moment the
   numbers are what they are, needs no training history to establish, and the
   athlete should be able to see it before spending a block on it.

   UNITS. maxDeliverable is per-ROTATION; landmarks are per-CALENDAR-WEEK.
   Dividing by freqScale converts the former into the latter — the same
   conversion AUDIT 3.3 had to add inside adjustLandmarks after the raise gates
   were found comparing the two directly, which is only correct at exactly
   4x/week. Getting this backwards is the single most likely way for this
   function to be wrong, so the test suite pins it against what prescribe()
   actually delivers rather than against this formula. */
function capacityShortfalls(program, blockType = "accumulation") {
  const freqScale = weeklyFreqScale(effectiveGapDays(program));
  const out = {};
  Object.entries(program?.landmarks || {}).forEach(([p, lm]) => {
    const capA = maxDeliverable(p, blockType);   // per-rotation
    const capW = capA / freqScale;               // per-calendar-week
    /* Tolerance, not a fudge: capW is a rate with a repeating decimal at most
       cadences (20/1.142857... = 17.5), and a group whose MAV sits a hundredth
       of a set above its capacity is not something to warn an athlete about. */
    if (lm.mav <= capW + 1e-9) return;
    /* Cadence needed to close it. capW >= mav  <=>  capA/freqScale >= mav
       <=>  freqScale <= capA/mav, and freqScale = ROT / sessionsPerWeek, so
       sessionsPerWeek >= ROT * mav / capA. */
    const sessionsPerWeekNeeded = (ROT * lm.mav) / capA;
    /* Below FREQ_SCALE_MIN the clamp stops paying out, so past that point more
       training days genuinely cannot deliver this MAV — the group is short of
       ramped SLOTS, and only a rotation change (or a lower MAV) fixes it.
       Reporting these two cases identically would send the athlete to add
       training days that provably won't help. */
    /* Measured against the floor the RATE ESTIMATOR can actually produce, not
       against the clamp. sessionsPerWeekObserved counts distinct calendar days
       in its window, so it tops out at 7 sessions/week — a gap of 1.0 day, a
       freqScale of ROT/7. FREQ_SCALE_MIN (0.6) sits below that and is now only
       reachable through the avgSessionGapDays fallback, so measuring against
       it advertised a capacity ceiling ~19% above anything the primary
       estimator can reach, and could tell the athlete a MAV was reachable by
       training more when no achievable cadence delivers it. */
    const fixableByCadence = capA / FREQ_SCALE_REACHABLE_MIN >= lm.mav;
    out[p] = {
      label: lm.label,
      mav: lm.mav,
      capacityWeekly: capW,
      shortfall: lm.mav - capW,
      slots: PATTERN_FREQ[p] || 0,
      fixableByCadence,
      sessionsPerWeekNeeded: fixableByCadence ? sessionsPerWeekNeeded : null,
    };
  });
  return out;
}

/* ---- groups whose MAV has nowhere left to grow ----

   WHAT THIS CATCHES THAT capacityShortfalls DOES NOT. That function asks "is
   this MAV out of reach?" — `mav > capW`. This asks the question one step
   earlier: "has this MAV arrived AT the schedule's ceiling, so the auto-tune
   can never raise it again?" — `mav === capW`. At equality nothing is short,
   so capacityShortfalls is silent, while adjustLandmarks' raise gate
   (`mav + 1 <= capW`) is permanently false.

   That is not a corner case. Measured over ~6 months of healthy growth at the
   advanced tier, NINE of the ten tracked groups end pinned at capacity. MAV
   drift is the only progressive-overload mechanism this program has BETWEEN
   blocks, so for those groups it stops: the athlete keeps training, the ramp
   keeps running to the same top, and nothing anywhere says the target has
   stopped moving. The only landmark still able to climb is MEV, which
   compresses the ramp from below (side delts went 7->18 to 10->18 in three
   blocks) until MEV_MAV_MAX_RATIO's clamp stops it.

   The ROTATION comment used to claim the capacity warning would surface this
   if the auto-tune ever raised one of the pinned groups. It cannot — the
   auto-tune is exactly what is blocked — so that safety net could never be
   reached. This is the net. */
function capacityPinned(program, blockType = "accumulation") {
  const freqScale = weeklyFreqScale(effectiveGapDays(program));
  const out = {};
  Object.entries(program?.landmarks || {}).forEach(([p, lm]) => {
    const capW = maxDeliverable(p, blockType) / freqScale;
    /* At or above capacity, but NOT short of it — a group that is genuinely
       short is capacityShortfalls' to report, and reporting it twice would
       tell the athlete to add days and change the rotation for one problem. */
    if (lm.mav > capW + 1e-9) return;
    if (lm.mav < capW - 1e-9) return;
    out[p] = {
      label: lm.label,
      mav: lm.mav,
      capacityWeekly: capW,
      slots: PATTERN_FREQ[p] || 0,
      /* What it would take to give this group room again. More training days
         raise capW; so does another ramped slot on a day that is not already
         at SAME_DAY_GROUP_CAP. */
      sessionsPerWeekForHeadroom: (ROT * (lm.mav + 1)) / maxDeliverable(p, blockType),
    };
  });
  return out;
}

/* ---- automatic volume-landmark adjustment (runs at accumulation→deload) ----
   Two signals per pattern drive a gradual ±1-set drift over many blocks:
     • growth  — normalized e1RM slope of the pattern's driver: the main lift
                 for squat/hinge/horiz_press, else the average slope of that
                 pattern's landmark-ramped (non-fixedSets) accessories.
     • fatigue — the block-level fatigue index at the transition.
   Rules: strong growth + comfortable fatigue → MEV+1, MRV+1; growth stalled
   early (before the pattern's volume reached MRV) + fatigue spiked early
   → MRV−1. Change is capped at ±1/pattern/cycle so landmarks drift rather
   than swing on one noisy block, and MEV is kept ≥2 sets below MRV so the
   working range can't collapse. The 0.7 fatigue-spike bound reuses the same
   high-fatigue threshold the deload trigger already uses; both are
   literature-informed but not precisely-validated engine constants. */
const FATIGUE_SPIKE = 0.7;   // fatigue index at/above this = "spiked" (same threshold as the deload trigger's highFatigue check)
const FATIGUE_AMBER = 0.55;  // fatigue index at/above this = "amber" (same threshold as grayFatigue below and the Status fatigue-gauge color)
const FATIGUE_STILL_ELEVATED = 0.5; // deliberately below FATIGUE_SPIKE: deload must clear fatigue below this before routing into a near-max test (realization/intensification)
const GROWTH_POS = 0.001;    // normalized slope above this = still progressing (mirrors the stall check)
/* Consecutive ACCUMULATION BLOCKS (not cycles within a block — adjustLandmarks
   runs once per completed accumulation block) a pattern must show flat growth
   with volume/fatigue/ceiling all ruled out before a persistent stall notice
   surfaces. 3 blocks is ~9-18 real training sessions of genuine "volume and
   recovery aren't the problem" evidence — enough to rule out normal block-to-
   block noise, not so long the athlete goes months on an ineffective exercise
   before anything says so. Observation only: see the stall-streak block in
   adjustLandmarks — it never touches exercise selection, MEV/MRV, or e1RM. */
const STALL_STREAK_THRESHOLD = 3;
/* Hard ceiling on MEV as a fraction of MAV, enforced in both directions by the
   landmark auto-tune. The MEV->MAV distance IS the accumulation block's ramp,
   so it is not something the tuner may spend: if MEV is allowed to converge on
   MAV the block flattens into a constant-volume phase at the athlete's ceiling
   and the mesocycle stops existing (measured, see the ramp-span note in
   adjustLandmarks). Expressed as a ratio rather than a fixed set count so it
   scales with the group — a 3-set span is generous for hamstrings and useless
   for back. RP's published landmarks sit near 0.40-0.50 MEV/MAV; 0.65 leaves
   real headroom for MEV to grow while never letting the ramp close. */
const MEV_MAV_MAX_RATIO = 0.65;
/* T2-2: the fatigue-lowering branch of adjustLandmarks may not tune a group's
   MAV/MRV below this fraction of its SEEDED (experience-tier) value. See the
   fatigue branch for why: unbounded, repeated bad blocks walk every group down
   to the relational clamps' floor, where the landmarks no longer describe what
   is prescribed. */
const FATIGUE_FLOOR_FRAC = 0.5;
/* landmark group → the lift that carries its growth signal, for pools where a
   single exercise is unambiguously the driver. Empty since the hypertrophy
   rebuild: with no main lifts, no pool has one exercise that dominates it — a
   4-slot chest pool spread across bench/incline/dip/fly has no more reason to
   read its growth off bench than off incline. EVERY pool now reads the
   precision-weighted pool of its ramped accessories' slopes (see
   patternGrowth), which was already the code path for the 5 pools that never
   had a main lift. Kept as an empty map rather than deleted so patternGrowth's
   two-branch shape stays intact and a future single-driver pool is a one-line
   re-add, not a re-plumb. */
const PATTERN_MAIN = {};
/* volumeGroup → its landmark-ramped accessories (role=acc, not fixedSets), for
   the pools that have no main lift to read a slope from. Restricted to
   exercises actually IN the rotation — LIB entries kept only for history
   (ohp) would otherwise dilute the pooled slope with a permanently-flat,
   never-trained lift. Keyed the same way as the landmark table so the
   auto-tune resolves each landmark key to the right accessory slopes. */
const PATTERN_RAMPED_ACC = (() => {
  const inRotation = new Set(ROTATION.flatMap((d) => d.items));
  const m = {};
  Object.entries(LIB).forEach(([k, L]) => {
    if (L.role !== "acc" || L.fixedSets || !inRotation.has(k)) return;
    const g = L.volumeGroup;
    (m[g] = m[g] || []).push(k);
  });
  return m;
})();
function patternGrowth(program, pattern) {
  const mainKey = PATTERN_MAIN[pattern];
  if (mainKey) {
    const { g, n } = liftSlopeInfo(program.lifts[mainKey]);
    return { g, n };
  }
  const accs = PATTERN_RAMPED_ACC[pattern] || [];
  if (!accs.length) return { g: 0, n: 0 };
  /* precision-weighted pool: each accessory's slope weighted by the points its
     fit used, so a sparsely-logged lift contributes proportionally less signal
     instead of dragging the average toward zero. n reports window points (the
     evidence the slope actually rests on), not raw hist length. */
  const infos = accs.map((k) => liftSlopeInfo(program.lifts[k]));
  const totalN = infos.reduce((s, i) => s + i.n, 0);
  if (!totalN) return { g: 0, n: 0 };
  const g = infos.reduce((s, i) => s + i.g * i.n, 0) / totalN;
  return { g, n: Math.max(...infos.map((i) => i.n)) };
}
function adjustLandmarks(program) {
  const cyc = program.block.cycle;
  const maxCycles = BLOCKS.accumulation.maxCycles;
  const fatigueIndex = program.fatigue?.index ?? 0;
  const fatigueComfortable = fatigueIndex < FATIGUE_SPIKE;
  const fatigueSpikedEarly = fatigueIndex >= FATIGUE_SPIKE && cyc < maxCycles;
  const landmarks = structuredClone(program.landmarks);
  const adjustments = {};
  /* Convert delivered volume and the schedule ceiling into a true per-calendar-
     week rate before comparing to MRV, so this auto-tune gate and the
     transition trigger in ingest() (ceilingHit) agree on units — computed once
     per call since it depends only on the program's tracked frequency. */
  const freqScale = weeklyFreqScale(effectiveGapDays(program));
  /* Stall-notice tracking (additive, observation-only — see STALL_STREAK_
     THRESHOLD): reads program.landmarks (the pre-adjustment values, same
     source reachedCeiling below already uses) and reachedCeiling itself, so
     it can never be affected by this same call's own MEV/MRV/MAV mutations.
     Copied forward (not mutated in place) so a program with no evidence this
     call leaves both objects reference-equal to the input — same defensive
     style as `landmarks`/`adjustments` above. */
  const stallStreaks = { ...(program.stallStreaks || {}) };
  const stallNotices = { ...(program.stallNotices || {}) };
  Object.keys(landmarks).forEach((p) => {
    const lm = landmarks[p];
    const { g, n } = patternGrowth(program, p);
    if (n < 3) return; // not enough e1RM history to act on — leave it alone
    /* Did this group's DELIVERED volume (fixed + ramped, the sets actually
       prescribed) reach the ceiling this block actually offers (MRV, or the
       schedule max if that saturates first)? Both sides converted to a true
       weekly rate (÷ freqScale) so the comparison is against MRV as a
       per-calendar-week number; MRV itself is already weekly and isn't scaled.
       deliveredWeekly is called WITH freqScale (see the comment above
       weeklyFreqScale's definition — prescribe() now delivers a frequency-
       corrected ramped-accessory count, so this must match to stay accurate)
       and the /freqScale below still converts that real per-rotation total
       into a rate; not double-scaling, two different jobs.
       Compared against delivered reality, a capped group correctly reads "at
       ceiling" when its ramp saturates — so a stall there isn't misread as
       stalling with headroom.
       AUDIT 3.3: capW (capA as a per-calendar-week RATE) is now used by the
       raise gates below too. They previously compared a weekly landmark
       against raw per-rotation capA, which are only the same number at
       exactly 4x/week — the gate's own stated purpose is "don't grow a stored
       number no prescription can ever reach", and at 3x/week it permitted
       exactly that (beginner quads: gate allowed mrv 16 while the schedule
       tops out at 14.3 sets/week; at ~2.2x/week, 10.6). An earlier pass
       deliberately left this unscaled, reasoning that capA is a delivery
       ceiling rather than a rate — but it is being compared to mrv, which IS
       a rate, so the comparison needs both sides in the same units. */
    const capA = maxDeliverable(p, "accumulation"); // per-rotation
    const capW = capA / freqScale;                  // per-calendar-week, comparable to mev/mav/mrv
    /* reachedCeiling asks "was this group's volume limited by something other
       than the plan?" — the confound that makes flat growth uninformative.
       Its meaning had to be re-derived for the hypertrophy rebuild, not just
       re-pointed at a different landmark:
         • Under the old MRV-endpoint ramp it meant "delivered >= min(mrv,
           capW)" — we gave this group literally everything available, so a
           stall here says nothing about the exercise.
         • Under the MAV endpoint, reaching the ramp's top is the NORMAL end
           state of every block for every group. Testing delivered >= min(mav,
           capW) would therefore be true almost always, and — worse — it would
           become arithmetically identical to volumeAtMav below, so
           `volumeAtMav && !reachedCeiling` would cancel to a constant false and
           the stall notice could never fire again. (That degenerate case is
           exactly what the AUDIT 3.8 comment on volumeAtMav warned about.)
       So the surviving confound is specifically SCHEDULE CAPACITY: the group
       wanted its MAV and the rotation could not deliver it. Stalling while
       receiving the full planned MAV is not a confound at all — it is precisely
       the evidence the stall notice exists to surface, and this rebuild makes
       that case reachable where it previously was not. */
    const deliveredPrev =
      deliveredWeekly(p, "accumulation", Math.max(0, cyc - 1), program.landmarks, freqScale) / freqScale;
    const reachedCeiling = capW < lm.mav && deliveredPrev >= capW;
    const grew = g > GROWTH_POS;
    const stalledEarly = g <= GROWTH_POS && !reachedCeiling;

    /* Stall-notice streak: runs independently of the MEV/MRV raise/lower
       decision below (including when neither fires), since this is
       ADDITIVE tracking, not a modification of that logic.
         - real growth resets the streak to 0 (and clears any live notice) —
           the pattern is not stalled, unconditionally.
         - no growth increments the streak ONLY when volume, fatigue, and
           ceiling are all ruled out as explanations (delivered volume has
           reached MAV, fatigue is comfortable, and the pattern hasn't
           saturated its own ceiling this block) — i.e. every condition this
           engine already tracks for "why might growth have stalled" says
           it's NOT volume, NOT fatigue, and NOT a schedule ceiling.
         - if growth is flat but any of those three gates fails (low volume,
           high fatigue, or already at ceiling), the streak is left
           UNCHANGED — neither incremented nor reset — matching the
           rpeMiss/backoffDrift "null means no evidence" convention: a
           volume/fatigue/ceiling-confounded block is not evidence the
           EXERCISE itself has stopped working, so it shouldn't count either
           for or against the streak. */
    if (grew) {
      stallStreaks[p] = 0;
      delete stallNotices[p];
    } else {
      /* Same call-then-divide pattern as reachedCeiling a few lines above:
         deliveredWeekly is called WITH freqScale so it reflects what
         prescribe() is actually delivering at the athlete's real frequency
         (not a hypothetical "at 4x/week" figure), then divided by freqScale
         to convert that into a true-weekly rate comparable to `mav`.
         This call site used to be left deliberately unscaled — that was
         defensible ONLY while prescribe() itself ignored frequency, since an
         unscaled deliveredWeekly then matched reality at any cadence. Now
         that prescribe() scales its own ramped-accessory output, leaving
         this one call unscaled would silently reintroduce the same staleness
         bug the rest of that fix closed everywhere else — comparing a
         hypothetical per-rotation count against a true-weekly landmark. */
      const deliveredThis = deliveredWeekly(p, "accumulation", Math.max(0, cyc - 1), program.landmarks, freqScale) / freqScale;
      /* AUDIT 3.8 — KNOWN LIMITATION, deliberately NOT "fixed" here.
         MAV exceeds maxDeliverable for 6 of 8 groups at intermediate defaults
         (7 of 8 at advanced), so this gate is unsatisfiable for them and the
         stall-notice feature is effectively dead outside `quads`: a
         120-session total plateau produces a notice for quads alone while the
         other seven stall silently.
         The obvious repair — comparing against min(mav, capW) so "enough
         volume" means "as much as this schedule can give it" — was tried and
         is a NO-OP, because `reachedCeiling` below would then always be true
         at the same moment. Proof: capW <= mav makes both thresholds capW, so
         volumeAtMav becomes equivalent to reachedCeiling and the
         `!reachedCeiling` term cancels it; capW > mav leaves this line
         unchanged. Swept over 3 experience tiers x 3 cadences x 8 groups x 6
         cycles: the gate's value changes in 303 of 432 scenarios and the
         streak outcome changes in ZERO of them.
         The real blocker is that reaching the ceiling is treated as a
         CONFOUND. For a capacity-limited group that is simply its normal
         end-of-block state, so it is permanently "confounded" and can never
         accumulate evidence. Un-confounding it is a semantics change (having
         given a group everything the schedule holds is arguably the STRONGEST
         evidence an exercise isn't working, not a reason to abstain), and it
         belongs with the landmark-vs-schedule decision, not with this pass. */
      const volumeAtMav = deliveredThis >= program.landmarks[p].mav;
      if (volumeAtMav && fatigueComfortable && !reachedCeiling) {
        stallStreaks[p] = (stallStreaks[p] || 0) + 1;
        if (stallStreaks[p] >= STALL_STREAK_THRESHOLD) {
          stallNotices[p] = {
            cyclesStalled: stallStreaks[p],
            // fixed at first detection, not overwritten on later stalled blocks
            sinceCycle: stallNotices[p]?.sinceCycle ?? cyc,
          };
        }
      }
      // else: volume/fatigue/ceiling confounded — leave the streak untouched
    }

    let dMev = 0, dMrv = 0, dMav = 0, signal = null;
    if (grew && fatigueComfortable) {
      /* Raises are gated to what the schedule can deliver: drifting MRV above
         maxDeliverable would grow a stored number no prescription can ever
         reach (the pre-fix failure mode). MEV raises are likewise kept ≥2
         below the (possibly capacity-frozen) MRV so they can't drag it up
         through the range clamp below. */
      const canRaiseMrv = lm.mrv + 1 <= capW;
      const mrvAfter = lm.mrv + (canRaiseMrv ? 1 : 0);
      /* AUDIT 3.5: MEV additionally may not climb past MAV. maxDeliverable is
         below MRV for every group at intermediate/advanced defaults, so
         canRaiseMrv is permanently false there and the only reachable
         adjustment in the whole auto-tune was +MEV — a one-way ratchet,
         verified as 15 landmark changes across a simulated year, every one of
         them +MEV with MRV never moving. Left unbounded that collapses the
         MEV->MRV ramp the accumulation block is built on (quads' span fell
         from 12 sets to 7), shortens accumulation blocks, and permanently
         raises intensification/deload volume too, since VOL_SCALE keys off
         MEV. This is containment, not a cure: the root cause is that the
         landmark table describes volume this ROTATION cannot deliver.

         RAMP-SPAN BOUND (fixes a defect introduced by the MAV ramp endpoint).
         The AUDIT 3.5 guard above — "MEV may not climb past MAV" — was
         sufficient while the ramp ran MEV -> MRV: MEV pinning at MAV still
         left an MAV -> MRV span for the block to ramp across. Once MAV became
         the ramp's endpoint that guard stopped being enough, because MAV is
         bounded (by MRV-1 and by schedule capacity) and stops rising while MEV
         keeps going, so MEV converges on MAV-1 and the ramp width goes to
         ZERO. Simulated 24 successful blocks: by block ~15 quads/chest/back
         all sat at mev/mav/mrv = 22/23/24 delivering 24 -> 24 sets, i.e. every
         accumulation block a flat line at maximum deliverable volume with no
         ramp at all — the mesocycle structure silently gone after roughly a
         year of good training.
         The fix keeps MEV strictly a bounded FRACTION of MAV rather than
         merely below it, so the span scales with the group instead of being a
         fixed number that is too wide for hamstrings and too narrow for back.
         RP's own published tables put MEV at roughly 40-50% of MAV; 0.65 is a
         permissive ceiling that still lets MEV nearly double from its seeded
         value while guaranteeing the block always has somewhere to ramp. */
      const mavAfterRaise = Math.min(mrvAfter - 1, lm.mav + 1);
      const mevCeiling = Math.floor(MEV_MAV_MAX_RATIO * mavAfterRaise);
      const canRaiseMev = lm.mev + 1 <= Math.min(mrvAfter, capW) - 2
        && lm.mev + 1 <= lm.mav
        && lm.mev + 1 <= mevCeiling;
      dMev = canRaiseMev ? 1 : 0;
      dMrv = canRaiseMrv ? 1 : 0;
      /* MAV drifts too, and this is now the auto-tune's most important output:
         since the hypertrophy rebuild MAV — not MRV — is where the accumulation
         ramp tops out (see weeklyTarget), so if MAV never moved, the volume the
         athlete actually trains would be identical in block 20 as in block 1 no
         matter how well they grew or recovered. Progressive overload across
         mesocycles IS this line. Gated the same way the other two are: a raise
         must stay strictly inside the recovery ceiling (MRV) and inside what
         the schedule can actually deliver, so MAV can never become a target no
         prescription can reach. */
      dMav = (lm.mav + 1 <= mrvAfter - 1 && lm.mav + 1 <= capW) ? 1 : 0;
      if (dMev || dMrv || dMav) signal = canRaiseMrv ? "growth strong, fatigue in check" : "growth strong — schedule at capacity, MEV only";
    }
    else if (stalledEarly && fatigueSpikedEarly) {
      /* Fatigue spiked before the block ran its length AND growth stalled: pull
         the recovery ceiling down, and pull the training target down with it —
         dropping MRV alone would leave the athlete training at exactly the same
         MAV that just failed them. */
      /* T2-2: bounded below at half the athlete's SEEDED landmarks. Unbounded,
         a run of bad blocks walked every group down to the relational clamps'
         own floor (2/3/4), where the landmark system is decoupled from the
         prescription entirely — RAMPED_SET_FLOOR alone still delivers 8 sets to
         quads against a stated MAV of 3, so the numbers on the Status screen
         stop describing the program. The step is a constant -1 rather than
         proportional, so small-MAV groups also fell fastest: hamstrings reached
         the floor in 5 bad blocks where chest took 18. Half the seed is a
         deliberate deload-depth bound, not a guess — it is roughly the volume
         drop a genuine resensitisation block uses, and anything below it is
         better handled by the athlete changing the program than by the
         auto-tune grinding down another set per block. Reachability is low
         (this branch needs stall AND fatigue spike every block) but the whole
         point of the bound is the tail. */
      const seeded = landmarksForExperience(program.experience)[p];
      const mrvFloor = Math.ceil(seeded.mrv * FATIGUE_FLOOR_FRAC);
      const mavFloor = Math.ceil(seeded.mav * FATIGUE_FLOOR_FRAC);
      dMrv = lm.mrv > mrvFloor ? -1 : 0;
      dMav = lm.mav > mavFloor ? -1 : 0;
      signal = "stalled early with fatigue spike";
    }
    if (!dMev && !dMrv && !dMav) return;

    const before = { mev: lm.mev, mav: lm.mav, mrv: lm.mrv };
    lm.mev = Math.max(2, lm.mev + dMev);           // floor MEV at 2
    lm.mrv = Math.max(lm.mev + 2, lm.mrv + dMrv);  // keep MRV ≥2 above MEV (range can't collapse)
    lm.mav = Math.min(lm.mrv - 1, Math.max(lm.mev + 1, lm.mav + dMav));
    /* Enforce the ramp span from the OTHER direction too. The raise gate above
       stops MEV climbing into MAV, but MAV can also come DOWN to meet a
       standing MEV — the fatigue path lowers MAV, and the MRV-1 clamp on the
       line above can drag it down further when MRV falls. Without this, a
       string of bad blocks compresses the ramp just as effectively as a string
       of good ones used to. MEV yields, because between "train less at the
       floor" and "have no ramp", the former is the recoverable state. */
    lm.mev = Math.max(2, Math.min(lm.mev, Math.floor(MEV_MAV_MAX_RATIO * lm.mav)));
    // report the deltas actually realized after the safety clamps
    const rMev = lm.mev - before.mev, rMrv = lm.mrv - before.mrv, rMav = lm.mav - before.mav;
    if (!rMev && !rMrv && !rMav) return;
    adjustments[p] = { before, after: { mev: lm.mev, mav: lm.mav, mrv: lm.mrv }, dMev: rMev, dMrv: rMrv, dMav: rMav, signal, at: Date.now() };
  });
  return { landmarks, adjustments, stallStreaks, stallNotices };
}

/* ---- readiness score (0–1) from Garmin Training Readiness Score ----
   Readiness plays TWO SEPARATE, deliberately-decoupled roles in this engine,
   on two different timescales — see engine-research-summary.md's Readiness
   section for the full rationale (bounded/secondary role; HRV-guided-
   programming evidence doesn't hold up for resistance training the way it
   does for endurance work, so readiness never drives the program alone):
     1. SAME-DAY prescription softening (READINESS_RPE_ADJ / READINESS_SET_MULT
        below, consumed in prescribe()) — reads TODAY's live readiness object
        directly via readinessScore/readinessBand every session. Nothing here
        is smoothed or remembered across sessions.
     2. MULTI-SESSION fatigue-index contribution (READINESS_FATIGUE_WEIGHT,
        consumed in ingest()) — an EWMA of (1 - today's score) accumulated
        into fatigue.readSupp, which drives deload timing alongside RPE-creep
        and missed-set frequency.
   These are structurally independent code paths (prescribe() never reads
   fatigue.readSupp; ingest()'s EWMA never reads rpeAdj/setMult) and each has
   its OWN named constant below specifically so they can be tuned separately
   once real session history exists — a run of noisy wearable readings should
   be able to soften isolated sessions without necessarily nudging the
   athlete toward an early deload for reasons that were never about
   accumulated training stress, and vice versa. See
   engine-research-summary.md for why these particular numbers were chosen
   as a first-pass parameterization and how to validate/adjust them against
   this athlete's own logged data (readiness_analysis.mjs). */
/* AUDIT 3.1/3.9: returns null for "no usable reading" rather than coercing.
   `r.trainingReadiness` of null/undefined/"" all divide to 0 or NaN, and both
   failure modes were silently harmful: null/100 === 0 read as a PERFECT
   readiness DEFICIT (the red band, a 40% set cut, from absent data), while
   {} produced NaN, which then propagated into fatigue.readSupp and
   fatigue.index through the EWMA and never washed out — every later
   comparison against it (`fatigueComfortable = index < FATIGUE_SPIKE`) is
   false for NaN, which permanently disables the landmark auto-tune's growth
   branch. Callers distinguish null ("no evidence", the same convention
   rpeMiss/backoffDrift already use) from a real 0. */
function readinessScore(r) {
  const v = r?.trainingReadiness;
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1, v / 100));
}
const readinessBand = (s) => (s >= 0.60 ? "green" : s >= 0.40 ? "amber" : "red");
/* Same-day-only: how much a non-green readiness band softens TODAY's rpe
   target / set count. Read exclusively by prescribe(); never accumulated,
   never touches fatigue.index. */
const READINESS_RPE_ADJ = { green: 0, amber: -0.5, red: -1.5 };
const READINESS_SET_MULT = { green: 1, amber: 0.85, red: 0.6 };
/* Multi-session-only: how much weight the EWMA'd readiness-deficit signal
   (fatigue.readSupp) carries in the composite fatigue index — see ingest().
   Read exclusively there; never consulted by prescribe()'s same-day path.
   The EWMA's own smoothing rate (readSuppAlpha, also in ingest()) is a
   SEPARATE constant from this weight even though both happen to be 0.3 today
   — one governs how fast the multi-session signal moves, the other how much
   it counts once it has; conflating them into one shared literal is exactly
   the kind of accidental coupling this split is meant to prevent. */
const READINESS_FATIGUE_WEIGHT = 0.3;
/* Divisor that maps the rpeCreep channel onto 0..1 in the fatigue index: the
   value of `rpeCreep` a thoroughly bad training week actually produces.
   It is NOT a free tuning knob — it has to track what feeds the channel, which
   is `rpeMiss + 0.5 * backoffDrift` (see ingest). It was 1.5 when both terms
   were live: ~1.0 of top-set RPE overshoot plus ~1.0 of backoff drift at half
   weight. The hypertrophy rebuild prescribes straight sets everywhere, so
   nothing is ever assigned a backoff set, backoffDrift is structurally 0, and
   the input tops out at ~1.0. Leaving the divisor at 1.5 silently capped the
   channel at 2/3 of its intended contribution and made FATIGUE_SPIKE (0.7)
   unreachable — measured: a deliberately terrible week (every set +1 RPE over
   target, readiness 45, 40% of exercises missing reps) peaked at index 0.592,
   so the fatigue-driven deload could never fire. At 1.0 that same week reaches
   0.745 and a healthy one still sits near 0.06.
   MUST be revisited if any exercise is ever prescribed backoff sets again. */
const RPE_CREEP_FULL_SCALE = 1.0;
/* How fast fatigue.readSupp itself moves toward each new daily reading —
   distinct from READINESS_FATIGUE_WEIGHT (how much the resulting value counts
   once smoothed). Both are 0.3 today; that's a coincidence of the initial
   parameterization; keeping them as two constants means changing one can
   never accidentally change the other. */
const READSUPP_EWMA_ALPHA = 0.3;

/* ---- warmup ramp ----
   Structured percentage ramps are restricted to barbell:true exercises only
   (mains + RDL/Front Squat/OHP/Barbell Row) — these are loaded with plates,
   where a graduated ramp actually matters for bar speed/joint prep. Non-
   barbell compound accessories get at most a single light feeler set, not a
   percentage sequence; isolation/unilateral accessories get no warmup — the
   working sets themselves are already light enough to serve as warmup.
   Ramp tier is driven directly by the top set's %1RM (the same RPE-table
   lookup, rpePct(reps, rpe), prescribe() already uses for load math) rather
   than the block-phase label: >=85% full 4-step, 70-85% short 2-step, <70%
   minimal 1-step. This naturally reflects readiness-adjusted RPE shifts that
   a phase-name check couldn't see, and correctly handles realization (a
   near-max single/double at high RPE — genuinely needs the full ramp despite
   being a short "test" phase) as well as deload (RPE floors at 6, but at only
   3-4 reps that's still ~79-81%1RM, landing short rather than minimal).
   On top of the %1RM tier, if an earlier exercise this session already worked
   the same movement pattern (main or accessory, barbell or not — the pattern
   is already primed either way), the tier drops one step further (full->short,
   short->minimal). Main lifts are always first in the day's rotation, so this
   reduction never applies to them. */
const FULL_RAMP = [{ pct: 0.40, reps: 5 }, { pct: 0.60, reps: 3 }, { pct: 0.75, reps: 2 }, { pct: 0.90, reps: 1 }];
const SHORT_RAMP = [{ pct: 0.60, reps: 3 }, { pct: 0.90, reps: 1 }];
const MINIMAL_RAMP = [{ pct: 0.60, reps: 3 }];
/* Build the loadable warmup steps for a barbell top set.
   Each step is floored at barWeight: a percentage step below an empty bar is
   not a weight the athlete can actually load (FULL_RAMP's 40% step on a 95 lb
   top set is 40 lb — lighter than the 45 lb bar holding it). Steps that floor
   into the same weight collapse to one, and any step that reaches the work
   weight is dropped, so the returned array can be SHORTER than the tier's
   nominal length. The `type` label continues to describe the tier the top
   set's %1RM earned (see the prescribe() warmup block); the array describes
   what is actually loadable underneath it. The stress suite's ramp-length
   invariant is correspondingly "never longer than the tier", not "exactly the
   tier" — deliberately chosen over relabelling, because collapsing can leave
   3 steps and there is no 3-step tier to relabel to. */
function buildRamp(topLoad, ramp, unit, barWeight) {
  // top-set weight itself too light for a ramp to make sense (e.g. deload-week loads near an empty bar)
  if (topLoad <= barWeight) return null;
  const step = unit === "kg" ? 2.5 : 5;
  const out = [];
  for (const { pct, reps } of ramp) {
    const weight = Math.max(barWeight, Math.round((topLoad * pct) / step) * step);
    if (weight >= topLoad) continue;                                  // collapsed into the work set
    if (out.length && out[out.length - 1].weight === weight) continue; // collapsed into the previous step
    out.push({ weight, reps });
  }
  return out.length ? out : null;
}
/* AUDIT 2.10: the feeler path never saw the earlierPrimed signal the barbell
   ramp two branches over already computes — a lift whose muscle was never
   touched yet this session got the same single 50% set as one immediately
   following its own heavy exposure. Cold gets two ascending steps (50%,
   75%), primed keeps the original single 50% step. */
function buildFeeler(topLoad, reps, bodyweight, unit, step = unit === "kg" ? 2.5 : 5, earlierPrimed = false) {
  if (bodyweight) return { type: "feeler", sets: [], note: "single light set — reduced range/tempo" };
  if (topLoad <= 0) return null;
  const pcts = earlierPrimed ? [0.5] : [0.5, 0.75];
  const sets = [];
  for (const pct of pcts) {
    const weight = Math.max(0, Math.round((topLoad * pct) / step) * step);
    /* At very light working loads a feeler step rounds up into the working
       weight itself — a "warmup" at >= the work weight is no warmup at all,
       so skip it (this was the stress suite's entire long-standing
       feeler>=topLoad violation class). Also skip a step that rounded down
       to/below the previous one — collapsed steps aren't a second warmup. */
    if (weight >= topLoad) continue;
    if (sets.length && weight <= sets[sets.length - 1].weight) continue;
    sets.push({ weight, reps });
  }
  return sets.length ? { type: "feeler", sets } : null;
}

/* ════════════ PRESCRIPTION ════════════ */
/* Layoff handling: after a gap past LAYOFF_THRESHOLD_DAYS the stored e1RM is
   stale — prescribing full load off it is exactly how comeback sessions get
   ugly. Strength is well-preserved through ~2 weeks of detraining, so under
   the threshold nothing changes; past it, prescription loads take a gentle
   haircut per day, capped at LAYOFF_MAX_DECAY. The stored e1rm itself is NOT
   mutated — the first real comeback session re-anchors it through the normal
   EWMA (an RPE≥7 session still updates, see E1RM_MIN_RPE). */
const LAYOFF_THRESHOLD_DAYS = 14;
const LAYOFF_DECAY_PER_DAY = 0.004; // ~0.4%/day beyond the threshold
const LAYOFF_MAX_DECAY = 0.15;      // never cut a comeback prescription more than 15%
/* AUDIT 2.8: the layoff load cut above tops out at 15% and targets 1RM,
   which is the wrong lever for what a layoff actually detrains fastest —
   volume tolerance and eccentric-load tolerance, not maximal strength (well
   preserved through weeks of detraining). Rather than push LAYOFF_MAX_DECAY
   higher and cut load a comeback session doesn't need cut, cap effort and
   trim sets for the return window instead — self-clearing, and the first
   logged session re-anchors e1RM through the normal EWMA regardless. */
const RETURN_RPE_CAP = 8;
const RETURN_SET_MULT = 0.7;
/* AUDIT 2.12: the "isolation self-warms" exemption is keyed on repTier, which
   puts a 290 lb standing calf raise and a 25 lb wrist curl under the same
   free pass — the load spread within one tier is bigger than the spread the
   tier boundary itself protects against. Gate on absolute load instead: any
   accessory whose top set is at or above this floor earns a feeler,
   isolation included, and it degrades gracefully for a novice whose loads
   never reach it (still exempt, same as today). kg value is the same
   physical floor as the lb one (100 lb ~= 45.4 kg), not a separately chosen
   number. */
const FEELER_LOAD_FLOOR_LB = 100;
const FEELER_LOAD_FLOOR_KG = 45;
/* Double-progression window for isolation accessories: load holds while reps
   climb from the bottom of the window to the tier's rep target; hitting the
   target earns one load step and resets to the bottom.
   DERIVED from the isolation rep target, not an absolute number. It was
   absolute (8), and when the rep targets were scaled down by 2 the window
   silently narrowed from 5 steps to 3 — the constant no longer expressed the
   thing it was for. Deriving it means the window is invariant to rep-target
   changes: at the previous 12-rep isolation target this yields exactly the old
   8, so it also reproduces history rather than quietly redefining it.
   WIDTH CHOSEN FROM MEASUREMENT, not preference. Simulated a lateral raise
   over 52 weeks against a true capability growing 15%/yr, logging honestly
   (the athlete gets the reps their capability supports at the prescribed load
   and falls short when it doesn't):
     floor 8 (window 3): athlete short of target in 52% of sessions, 12 stall-
                         driven load cuts in the year
     floor 7 (window 4): 42% short, 10 cuts
     floor 6 (window 5): 38% short,  8 cuts
   A narrow window makes the mechanism climb faster than the lift can actually
   support, then claw back — over the year the load nets one 2.5 lb increment
   either way, so the extra steps buy nothing and are paid for in missed reps.
   My earlier reasoning here — that a floor of 6 means "6-rep lateral raises",
   which is not a prescription worth writing — was wrong about what the floor
   IS. It is not a training style; it is the rep count you land on immediately
   after a load increase, when the weight is hardest. Climbing 6 -> 10 and then
   adding weight is exactly how double progression is supposed to read. The
   residual 38% shortfall is not the window's fault: a 2.5 lb step on a ~22 lb
   lateral raise is an 11% jump against ~15%/yr of real progress, so the
   equipment's granularity, not this constant, sets the floor on thrashing. */
const DP_WINDOW = 4;
const DP_MIN_REPS = ACC_REP_TIERS.accumulation.isolation.reps - DP_WINDOW;
/* AUDIT 2.6: the +1-rep-per-session rule was fixed regardless of how the
   previous set actually went — a set logged well under the block's target
   RPE (an easy rep-in-reserve session) earned the same single-rep bump as
   one logged right at target. rpeGap compares the tier's target RPE to what
   was actually logged; a bigger gap (more reserve left) earns a bigger bump.
   Thresholds are a coarse three-band split of the RPE table's own 0.5-point
   granularity, not a separately-derived constant. */
const DP_RPE_GAP_BIG = 1.5;
const DP_RPE_GAP_MED = 0.5;
const DP_BUMP_BIG = 3;
const DP_BUMP_MED = 2;
const DP_BUMP_SMALL = 1;
/* Overshooting the rep target (a big single-session jump, e.g. a rep PR) used
   to earn exactly one load step no matter how far past target the athlete
   landed — capped here so a large overshoot converts to more than one step,
   without ever taking a bigger leap than DP_MAX_STEPS in a single session
   (an isolation exercise's per-step jump is already a meaningful fraction of
   the working load — see audit 2.7's per-exercise increments). */
const DP_MAX_STEPS = 3;
/* A double-progression lift that logs a same-or-fewer rep count than its OWN
   last session, isolation-tier-wide, for this many consecutive sessions is
   stuck: the +1-rep target is being re-issued every session but never met,
   and load never adjusts to break the deadlock (see the pre-fix "stall" bug
   in the audit — 30x8 -> 30x9 forever). At the threshold, the next
   prescription cuts load instead of reissuing the same unreachable rep
   target, and the counter resets so it can only fire again after another
   full run of stalled sessions. Independent of STALL_STREAK_THRESHOLD, which
   governs cycle-level landmark auto-tuning, not session-level DP anchors. */
const DP_STALL_THRESHOLD = 4;
const DP_STALL_DECAY = 0.9;
/* Bodyweight-lift fallback threshold (see the L.bodyweight branch in
   prescribe). When the prescribed system load lands BELOW the athlete's
   bodyweight, unloaded reps are still the sensible prescription as long as
   the gap is small; below this fraction of bodyweight the set is genuinely
   too heavy and assistance is prescribed instead. 0.85 means "within ~15% of
   bodyweight" — a band narrow enough that the rep adjustment in that branch
   (repsAtPct) stays inside the RPE table's validated 1-12 rep range rather
   than running off its end, and wide enough that a lifter hovering near their
   first unassisted rep isn't flipped onto a band for a rounding wobble. Not a
   research-derived constant: it is a UI/prescription-shape choice about when
   to switch modes, and the mode it selects is always the safer of the two. */
const BW_REPONLY_FLOOR = 0.85;

function prescribe(program, readiness) {
  const day = ROTATION[program.cycleIndex % ROT];
  const cfg = BLOCKS[program.block.type];
  const cyc = program.block.cycle;
  const unit = program.unit;
  /* Frequency-corrects the ramped-accessory set count below (see the comment
     above weeklyTarget) — this is the actual per-session prescription math,
     not just a decision-site comparison; without it prescribe() keeps
     assuming exactly 4x/week regardless of the athlete's real cadence. */
  const freqScale = weeklyFreqScale(effectiveGapDays(program));

  /* AUDIT 3.1/3.9: an unusable reading falls back to "green" (no softening),
     the same as no readiness object at all — absent data must not be read as
     a maximum readiness deficit and silently cut the session by 40%. */
  const rxScore = readinessScore(readiness);
  const band = rxScore == null ? "green" : readinessBand(rxScore);
  const rpeAdj = READINESS_RPE_ADJ[band];

  const gapDays = program.lastSessionAt ? (Date.now() - program.lastSessionAt) / 86400000 : 0;
  const layoffFactor = gapDays > LAYOFF_THRESHOLD_DAYS
    ? 1 - Math.min(LAYOFF_MAX_DECAY, (gapDays - LAYOFF_THRESHOLD_DAYS) * LAYOFF_DECAY_PER_DAY)
    : 1;
  /* AUDIT 2.8: this session is in the post-layoff return window either because
     it's the live comeback itself (gapDays just crossed the threshold — the
     stored counter can't reflect that until it's logged) or because the
     PRIOR session's ingest() already marked the window open and it hasn't
     closed yet (see the sessionsSinceLayoff comment in ingest). */
  const inReturnWindow = gapDays > LAYOFF_THRESHOLD_DAYS
    || (program.sessionsSinceLayoff != null && program.sessionsSinceLayoff < 2);
  const setMult = READINESS_SET_MULT[band] * (inReturnWindow ? RETURN_SET_MULT : 1);

  const inTraining = program.block.type === "accumulation";
  const barWeight = program.barWeight || 45;
  const items = day.items.map((key, idx) => {
    const L = LIB[key];
    const lift = program.lifts[key];
    const accTarget = ACC_REP_TIERS[program.block.type][L.repTier];
    /* effort ramps across an accumulation block for every tier (rpeStep/
       rpeCap); deload is flat — see ACC_REP_TIERS */
    const accRpeBase = accTarget && accTarget.rpeStep
      ? Math.min(accTarget.rpeCap, accTarget.rpe + accTarget.rpeStep * cyc)
      : accTarget?.rpe;
    let reps = accTarget.reps;
    /* The post-layoff effort cap applies to the accessory RPE directly now
       that no main-lift RPE path exists to carry it (it used to be folded into
       rpeTop). Same intent: a comeback session is not the place to be at 1 RIR
       on the block's ramped effort target. */
    const rpeBase = clampRpe(accRpeBase + rpeAdj);
    const rpe = inReturnWindow ? Math.min(rpeBase, RETURN_RPE_CAP) : rpeBase;

    let sets;
    if (L.fixedSets) sets = Math.max(1, Math.round(L.fixedSets * VOL_SCALE[cfg.volLevel] * setMult));
    else {
      /* ramped pool accessory: prescribe the residual share (full-muscle
         accounting, frequency-corrected — see rampedSlotSets); readiness
         trims but never exceeds the slot's nominal share */
      const vg = L.volumeGroup; // shared landmark pool key (e.g. 'back')
      /* slotOrdinal picks THIS slot's share out of the group's allocation —
         two slots of the same group can legitimately differ by one set now
         that the residual's remainder is distributed rather than rounded
         per-slot (T1-3). */
      const slotOrdinal = SLOT_ORDINAL[`${program.cycleIndex % ROT}:${key}`] ?? 0;
      sets = Math.max(1, Math.round(rampedSlotSets(vg, program.block.type, cyc, program.landmarks, freqScale, slotOrdinal) * setMult));
    }
    /* Straight sets: one load, one rep target, one RPE target, `sets` times.
       The top-single-plus-backoff split existed for the barbell main lifts and
       went with them — for hypertrophy there is no reason to make the first set
       structurally different from the rest, and RP-style mesocycles prescribe
       straight sets throughout. backoffSetCount stays in the item shape (always
       0) because ingest()'s backoff-drift fatigue channel and the logging UI
       both branch on it. */
    const topSetCount = sets;
    const backoffSetCount = 0;

    const effE1rm = lift.e1rm * layoffFactor;
    const step = stepFor(L, unit); // audit 2.7: per-exercise override, defaults to the unit-based 5/2.5 step
    let topLoad, assistanceNeeded = false, repOnly = false, bodyweightUnknown = false, dpMode = false;
    if (L.bodyweight) {
      const bw = program.bodyweight;
      if (!(bw > 0)) {
        /* Bodyweight missing, zero, or non-finite (unset at onboarding, or lost
           in a migration). EVERY branch below is a comparison against bw, so
           without it there is no honest answer — and the dangerous failure is
           silent: `bw || 0` used to make addedRaw = rawSys - 0 >= 0, taking the
           "added weight" path and prescribing the athlete's ENTIRE system load
           as weight hung off a belt (a 240 lb pull-up e1RM prescribing +175 lb).
           Fall back to the one prescription that needs no bodyweight to be
           safe: unloaded reps. */
        topLoad = 0; repOnly = true; bodyweightUnknown = true;
      } else {
        const rawSys = effE1rm * rpePct(reps, rpe);
        const addedRaw = rawSys - bw;
        if (addedRaw >= 0) topLoad = Math.round(addedRaw / step) * step;
        else if (rawSys >= bw * BW_REPONLY_FLOOR) {
          /* Bodyweight alone is HEAVIER than the prescribed system load, but
             close enough that unloaded reps are still the right call. The load
             can't be reduced, so hold the RPE and move the REP target instead:
             solve for the rep count at which bodyweight sits at this RPE.
             Leaving `reps` untouched (the old behaviour) shipped a set up to
             1/BW_REPONLY_FLOOR ≈ 18% heavier than the RPE label claimed. */
          topLoad = 0; repOnly = true;
          reps = clampReps(repsAtPct(bw / effE1rm, rpe));
        }
        else {
          /* Bodyweight alone is too heavy — the athlete needs assistance. The
             magnitude is already known here (bw - rawSys), so emit it as a
             NEGATIVE added load rather than discarding it and leaving the
             athlete to guess a band. This is the same sign convention
             e1rmFromBW() already documents and accepts on the ingest side. */
          topLoad = -(Math.round((bw - rawSys) / step) * step);
          assistanceNeeded = true;
        }
      }
    } else if (L.repTier === "isolation" && lift.last?.w > 0) {
      /* Double progression for isolation accessories: at these low absolute
         loads one 5 lb / 2.5 kg plate step is a 15-25% jump, so re-deriving
         load from a noisy e1RM through a %1RM multiplier whipsaws the
         prescription. Instead: hold the last performed load and climb reps
         toward the tier's target; hitting the target earns a load step and
         resets reps to DP_MIN_REPS. `lift.last` only records
         accumulation/intensification sessions (see ingest), so deload
         haircuts never become the next progression anchor. Deload/realization
         prescribe the last working load minus ~15% at the tier's lighter
         rep/RPE targets. First-ever session (no `last` yet) falls back to the
         e1RM path below. */
      dpMode = true;
      if (inTraining) {
        const anchor = Math.round((lift.last.w * layoffFactor) / step) * step;
        const dpStalls = lift.dpStalls || 0;
        if (dpStalls >= DP_STALL_THRESHOLD) {
          // AUDIT 2.6: stuck on the same rep count for DP_STALL_THRESHOLD
          // sessions running — break the deadlock with a load cut instead of
          // reissuing the same unreachable rep target again.
          topLoad = Math.max(step, Math.round((lift.last.w * DP_STALL_DECAY * layoffFactor) / step) * step);
          reps = DP_MIN_REPS;
        } else if (lift.last.reps >= accTarget.reps) {
          // AUDIT 2.6: overshoot converts to more than one load step, capped.
          const overshootSteps = Math.min(DP_MAX_STEPS, Math.floor((lift.last.reps - accTarget.reps) / 2) + 1);
          topLoad = anchor + step * overshootSteps;
          reps = DP_MIN_REPS;
        } else {
          // AUDIT 2.6: bump size scales with reserve left at the last logged RPE,
          // not a flat +1 regardless of how easy that set actually was.
          const rpeGap = accRpeBase - (lift.last.rpe ?? accRpeBase);
          const bump = rpeGap >= DP_RPE_GAP_BIG ? DP_BUMP_BIG : rpeGap >= DP_RPE_GAP_MED ? DP_BUMP_MED : DP_BUMP_SMALL;
          topLoad = anchor;
          reps = clampReps(Math.max(DP_MIN_REPS, lift.last.reps + bump));
        }
      } else {
        topLoad = Math.max(step, Math.round((lift.last.w * 0.85 * layoffFactor) / step) * step);
      }
    } else {
      topLoad = loadFor(effE1rm, reps, rpe, unit, step);
    }
    const backoffLoad = topLoad; // straight sets — no distinct backoff load

    /* An earlier exercise this session already primed this one's target
       muscle iff it shares the same volumeGroup (the single canonical
       classifier). E.g. Lat Pulldown (back) primes Barbell Row (back), but
       Incline Curl (biceps) does not — even though both used to share the
       loose horiz_pull movement pattern. Shared by both warmup branches
       below (audit 2.10 extends this signal to the feeler path). */
    const earlierPrimed = day.items.slice(0, idx).some((k) => LIB[k].volumeGroup === L.volumeGroup);
    let warmup = null;
    if (L.barbell) {
      const topPct1RM = rpePct(reps, rpe);
      const baseTier = topPct1RM >= 0.85 ? "full" : topPct1RM >= 0.70 ? "short" : "minimal";
      let type = earlierPrimed ? (baseTier === "full" ? "short" : "minimal") : baseTier;
      /* AUDIT 2.9: tier is a pure function of %1RM with no first-of-session
         term, so the day's opening barbell lift could land on "minimal" (one
         warmup set) straight from cold — e.g. a volume-day squat at ~71%1RM.
         Never open a session's first barbell movement on a single set. */
      const isFirstBarbell = !day.items.slice(0, idx).some((k) => LIB[k].barbell);
      if (isFirstBarbell && type === "minimal") type = "short";
      const ramp = type === "full" ? FULL_RAMP : type === "short" ? SHORT_RAMP : MINIMAL_RAMP;
      const rampSets = buildRamp(topLoad, ramp, unit, barWeight);
      if (rampSets) warmup = { type, sets: rampSets };
    } else if (L.repTier === "compound" || L.repTier === "unilateral"
               || topLoad >= (unit === "kg" ? FEELER_LOAD_FLOOR_KG : FEELER_LOAD_FLOOR_LB)) {
      /* unilateral/compound accessories earn a feeler because at 6-8 reps a
         working set is no longer light enough to be its own warmup; isolation
         accessories earn one too once the load itself crosses the floor
         (audit 2.12) — repTier alone doesn't track absolute load. */
      warmup = buildFeeler(topLoad, reps, !!L.bodyweight, unit, step, earlierPrimed);
    }
    // isolation non-barbell accessories below the load floor: no warmup (working sets are light enough)

    return { key, label: L.label, barbell: L.barbell, repTier: L.repTier, volumeGroup: L.volumeGroup,
      bodyweight: !!L.bodyweight, unilateral: L.repTier === "unilateral",
      /* perDumbbell drives the "Weight per dumbbell" label, and is deliberately
         SEPARATE from `unilateral`. Unilateral means one limb at a time (split
         squat); perDumbbell means a matched pair held simultaneously (DB bench).
         Both log the weight of ONE dumbbell, but they are different training
         shapes and only the former gets the unilateral rep tier. Before the
         BB/DB exercises were split apart, every dumbbell press shared a slot
         with its barbell version and the athlete had no way to tell which
         convention a number was in. */
      perDumbbell: !!L.perDumbbell, assistanceNeeded, repOnly, bodyweightUnknown,
      reps, rpe, sets, topLoad, backoffLoad, backoffRpeCap: cfg.backoffRpeCap,
      topSetCount, backoffSetCount, warmup, dpMode };
  });

  /* AUDIT 3.13: if this day stacks more than one RAMPED slot for the same
     muscle (only back does, today — see SAME_DAY_GROUP_CAP), scale those
     items down proportionally so the day's total for that muscle never
     exceeds the same-session ceiling, rather than letting ACC_SET_CAP's
     per-slot bound multiply by however many of that muscle's slots happen
     to land on one day. A no-op for every group that doesn't stack. */
  const rampedByGroup = {};
  items.forEach((it, idx) => {
    if (LIB[it.key].fixedSets) return;
    (rampedByGroup[it.volumeGroup] = rampedByGroup[it.volumeGroup] || []).push(idx);
  });
  Object.values(rampedByGroup).forEach((idxs) => {
    if (idxs.length < 2) return;
    const total = idxs.reduce((s, i) => s + items[i].sets, 0);
    if (total <= SAME_DAY_GROUP_CAP) return;
    const scale = SAME_DAY_GROUP_CAP / total;
    /* topSetCount must be re-derived here, not left at whatever it was when the
       item was built: it is set to `sets` up in the map above, so scaling `sets`
       down without it silently breaks the topSetCount + backoffSetCount === sets
       invariant the logging UI and stress test both rely on (caught by the
       stress test as set-split-mismatch, e.g. top=6 backoff=0 sets=5). */
    idxs.forEach((i) => {
      const sets = Math.max(1, Math.round(items[i].sets * scale));
      items[i] = { ...items[i], sets, topSetCount: sets };
    });
  });

  /* blockEffortRpe reports the block's ramped effort target for this cycle at
     the compound tier — what `rpeTop` used to report for the main lifts. It is
     a display/diagnostic figure (Status screen, readiness_analysis.mjs), not an
     input to any prescription: each item's own RPE is computed per repTier
     above. Compound is the representative tier because it is the one whose
     effort target the athlete feels as "how hard is this block right now". */
  const compoundTier = ACC_REP_TIERS[program.block.type].compound;
  const blockEffortRpe = clampRpe((compoundTier.rpeStep
    ? Math.min(compoundTier.rpeCap, compoundTier.rpe + compoundTier.rpeStep * cyc)
    : compoundTier.rpe) + rpeAdj);
  return { dayName: day.name, block: cfg.label, cycle: cyc, blockEffortRpe, band, rpeAdj, setMult, items,
    layoff: layoffFactor < 1 ? { days: Math.round(gapDays), factor: +layoffFactor.toFixed(3) } : null };
}

/* ════════════ INGEST + STATE MACHINE ════════════ */
/* e1RM readings below this RPE don't update trend/PR machinery: the RPE table
   is an extrapolation below ~7, and deload runs at RPE 6 BY DESIGN — feeding
   those readings into the EWMA/slope treats a deliberately-light week as a
   strength change. Such sessions still count for fatigue/adherence below. */
const E1RM_MIN_RPE = 7;

function ingest(program, logs, readiness) {
  const next = structuredClone(program);
  const prs = [];
  const prEps = next.unit === "kg" ? 1 : 2; // ignore load-rounding jitter

  logs.forEach((g) => {
    const lift = next.lifts[g.key];
    const L = LIB[g.key];
    if (!lift || !L || !g.topReps) return;
    if (!L.bodyweight && !g.topWeight) return;
    /* Last-performed memory for the isolation double-progression rule — only
       from training blocks (deload/realization loads are deliberate haircuts,
       not progression anchors). Recorded even for untouched logs: logging an
       unedited prescription is a tacit claim the sheet was done as written,
       which is exactly the information double progression keys on. That's
       different from the trend gate below — an echoed log carries zero
       information about whether the MODEL's estimate is right, so it must not
       feed e1RM/slope, but it does tell us what load was on the bar. */
    if (next.block.type === "accumulation" || next.block.type === "intensification") {
      /* AUDIT 2.6 stall tracking: count consecutive DP sessions that log no
         more reps than the PREVIOUS session (see DP_STALL_THRESHOLD) so
         prescribe() can break a deadlocked rep target with a load cut.
         A dpStalls count already at/past threshold means the just-logged
         session WAS that load-cut prescription (prescribe() only takes the
         stall-decay branch once dpStalls reaches threshold) — resolved
         either way, so start the count over rather than let it climb
         forever. Otherwise: reps advanced past last time -> reset to 0;
         held or fell back -> +1. No prior `last` (first-ever session) can't
         be a stall by definition. */
      if (L.repTier === "isolation") {
        const priorStalls = lift.dpStalls || 0;
        const priorReps = lift.last?.reps;
        lift.dpStalls = priorStalls >= DP_STALL_THRESHOLD ? 0
          : (priorReps != null && g.topReps <= priorReps) ? priorStalls + 1 : 0;
      }
      lift.last = { w: g.topWeight, reps: g.topReps, rpe: g.topRpe };
    }
    /* Data-quality gates: a log the athlete never edited is the prescription
       echoed back, not a measurement — echoes sit exactly on the model's own
       prediction, flattening liftNormSlope toward zero and spuriously tripping
       the "stalled" transition. Logs without the flag (older records, test
       harnesses) are treated as touched. Sub-E1RM_MIN_RPE sessions are skipped
       for the table-validity reason above. */
    if (g.touched === false) return;
    if (g.topRpe < E1RM_MIN_RPE) return;
    const reading = L.bodyweight
      ? e1rmFromBW(next.bodyweight, g.topWeight, g.topReps, g.topRpe)
      : e1rmFrom(g.topWeight, g.topReps, g.topRpe);
    if (!reading) return;
    lift.e1rmRaw = reading;
    /* Faster EWMA for multi-joint work: a compound's logged e1RM is a less
       noisy estimate of real capability than an isolation lift's (heavier
       absolute loads, coarser rep ranges, less sensitive to a single
       cue/setup change), so its readings deserve more weight. Was keyed on
       role==="main" before the hypertrophy rebuild removed that role; the
       0.34/0.20 split itself is unchanged. */
    const alpha = LIB[g.key].repTier === "compound" ? 0.34 : 0.20;
    lift.e1rm = ewma(lift.e1rm, reading, alpha);
    /* hist entries tag the block type (`b`) so liftNormSlope can scope its
       window to the current block and skip cross-boundary rep-range steps */
    lift.hist = [...(lift.hist || []), { e: Math.round(lift.e1rm), raw: Math.round(reading), b: next.block.type }].slice(-60);
    /* raw-reading PR ratchet; first ingest sets the baseline silently */
    if (lift.best == null) lift.best = reading;
    else if (reading > lift.best + prEps) { prs.push(g.key); lift.best = reading; }
  });

  const rScore = readinessScore(readiness);

  const now = Date.now();
  const daysSinceLast = next.lastSessionAt != null ? (now - next.lastSessionAt) / 86400000 : 0;
  /* Session-specific fatigue is understood to mostly resolve within ~48-72h
     (ACSM-cited resistance training recovery window); we use a 3-day cap as a
     literature-grounded but not precisely-validated constant — gaps beyond it
     don't earn extra "recovered" credit.
     AUDIT 3.4: this decay is NO LONGER applied on top of the EWMA below. An
     EWMA already carries its own retention term (1 - alpha), so multiplying
     the prior by (1 - recoveryFactor) immediately before it applied recovery
     TWICE, and the accumulators could then only ever reach a fraction of
     their own inputs: readSupp settled at 0.424x the readiness deficit at
     4x/week (0.300x at gaps >= 3 days, where the "multi-session accumulator"
     was fully wiped every session), and rpeCreep at 0.533x its input, so
     saturating the /1.5 cap needed a sustained 2.81 RPE points of overshoot.
     Measured consequence: a realistically bad week (+1 RPE on every top set,
     +1 backoff drift, missed sets in 40% of exercises, amber readiness 45)
     peaked at index 0.427 — under FATIGUE_AMBER, let alone FATIGUE_SPIKE —
     and a full simulated year of ordinary training never exceeded 0.032.
     That left the fatigue-triggered deload, the borderline-transition coach
     escalation, the deload extension, and the next-session advisory's stretched
     advice all unreachable in practice. Recovery now applies only where
     there is no fresh evidence to supersede it (see the rpeCreep block
     below); readiness is not decayed at all, because today's reading already
     embeds the athlete's recovery. */
  const recoveryFactor = Math.min(1, daysSinceLast / 3);
  next.lastSessionAt = now;
  /* Rolling inter-session gap (days), capped so a one-off layoff doesn't wreck
     the average. Consumed by weeklyFreqScale() to frequency-scale the
     rotation≈week assumption: prescribe()'s ramped-accessory dosing,
     ingest()'s ceilingHit transition trigger, and adjustLandmarks' reachedCeiling
     auto-tune gate all read weeklyFreqScale(avgSessionGapDays) — see the
     comment above weeklyTarget() for what's scaled (the ramped-accessory
     residual, wherever it's computed) vs. deliberately not (fixedWeeklySets,
     ACC_SET_CAP/maxDeliverable — real structural counts and schedule-capacity
     ceilings, not rates). */
  /* AUDIT 3.7: a layoff is NOT a frequency signal, and folding it in inverted
     the intent of the layoff handling entirely. The old 14-day cap is 8x a
     normal 4x/week gap, so one 3-week break pushed avgSessionGapDays to ~5.4,
     freqScale to its 1.8 clamp, and — because freqScale MULTIPLIES the volume
     target (see weeklyTarget) — prescribed MORE sets on the comeback: quads
     ramped slots went 1 -> 4 (+300%), persisting ~11 sessions after the
     athlete had fully resumed normal frequency. That is the opposite of what
     RETURN_RPE_CAP/RETURN_SET_MULT (audit 2.8) exist to do, and it survived
     precisely because the two mechanisms were reasoned about separately.
     Layoff-length gaps are already handled by layoffFactor + the
     sessionsSinceLayoff return window; excluding them here leaves the
     frequency estimate describing the athlete's actual training cadence. */
  if (daysSinceLast > 0 && daysSinceLast <= LAYOFF_THRESHOLD_DAYS)
    next.avgSessionGapDays = ewma(next.avgSessionGapDays, daysSinceLast, 0.3);

  /* Session timestamps, newest last, for sessionsPerWeekObserved(). Kept as a
     plain bounded list rather than folded into a running statistic precisely
     because the thing it has to measure — a weekly PATTERN — is destroyed by
     the folding (see the comment above SESSION_RATE_WINDOW_WEEKS). Bounded to
     a little more than the rate window so it cannot grow without limit in
     stored program state. */
  next.sessionLog = [...(next.sessionLog || []), now].slice(-SESSION_LOG_MAX);
  /* The last rate read from a REPRESENTATIVE window, held so absences cannot
     move the dose. Written only when sessionsPerWeekObserved actually returns
     one — during and after a break it returns null, the stored value stands,
     and prescribing continues at the athlete's real cadence. A genuine change
     of cadence contains no abnormal gaps, so it flows through here normally and
     is picked up once three weeks of the new pattern accumulate. */
  const observedRate = sessionsPerWeekObserved(next);
  if (observedRate != null) next.sessionsPerWeek = observedRate;

  /* AUDIT 2.8: layoffFactor only softens LOAD — reps, RPE ceiling, and set
     count come back at full pre-layoff intensity the very next session, even
     though what detrains fastest is volume/eccentric tolerance, not the
     1RM the load cut is protecting. sessionsSinceLayoff counts logged
     sessions completed so far in the return window (the comeback session
     itself counts as 1); prescribe() applies RETURN_RPE_CAP/RETURN_SET_MULT
     for a session whenever it's either the live comeback (gapDays over
     threshold, detected directly in prescribe — this stored counter can't
     see that until AFTER it's logged) or sessionsSinceLayoff < 2 (the one
     session that follows it). Once a second session is logged the counter
     reaches 2 and the window closes. daysSinceLast, not gapDays as computed
     by the *next* prescribe() call, is deliberately what's tested here —
     it's the gap that just elapsed BEFORE this logged session, i.e. whether
     the session being ingested right now was itself the comeback. */
  if (daysSinceLast > LAYOFF_THRESHOLD_DAYS) next.sessionsSinceLayoff = 1;
  else if (next.sessionsSinceLayoff != null)
    next.sessionsSinceLayoff = next.sessionsSinceLayoff < 2 ? next.sessionsSinceLayoff + 1 : null;

  /* RPE-creep reads only TOUCHED main logs: an unedited log echoes the target
     back (miss = 0 by construction), so counting it would fake recovery. When
     no touched mains exist this session, only time-based recovery applies —
     see the else-branch below (AUDIT 3.4 / 3.T1: the old code claimed creep
     was "left where it was" in that case, but the unconditional pre-decay
     above had already cut it — 1.2 became 0.4000 after a single 2-day gap).
     rpeMiss/backoffDrift are hoisted (not just used inline) so this session's
     RAW outcome numbers — not the multi-session EWMA'd fatigue fields they
     also feed — can be returned below for readiness_analysis.mjs to compare
     against the readiness band/adjustment that was actually applied. null
     means "no evidence this session", not "zero overshoot". */
  /* Which logs carry the RPE-creep fatigue signal. This used to be the three
     barbell main lifts; with those gone it is the multi-joint work — compound
     and unilateral tiers. Rationale is unchanged from when it was "mains":
     these are the exercises whose logged RPE overshooting its target actually
     means systemic fatigue, because they are heavy enough and stable enough
     that a bad day shows up as effort creep rather than as noise. Isolation
     work is deliberately excluded: it is prescribed by double progression at
     RPE 8-10 and is MEANT to run to failure late in a block, so its RPE
     routinely sits at target-or-above for reasons that are the program working
     as designed, not fatigue. Folding it in would make fatigue.index climb
     every accumulation block by construction. */
  const anchorLogs = logs.filter((g) => {
    const t = LIB[g.key]?.repTier;
    return t === "compound" || t === "unilateral";
  });
  /* AUDIT 3.1: a log missing either RPE (older saved record, or any caller
     that omits targetRpe) yields Math.max(0, x - undefined) = NaN, which the
     EWMA then makes a PERMANENT NaN in fatigue.rpeCreep and fatigue.index.
     Same "no evidence" treatment as an untouched log: drop it from the mean
     rather than letting it poison the channel. */
  const rpeLogs = anchorLogs.filter((g) => g.touched !== false
    && Number.isFinite(g.topRpe) && Number.isFinite(g.targetRpe));
  let rpeMiss = null, backoffDrift = null;
  if (rpeLogs.length) {
    rpeMiss = rpeLogs.reduce((s, g) => s + Math.max(0, g.topRpe - g.targetRpe), 0) / rpeLogs.length;
    /* Backoff-set RPE drifting above its prescribed cap while the top set sits
       on target is fatigue accumulating UNDER the top set — cheap signal the
       UI already collects, previously discarded. Folded into the same creep
       channel at half weight (backoff sets are submaximal; their drift is a
       softer signal than a top-set overshoot). */
    // AUDIT 3.1: `!= null` lets NaN through (NaN != null is true) — require finite.
    const boLogs = rpeLogs.filter((g) => g.backoffSetCount > 0
      && Number.isFinite(g.backoffRpe) && Number.isFinite(g.backoffRpeCap));
    backoffDrift = boLogs.length
      ? boLogs.reduce((s, g) => s + Math.max(0, g.backoffRpe - g.backoffRpeCap), 0) / boLogs.length : 0;
    next.fatigue.backoffDrift = ewma(next.fatigue.backoffDrift ?? 0, backoffDrift, 0.4);
    next.fatigue.rpeCreep = ewma(next.fatigue.rpeCreep, rpeMiss + 0.5 * backoffDrift, 0.4);
  } else {
    /* AUDIT 3.4: no touched compound/unilateral logs — nothing supersedes the
       stored creep,
       so time-based recovery applies here INSTEAD of the EWMA, not on top of
       it. This is the only place the pre-EWMA decay used to be justified. */
    next.fatigue.rpeCreep *= (1 - recoveryFactor);
  }
  /* Multi-session readiness-deficit accumulator (fatigue.readSupp): a
     SEPARATE EWMA smoothing rate (READSUPP_EWMA_ALPHA) from
     READINESS_FATIGUE_WEIGHT below, on purpose — see the decoupling note
     above readinessScore(). This is the ONLY place readiness feeds the
     multi-session fatigue index; prescribe()'s same-day softening
     (READINESS_RPE_ADJ/READINESS_SET_MULT) never reads this field. */
  /* AUDIT 3.1: only fold a REAL reading into the accumulator. A missing or
     malformed one is no evidence about accumulated fatigue, so readSupp is
     left where it is rather than poisoned with NaN (permanent) or credited
     with a fabricated maximum deficit. */
  if (rScore != null) {
    next.fatigue.readSupp = ewma(next.fatigue.readSupp, 1 - rScore, READSUPP_EWMA_ALPHA);
    next.fatigue.hasReadiness = true;
  }
  /* PROPORTIONAL MISS TRACKING. This used to be
       logs.filter((g) => g.missedSets > 0).length / logs.length
     — a per-exercise BOOLEAN. The magnitude was discarded entirely, so missing
     one set of five and missing four of five produced an identical fatigue
     contribution, and the field's own "(reps short)" label described
     information the engine then threw away. Missing most of a session is
     categorically worse evidence than clipping one set, and the fatigue index
     could not see the difference.
     Now each exercise contributes the FRACTION of its prescribed reps that went
     unperformed — repsShort / (sets x target reps) — and missFreq is the mean
     of those fractions. Still bounded [0,1], so READINESS_FATIGUE_WEIGHT and
     the 0.2 weighting below are unchanged and every fatigue threshold keeps its
     meaning.
     Legacy logs carry `missedSets` (a COUNT OF SETS) instead of `repsShort`.
     Those are read at their original semantics rather than silently
     reinterpreted as reps — a stored 3 meant three sets, not three reps, and
     treating it as reps would understate a historical bad session by roughly
     the rep target. Converted as "those sets fell short", i.e. the same
     per-exercise fraction the old boolean implied. */
  const missFrac = (g) => {
    const target = (g.sets ?? 1) * (g.targetReps ?? g.topReps ?? 0);
    if (g.repsShort != null && target > 0)
      return Math.max(0, Math.min(1, g.repsShort / target));
    if (g.missedSets > 0) return Math.max(0, Math.min(1, g.missedSets / (g.sets ?? 1)));
    return 0;
  };
  const missFreq = logs.length ? logs.reduce((s, g) => s + missFrac(g), 0) / logs.length : 0;
  next.fatigue.missFreq = ewma(next.fatigue.missFreq, missFreq, 0.4);

  /* T2-3: with no readiness data the readiness term is structurally zero, so
     the index's supremum was 0.5 + 0.2 = 0.700 — exactly FATIGUE_SPIKE, which
     meant the spike threshold was reachable only in the degenerate limit where
     EVERY exercise in EVERY session misses sets AND rpeCreep is saturated,
     sustained. In practice that put highFatigue, the 3-day rest advice, and the
     entire fatigue-lowering branch of adjustLandmarks out of reach for anyone
     not syncing a wearable. Renormalising the two remaining weights over their
     own total restores the full 0..1 range instead of moving a threshold — the
     thresholds keep meaning the same thing whether or not readiness is present,
     which is the property that matters. Gated on hasReadiness rather than on
     `readSupp === 0`, because a genuinely well-recovered athlete WITH a wearable
     also sits at 0 and must not have their weights quietly rescaled. */
  const readingsSeen = next.fatigue.hasReadiness === true;
  const wCreep = readingsSeen ? 0.5 : 0.5 / (1 - READINESS_FATIGUE_WEIGHT);
  const wMiss = readingsSeen ? 0.2 : 0.2 / (1 - READINESS_FATIGUE_WEIGHT);
  /* The readiness term is gated on the same flag that rescales the other two.
     Ungated, any path leaving a stale readSupp behind while readingsSeen is
     false adds a third channel on top of two already-rescaled ones, for a total
     weight of 1.3. applyTransition was exactly such a path. That is fixed at
     source, but the weights should sum to 1 by construction rather than by
     every caller remembering to keep a flag in sync. */
  const fatigueIndex = Math.max(0, Math.min(1,
    wCreep * Math.min(1, next.fatigue.rpeCreep / RPE_CREEP_FULL_SCALE)
    + (readingsSeen ? READINESS_FATIGUE_WEIGHT * next.fatigue.readSupp : 0)
    + wMiss * next.fatigue.missFreq));
  next.fatigue.index = fatigueIndex;

  /* Block-level strength trend: main-lift slopes, PRECISION-WEIGHTED by the
     number of same-block readings each fit used. Deadlift logs one exposure
     per rotation vs two each for squat/bench, so early in a block its window
     is below slope()'s 3-point minimum and its placeholder-zero slope used to
     count 1/3 of the average — diluting a genuine squat/bench trend toward
     the stall threshold. Weighting by evidence lets the lifts with real data
     carry the signal; a lift with <3 points contributes nothing rather than a
     fake zero.
     T2-6: the lift list is now derived from the ROTATION instead of being the
     hardcoded ["squat", "bench", "deadlift"] the strength program left behind.
     Deadlift has not been in the rotation since the hypertrophy rebuild, so its
     hist never grew past its seed and it contributed n=0 forever — harmless,
     but it meant the block-level stall trigger for a 20-exercise program was
     riding on two exercises that both happen to fall on the same day. Every
     compound in the rotation now feeds it, which is both more evidence and
     evidence that cannot silently refer to something untrained. Compounds
     only: isolation e1RM is noisier and its double-progression load steps make
     the series jumpier, so it is a worse stall signal per reading. */
  const SLOPE_LIFTS = [...new Set(ROTATION.flatMap((d) => d.items))]
    .filter((k) => !LIB[k].fixedSets && LIB[k].repTier === "compound");
  const slopeInfos = SLOPE_LIFTS.map((k) => liftSlopeInfo(next.lifts[k]));
  const slopeN = slopeInfos.reduce((s, i) => s + i.n, 0);
  const e1rmSlope = slopeN ? slopeInfos.reduce((s, i) => s + i.g * i.n, 0) / slopeN : 0;
  next.fatigue.slope = e1rmSlope;

  next.sessionCount += 1;
  next.cycleIndex = (program.cycleIndex + 1) % ROT;
  next.block.sessionsInBlock += 1;
  next.block.cycle = Math.floor(next.block.sessionsInBlock / ROT);

  let transition = null;
  const endOfCycle = next.block.sessionsInBlock % ROT === 0;
  const cfg = BLOCKS[next.block.type];
  const cyc = next.block.cycle;

  if (endOfCycle) {
    const t = next.block.type;
    /* Volume-ceiling trigger, on DELIVERED volume (the sets actually
       prescribed — full-muscle accounting), for the three main-lift-driven
       groups only: they carry the systemic fatigue cost, and a small group
       (calves) saturating its slots shouldn't end accumulation for everything
       else. When the ceiling is true MRV, reaching it fires immediately; when
       the schedule saturates BELOW MRV (effectiveCeiling < mrv), the ceiling
       must have been held for one extra full cycle first — saturation alone
       isn't the same evidence of accumulated volume tolerance as reaching MRV. */
    const justDone = Math.max(0, cyc - 1);
    /* Convert both delivered volume and the schedule ceiling from per-rotation-
       pass units into a true per-CALENDAR-WEEK rate before comparing to the
       (already per-true-week) MRV landmark: one rotation spans freqScale weeks,
       so N sets/rotation is N/freqScale sets/week. MRV is a weekly number and
       is NOT scaled. Same conversion the adjustLandmarks auto-tune gate uses,
       so the two stay in agreement.
       deliveredWeekly is called WITH freqScale (prescribe() now delivers a
       frequency-corrected ramped-accessory count — see weeklyTarget — so this
       must reflect the SAME correction to accurately measure what was really
       prescribed) and the external /freqScale below still runs on top of that,
       converting the now-accurate per-rotation total into a rate. That is not
       double-scaling: passing freqScale in makes the number real; dividing by
       it afterward makes it comparable to a weekly landmark — two different
       jobs. maxDeliverable/capA is a schedule-capacity ceiling and stays
       unscaled internally (only its own /freqScale below, unchanged). */
    const freqScale = weeklyFreqScale(effectiveGapDays(next));
    /* THE VOLUME-CEILING TRIGGER IS GONE, and this records why so it is not
       reinvented. It read: has a major pool delivered everything the block can
       give it, so deload rather than repeat the top? It could never answer yes.

       It required `delivered >= ceilTrue` where `ceilTrue = min(mrv, capW)`,
       AND (AUDIT 3.6) `ceilTrue >= mav` so schedule saturation below the
       landmark range could not masquerade as accumulated tolerance. But the
       ramp tops out at MAV, so `delivered` never exceeds MAV — which leaves
       only `capW === mav` exactly, and then, because `ceilTrue < mrv` there, a
       further requirement that the PREVIOUS cycle also sat at the ceiling. The
       ramp reaches its top only in its final cycle, so that second cycle never
       exists. Two guards, each correct on its own, mutually exclusive together.

       Measured before removal: 11 firing combinations out of 234 swept over 3
       tiers x 13 freqScale values x 6 cycles, and ZERO end-to-end — 120
       sessions of healthy growth at both intermediate and advanced produced
       only "max accumulation length reached". Removing it changes no behaviour:
       `atVolCeiling` was constant false, so the reason string was unreachable
       and `borderline`'s `&& !atVolCeiling` was a no-op. The suite and the
       stress harness are identical before and after.

       If a volume-based trigger is wanted later it needs a different premise —
       something like "this group has now trained a full cycle AT its MAV",
       which is a statement about the ramp completing rather than about a
       ceiling being exceeded. That is also, note, exactly what maxCycles
       already detects, which is why this was only ever a second name for the
       same event. */
    const highFatigue = fatigueIndex >= 0.7;
    const grayFatigue = fatigueIndex >= 0.55 && fatigueIndex < 0.7;
    const stalled = e1rmSlope <= 0.001;

    if (t === "accumulation") {
      const enoughTime = cyc >= cfg.minCycles, maxedTime = cyc >= cfg.maxCycles;
      if (maxedTime || (enoughTime && (highFatigue || (stalled && cyc >= cfg.minCycles + 1)))) {
        transition = { to: "deload",
          reason: maxedTime ? "max accumulation length reached"
            : highFatigue ? "fatigue index high" : "e1RM progress stalled",
          borderline: grayFatigue && !maxedTime };
      }
    } else if (t === "deload") {
      /* Fatigue gate before routing out of deload: if fatigue hasn't cleared
         below FATIGUE_STILL_ELEVATED, extend deload by exactly one more cycle
         rather than proceeding on schedule. Capped at a single extension so we
         can't loop indefinitely — if it's still elevated after the extension we
         proceed anyway but flag it (forcedDespiteFatigue) so it's visible.
         Since the hypertrophy rebuild the only destination is a new
         accumulation block: deload no longer routes into an intensification or
         a max re-test, so nextAfter is vestigial and is not read here. */
      const stillElevated = fatigueIndex >= FATIGUE_STILL_ELEVATED;
      if (stillElevated && !next.block.deloadExtended) {
        next.block.deloadExtended = true; // extend one cycle; no transition this cycle
      } else {
        transition = { to: "accumulation",
          reason: stillElevated ? "deload complete — fatigue still elevated, proceeding anyway"
            : (next.block.deloadExtended ? "deload extended — fatigue cleared" : "deload complete — fatigue dissipated"),
          forcedDespiteFatigue: stillElevated };
      }
    }
  }

  /* rpeMiss/backoffDrift/missFreq are THIS SESSION's raw outcome numbers
     (before EWMA smoothing) — returned so callers can record what actually
     happened alongside the readiness band/adjustment that was applied, for
     later retrospective comparison (see readiness_analysis.mjs). Distinct
     from fatigueIndex/e1rmSlope, which are the smoothed multi-session state. */
  return { next, transition, fatigueIndex, rScore, e1rmSlope, prs, rpeMiss, backoffDrift, missFreq };
}

/* ---- next-session advisory ----
   Advisory only — the engine never blocks or restricts logging a session
   before the recommended date; this just informs the athlete.

   REPLACES restDaysForFatigue, which returned a flat 1/2/3 days and pointed at
   the wrong cadence in both readings. The athlete caught this: at normal
   fatigue it returned 1, and `now + 1 day` literally means "train again
   tomorrow" — 7 sessions/week, nearly double what the volume math is built
   for. Read the other way, as English ("take one rest day"), it lands on a
   2-day gap and 3.5 sessions/week. The program is tuned for 4. The old number
   was a MINIMUM SAFE GAP being displayed as a recommendation, and it happened
   to name the design cadence under neither interpretation.

   The target is now anchored on the schedule the volume math actually assumes.
   weeklyFreqScale is 1.0 — the unscaled centre of the whole volume system — at
   exactly ROT sessions per 7 days, i.e. a gap of 7/ROT days. At ROT = 4 that
   is 1.75 days: every muscle gets its two exposures per rotation spread over
   7 days, which is the 2x/week the frequency evidence supports.

   THE FRACTIONAL-GAP MECHANISM IS GONE, AND THIS IS WHY. The previous version
   added a fractional gap (7/ROT days) to a running target so the advised dates
   would walk through the week and average out to ROT sessions per 7 days. That
   is the correct way to hit a rate when training days are not tied to the
   calendar — but the athlete's schedule IS tied to the calendar: Monday to
   Friday, resting Saturday and Sunday. Followed literally from a Monday, the
   fractional advisory produced Mon -> Wed -> Thu -> Fri -> SUNDAY -> Mon: it
   skipped a Tuesday and advised training on a rest day.
   Against a fixed weekly schedule the calendar is the schedule, so the
   advisory now names the next TRAINING DAY. No fraction to accumulate, no
   drift to re-anchor. */
const TARGET_SESSION_GAP_DAYS = 7 / ROT;
/* Weekdays the athlete trains, as JS getDay() indices (0 = Sunday).
   Mon-Fri, resting Saturday and Sunday. The count deliberately equals ROT:
   one rotation day per training day means the rotation completes in exactly
   one calendar week, which is the cadence the whole volume system is centred
   on (weeklyFreqScale === 1). A mismatch here would silently reintroduce the
   drift this replaced, so it is asserted in the test suite. */
const TRAINING_WEEKDAYS = [1, 2, 3, 4, 5];
/* Fatigue stretches the gap rather than replacing it, so a tired athlete slows
   down from their own cadence instead of being handed an unrelated number.
   1.6x and 2.3x land a normal 1.75-day gap on ~2.8 and ~4.0 days — close to
   the old 2/3-day advisories at those fatigue levels, so the felt behaviour
   when genuinely beaten up is roughly preserved. */
const FATIGUE_GAP_STRETCH = { amber: 1.6, spike: 2.3 };
function nextSessionGapDays(fatigueIndex) {
  const stretch = fatigueIndex >= FATIGUE_SPIKE ? FATIGUE_GAP_STRETCH.spike
    : fatigueIndex >= FATIGUE_AMBER ? FATIGUE_GAP_STRETCH.amber
    : 1;
  return TARGET_SESSION_GAP_DAYS * stretch;
}
/* Fatigue expressed in the unit a fixed schedule actually has: TRAINING DAYS
   to skip. Derived from FATIGUE_GAP_STRETCH rather than hardcoded so the two
   cannot drift apart — at 5 training days a week, stretching the gap 1.6x and
   2.3x means advising the 2nd and 3rd training day out rather than the 1st,
   which is the same felt behaviour the gap version produced.

   CEIL, NOT ROUND. Math.round(2.3) is 2, which gave a fatigue SPIKE exactly
   the same advice as amber — collapsing the two bands into one and quietly
   removing the engine's most conservative recommendation. Rounding up also
   errs in the right direction for a recovery advisory: when the stretch falls
   between two training days, take the later one. */
function trainingDaysToSkip(fatigueIndex) {
  return Math.max(1, Math.ceil(nextSessionGapDays(fatigueIndex) / TARGET_SESSION_GAP_DAYS - 1e-9));
}

/* The advisory TIMESTAMP: the next training weekday after `now`, skipping
   further ahead when fatigue is elevated.

   Anchored on NOW rather than on a running target. The previous version
   carried prevTargetAt forward so a fractional gap could accumulate, and
   needed a drift threshold to stop it chasing a stale date after time off.
   Neither is needed once the advisory lands on weekdays: the calendar carries
   the schedule, so a returning athlete is simply told the next training day,
   and there is no fraction that can be lost by rounding to a date.

   Returns local midnight of the advised day. The athlete is being told WHICH
   DAY, not what time — and pinning it to midnight means the banner cannot show
   tomorrow's date because the session was logged late in the evening.

   prevTargetAt is accepted and ignored, keeping the call signature stable for
   App.jsx and for stored programs carrying the field. */
function nextSessionTargetAt(prevTargetAt, now, fatigueIndex) {
  let skip = trainingDaysToSkip(fatigueIndex);
  const d = new Date(now);
  /* Walk forward a day at a time and count only training days. Bounded at 21
     so a TRAINING_WEEKDAYS misconfiguration can never spin: with an empty
     list there is no next training day and the loop must terminate anyway. */
  for (let i = 1; i <= 21; i++) {
    const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
    if (!TRAINING_WEEKDAYS.includes(cand.getDay())) continue;
    if (--skip === 0) return cand.getTime();
  }
  return now + nextSessionGapDays(fatigueIndex) * 86400000; // unreachable with a sane schedule
}
/* Sessions per week the advisory is steering toward, for display. Derived from
   the same constant so the number shown to the athlete can never disagree with
   the date they are given. */
function targetSessionsPerWeek(fatigueIndex) {
  /* At normal fatigue this is the schedule itself — one session per training
     weekday — rather than a rate derived from a gap. Derived from
     TRAINING_WEEKDAYS.length so the number shown to the athlete cannot
     disagree with the dates they are given. Elevated fatigue skips training
     days, which divides the weekly count by the same factor. */
  return TRAINING_WEEKDAYS.length / trainingDaysToSkip(fatigueIndex);
}

function applyTransition(program, transition) {
  const next = structuredClone(program);
  /* Auto-tune volume landmarks for the next cycle as an accumulation block
     closes into a deload — the point where a full block's worth of growth +
     fatigue evidence is available. */
  if (program.block.type === "accumulation" && transition.to === "deload") {
    const { landmarks, adjustments, stallStreaks, stallNotices } = adjustLandmarks(program);
    if (Object.keys(adjustments).length) {
      next.landmarks = landmarks;
      next.landmarkAdjustments = { ...(program.landmarkAdjustments || {}), ...adjustments };
      next.landmarkLog = [...(program.landmarkLog || []), { at: Date.now(), cycle: program.block.cycle, changes: adjustments }].slice(-24);
    }
    /* Stall streaks/notices update every time adjustLandmarks runs, not just
       when adjustments is non-empty — a flat-growth block with no MEV/MRV
       change is exactly the case the streak needs to increment on. */
    next.stallStreaks = stallStreaks;
    next.stallNotices = stallNotices;
  }
  next.block = {
    type: transition.to, cycle: 0, sessionsInBlock: 0,
    nextAfter: transition.nextAfter || (transition.to === "deload" ? next.block.nextAfter : null),
  };
  if (transition.to === "accumulation")
    /* hasReadiness MUST survive this reset. It was dropped, and because
       readSupp is carried forward the next readiness-free session then
       renormalised the creep and miss weights to 0.714/0.286 while STILL
       adding the readiness term at its full 0.3 against a stale readSupp —
       total weight 1.3, measured fatigue index inflated 1.28x (0.422 against a
       true 0.329). Every threshold read against the index was wrong in that
       state: the advisory band, the deload trigger, and adjustLandmarks'
       fatigue branch. It repaired itself as soon as one session supplied
       readiness, which made it intermittent rather than harmless. */
    next.fatigue = { index: 0, rpeCreep: 0, readSupp: next.fatigue.readSupp,
      hasReadiness: next.fatigue.hasReadiness, missFreq: 0, slope: 0, backoffDrift: 0 };
  next.blockHistory = [...(next.blockHistory || []), { type: transition.to, at: Date.now(), reason: transition.reason,
    ...(transition.forcedDespiteFatigue ? { forcedDespiteFatigue: true } : {}) }];
  return next;
}

/* Accessory e1RM seeding ratios (fraction of a reference lift's e1RM) — used
   by freshProgram for a new program AND by migrateProgram to backfill a lift
   for any exercise added to the rotation after a program was saved (without
   this, prescribe() would crash on the missing lift). Rough on purpose: the
   EWMA re-anchors from the first real session. */
const ACC_E1RM_REF = {
  // lower — referenced off the two seeded lower lifts
  frontsquat: "squat", bsplit: "squat", legext: "squat", calfraise: "squat",
  legcurl: "rdl", deadlift: "rdl",
  // upper push — referenced off bench
  inclinebench: "bench", inclinebb: "bench", dbbench: "bench", dip: "bench",
  cablefly: "bench", dbshoulderpress: "bench",
  lateralraise: "bench", dblateralraise: "bench", triext: "bench", triceppushdown: "bench",
  wristcurl: "bench", bbwristcurl: "bench", cablecrunch: "bench",
  // upper pull — referenced off the seeded row rather than off bench, which is
  // what the pre-rebuild table did for every pulling movement. A pressing lift
  // is a poor predictor of pulling capacity; with T-Bar Row seeded directly at
  // onboarding these no longer have to guess across the push/pull divide.
  latpullover: "tbarrow", pulldown: "tbarrow", reversepecdeck: "tbarrow",
  bayesiancurl: "tbarrow", preachercurl: "tbarrow", shrug: "tbarrow",
};
/* bsplit: 0.2 is a PER-DUMBBELL fraction of squat e1RM, matching the logging
   convention on LIB.bsplit (one dumbbell, matched pair). Derived from the
   natural estimate of TOTAL added load for a loaded single-leg squat pattern
   (~0.4x squat e1RM combined across both hands — most of the resistance
   already comes from bodyweight loaded through one leg) halved for one hand.
   For a 315 lb squat e1RM (~388 lb) this seeds ~55 lb per dumbbell at cycle 0
   — a plausible opening load, not a guess: any future unilateral dumbbell
   exercise should size its own MULT the same way (estimate total two-hand
   load, then halve for the per-dumbbell logging convention). */
const ACC_E1RM_MULT = {
  frontsquat: 0.8, bsplit: 0.2, legext: 0.65, calfraise: 1.2,
  legcurl: 0.47, deadlift: 1.18, // rdl is seeded directly; deadlift ~= rdl / 0.85
  /* PER-DUMBBELL entries (LIB.perDumbbell) are fractions of the reference lift
     sized for ONE dumbbell of a matched pair, the same convention bsplit uses.
     A DB bench press moves roughly 80% of a barbell bench's total load, so one
     hand is ~0.4x — never 0.8x. Getting this wrong is not a rounding error, it
     is a 2x prescription, so every perDumbbell exercise's ratio below is a
     halved TOTAL estimate rather than a guess. */
  inclinebench: 0.4, inclinebb: 0.8, dbbench: 0.42, dip: 0.75,
  cablefly: 0.3, dbshoulderpress: 0.3,
  lateralraise: 0.12, dblateralraise: 0.1, triext: 0.45, triceppushdown: 0.42,
  wristcurl: 0.1, bbwristcurl: 0.15, cablecrunch: 0.4,
  // pull ratios are relative to T-Bar Row, not bench (see ACC_E1RM_REF)
  latpullover: 0.6, pulldown: 0.95, reversepecdeck: 0.2,
  bayesiancurl: 0.4, preachercurl: 0.45, shrug: 0.3,
};

function freshProgram({ seeds, experience, unit, goal, bodyweight }) {
  const landmarks = landmarksForExperience(experience);
  const lifts = {};
  Object.keys(LIB).forEach((k) => {
    let e1rm;
    if (LIB[k].bodyweight) {
      e1rm = seeds[k] ? e1rmFromBW(bodyweight, seeds[k].weight, seeds[k].reps, seeds[k].rpe) : bodyweight;
    } else if (seeds[k]) {
      e1rm = e1rmFrom(seeds[k].weight, seeds[k].reps, seeds[k].rpe);
    } else {
      const ref = ACC_E1RM_REF[k];
      const base = seeds[ref] ? e1rmFrom(seeds[ref].weight, seeds[ref].reps, seeds[ref].rpe) : 100;
      e1rm = base * (ACC_E1RM_MULT[k] || 0.6);
    }
    lifts[k] = { e1rm, e1rmRaw: e1rm, hist: [{ e: Math.round(e1rm), raw: Math.round(e1rm) }], volumeGroup: LIB[k].volumeGroup,
      /* T1-4: a program created now is already on the current per-dumbbell
         convention, so the migration-time ratio heuristic must never examine
         it. Stamping at creation is what keeps that heuristic scoped to the
         genuinely-legacy saves it was written for. */
      ...(CONVENTION_RESCALE[k] ? { convRescaled: true } : {}) };
  });
  return {
    unit, goal, experience: experience || "intermediate", landmarks, lifts, bodyweight,
    cycleIndex: 0, sessionCount: 0, lastSessionAt: null, avgSessionGapDays: null, sessionLog: [], sessionsPerWeek: null, sessionsSinceLayoff: null,
    fatigue: { index: 0, rpeCreep: 0, readSupp: 0, missFreq: 0, slope: 0, backoffDrift: 0 },
    block: { type: "accumulation", cycle: 0, sessionsInBlock: 0, nextAfter: null },
    blockHistory: [{ type: "accumulation", at: Date.now(), reason: "program start" }],
    landmarkAdjustments: {}, landmarkLog: [], stallStreaks: {}, stallNotices: {},
  };
}

/* Old movement-pattern landmark keys → new muscle keys. A program saved before
   the classification consolidation has its four compound landmarks keyed by the
   old pattern names; rename them in place so the athlete's auto-tuned MEV/MAV/MRV
   values (and their most-recent auto-tune deltas) carry over instead of being
   dropped and reseeded from the experience defaults. */
const LANDMARK_RENAME = { squat: "quads", hinge: "hamstrings", horiz_press: "chest", vert_press: "front_delts" };

/* Exercises the hypertrophy rebuild removed from LIB entirely (they are not on
   the athlete's approved list, so nothing may prescribe them again). Already-
   logged sessions still reference these keys, and History/PR rendering resolves
   a label as `LIB[k]?.label || RETIRED_LABELS[k] || k` — without this map an old
   session would render the bare key ("cablerow"). Label lookup only: nothing
   here participates in volume math, seeding, or prescription. */
const RETIRED_LABELS = {
  row: "Barbell Row", cablerow: "Seated Cable Row",
  ohp: "Overhead Press", curl: "Incline Dumbbell Curl", seatedcalf: "Seated Calf Raise",
};

/* Seeding an exercise the rebuild ADDED, for a program saved before it existed.
   The generic ACC_E1RM_REF backfill can't do this alone: these five have no
   pre-rebuild equivalent under their own key, and several reference lifts that
   are themselves new (bayesiancurl → tbarrow), so a saved program would seed
   them off the `|| 100` fallback and open at a nonsense load. Each entry is an
   ordered list of [sourceKeyTheOldProgramMightHave, ratio]; the first source
   actually present wins, and anything with no source falls through to the
   generic path. Ratios are rough by design — the e1RM EWMA re-anchors from the
   first real session, and every one of these errs light rather than heavy. */
const RETIRED_LIFT_SEEDS = {
  tbarrow:      [["row", 1.0], ["cablerow", 1.0]],
  latpullover:  [["cablerow", 0.8]],
  bayesiancurl: [["curl", 1.0]],
  preachercurl: [["curl", 1.1]],
  dip:          [["bench", 0.75]],
};

/* Lifts whose LOGGING CONVENTION changed, not just their label.
   Splitting the slash-separated exercises apart (DB/BB bench, machine/DB
   lateral raise, etc.) forced every dumbbell movement to declare whether its
   logged number is one dumbbell or the pair — `perDumbbell` on LIB. For the
   entries below the answer is now "one dumbbell", but a saved program may hold
   an e1RM recorded under the older, ambiguous convention at roughly double
   that. Prescribing from an unconverted value would issue a per-dumbbell load
   equal to the athlete's two-dumbbell (or barbell) load — a 2x overload on a
   pressing movement, which is the one direction this must never fail in.
   Detection is a ratio test against a reference lift the program already
   tracks, with the threshold set between the old and new expected ratios, and
   the repair reseeds rather than guessing a conversion factor: the e1RM EWMA
   re-anchors from the first real session anyway, so a slightly-low reseed
   costs one session of easy work while a silent 2x costs an injury. */
const CONVENTION_RESCALE = {
  inclinebench:    { ref: "bench",   suspectAbove: 0.6,  reseedAt: 0.4 },
  dbshoulderpress: { ref: "bench",   suspectAbove: 0.45, reseedAt: 0.3 },
  shrug:           { ref: "tbarrow", suspectAbove: 0.42, reseedAt: 0.3 },
};

/* Reconcile a loaded program's landmark keys to the current PATTERNS set so
   older saved programs survive landmark-schema changes: first rename any old
   pattern-named keys to their muscle names (preserving tuned values), then add
   any still-missing group from the experience defaults and drop any stale group
   no longer in the schema. Generic by design — it already backfills every schema
   addition automatically: the merged 'back' pool, and the promoted
   'rear_delts' / 'calves' pools (previously fixedSets, now landmark-tracked).
   Without this, a pre-change saved program would hit an undefined landmark on
   the next prescribe() for one of those exercises. */
function migrateProgram(program) {
  if (!program?.landmarks) return program;
  const canonical = landmarksForExperience(program.experience);
  const lm = { ...program.landmarks };
  const adj = { ...(program.landmarkAdjustments || {}) };
  let changed = false;
  // 1. rename old pattern-named keys to muscle names, keeping their values.
  for (const [oldKey, newKey] of Object.entries(LANDMARK_RENAME)) {
    if (lm[oldKey] && !lm[newKey]) {
      lm[newKey] = { ...lm[oldKey], label: canonical[newKey]?.label ?? lm[oldKey].label };
      delete lm[oldKey];
      if (adj[oldKey]) { adj[newKey] = adj[oldKey]; delete adj[oldKey]; }
      changed = true;
    }
  }
  /* 1.5. rear/side delt split: a program without a side_delts pool predates
     the split, so its rear_delts numbers describe the OLD combined pool
     (rear + side pooled). Those tuned values are a different quantity than
     the new rear-only pool measures — carrying them over would hand the
     rear-only pool a combined-pool MRV — so rear_delts resets to canonical
     and step 2 below adds side_delts fresh. */
  if (lm.rear_delts && !lm.side_delts) {
    lm.rear_delts = { ...canonical.rear_delts };
    delete adj.rear_delts;
    changed = true;
  }
  // 2. add any missing group, drop any stale group.
  for (const key of Object.keys(canonical)) if (!lm[key]) { lm[key] = canonical[key]; changed = true; }
  for (const key of Object.keys(lm)) if (!canonical[key]) { delete lm[key]; changed = true; }
  /* 2.5 (T2-4). Bring any landmark set that violates MEV_MAV_MAX_RATIO back
     inside the bound, as a migration step.
     A program saved before the ramp-collapse fix could carry a legacy one-way
     MEV ratchet with MAV untuned — e.g. quads 12/14/18, an MEV/MAV ratio of
     0.857 against a bound of 0.65. None of the seeded tiers can produce that,
     so it arrives only through migration. Left alone, the first growth block
     would clamp it and report the correction to the athlete as
     {dMev: -3, signal: "growth strong, fatigue in check"} — a volume CUT
     labelled as a strong-growth adjustment, which is worse than the stale
     number it fixes. Correcting it silently here, where "we changed your saved
     data to fit the current schema" is exactly what the athlete is already
     being told, keeps the adjustment log honest. */
  for (const key of Object.keys(lm)) {
    const cap = Math.floor(lm[key].mav * MEV_MAV_MAX_RATIO);
    if (lm[key].mev > cap) { lm[key] = { ...lm[key], mev: Math.max(1, cap) }; changed = true; }
  }
  /* 3. backfill a lift record for any rotation member added to the program
     AFTER this save was created (e.g. bsplit re-entering the rotation) —
     seeded off a reference lift the program already tracks, exactly like
     freshProgram. Without this, prescribe() dereferences a missing lift and
     crashes on the first day containing the new exercise. */
  const lifts = { ...(program.lifts || {}) };
  let liftsChanged = false;
  const seedLift = (k, e1rm) => {
    lifts[k] = { e1rm, e1rmRaw: e1rm, hist: [{ e: Math.round(e1rm), raw: Math.round(e1rm) }], volumeGroup: LIB[k].volumeGroup };
    liftsChanged = true;
  };
  /* 3a. exercises the hypertrophy rebuild ADDED — seed from the closest lift
     the saved program already tracks before the generic pass below, which
     would otherwise fall through to its `|| 100` default (see
     RETIRED_LIFT_SEEDS). Runs first so that a new lift seeded here can itself
     serve as the ACC_E1RM_REF base for another new lift in 3b. */
  Object.entries(RETIRED_LIFT_SEEDS).forEach(([k, sources]) => {
    if (lifts[k] || !LIB[k]) return;
    const hit = sources.find(([src]) => lifts[src]?.e1rm > 0);
    if (hit) seedLift(k, lifts[hit[0]].e1rm * hit[1]);
  });
  /* 3b. backfill a lift record for any rotation member added to the program
     AFTER this save was created — seeded off a reference lift the program
     already tracks, exactly like freshProgram. Without this, prescribe()
     dereferences a missing lift and crashes on the first day containing the
     new exercise. */
  ROTATION.forEach((d) => d.items.forEach((k) => {
    if (lifts[k]) return;
    const base = lifts[ACC_E1RM_REF[k]]?.e1rm || 100;
    seedLift(k, base * (ACC_E1RM_MULT[k] || 0.6));
  }));
  /* 3c. reseed any lift still carrying an e1RM on a superseded LOGGING
     convention (see CONVENTION_RESCALE). Runs after the backfills so the
     reference lifts it tests against are guaranteed present. */
  /* T1-4: the ratio test fires AT MOST ONCE per lift, ever, and is stamped so
     it can never fire again. Without the stamp this ran on every program load
     against the lift's CURRENT value, so a lift that grew legitimately past its
     threshold was silently reseeded back down — measured: a shrug progressing
     3%/month against a flat T-Bar Row got cut 29% (106 -> 75 lb) the month it
     crossed 0.42x, and would be cut again every time it climbed back. That is a
     permanent invisible ceiling on the lift, not a one-time migration.
     The stamp is also what makes the heuristic defensible at all: it is only
     ever asked "was this value recorded under the old convention?", which is a
     question about a program's ORIGIN, so it must be answered once at first
     load and then remembered — never re-litigated against a value that has
     since moved for ordinary training reasons. freshProgram stamps every
     candidate key at creation, so a program created after the split is never a
     candidate and the whole misfire class disappears for new athletes. */
  Object.entries(CONVENTION_RESCALE).forEach(([k, { ref, suspectAbove, reseedAt }]) => {
    if (!lifts[k] || lifts[k].convRescaled) return;
    const cur = lifts[k]?.e1rm, base = lifts[ref]?.e1rm;
    if (!(cur > 0) || !(base > 0)) return;
    if (cur > base * suspectAbove) { seedLift(k, base * reseedAt); liftsChanged = true; }
    lifts[k] = { ...lifts[k], convRescaled: true };
    liftsChanged = true;
  });
  // 4. backfill stall-notice tracking for a program saved before this feature existed.
  const stallStreaks = program.stallStreaks || {};
  const stallNotices = program.stallNotices || {};
  const stallFieldsChanged = !program.stallStreaks || !program.stallNotices;
  /* 4b. sessionLog, for a program saved before frequency was measured as a
     weekly rate. Backfilled EMPTY rather than reconstructed: with fewer than
     SESSION_RATE_MIN_SESSIONS entries effectiveGapDays falls back to the
     tracked mean gap, so the athlete keeps their existing dosing and the rate
     estimator takes over once enough real sessions have accumulated. Inventing
     plausible timestamps would hand the new estimator fabricated evidence. */
  const sessionLog = Array.isArray(program.sessionLog) ? program.sessionLog : [];
  const sessionLogChanged = !Array.isArray(program.sessionLog);
  /* 5. a program saved mid-intensification or mid-realization is sitting in a
     block type the hypertrophy rebuild deleted — BLOCKS has no config for it,
     so prescribe() would dereference undefined on the very next session. Land
     it at the start of a fresh accumulation block: that is where both of those
     blocks were headed anyway (realization always transitioned to accumulation,
     and intensification reached it one deload later), and starting at cycle 0
     means the volume ramp restarts from MEV rather than resuming mid-ramp at a
     cycle index the new block never assigned. */
  let block = program.block;
  let blockChanged = false;
  if (block && LEGACY_BLOCK_TYPES[block.type]) {
    block = { type: "accumulation", cycle: 0, sessionsInBlock: 0, nextAfter: null };
    blockChanged = true;
  }
  return (changed || liftsChanged || stallFieldsChanged || blockChanged || sessionLogChanged)
    ? { ...program, landmarks: lm, landmarkAdjustments: adj, lifts, stallStreaks, stallNotices, block, sessionLog }
    : program;
}

/* ---- plate math (pure; the Barbell UI component in App.jsx renders these) ---- */
const PLATES = [
  { w: 45, c: "#D7443E", h: 58 }, { w: 35, c: "#2F6FB0", h: 50 }, { w: 25, c: "#3FA85F", h: 42 },
  { w: 10, c: "#C9CDD4", h: 30 }, { w: 5, c: "#E8C547", h: 22 }, { w: 2.5, c: "#9AA0AC", h: 16 },
];
function platesForSide(weight, bar = 45) {
  let per = (weight - bar) / 2; const out = [];
  if (per <= 0) return out;
  for (const p of PLATES) while (per >= p.w) { out.push(p); per = +(per - p.w).toFixed(2); }
  return out;
}
function plateText(weight, bar = 45) {
  if (weight <= bar) return "empty bar";
  const side = platesForSide(weight, bar);
  if (!side.length) return "empty bar";
  return side.map((p) => p.w).join("+") + "/side";
}

export {
  RPE_TABLE, clampReps, clampRpe, rpePct, repsAtPct, e1rmFrom, e1rmFromBW, loadFor, ewma, slope, liftNormSlope, liftSlopeInfo,
  PATTERNS, EXPERIENCE_TIERS, landmarksForExperience,
  LIB, ROTATION, ROT, PATTERN_FREQ, PATTERN_OF, ACC_SET_CAP, maxDeliverable, VOL_SCALE, ACC_REP_TIERS, BLOCKS,
  weeklyTarget, fixedWeeklySets, rampedSlotSets, rampedAllocation, deliveredWeekly, effectiveCeiling, weeklyFreqScale,
  capacityShortfalls, capacityPinned, FREQ_SCALE_MIN, FREQ_SCALE_REACHABLE_MIN, effectiveGapDays, sessionsPerWeekObserved, TRAINING_WEEKDAYS, abnormalGapDays,
  SESSION_RATE_WINDOW_WEEKS, SESSION_RATE_MIN_SESSIONS, SESSION_LOG_MAX, trainingDaysToSkip,
  PATTERN_DAY_SLOTS, SLOT_ORDINAL,
  FATIGUE_SPIKE, FATIGUE_AMBER, FATIGUE_STILL_ELEVATED, GROWTH_POS, E1RM_MIN_RPE, STALL_STREAK_THRESHOLD,
  LAYOFF_THRESHOLD_DAYS, LAYOFF_DECAY_PER_DAY, LAYOFF_MAX_DECAY,
  DP_MIN_REPS, DP_WINDOW, BW_REPONLY_FLOOR, LEGACY_BLOCK_TYPES, RETIRED_LABELS, RETIRED_LIFT_SEEDS,
  MEV_MAV_MAX_RATIO, RPE_CREEP_FULL_SCALE, RAMPED_SET_FLOOR, CONVENTION_RESCALE,
  DP_RPE_GAP_BIG, DP_RPE_GAP_MED, DP_BUMP_BIG, DP_BUMP_MED, DP_BUMP_SMALL, DP_MAX_STEPS, DP_STALL_THRESHOLD, DP_STALL_DECAY,
  RETURN_RPE_CAP, RETURN_SET_MULT, FEELER_LOAD_FLOOR_LB, FEELER_LOAD_FLOOR_KG, SAME_DAY_GROUP_CAP, FATIGUE_FLOOR_FRAC,
  PATTERN_MAIN, PATTERN_RAMPED_ACC, patternGrowth, adjustLandmarks,
  readinessScore, readinessBand, READINESS_RPE_ADJ, READINESS_SET_MULT, READINESS_FATIGUE_WEIGHT, READSUPP_EWMA_ALPHA,
  FULL_RAMP, SHORT_RAMP, MINIMAL_RAMP, buildRamp, buildFeeler,
  prescribe, ingest, nextSessionGapDays, nextSessionTargetAt, targetSessionsPerWeek, TARGET_SESSION_GAP_DAYS, applyTransition, freshProgram,
  LANDMARK_RENAME, migrateProgram,
  PLATES, platesForSide, plateText,
};
