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

   • Load = autoregulated RPE → estimated-1RM (Zourdos/Helms RPE chart),
     not fixed %1RM or fixed +5lb increments. e1RM is re-read every session
     from weight×reps×RPE, so load floats with daily readiness + adaptation.
   • Volume periodized between user-set landmarks (MEV→MAV→MRV weekly hard
     sets per movement pattern). Accessories carry ramping hypertrophy volume;
     main lifts stay moderate (strength has stronger diminishing returns).
   • Block periodization without a peak: accumulation ⇄ intensification, deload
     between, brief realization re-test. Block length auto-detected from e1RM
     trend + RPE-creep + readiness suppression.
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
/* Applying RPE_TABLE unmodified to unilateral work (repTier:"unilateral", e.g.
   bsplit): the underlying Helms/Zourdos data was validated on bilateral
   barbell compounds, not stability-limited single-leg/arm movements, so this
   is a judgment call, not a proven fit — but a defensible one, and no numeric
   offset is applied. Reasoning: e1rmFrom/loadFor never compare this e1rm
   against another exercise's — every read (e1rmFrom) and every prescription
   (loadFor) round-trips through the SAME per-exercise e1rm, so the table only
   needs to be a reasonable model of how THIS lift's own %-of-max decays across
   reps/RPE, not an absolute cross-exercise truth. A flat offset (shifting RPE
   or scaling load) would only be justified by evidence that the CURVE's shape
   — not its anchor — differs for unilateral work; no such exercise-specific
   data exists to size an offset from, and inventing one would be exactly the
   unjustified fudge factor this was flagged against. If balance/coordination
   fatigue causes systematic RPE under-reporting relative to true mechanical
   effort, that shows up as a slower measured e1RM climb, which the existing
   EWMA/slope machinery already absorbs — no separate correction needed. */
/* ---- bodyweight lifts: e1rm tracked as SYSTEM load (bodyweight + added) ----
   added may be 0 (bodyweight-only) or negative (band/machine assistance),
   so unlike e1rmFrom() we can't gate on truthy weight — only reps + a
   positive system load are required. */
