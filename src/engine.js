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
   growth signal used for landmark auto-tuning. */
function liftNormSlope(lift) {
  const h = (lift?.hist || []).map((p) => p.e);
  const base = lift?.e1rm || 1;
  return slope(h.slice(-8)) / base;
}

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
  /* Rear/side delts and calves were previously fixedSets accessories (flat set
     count, no landmark tracking); the volume audit found both sitting below
     MEV. Promoted to real landmark-tracked pools. rear_delts = Reverse Pec Deck
     + Cable Lateral Raise; calves = Standing Calf Raise (trained on two days). */
  rear_delts:  { label: "Rear / Side Delts",   mev: 8,  mav: 19, mrv: 26 },
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
   Deadlift as the growth driver for the hamstrings landmark (PATTERN_MAIN). */
const LIB = {
  squat:        { label: "Back Squat",                    role: "main", barbell: true, volumeGroup: "quads" },
  bench:        { label: "Bench Press",                   role: "main", barbell: true, volumeGroup: "chest" },
  deadlift:     { label: "Deadlift",                      role: "main", barbell: true, volumeGroup: "hamstrings" },
  rdl:          { label: "Romanian Deadlift",              role: "acc",  barbell: true,  repTier: "compound", volumeGroup: "hamstrings" },
  frontsquat:   { label: "Front Squat",                   role: "acc",  barbell: true,  repTier: "compound", volumeGroup: "quads" },
  ohp:          { label: "Overhead Press",                role: "acc",  barbell: true,  repTier: "compound", volumeGroup: "front_delts" },
  row:          { label: "Barbell Row",                   role: "acc",  barbell: true,  repTier: "compound", volumeGroup: "back" },
  cablerow:     { label: "Seated Cable Row",               role: "acc",  barbell: false, repTier: "compound", volumeGroup: "back" },
  pulldown:     { label: "Lat Pulldown",                  role: "acc",  barbell: false, repTier: "compound", volumeGroup: "back" },
  pullup:       { label: "Pull-Up / Chin-Up",             role: "acc",  barbell: false, bodyweight: true, repTier: "compound", volumeGroup: "back" },
  curl:         { label: "Incline Dumbbell Curl",         role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", volumeGroup: "biceps" },
  triext:       { label: "Cable Overhead Triceps Extension", role: "acc", barbell: false, fixedSets: 3, repTier: "isolation", volumeGroup: "triceps" },
  lateralraise: { label: "Cable Lateral Raise",           role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "rear_delts" },
  calfraise:    { label: "Standing Calf Raise",           role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "calves" },
  inclinebench: { label: "Incline Dumbbell Press (~30°)", role: "acc",  barbell: false, repTier: "compound", volumeGroup: "chest" },
  legcurl:      { label: "Seated Leg Curl",               role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", volumeGroup: "hamstrings" },
  legext:       { label: "Leg Extension",                 role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", volumeGroup: "quads" },
  reversepecdeck: { label: "Reverse Pec Deck",             role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "rear_delts" },
  wristcurl:    { label: "Dumbbell Wrist Curl",           role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", volumeGroup: "forearms" },
  cablecrunch:  { label: "Cable Crunch",                  role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", volumeGroup: "abs" },
  shrug:        { label: "Dumbbell Shrug",                role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", volumeGroup: "traps" },
  cablefly:     { label: "Cable Fly",                     role: "acc",  barbell: false, repTier: "isolation", volumeGroup: "chest" },
  dbshoulderpress: { label: "Dumbbell Shoulder Press",    role: "acc",  barbell: false, repTier: "compound", volumeGroup: "front_delts" },
};

/* ---- rotation: which lifts each training day trains ---- */
const ROTATION = [
  { name: "Squat",            items: ["squat", "rdl", "legcurl", "legext", "calfraise", "wristcurl", "cablecrunch"] },
  { name: "Bench",            items: ["bench", "ohp", "cablerow", "triext", "pullup", "inclinebench", "reversepecdeck", "dbshoulderpress"] },
  { name: "Deadlift",         items: ["deadlift", "frontsquat", "pulldown", "curl", "row", "shrug", "calfraise", "reversepecdeck"] },
  { name: "Squat+Bench Vol.", items: ["squat", "bench", "curl", "lateralraise", "cablefly", "calfraise"] },
];
const ROT = ROTATION.length;
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
/* The most weekly sets a group can ACTUALLY receive: each of its landmark-ramped
   accessories is capped at ACC_SET_CAP, and the group is trained
   PATTERN_FREQ[group] times per week. A weekly target above this is a ceiling
   the ramp can aim at but the schedule can never deliver — so ceiling/transition
   and auto-tune decisions must clamp to it (see deliverableTarget), otherwise the
   engine concludes 'MRV reached' for volume it never actually prescribed. */
function maxDeliverable(group) {
  return ACC_SET_CAP * (PATTERN_FREQ[group] || 0);
}
/* ---- fixedSets accessories still shrink with block volume tier + readiness ---- */
const VOL_SCALE = { ramp: 1, mev: 0.75, half: 0.5 };

/* ---- per-tier accessory rep + RPE targets ----
   Both reps and RPE are now direct per-tier lookups (previously only reps
   were per-tier; RPE was a single value shared across all accessories in a
   phase). Compound accessories (multi-joint, heaviest relative load) stay
   lowest-rep; isolation (single-joint, safest to push near failure) goes
   highest-rep and is deliberately prescribed to RPE 10 whenever it hits the
   12-rep ceiling in accumulation/intensification — a set should only earn
   the top of its rep range by actually reaching genuine failure, not just
   by hitting a rep count. Unilateral sits in between on both axes. Deload/
   realization drop reps and RPE together, same as before. */
const ACC_REP_TIERS = {
  accumulation:    { compound: { reps: 10, rpe: 7.5 }, unilateral: { reps: 12, rpe: 8 },   isolation: { reps: 12, rpe: 10 } },
  intensification: { compound: { reps: 9,  rpe: 8 },   unilateral: { reps: 11, rpe: 8.5 }, isolation: { reps: 12, rpe: 10 } },
  deload:          { compound: { reps: 8,  rpe: 6 },   unilateral: { reps: 9,  rpe: 6.5 }, isolation: { reps: 10, rpe: 7 } },
  realization:     { compound: { reps: 8,  rpe: 6 },   unilateral: { reps: 9,  rpe: 6.5 }, isolation: { reps: 10, rpe: 7 } },
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

function weeklyTarget(group, blockType, cycleInBlock, landmarks) {
  const lm = landmarks[group]; // group is a landmark key (volumeGroup, e.g. 'back', or pattern when no override)
  const cfg = BLOCKS[blockType];
  if (cfg.volLevel === "half") return Math.round(lm.mev * 0.5);
  if (cfg.volLevel === "mev") return lm.mev;
  const span = Math.max(1, cfg.maxCycles - 1);
  const frac = Math.min(1, cycleInBlock / span);
  return Math.round(lm.mev + (lm.mrv - lm.mev) * frac);
}

/* The weekly target a group can actually be given: the raw ramp target clamped
   to what per-exercise cap × training frequency can produce. Ceiling/transition
   and auto-tune 'reached MRV' decisions use THIS, not the raw target — so the
   engine never treats undeliverable volume as if it had been trained. */
function deliverableTarget(group, blockType, cycleInBlock, landmarks) {
  return Math.min(weeklyTarget(group, blockType, cycleInBlock, landmarks), maxDeliverable(group));
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
/* landmark group → main lift that carries its growth signal */
const PATTERN_MAIN = { quads: "squat", hamstrings: "deadlift", chest: "bench" };
/* volumeGroup → its landmark-ramped accessories (role=acc, not fixedSets), for
   the pools that have no main lift to read a slope from. Keyed the same way as
   the landmark table so the auto-tune resolves each landmark key (incl. the
   merged 'back' pool) to the right accessory slopes. */
const PATTERN_RAMPED_ACC = (() => {
  const m = {};
  Object.entries(LIB).forEach(([k, L]) => {
    if (L.role !== "acc" || L.fixedSets) return;
    const g = L.volumeGroup;
    (m[g] = m[g] || []).push(k);
  });
  return m;
})();
function patternGrowth(program, pattern) {
  const mainKey = PATTERN_MAIN[pattern];
  if (mainKey) {
    const lift = program.lifts[mainKey];
    return { g: liftNormSlope(lift), n: (lift?.hist || []).length };
  }
  const accs = PATTERN_RAMPED_ACC[pattern] || [];
  if (!accs.length) return { g: 0, n: 0 };
  const gs = accs.map((k) => liftNormSlope(program.lifts[k]));
  const ns = accs.map((k) => (program.lifts[k]?.hist || []).length);
  return { g: gs.reduce((a, b) => a + b, 0) / gs.length, n: Math.max(...ns) };
}
function adjustLandmarks(program) {
  const cyc = program.block.cycle;
  const maxCycles = BLOCKS.accumulation.maxCycles;
  const fatigueIndex = program.fatigue?.index ?? 0;
  const fatigueComfortable = fatigueIndex < FATIGUE_SPIKE;
  const fatigueSpikedEarly = fatigueIndex >= FATIGUE_SPIKE && cyc < maxCycles;
  const landmarks = structuredClone(program.landmarks);
  const adjustments = {};
  Object.keys(landmarks).forEach((p) => {
    const lm = landmarks[p];
    const { g, n } = patternGrowth(program, p);
    if (n < 3) return; // not enough e1RM history to act on — leave it alone
    // did this group's ramped volume already reach MRV this block? — measured
    // against the DELIVERABLE target, so a group whose schedule can't reach MRV
    // never reads as "at ceiling" (which would suppress the stalled-early check).
    const reachedCeiling = deliverableTarget(p, "accumulation", Math.max(0, cyc - 1), program.landmarks) >= lm.mrv;
    const grew = g > GROWTH_POS;
    const stalledEarly = g <= GROWTH_POS && !reachedCeiling;

    let dMev = 0, dMrv = 0, signal = null;
    if (grew && fatigueComfortable) { dMev = 1; dMrv = 1; signal = "growth strong, fatigue in check"; }
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
  return { landmarks, adjustments };
}

/* ---- readiness score (0–1) from Garmin Training Readiness Score ---- */
function readinessScore(r) {
  return Math.max(0, Math.min(1, r.trainingReadiness / 100));
}
const readinessBand = (s) => (s >= 0.60 ? "green" : s >= 0.40 ? "amber" : "red");

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
  return { type: "feeler", sets: [{ weight, reps }] };
}

/* ════════════ PRESCRIPTION ════════════ */
function prescribe(program, readiness) {
  const day = ROTATION[program.cycleIndex % ROT];
  const cfg = BLOCKS[program.block.type];
  const cyc = program.block.cycle;
  const unit = program.unit;

  const band = readiness ? readinessBand(readinessScore(readiness)) : "green";
  const rpeAdj = band === "green" ? 0 : band === "amber" ? -0.5 : -1.5;
  const setMult = band === "green" ? 1 : band === "amber" ? 0.85 : 0.6;
  const rpeTop = clampRpe(Math.min(cfg.rpeCap, cfg.rpeBase + cfg.rpeStep * cyc) + rpeAdj);

  const barWeight = program.barWeight || 45;
  const items = day.items.map((key, idx) => {
    const L = LIB[key];
    const lift = program.lifts[key];
    const isMain = L.role === "main";
    const accTarget = ACC_REP_TIERS[program.block.type][L.repTier];
    const reps = isMain ? (cfg.mainReps[key] || 4) : accTarget.reps;
    const rpe = isMain ? rpeTop : clampRpe(accTarget.rpe + rpeAdj);

    let sets;
    if (isMain) sets = Math.max(1, Math.round(cfg.mainSets * setMult));
    else if (L.fixedSets) sets = Math.max(1, Math.round(L.fixedSets * VOL_SCALE[cfg.volLevel] * setMult));
    else {
      const vg = L.volumeGroup; // shared landmark pool key (e.g. 'back')
      const wk = weeklyTarget(vg, program.block.type, cyc, program.landmarks);
      const freq = PATTERN_FREQ[vg] || 1;
      const rawSets = Math.round((wk / freq) * setMult);
      sets = Math.max(1, Math.min(ACC_SET_CAP, rawSets));
    }
    /* Top single + backoff sets are the same prescribed `sets` total, split
       explicitly rather than left as an ambiguous "sets × reps · back-off
       weight" label (see ExerciseCard). Only meaningful for mains, which are
       the only lifts with a distinct backoff weight at all. */
    const topSetCount = isMain ? 1 : sets;
    const backoffSetCount = isMain ? Math.max(0, sets - 1) : 0;

    let topLoad, assistanceNeeded = false, repOnly = false;
    if (L.bodyweight) {
      const bw = program.bodyweight || 0;
      const rawSys = lift.e1rm * rpePct(reps, rpe);
      const step = unit === "kg" ? 2.5 : 5;
      const addedRaw = rawSys - bw;
      if (addedRaw >= 0) topLoad = Math.round(addedRaw / step) * step;
      else if (rawSys >= bw * 0.85) { topLoad = 0; repOnly = true; }
      else { topLoad = 0; assistanceNeeded = true; }
    } else {
      topLoad = loadFor(lift.e1rm, reps, rpe, unit);
    }
    const boRaw = isMain ? lift.e1rm * rpePct(reps, rpe) * (1 - cfg.backoffDrop) : topLoad;
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
    } else if (!isMain && L.repTier === "compound") {
      warmup = buildFeeler(topLoad, reps, !!L.bodyweight, unit);
    }
    // isolation/unilateral non-barbell accessories: no warmup (warmup stays null)

    return { key, label: L.label, barbell: L.barbell, isMain, volumeGroup: L.volumeGroup,
      bodyweight: !!L.bodyweight, assistanceNeeded, repOnly,
      reps, rpe, sets, topLoad, backoffLoad, backoffRpeCap: cfg.backoffRpeCap,
      topSetCount, backoffSetCount, warmup };
  });

  return { dayName: day.name, block: cfg.label, cycle: cyc, rpeTop, band, items };
}

/* ════════════ INGEST + STATE MACHINE ════════════ */
function ingest(program, logs, readiness) {
  const next = structuredClone(program);
  const prs = [];
  const prEps = next.unit === "kg" ? 1 : 2; // ignore load-rounding jitter

  logs.forEach((g) => {
    const lift = next.lifts[g.key];
    const L = LIB[g.key];
    if (!lift || !L || !g.topReps) return;
    if (!L.bodyweight && !g.topWeight) return;
    const reading = L.bodyweight
      ? e1rmFromBW(next.bodyweight, g.topWeight, g.topReps, g.topRpe)
      : e1rmFrom(g.topWeight, g.topReps, g.topRpe);
    if (!reading) return;
    lift.e1rmRaw = reading;
    const alpha = LIB[g.key].role === "main" ? 0.34 : 0.20;
    lift.e1rm = ewma(lift.e1rm, reading, alpha);
    lift.hist = [...(lift.hist || []), { e: Math.round(lift.e1rm), raw: Math.round(reading) }].slice(-60);
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

  const mainLogs = logs.filter((g) => LIB[g.key]?.role === "main");
  const rpeMiss = mainLogs.length
    ? mainLogs.reduce((s, g) => s + Math.max(0, g.topRpe - g.targetRpe), 0) / mainLogs.length : 0;
  next.fatigue.rpeCreep = ewma(next.fatigue.rpeCreep, rpeMiss, 0.4);
  next.fatigue.readSupp = ewma(next.fatigue.readSupp, 1 - rScore, 0.3);
  const missFreq = logs.length ? logs.filter((g) => g.missedSets > 0).length / logs.length : 0;
  next.fatigue.missFreq = ewma(next.fatigue.missFreq, missFreq, 0.4);

  const fatigueIndex = Math.max(0, Math.min(1,
    0.5 * Math.min(1, next.fatigue.rpeCreep / 1.5) + 0.3 * next.fatigue.readSupp + 0.2 * next.fatigue.missFreq));
  next.fatigue.index = fatigueIndex;

  const slopes = ["squat", "bench", "deadlift"].map((k) => liftNormSlope(next.lifts[k]));
  const e1rmSlope = slopes.reduce((a, b) => a + b, 0) / slopes.length;
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
    const atVolCeiling = ["quads", "chest", "hamstrings"].some((p) =>
      deliverableTarget(p, t, Math.max(0, cyc - 1), next.landmarks) >= next.landmarks[p].mrv);
    const highFatigue = fatigueIndex >= 0.7;
    const grayFatigue = fatigueIndex >= 0.55 && fatigueIndex < 0.7;
    const stalled = e1rmSlope <= 0.001;

    if (t === "accumulation") {
      const enoughTime = cyc >= cfg.minCycles, maxedTime = cyc >= cfg.maxCycles;
      if (maxedTime || (enoughTime && (atVolCeiling || highFatigue || (stalled && cyc >= cfg.minCycles + 1)))) {
        transition = { to: "deload",
          reason: maxedTime ? "max accumulation length reached" : atVolCeiling ? "weekly volume reached your MRV"
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

  return { next, transition, fatigueIndex, rScore, e1rmSlope, prs };
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
    const { landmarks, adjustments } = adjustLandmarks(program);
    if (Object.keys(adjustments).length) {
      next.landmarks = landmarks;
      next.landmarkAdjustments = { ...(program.landmarkAdjustments || {}), ...adjustments };
      next.landmarkLog = [...(program.landmarkLog || []), { at: Date.now(), cycle: program.block.cycle, changes: adjustments }].slice(-24);
    }
  }
  next.block = {
    type: transition.to, cycle: 0, sessionsInBlock: 0,
    nextAfter: transition.nextAfter || (transition.to === "deload" ? next.block.nextAfter : null),
  };
  if (transition.to === "accumulation")
    next.fatigue = { index: 0, rpeCreep: 0, readSupp: next.fatigue.readSupp, missFreq: 0, slope: 0 };
  next.blockHistory = [...(next.blockHistory || []), { type: transition.to, at: Date.now(), reason: transition.reason,
    ...(transition.forcedDespiteFatigue ? { forcedDespiteFatigue: true } : {}) }];
  return next;
}

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
      const ref = { rdl: "deadlift", frontsquat: "squat", ohp: "bench",
        row: "bench", cablerow: "bench", pulldown: "bench", curl: "bench",
        triext: "bench", lateralraise: "bench", calfraise: "squat", inclinebench: "bench",
        legcurl: "deadlift", legext: "squat", reversepecdeck: "bench", wristcurl: "bench",
        cablecrunch: "bench", shrug: "deadlift",
        cablefly: "bench", dbshoulderpress: "bench" }[k];
      const base = seeds[ref] ? e1rmFrom(seeds[ref].weight, seeds[ref].reps, seeds[ref].rpe) : 100;
      const mult = { rdl: 0.85, frontsquat: 0.8, ohp: 0.62, row: 0.75,
        cablerow: 0.75, pulldown: 0.7, curl: 0.35,
        triext: 0.45, lateralraise: 0.12, calfraise: 1.2, inclinebench: 0.55,
        legcurl: 0.4, legext: 0.65, reversepecdeck: 0.15, wristcurl: 0.15,
        cablecrunch: 0.4, shrug: 0.35,
        cablefly: 0.3, dbshoulderpress: 0.6 }[k] || 0.6;
      e1rm = base * mult;
    }
    lifts[k] = { e1rm, e1rmRaw: e1rm, hist: [{ e: Math.round(e1rm), raw: Math.round(e1rm) }], volumeGroup: LIB[k].volumeGroup };
  });
  return {
    unit, goal, experience: experience || "intermediate", landmarks, lifts, bodyweight,
    cycleIndex: 0, sessionCount: 0, lastSessionAt: null,
    fatigue: { index: 0, rpeCreep: 0, readSupp: 0, missFreq: 0, slope: 0 },
    block: { type: "accumulation", cycle: 0, sessionsInBlock: 0, nextAfter: null },
    blockHistory: [{ type: "accumulation", at: Date.now(), reason: "program start" }],
    landmarkAdjustments: {}, landmarkLog: [],
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
  // 2. add any missing group, drop any stale group.
  for (const key of Object.keys(canonical)) if (!lm[key]) { lm[key] = canonical[key]; changed = true; }
  for (const key of Object.keys(lm)) if (!canonical[key]) { delete lm[key]; changed = true; }
  return changed ? { ...program, landmarks: lm, landmarkAdjustments: adj } : program;
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
  RPE_TABLE, clampReps, clampRpe, rpePct, e1rmFrom, e1rmFromBW, loadFor, ewma, slope, liftNormSlope,
  PATTERNS, EXPERIENCE_TIERS, landmarksForExperience,
  LIB, ROTATION, ROT, PATTERN_FREQ, ACC_SET_CAP, maxDeliverable, VOL_SCALE, ACC_REP_TIERS, BLOCKS,
  weeklyTarget, deliverableTarget,
  FATIGUE_SPIKE, FATIGUE_AMBER, FATIGUE_STILL_ELEVATED, GROWTH_POS,
  PATTERN_MAIN, PATTERN_RAMPED_ACC, patternGrowth, adjustLandmarks,
  readinessScore, readinessBand,
  FULL_RAMP, SHORT_RAMP, MINIMAL_RAMP, buildRamp, buildFeeler,
  prescribe, ingest, restDaysForFatigue, applyTransition, freshProgram,
  LANDMARK_RENAME, migrateProgram,
  PLATES, platesForSide, plateText,
};