function e1rmFromBW(bodyweight, added, reps, rpe) {
  const sys = (bodyweight || 0) + (added || 0);
  if (!reps || sys <= 0) return 0;
  return sys / rpePct(reps, rpe);
}
function loadFor(e1rm, reps, rpe, unit) {
  const raw = e1rm * rpePct(reps, rpe);
  const step = unit === "kg" ? 2.5 : 5;
  return Math.max(0, Math.round(raw / step) * step);
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
  const ys = run.slice(-8).map((p) => p.raw ?? p.e);
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
   Same MEV/MAV/MRV numbers as before — this was a rename, not a recalculation.
   migrateProgram() renames these keys in any already-saved program. */
const PATTERNS = {
  quads:       { label: "Quads",               mev: 8,  mav: 14, mrv: 20 },
  hamstrings:  { label: "Hamstrings / Post. chain", mev: 6, mav: 12, mrv: 16 },
  chest:       { label: "Chest",               mev: 8,  mav: 14, mrv: 22 },
  /* Front delts get indirect stimulus from chest/triceps pressing already
     covered elsewhere in the program; RP's published landmark table gives
     them an MEV of 0 for that reason. mev:2 keeps a small non-zero floor
     since this program tracks front-delt pressing as part of a whole routine,
     not in isolation. mav:7 is the midpoint of RP's 6-8 range. */
  front_delts: { label: "Front Delts",         mev: 2,  mav: 7,  mrv: 12 },
  /* Horizontal + vertical pulling are consolidated into ONE 'back' volume pool:
     RP's landmark research treats back as a single muscle group, not two. Every
     pulling exercise carries volumeGroup:'back' so all their volume math
     (PATTERN_FREQ / weeklyTarget / landmark auto-tune) shares this pool. */
  back:        { label: "Back",                mev: 10, mav: 18, mrv: 25 },
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
  rear_delts:  { label: "Rear Delts",          mev: 4,  mav: 10, mrv: 16 },
  side_delts:  { label: "Side Delts",          mev: 6,  mav: 12, mrv: 18 },
  calves:      { label: "Calves",              mev: 8,  mav: 14, mrv: 20 },
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
  squat:        { label: "Back Squat",                    role: "main", barbell: true, volumeGroup: "quads" },
  bench:        { label: "Bench Press",                   role: "main", barbell: true, volumeGroup: "chest" },
  deadlift:     { label: "Deadlift",                      role: "main", barbell: true, volumeGroup: "hamstrings" },
  rdl:          { label: "Romanian Deadlift",              role: "acc",  barbell: true,  repTier: "compound", volumeGroup: "hamstrings" },
  frontsquat:   { label: "Front Squat",                   role: "acc",  barbell: true,  repTier: "compound", volumeGroup: "quads" },
  /* out of rotation by athlete preference — DB Shoulder Press carries the
     front-delt slot; kept defined for History labels/old e1RM records */
  ohp:          { label: "Overhead Press",                role: "acc",  barbell: true,  repTier: "compound", volumeGroup: "front_delts" },
  row:          { label: "Barbell Row",                   role: "acc",  barbell: true,  repTier: "compound", volumeGroup: "back" },
  cablerow:     { label: "Seated Cable Row",               role: "acc",  barbell: false, repTier: "compound", volumeGroup: "back" },
  pulldown:     { label: "Lat Pulldown",                  role: "acc",  barbell: false, repTier: "compound", volumeGroup: "back" },
  pullup:       { label: "Pull-Up / Chin-Up",             role: "acc",  barbell: false, bodyweight: true, repTier: "compound", volumeGroup: "back" },
  curl:         { label: "Incline Dumbbell Curl",         role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", volumeGroup: "biceps" },
  triext:       { label: "Cable Overhead Triceps Extension", role: "acc", barbell: false, fixedSets: 3, repTier: "isolation", volumeGroup: "triceps" },
  lateralraise: { label: "Cable Lateral Raise",           role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "side_delts" },
  /* LOGGING CONVENTION for this and any future repTier:"unilateral" dumbbell
     exercise: log the weight of ONE dumbbell, assuming a matched pair (one in
     each hand) — the convention lifters already use mentally for split
     squats/lunges, and the one App.jsx's "Weight per dumbbell" field label
     (driven by prescribe()'s `unilateral` flag, not a bsplit-specific check)
     assumes. See ACC_E1RM_MULT.bsplit for how the seed ratio maps to this. */
  bsplit:       { label: "Bulgarian Split Squat",         role: "acc",  barbell: false, repTier: "unilateral", volumeGroup: "quads" },
  calfraise:    { label: "Standing Calf Raise",           role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "calves" },
  inclinebench: { label: "Incline Dumbbell Press (~30°)", role: "acc",  barbell: false, repTier: "compound", volumeGroup: "chest" },
  legcurl:      { label: "Seated Leg Curl",               role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", volumeGroup: "hamstrings" },
  /* out of rotation — its D0 slot went to Bulgarian Split Squat (same quad
     volume, plus unilateral stability/asymmetry work the program otherwise
     lacked); kept defined for History labels/old e1RM records */
  legext:       { label: "Leg Extension",                 role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", volumeGroup: "quads" },
  reversepecdeck: { label: "Reverse Pec Deck",             role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "rear_delts" },
  wristcurl:    { label: "Dumbbell Wrist Curl",           role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", volumeGroup: "forearms" },
  cablecrunch:  { label: "Cable Crunch",                  role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", volumeGroup: "abs" },
  shrug:        { label: "Dumbbell Shrug",                role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", volumeGroup: "traps" },
  cablefly:     { label: "Cable Fly",                     role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "chest" },
  dbshoulderpress: { label: "Dumbbell Shoulder Press",    role: "acc",  barbell: false, repTier: "compound", volumeGroup: "front_delts" },
};

/* ---- rotation: which lifts each training day trains ----
   volumeDay: main lifts on this day get a differentiated second exposure —
   higher reps, RPE-capped (see VOLUME_DAY_* in prescribe) — instead of
   repeating the week's first heavy top set.
   Session-balance note: the previous layout peaked Bench day at 31 sets while
   Squat day sat at 24. Three moves rebalance late-block days to ~28/28/30/23
   with no net weekly growth: OHP dropped (athlete preference), its D1 space
   taken by the second lateral-raise slot (side delts lose OHP's indirect work
   and have no other direct driver); triceps isolation moved D1→D0 (trained
   fresh instead of pre-fatigued 8th on pressing day — triceps already get
   heavy indirect work from every D1 press); Bulgarian Split Squat takes leg
   extension's D0 slot as a ramped unilateral quad slot. */
const ROTATION = [
  { name: "Squat",            items: ["squat", "rdl", "bsplit", "legcurl", "calfraise", "triext", "wristcurl", "cablecrunch"] },
  { name: "Bench",            items: ["bench", "cablerow", "pullup", "inclinebench", "dbshoulderpress", "reversepecdeck", "lateralraise"] },
  { name: "Deadlift",         items: ["deadlift", "frontsquat", "pulldown", "curl", "row", "shrug", "calfraise", "reversepecdeck"] },
  { name: "Squat+Bench Vol.", volumeDay: true, items: ["squat", "bench", "curl", "lateralraise", "cablefly", "calfraise"] },
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
    if (LIB[k].role === "main" || LIB[k].fixedSets) return;
    const p = LIB[k].volumeGroup; f[p] = (f[p] || 0) + 1;
  }));
  return f;
})();
/* Hard per-exercise weekly set cap: prescribe() never assigns a single ramped
   accessory more than this many sets in a week, however high the landmark
   target climbs. */
const ACC_SET_CAP = 4;
/* ---- fixedSets accessories still shrink with block volume tier + readiness ---- */
const VOL_SCALE = { ramp: 1, mev: 0.75, half: 0.5 };

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

/* Weekly sets a group receives from sources that do NOT ramp: main-lift work
   (BLOCKS[bt].mainSets per rotation slot) and fixedSets accessories (scaled by
   the block's volume tier). Green-readiness nominal, same as weeklyTarget. */
function fixedWeeklySets(group, blockType) {
  const cfg = BLOCKS[blockType];
  let total = 0;
  ROTATION.forEach((d) => d.items.forEach((k) => {
    const L = LIB[k];
    if (L.volumeGroup !== group) return;
    if (L.role === "main") total += cfg.mainSets;
    else if (L.fixedSets) total += Math.max(1, Math.round(L.fixedSets * VOL_SCALE[cfg.volLevel]));
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
  return fixedWeeklySets(group, blockType) + ACC_SET_CAP * (PATTERN_FREQ[group] || 0);
}

/* ---- per-tier accessory rep + RPE targets ----
   Both reps and RPE are direct per-tier lookups. Compound + unilateral
   accessories run 6-8 reps (athlete's stated range — heavier, strength-
   supporting loading for multi-joint work): the higher-rep end (8) in
   accumulation, the lower end (6-7) in intensification as loads climb with
   the block's intensity emphasis. Unilateral stays a rep above bilateral
   compound in intensification — balance-limited movements shouldn't chase the
   same low-rep loading. Isolation (single-joint, safest near failure) stays
   10-12, unchanged.
   Isolation effort RAMPS across the block instead of sitting at RPE 10 from
   day one: rpe is the cycle-0 base, rpeStep advances it per cycle, rpeCap
   bounds it — accumulation 8 → 10 over 4 cycles, intensification 9 → 10 over
   2. Failure is earned in the late cycles the same way main-lift RPE climbs,
   matching the double-progression load rule (see prescribe). */
const ACC_REP_TIERS = {
  accumulation:    { compound: { reps: 8, rpe: 7.5 }, unilateral: { reps: 8, rpe: 8 },   isolation: { reps: 12, rpe: 8, rpeStep: 0.5, rpeCap: 10 } },
  intensification: { compound: { reps: 6, rpe: 8 },   unilateral: { reps: 7, rpe: 8.5 }, isolation: { reps: 12, rpe: 9, rpeStep: 0.5, rpeCap: 10 } },
  deload:          { compound: { reps: 8, rpe: 6 },   unilateral: { reps: 8, rpe: 6.5 }, isolation: { reps: 10, rpe: 7 } },
  realization:     { compound: { reps: 8, rpe: 6 },   unilateral: { reps: 8, rpe: 6.5 }, isolation: { reps: 10, rpe: 7 } },
};

/* ---- block configurations ---- */
const BLOCKS = {
  accumulation: {
    label: "Accumulation", emphasis: "volume",
    mainReps: { squat: 5, bench: 5, deadlift: 4 }, mainSets: 4,
    rpeBase: 7.0, rpeStep: 0.4, rpeCap: 8.5,
    backoffDrop: 0.06, backoffRpeCap: 8,
    volLevel: "ramp",
    minCycles: 3, maxCycles: 6,
  },
  intensification: {
    label: "Intensification", emphasis: "intensity",
    mainReps: { squat: 3, bench: 3, deadlift: 2 }, mainSets: 4,
    rpeBase: 8.5, rpeStep: 0.3, rpeCap: 9.5,
    backoffDrop: 0.08, backoffRpeCap: 8.5,
    volLevel: "mev",
    minCycles: 2, maxCycles: 4,
  },
  deload: {
    label: "Deload", emphasis: "recovery",
    mainReps: { squat: 4, bench: 4, deadlift: 3 }, mainSets: 2,
    rpeBase: 6, rpeStep: 0, rpeCap: 6,
    backoffDrop: 0.1, backoffRpeCap: 6,
    volLevel: "half",
    minCycles: 1, maxCycles: 1,
  },
  realization: {
    label: "Re-test", emphasis: "test",
    mainReps: { squat: 2, bench: 2, deadlift: 1 }, mainSets: 1,
    rpeBase: 9, rpeStep: 0.5, rpeCap: 9.5,
    backoffDrop: 0, backoffRpeCap: 9,
    volLevel: "half",
    minCycles: 1, maxCycles: 1,
  },
};

/* Weekly TOTAL hard-set target for a landmark group this cycle (full-muscle:
   mains + fixedSets + ramped accessories all count — see the accounting note
   above maxDeliverable).
   CALENDAR-TIME ASSUMPTION: "weekly" here means ONE FULL ROTATION (ROT=4
   sessions), not 7 calendar days. Training ~4x/week the two coincide; at
   3x/week a rotation takes ~9 days so real per-calendar-week volume runs ~25%
   lighter than these numbers, at 5x/week ~20% heavier. ingest() tracks
   avgSessionGapDays so a future pass can scale targets by implied frequency.
   TODO: frequency-scale the ramp from avgSessionGapDays — deferred because it
   interacts with the landmark auto-tune (delivered-vs-MRV comparisons) and
   deserves its own verification pass rather than riding along here. */
function weeklyTarget(group, blockType, cycleInBlock, landmarks) {
  const lm = landmarks[group]; // group is a landmark key (volumeGroup, e.g. 'back')
  const cfg = BLOCKS[blockType];
  if (cfg.volLevel === "half") return Math.round(lm.mev * 0.5);
  if (cfg.volLevel === "mev") return lm.mev;
  const span = Math.max(1, cfg.maxCycles - 1);
  const frac = Math.min(1, cycleInBlock / span);
  return Math.round(lm.mev + (lm.mrv - lm.mev) * frac);
}

/* Sets prescribed to ONE ramped accessory slot of `group` this cycle (green
   readiness): the residual left after the fixed contribution, split across the
   group's slots, floored at 1 (a movement-maintenance set — an exercise is
   never dropped to zero mid-block just because mains already cover the
   target) and capped at ACC_SET_CAP. prescribe() and the ceiling math below
   both go through this, so what's checked is exactly what's prescribed. */
function rampedSlotSets(group, blockType, cycleInBlock, landmarks) {
  const wk = weeklyTarget(group, blockType, cycleInBlock, landmarks);
  const freq = PATTERN_FREQ[group] || 1;
  const residual = wk - fixedWeeklySets(group, blockType);
  return Math.max(1, Math.min(ACC_SET_CAP, Math.round(residual / freq)));
}

/* Total weekly sets the schedule actually delivers for `group` this cycle
   (green readiness): fixed contribution + every ramped slot. THIS — not the
   raw weeklyTarget — is what ceiling checks and the landmark auto-tune compare
   against MEV/MAV/MRV, so decisions are made about volume that was really
   prescribed. */
function deliveredWeekly(group, blockType, cycleInBlock, landmarks) {
  return fixedWeeklySets(group, blockType)
    + rampedSlotSets(group, blockType, cycleInBlock, landmarks) * (PATTERN_FREQ[group] || 0);
}

/* The volume ceiling a block can actually reach for `group`: its MRV, unless
   the schedule saturates first. */
function effectiveCeiling(group, blockType, landmarks) {
  return Math.min(landmarks[group].mrv, maxDeliverable(group, blockType));
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
   Applied ONLY at the two delivered-vs-ceiling DECISION sites (ingest()'s
   ceilingHit transition trigger and adjustLandmarks' reachedCeiling auto-tune
   gate); the helpers above and every UI/display consumer stay in per-rotation
   units (see the item-4 note on those sites). */
function weeklyFreqScale(avgSessionGapDays) {
  if (avgSessionGapDays == null) return 1;
  return Math.max(0.6, Math.min(1.8, (ROT * avgSessionGapDays) / 7));
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
/* landmark group → main lift that carries its growth signal (quads/hamstrings/
   chest are driven by their main lift's e1RM; other pools read accessory slopes) */
const PATTERN_MAIN = { quads: "squat", hamstrings: "deadlift", chest: "bench" };
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
  const freqScale = weeklyFreqScale(program.avgSessionGapDays);
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
       Compared against delivered reality, a capped group correctly reads "at
       ceiling" when its ramp saturates — so a stall there isn't misread as
       stalling with headroom. */
    const capA = maxDeliverable(p, "accumulation"); // per-rotation; the MRV-raise gate below stays in these units
    const reachedCeiling =
      deliveredWeekly(p, "accumulation", Math.max(0, cyc - 1), program.landmarks) / freqScale
        >= Math.min(lm.mrv, capA / freqScale);
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
      const deliveredThis = deliveredWeekly(p, "accumulation", Math.max(0, cyc - 1), program.landmarks);
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

    let dMev = 0, dMrv = 0, signal = null;
    if (grew && fatigueComfortable) {
      /* Raises are gated to what the schedule can deliver: drifting MRV above
         maxDeliverable would grow a stored number no prescription can ever
         reach (the pre-fix failure mode). MEV raises are likewise kept ≥2
         below the (possibly capacity-frozen) MRV so they can't drag it up
         through the range clamp below. */
      const canRaiseMrv = lm.mrv + 1 <= capA;
      const mrvAfter = lm.mrv + (canRaiseMrv ? 1 : 0);
      const canRaiseMev = lm.mev + 1 <= Math.min(mrvAfter, capA) - 2;
      dMev = canRaiseMev ? 1 : 0;
      dMrv = canRaiseMrv ? 1 : 0;
      if (dMev || dMrv) signal = canRaiseMrv ? "growth strong, fatigue in check" : "growth strong — schedule at capacity, MEV only";
    }
    else if (stalledEarly && fatigueSpikedEarly) { dMrv = -1; signal = "stalled early with fatigue spike"; }
    if (!dMev && !dMrv) return;

    const before = { mev: lm.mev, mav: lm.mav, mrv: lm.mrv };
    lm.mev = Math.max(2, lm.mev + dMev);           // floor MEV at 2
    lm.mrv = Math.max(lm.mev + 2, lm.mrv + dMrv);  // keep MRV ≥2 above MEV (range can't collapse)
    lm.mav = Math.min(lm.mrv - 1, Math.max(lm.mev + 1, lm.mav));
    // report the deltas actually realized after the safety clamps
    const rMev = lm.mev - before.mev, rMrv = lm.mrv - before.mrv;
    if (!rMev && !rMrv) return;
    adjustments[p] = { before, after: { mev: lm.mev, mav: lm.mav, mrv: lm.mrv }, dMev: rMev, dMrv: rMrv, signal, at: Date.now() };
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
function readinessScore(r) {
  return Math.max(0, Math.min(1, r.trainingReadiness / 100));
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
function buildRamp(topLoad, ramp, unit, barWeight) {
  // top-set weight itself too light for a ramp to make sense (e.g. deload-week loads near an empty bar)
  if (topLoad <= barWeight) return null;
  const step = unit === "kg" ? 2.5 : 5;
  return ramp.map(({ pct, reps }) => ({ weight: Math.max(0, Math.round((topLoad * pct) / step) * step), reps }));
}
function buildFeeler(topLoad, reps, bodyweight, unit) {
  if (bodyweight) return { type: "feeler", sets: [], note: "single light set — reduced range/tempo" };
  if (topLoad <= 0) return null;
  const step = unit === "kg" ? 2.5 : 5;
  const weight = Math.max(0, Math.round((topLoad * 0.5) / step) * step);
  /* At very light working loads the 50% feeler rounds up into the working
     weight itself — a "warmup" at >= the work weight is no warmup at all, so
     skip it (this was the stress suite's entire long-standing
     feeler>=topLoad violation class). */
  if (weight >= topLoad) return null;
  return { type: "feeler", sets: [{ weight, reps }] };
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
/* Volume-day main-lift override (see ROTATION[3].volumeDay): the second weekly
   squat/bench exposure runs higher-rep and RPE-capped instead of duplicating
   the week's first heavy top set — rep bump on the block's base reps, effort
   capped even when the block's RPE ramp has climbed past it. */
const VOLUME_DAY_REP_BUMP = 3;
const VOLUME_DAY_RPE_CAP = 8;
/* Double-progression rep floor for isolation accessories: load holds while
   reps climb from here to the tier's rep target; hitting the target earns one
   load step and resets reps (see the isolation branch in prescribe). */
const DP_MIN_REPS = 8;

function prescribe(program, readiness) {
  const day = ROTATION[program.cycleIndex % ROT];
  const cfg = BLOCKS[program.block.type];
  const cyc = program.block.cycle;
  const unit = program.unit;

  const band = readiness ? readinessBand(readinessScore(readiness)) : "green";
  const rpeAdj = READINESS_RPE_ADJ[band];
  const setMult = READINESS_SET_MULT[band];
  const rpeTop = clampRpe(Math.min(cfg.rpeCap, cfg.rpeBase + cfg.rpeStep * cyc) + rpeAdj);

  const gapDays = program.lastSessionAt ? (Date.now() - program.lastSessionAt) / 86400000 : 0;
  const layoffFactor = gapDays > LAYOFF_THRESHOLD_DAYS
    ? 1 - Math.min(LAYOFF_MAX_DECAY, (gapDays - LAYOFF_THRESHOLD_DAYS) * LAYOFF_DECAY_PER_DAY)
    : 1;

  const inTraining = program.block.type === "accumulation" || program.block.type === "intensification";
  const barWeight = program.barWeight || 45;
  const items = day.items.map((key, idx) => {
    const L = LIB[key];
    const lift = program.lifts[key];
    const isMain = L.role === "main";
    const accTarget = ACC_REP_TIERS[program.block.type][L.repTier];
    /* isolation effort ramps across the block (rpeStep/rpeCap); other tiers
       are flat — see ACC_REP_TIERS */
    const accRpeBase = accTarget && accTarget.rpeStep
      ? Math.min(accTarget.rpeCap, accTarget.rpe + accTarget.rpeStep * cyc)
      : accTarget?.rpe;
    const volMain = isMain && day.volumeDay;
    let reps = isMain ? (cfg.mainReps[key] || 4) + (volMain ? VOLUME_DAY_REP_BUMP : 0) : accTarget.reps;
    const rpe = isMain
      ? (volMain ? clampRpe(Math.min(rpeTop, VOLUME_DAY_RPE_CAP)) : rpeTop)
      : clampRpe(accRpeBase + rpeAdj);

    let sets;
    if (isMain) sets = Math.max(1, Math.round(cfg.mainSets * setMult));
    else if (L.fixedSets) sets = Math.max(1, Math.round(L.fixedSets * VOL_SCALE[cfg.volLevel] * setMult));
    else {
      /* ramped pool accessory: prescribe the residual share (full-muscle
         accounting — see rampedSlotSets); readiness trims but never exceeds
         the slot's nominal share */
      const vg = L.volumeGroup; // shared landmark pool key (e.g. 'back')
      sets = Math.max(1, Math.round(rampedSlotSets(vg, program.block.type, cyc, program.landmarks) * setMult));
    }
    /* Top single + backoff sets are the same prescribed `sets` total, split
       explicitly rather than left as an ambiguous "sets × reps · back-off
       weight" label (see ExerciseCard). Only meaningful for mains, which are
       the only lifts with a distinct backoff weight at all. */
    const topSetCount = isMain ? 1 : sets;
    const backoffSetCount = isMain ? Math.max(0, sets - 1) : 0;

    const effE1rm = lift.e1rm * layoffFactor;
    const step = unit === "kg" ? 2.5 : 5;
    let topLoad, assistanceNeeded = false, repOnly = false;
    if (L.bodyweight) {
      const bw = program.bodyweight || 0;
      const rawSys = effE1rm * rpePct(reps, rpe);
      const addedRaw = rawSys - bw;
      if (addedRaw >= 0) topLoad = Math.round(addedRaw / step) * step;
      else if (rawSys >= bw * 0.85) { topLoad = 0; repOnly = true; }
      else { topLoad = 0; assistanceNeeded = true; }
    } else if (L.repTier === "isolation" && lift.last?.w > 0) {
      /* Double progression for isolation accessories: at these low absolute
         loads one 5 lb / 2.5 kg plate step is a 15-25% jump, so re-deriving
         load from a noisy e1RM through a %1RM multiplier whipsaws the
         prescription. Instead: hold the last performed load and climb reps
         toward the tier's target; hitting the target earns exactly one load
         step and resets reps to DP_MIN_REPS. `lift.last` only records
         accumulation/intensification sessions (see ingest), so deload
         haircuts never become the next progression anchor. Deload/realization
         prescribe the last working load minus ~15% at the tier's lighter
         rep/RPE targets. First-ever session (no `last` yet) falls back to the
         e1RM path below. */
      if (inTraining) {
        const anchor = Math.round((lift.last.w * layoffFactor) / step) * step;
        if (lift.last.reps >= accTarget.reps) { topLoad = anchor + step; reps = DP_MIN_REPS; }
        else { topLoad = anchor; reps = clampReps(Math.max(DP_MIN_REPS, lift.last.reps + 1)); }
      } else {
        topLoad = Math.max(step, Math.round((lift.last.w * 0.85 * layoffFactor) / step) * step);
      }
    } else {
      topLoad = loadFor(effE1rm, reps, rpe, unit);
    }
    const boRaw = isMain ? effE1rm * rpePct(reps, rpe) * (1 - cfg.backoffDrop) : topLoad;
    const backoffLoad = isMain ? (unit === "kg" ? Math.round(boRaw / 2.5) * 2.5 : Math.round(boRaw / 5) * 5) : topLoad;

    let warmup = null;
    if (L.barbell) {
      const topPct1RM = rpePct(reps, rpe);
      const baseTier = topPct1RM >= 0.85 ? "full" : topPct1RM >= 0.70 ? "short" : "minimal";
      /* An earlier exercise this session already primed this one's target
         muscle iff it shares the same volumeGroup (the single canonical
         classifier). E.g. Lat Pulldown (back) primes Barbell Row (back), but
         Incline Curl (biceps) does not — even though both used to share the
         loose horiz_pull movement pattern. */
      const earlierPrimed = day.items.slice(0, idx).some((k) => LIB[k].volumeGroup === L.volumeGroup);
      const type = earlierPrimed ? (baseTier === "full" ? "short" : "minimal") : baseTier;
      const ramp = type === "full" ? FULL_RAMP : type === "short" ? SHORT_RAMP : MINIMAL_RAMP;
      const rampSets = buildRamp(topLoad, ramp, unit, barWeight);
      if (rampSets) warmup = { type, sets: rampSets };
    } else if (!isMain && (L.repTier === "compound" || L.repTier === "unilateral")) {
      /* unilateral accessories earn a feeler too now that they run 6-8 reps —
         at that loading a working set is no longer light enough to be its own
         warmup, and single-leg stability benefits from a rehearsal set */
      warmup = buildFeeler(topLoad, reps, !!L.bodyweight, unit);
    }
    // isolation non-barbell accessories: no warmup (working sets are light enough)

    return { key, label: L.label, barbell: L.barbell, isMain, volumeGroup: L.volumeGroup,
      bodyweight: !!L.bodyweight, unilateral: L.repTier === "unilateral", assistanceNeeded, repOnly,
      reps, rpe, sets, topLoad, backoffLoad, backoffRpeCap: cfg.backoffRpeCap,
      topSetCount, backoffSetCount, warmup };
  });

  return { dayName: day.name, block: cfg.label, cycle: cyc, rpeTop, band, rpeAdj, setMult, items,
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
    if (next.block.type === "accumulation" || next.block.type === "intensification")
      lift.last = { w: g.topWeight, reps: g.topReps, rpe: g.topRpe };
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
    const alpha = LIB[g.key].role === "main" ? 0.34 : 0.20;
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
     don't earn extra "recovered" credit. */
  const recoveryFactor = Math.min(1, daysSinceLast / 3);
  next.fatigue.rpeCreep *= (1 - recoveryFactor);
  next.fatigue.readSupp *= (1 - recoveryFactor);
  next.lastSessionAt = now;
  /* Rolling inter-session gap (days), capped so a one-off layoff doesn't wreck
     the average. Not yet consumed by the volume math — tracked so weeklyTarget
     can eventually frequency-scale its rotation≈week assumption (see TODO
     there). */
  if (daysSinceLast > 0)
    next.avgSessionGapDays = ewma(next.avgSessionGapDays, Math.min(daysSinceLast, 14), 0.3);

  /* RPE-creep reads only TOUCHED main logs: an unedited log echoes the target
     back (miss = 0 by construction), so counting it would fake recovery. When
     no touched mains exist this session, creep is simply left where it was —
     no evidence either way.
     rpeMiss/backoffDrift are hoisted (not just used inline) so this session's
     RAW outcome numbers — not the multi-session EWMA'd fatigue fields they
     also feed — can be returned below for readiness_analysis.mjs to compare
     against the readiness band/adjustment that was actually applied. null
     means "no evidence this session", not "zero overshoot". */
  const mainLogs = logs.filter((g) => LIB[g.key]?.role === "main");
  const rpeLogs = mainLogs.filter((g) => g.touched !== false);
  let rpeMiss = null, backoffDrift = null;
  if (rpeLogs.length) {
    rpeMiss = rpeLogs.reduce((s, g) => s + Math.max(0, g.topRpe - g.targetRpe), 0) / rpeLogs.length;
    /* Backoff-set RPE drifting above its prescribed cap while the top set sits
       on target is fatigue accumulating UNDER the top set — cheap signal the
       UI already collects, previously discarded. Folded into the same creep
       channel at half weight (backoff sets are submaximal; their drift is a
       softer signal than a top-set overshoot). */
    const boLogs = rpeLogs.filter((g) => g.backoffSetCount > 0 && g.backoffRpe != null && g.backoffRpeCap != null);
    backoffDrift = boLogs.length
      ? boLogs.reduce((s, g) => s + Math.max(0, g.backoffRpe - g.backoffRpeCap), 0) / boLogs.length : 0;
    next.fatigue.backoffDrift = ewma(next.fatigue.backoffDrift ?? 0, backoffDrift, 0.4);
    next.fatigue.rpeCreep = ewma(next.fatigue.rpeCreep, rpeMiss + 0.5 * backoffDrift, 0.4);
  }
  /* Multi-session readiness-deficit accumulator (fatigue.readSupp): a
     SEPARATE EWMA smoothing rate (READSUPP_EWMA_ALPHA) from
     READINESS_FATIGUE_WEIGHT below, on purpose — see the decoupling note
     above readinessScore(). This is the ONLY place readiness feeds the
     multi-session fatigue index; prescribe()'s same-day softening
     (READINESS_RPE_ADJ/READINESS_SET_MULT) never reads this field. */
  next.fatigue.readSupp = ewma(next.fatigue.readSupp, 1 - rScore, READSUPP_EWMA_ALPHA);
  const missFreq = logs.length ? logs.filter((g) => g.missedSets > 0).length / logs.length : 0;
  next.fatigue.missFreq = ewma(next.fatigue.missFreq, missFreq, 0.4);

  const fatigueIndex = Math.max(0, Math.min(1,
    0.5 * Math.min(1, next.fatigue.rpeCreep / 1.5) + READINESS_FATIGUE_WEIGHT * next.fatigue.readSupp + 0.2 * next.fatigue.missFreq));
  next.fatigue.index = fatigueIndex;

  /* Block-level strength trend: main-lift slopes, PRECISION-WEIGHTED by the
     number of same-block readings each fit used. Deadlift logs one exposure
     per rotation vs two each for squat/bench, so early in a block its window
     is below slope()'s 3-point minimum and its placeholder-zero slope used to
     count 1/3 of the average — diluting a genuine squat/bench trend toward
     the stall threshold. Weighting by evidence lets the lifts with real data
     carry the signal; a lift with <3 points contributes nothing rather than a
     fake zero. */
  const slopeInfos = ["squat", "bench", "deadlift"].map((k) => liftSlopeInfo(next.lifts[k]));
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
       so the two stay in agreement. Helpers keep per-rotation units (item 4). */
    const freqScale = weeklyFreqScale(next.avgSessionGapDays);
    const ceilingHit = (p) => {
      const ceilTrue = Math.min(next.landmarks[p].mrv, maxDeliverable(p, t) / freqScale);
      if (deliveredWeekly(p, t, justDone, next.landmarks) / freqScale < ceilTrue) return false;
      if (ceilTrue >= next.landmarks[p].mrv) return true;
      return justDone >= 1 && deliveredWeekly(p, t, justDone - 1, next.landmarks) / freqScale >= ceilTrue;
    };
    const atVolCeiling = ["quads", "chest", "hamstrings"].some(ceilingHit);
    const highFatigue = fatigueIndex >= 0.7;
    const grayFatigue = fatigueIndex >= 0.55 && fatigueIndex < 0.7;
    const stalled = e1rmSlope <= 0.001;

    if (t === "accumulation") {
      const enoughTime = cyc >= cfg.minCycles, maxedTime = cyc >= cfg.maxCycles;
      if (maxedTime || (enoughTime && (atVolCeiling || highFatigue || (stalled && cyc >= cfg.minCycles + 1)))) {
        transition = { to: "deload",
          reason: maxedTime ? "max accumulation length reached" : atVolCeiling ? "weekly volume reached its ceiling"
            : highFatigue ? "fatigue index high" : "e1RM progress stalled",
          borderline: grayFatigue && !atVolCeiling && !maxedTime };
      }
    } else if (t === "intensification") {
      const enoughTime = cyc >= cfg.minCycles, maxedTime = cyc >= cfg.maxCycles;
      if (maxedTime || (enoughTime && (highFatigue || stalled))) {
        transition = { to: "deload",
          reason: maxedTime ? "max intensification length reached" : highFatigue ? "fatigue index high"
            : "strength progress stalled at high intensity",
          borderline: grayFatigue, nextAfter: "realization" };
      }
    } else if (t === "deload") {
      /* Fatigue gate before routing out of deload (esp. into a near-max
         realization/intensification): if fatigue hasn't cleared below
         FATIGUE_STILL_ELEVATED, extend deload by exactly one more cycle rather
         than proceeding on schedule. Capped at a single extension so we can't
         loop indefinitely — if it's still elevated after the extension we
         proceed anyway but flag it (forcedDespiteFatigue) so it's visible. */
      const stillElevated = fatigueIndex >= FATIGUE_STILL_ELEVATED;
      if (stillElevated && !next.block.deloadExtended) {
        next.block.deloadExtended = true; // extend one cycle; no transition this cycle
      } else {
        transition = { to: next.block.nextAfter || "intensification",
          reason: stillElevated ? "deload complete — fatigue still elevated, proceeding anyway"
            : (next.block.deloadExtended ? "deload extended — fatigue cleared" : "deload complete — fatigue dissipated"),
          forcedDespiteFatigue: stillElevated };
      }
    } else if (t === "realization") {
      transition = { to: "accumulation", reason: "maxes re-tested — new accumulation block" };
    }
  }

  /* rpeMiss/backoffDrift/missFreq are THIS SESSION's raw outcome numbers
     (before EWMA smoothing) — returned so callers can record what actually
     happened alongside the readiness band/adjustment that was applied, for
     later retrospective comparison (see readiness_analysis.mjs). Distinct
     from fatigueIndex/e1rmSlope, which are the smoothed multi-session state. */
  return { next, transition, fatigueIndex, rScore, e1rmSlope, prs, rpeMiss, backoffDrift, missFreq };
}

/* ---- post-session rest advisory ----
   Advisory only — the engine never blocks or restricts logging a session
   before the recommended date; this just informs the athlete. Reuses the
   same fatigue thresholds (FATIGUE_AMBER, FATIGUE_SPIKE) the block-transition
   and landmark-adjustment logic already key off of, so "amber"/"high" mean
   the same thing everywhere in the app. */
function restDaysForFatigue(fatigueIndex) {
  if (fatigueIndex >= FATIGUE_SPIKE) return 3;
  if (fatigueIndex >= FATIGUE_AMBER) return 2;
  return 1;
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
    next.fatigue = { index: 0, rpeCreep: 0, readSupp: next.fatigue.readSupp, missFreq: 0, slope: 0, backoffDrift: 0 };
  next.blockHistory = [...(next.blockHistory || []), { type: transition.to, at: Date.now(), reason: transition.reason,
    ...(transition.forcedDespiteFatigue ? { forcedDespiteFatigue: true } : {}) }];
  return next;
}

/* Accessory e1RM seeding ratios (fraction of a reference lift's e1RM) — used
   by freshProgram for a new program AND by migrateProgram to backfill a lift
   for any exercise added to the rotation after a program was saved (without
   this, prescribe() would crash on the missing lift). Rough on purpose: the
   EWMA re-anchors from the first real session. */
const ACC_E1RM_REF = { rdl: "deadlift", frontsquat: "squat", ohp: "bench",
  row: "bench", cablerow: "bench", pulldown: "bench", curl: "bench", bsplit: "squat",
  triext: "bench", lateralraise: "bench", calfraise: "squat", inclinebench: "bench",
  legcurl: "deadlift", legext: "squat", reversepecdeck: "bench", wristcurl: "bench",
  cablecrunch: "bench", shrug: "deadlift",
  cablefly: "bench", dbshoulderpress: "bench" };
/* bsplit: 0.2 is a PER-DUMBBELL fraction of squat e1RM, matching the logging
   convention on LIB.bsplit (one dumbbell, matched pair). Derived from the
   natural estimate of TOTAL added load for a loaded single-leg squat pattern
   (~0.4x squat e1RM combined across both hands — most of the resistance
   already comes from bodyweight loaded through one leg) halved for one hand.
   For a 315 lb squat e1RM (~388 lb) this seeds ~55 lb per dumbbell at cycle 0
   — a plausible opening load, not a guess: any future unilateral dumbbell
   exercise should size its own MULT the same way (estimate total two-hand
   load, then halve for the per-dumbbell logging convention). */
const ACC_E1RM_MULT = { rdl: 0.85, frontsquat: 0.8, ohp: 0.62, row: 0.75,
  cablerow: 0.75, pulldown: 0.7, curl: 0.35, bsplit: 0.2,
  triext: 0.45, lateralraise: 0.12, calfraise: 1.2, inclinebench: 0.55,
  legcurl: 0.4, legext: 0.65, reversepecdeck: 0.15, wristcurl: 0.15,
  cablecrunch: 0.4, shrug: 0.35,
  cablefly: 0.3, dbshoulderpress: 0.6 };

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
    lifts[k] = { e1rm, e1rmRaw: e1rm, hist: [{ e: Math.round(e1rm), raw: Math.round(e1rm) }], volumeGroup: LIB[k].volumeGroup };
  });
  return {
    unit, goal, experience: experience || "intermediate", landmarks, lifts, bodyweight,
    cycleIndex: 0, sessionCount: 0, lastSessionAt: null, avgSessionGapDays: null,
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
  /* 3. backfill a lift record for any rotation member added to the program
     AFTER this save was created (e.g. bsplit re-entering the rotation) —
     seeded off a reference lift the program already tracks, exactly like
     freshProgram. Without this, prescribe() dereferences a missing lift and
     crashes on the first day containing the new exercise. */
  const lifts = { ...(program.lifts || {}) };
  let liftsChanged = false;
  ROTATION.forEach((d) => d.items.forEach((k) => {
    if (lifts[k]) return;
    const base = lifts[ACC_E1RM_REF[k]]?.e1rm || 100;
    const e1rm = base * (ACC_E1RM_MULT[k] || 0.6);
    lifts[k] = { e1rm, e1rmRaw: e1rm, hist: [{ e: Math.round(e1rm), raw: Math.round(e1rm) }], volumeGroup: LIB[k].volumeGroup };
    liftsChanged = true;
  }));
  // 4. backfill stall-notice tracking for a program saved before this feature existed.
  const stallStreaks = program.stallStreaks || {};
  const stallNotices = program.stallNotices || {};
  const stallFieldsChanged = !program.stallStreaks || !program.stallNotices;
  return (changed || liftsChanged || stallFieldsChanged)
    ? { ...program, landmarks: lm, landmarkAdjustments: adj, lifts, stallStreaks, stallNotices }
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
  RPE_TABLE, clampReps, clampRpe, rpePct, e1rmFrom, e1rmFromBW, loadFor, ewma, slope, liftNormSlope, liftSlopeInfo,
  PATTERNS, EXPERIENCE_TIERS, landmarksForExperience,
  LIB, ROTATION, ROT, PATTERN_FREQ, ACC_SET_CAP, maxDeliverable, VOL_SCALE, ACC_REP_TIERS, BLOCKS,
  weeklyTarget, fixedWeeklySets, rampedSlotSets, deliveredWeekly, effectiveCeiling, weeklyFreqScale,
  FATIGUE_SPIKE, FATIGUE_AMBER, FATIGUE_STILL_ELEVATED, GROWTH_POS, E1RM_MIN_RPE, STALL_STREAK_THRESHOLD,
  LAYOFF_THRESHOLD_DAYS, LAYOFF_DECAY_PER_DAY, LAYOFF_MAX_DECAY,
  VOLUME_DAY_REP_BUMP, VOLUME_DAY_RPE_CAP, DP_MIN_REPS,
  PATTERN_MAIN, PATTERN_RAMPED_ACC, patternGrowth, adjustLandmarks,
  readinessScore, readinessBand, READINESS_RPE_ADJ, READINESS_SET_MULT, READINESS_FATIGUE_WEIGHT, READSUPP_EWMA_ALPHA,
  FULL_RAMP, SHORT_RAMP, MINIMAL_RAMP, buildRamp, buildFeeler,
  prescribe, ingest, restDaysForFatigue, applyTransition, freshProgram,
  LANDMARK_RENAME, migrateProgram,
  PLATES, platesForSide, plateText,
};
