import React, { useState, useEffect, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  Dumbbell, TrendingUp, History as HistoryIcon, Activity, Layers,
  Minus, Plus, AlertTriangle, ChevronDown, ChevronRight, Settings, Check,
  Timer, X, Award,
} from "lucide-react";
import cloudStorage from "./storage.js";

/* ════════════════════════════════════════════════════════════════════════
   PROGRAMMING ENGINE
   ────────────────────────────────────────────────────────────────────────
   All sport-science logic lives here as pure, deterministic functions.
   The LLM only narrates + breaks genuinely borderline transitions (runCoach).

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

/* ---- movement patterns & landmark defaults (weekly hard sets) ----
   These baseline MEV/MAV/MRV are the INTERMEDIATE tier; beginner/advanced
   programs are seeded by scaling this table (see landmarksForExperience). */
const PATTERNS = {
  squat:       { label: "Squat / Quads",       mev: 8,  mav: 14, mrv: 20 },
  hinge:       { label: "Hinge / Post. chain", mev: 6,  mav: 12, mrv: 16 },
  horiz_press: { label: "Horizontal Press",    mev: 8,  mav: 14, mrv: 22 },
  /* Front delts get indirect stimulus from chest/triceps pressing already
     covered elsewhere in the program; RP's published landmark table gives
     them an MEV of 0 for that reason. mev:2 keeps a small non-zero floor
     since this program tracks vert_press as part of a whole routine, not in
     isolation. mav:7 is the midpoint of RP's 6-8 range. */
  vert_press:  { label: "Vertical Press",      mev: 2,  mav: 7,  mrv: 12 },
  /* horiz_pull + vert_pull are consolidated into ONE 'back' volume pool: RP's
     landmark research treats back as a single muscle group, not two. The pull
     exercises keep their horiz_pull/vert_pull `pattern` (used by the warmup
     muscle-overlap check) but carry volumeGroup:'back' so all their volume
     math (PATTERN_FREQ / weeklyTarget / landmark auto-tune) shares this pool. */
  back:        { label: "Back",                mev: 10, mav: 18, mrv: 25 },
  /* Rear/side delts and calves were previously fixedSets accessories (flat set
     count, no landmark tracking); the volume audit found both sitting below
     MEV. Promoted to real landmark-tracked pools. rear_delts = Reverse Pec Deck
     + Cable Lateral Raise; calves = Standing Calf Raise (trained on two days).
     Both use volumeGroup on those exercises to route here. */
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
   mainMuscle (barbell exercises only) / muscles (non-barbell exercises):
   used by the warmup-ramp logic to decide whether an earlier non-barbell
   exercise actually primed a later barbell exercise's target muscle, rather
   than just sharing its loose landmark `pattern` tag — e.g. Incline Dumbbell
   Curl shares Barbell Row's `horiz_pull` pattern (both feed the same volume
   landmark) but works biceps, not back, so it should NOT shorten Row's
   warmup; Lat Pulldown (back) should. See buildRamp's caller in prescribe().
   volumeGroup (optional): overrides `pattern` for VOLUME math only
   (PATTERN_FREQ / weeklyTarget / landmark auto-tune), letting several
   patterns share one landmark pool — e.g. the horiz_pull + vert_pull pulls
   all map to the single 'back' pool. Falls back to `pattern` when absent, so
   `pattern` still drives warmup logic and prescription rep/RPE unchanged. */
const LIB = {
  squat:        { label: "Back Squat",                    pattern: "squat",       role: "main", barbell: true, mainMuscle: "quads" },
  bench:        { label: "Bench Press",                   pattern: "horiz_press", role: "main", barbell: true, mainMuscle: "chest" },
  deadlift:     { label: "Deadlift",                      pattern: "hinge",       role: "main", barbell: true, mainMuscle: "hamstrings" },
  rdl:          { label: "Romanian Deadlift",              pattern: "hinge",       role: "acc",  barbell: true,  repTier: "compound", mainMuscle: "hamstrings" },
  frontsquat:   { label: "Front Squat",                   pattern: "squat",       role: "acc",  barbell: true,  repTier: "compound", mainMuscle: "quads" },
  ohp:          { label: "Overhead Press",                pattern: "vert_press",  role: "acc",  barbell: true,  repTier: "compound", mainMuscle: "shoulders" },
  row:          { label: "Barbell Row",                   pattern: "horiz_pull",  role: "acc",  barbell: true,  repTier: "compound", mainMuscle: "back", volumeGroup: "back" },
  cablerow:     { label: "Seated Cable Row",               pattern: "horiz_pull",  role: "acc",  barbell: false, repTier: "compound", muscles: ["back", "biceps"], volumeGroup: "back" },
  pulldown:     { label: "Lat Pulldown",                  pattern: "vert_pull",   role: "acc",  barbell: false, repTier: "compound", muscles: ["back", "biceps"], volumeGroup: "back" },
  pullup:       { label: "Pull-Up / Chin-Up",             pattern: "vert_pull",   role: "acc",  barbell: false, bodyweight: true, repTier: "compound", muscles: ["back", "biceps"], volumeGroup: "back" },
  curl:         { label: "Incline Dumbbell Curl",         pattern: "horiz_pull",  role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", muscles: ["biceps"] },
  bsplit:       { label: "Bulgarian Split Sq",            pattern: "squat",       role: "acc",  barbell: false, repTier: "unilateral", muscles: ["quads", "glutes"] },
  triext:       { label: "Cable Overhead Triceps Extension", pattern: "vert_press", role: "acc", barbell: false, fixedSets: 3, repTier: "isolation", muscles: ["triceps"] },
  lateralraise: { label: "Cable Lateral Raise",           pattern: "vert_press",  role: "acc",  barbell: false, repTier: "isolation", muscles: ["shoulders"], volumeGroup: "rear_delts" },
  calfraise:    { label: "Standing Calf Raise",           pattern: "squat",       role: "acc",  barbell: false, repTier: "isolation", muscles: ["calves"], volumeGroup: "calves" },
  inclinebench: { label: "Incline Dumbbell Press (~30°)", pattern: "horiz_press", role: "acc",  barbell: false, repTier: "compound", muscles: ["chest", "shoulders"] },
  legcurl:      { label: "Seated Leg Curl",               pattern: "hinge",       role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", muscles: ["hamstrings"] },
  legext:       { label: "Leg Extension",                 pattern: "squat",       role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", muscles: ["quads"] },
  reversepecdeck: { label: "Reverse Pec Deck",             pattern: "vert_press",  role: "acc",  barbell: false, repTier: "isolation", muscles: ["shoulders"], volumeGroup: "rear_delts" },
  wristcurl:    { label: "Dumbbell Wrist Curl",           pattern: "horiz_pull",  role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", muscles: ["forearms"] },
  cablecrunch:  { label: "Cable Crunch",                  pattern: "hinge",       role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", muscles: ["abs"] },
  shrug:        { label: "Dumbbell Shrug",                pattern: "vert_pull",   role: "acc",  barbell: false, fixedSets: 3, repTier: "isolation", muscles: ["traps"] },
  goodmorning:  { label: "Good Morning",                  pattern: "hinge",       role: "acc",  barbell: true,  repTier: "compound", mainMuscle: "hamstrings" },
  cablefly:     { label: "Cable Fly",                     pattern: "horiz_press", role: "acc",  barbell: false, repTier: "isolation", muscles: ["chest"] },
  dbshoulderpress: { label: "Dumbbell Shoulder Press",    pattern: "vert_press",  role: "acc",  barbell: false, repTier: "compound", muscles: ["shoulders", "triceps"] },
};

/* ---- rotation: which lifts each training day trains ---- */
const ROTATION = [
  { name: "Squat",            items: ["squat", "rdl", "legcurl", "legext", "calfraise", "wristcurl", "cablecrunch"] },
  { name: "Bench",            items: ["bench", "ohp", "cablerow", "triext", "pullup", "inclinebench", "reversepecdeck", "dbshoulderpress"] },
  { name: "Deadlift",         items: ["deadlift", "frontsquat", "pulldown", "curl", "row", "shrug", "goodmorning", "calfraise"] },
  { name: "Squat+Bench Vol.", items: ["squat", "bench", "bsplit", "curl", "lateralraise", "cablefly"] },
];
const ROT = ROTATION.length;
const PATTERN_FREQ = (() => {
  const f = {};
  ROTATION.forEach((d) => d.items.forEach((k) => {
    if (LIB[k].role === "main" || LIB[k].fixedSets) return;
    const p = LIB[k].volumeGroup || LIB[k].pattern; f[p] = (f[p] || 0) + 1;
  }));
  return f;
})();
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
/* pattern → main lift that carries its growth signal */
const PATTERN_MAIN = { squat: "squat", hinge: "deadlift", horiz_press: "bench" };
/* volumeGroup (or pattern) → its landmark-ramped accessories (role=acc, not
   fixedSets), for the pools that have no main lift to read a slope from.
   Keyed the same way as the landmark table so the auto-tune resolves each
   landmark key (incl. the merged 'back' pool) to the right accessory slopes. */
const PATTERN_RAMPED_ACC = (() => {
  const m = {};
  Object.entries(LIB).forEach(([k, L]) => {
    if (L.role !== "acc" || L.fixedSets) return;
    const g = L.volumeGroup || L.pattern;
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
    // did this pattern's ramped volume already reach MRV this block?
    const reachedCeiling = weeklyTarget(p, "accumulation", Math.max(0, cyc - 1), program.landmarks) >= lm.mrv;
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
      const vg = L.volumeGroup || L.pattern; // shared landmark pool key (e.g. 'back'); falls back to pattern
      const wk = weeklyTarget(vg, program.block.type, cyc, program.landmarks);
      const freq = PATTERN_FREQ[vg] || 1;
      const rawSets = Math.round((wk / freq) * setMult);
      sets = Math.max(1, Math.min(4, rawSets));
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
      /* An earlier barbell exercise counts if it shares this one's landmark
         pattern (two compound lifts under the same pattern always share the
         main muscle, e.g. squat/front squat -> quads). An earlier non-barbell
         exercise only counts if it actually worked this exercise's main
         muscle — sharing the loose `pattern` tag isn't enough (curl shares
         Barbell Row's horiz_pull pattern but works biceps, not back). */
      const earlierPrimed = day.items.slice(0, idx).some((k) => {
        const E = LIB[k];
        return E.barbell ? E.pattern === L.pattern : (E.muscles || []).includes(L.mainMuscle);
      });
      const type = earlierPrimed ? (baseTier === "full" ? "short" : "minimal") : baseTier;
      const ramp = type === "full" ? FULL_RAMP : type === "short" ? SHORT_RAMP : MINIMAL_RAMP;
      const rampSets = buildRamp(topLoad, ramp, unit, barWeight);
      if (rampSets) warmup = { type, sets: rampSets };
    } else if (!isMain && L.repTier === "compound") {
      warmup = buildFeeler(topLoad, reps, !!L.bodyweight, unit);
    }
    // isolation/unilateral non-barbell accessories: no warmup (warmup stays null)

    return { key, label: L.label, barbell: L.barbell, isMain, pattern: L.pattern,
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
    const atVolCeiling = ["squat", "horiz_press", "hinge"].some((p) =>
      weeklyTarget(p, t, Math.max(0, cyc - 1), next.landmarks) >= next.landmarks[p].mrv);
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
        row: "bench", cablerow: "bench", pulldown: "bench", curl: "bench", bsplit: "squat",
        triext: "bench", lateralraise: "bench", calfraise: "squat", inclinebench: "bench",
        legcurl: "deadlift", legext: "squat", reversepecdeck: "bench", wristcurl: "bench",
        cablecrunch: "bench", shrug: "deadlift" }[k];
      const base = seeds[ref] ? e1rmFrom(seeds[ref].weight, seeds[ref].reps, seeds[ref].rpe) : 100;
      const mult = { rdl: 0.85, frontsquat: 0.8, ohp: 0.62, row: 0.75,
        cablerow: 0.75, pulldown: 0.7, curl: 0.35, bsplit: 0.4,
        triext: 0.45, lateralraise: 0.12, calfraise: 1.2, inclinebench: 0.55,
        legcurl: 0.4, legext: 0.65, reversepecdeck: 0.15, wristcurl: 0.15,
        cablecrunch: 0.4, shrug: 0.35 }[k] || 0.6;
      e1rm = base * mult;
    }
    lifts[k] = { e1rm, e1rmRaw: e1rm, hist: [{ e: Math.round(e1rm), raw: Math.round(e1rm) }], pattern: LIB[k].pattern };
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

/* Reconcile a loaded program's landmark keys to the current PATTERNS set so
   older saved programs survive landmark-schema changes: add any missing group
   from the experience defaults, drop any stale group no longer in the schema.
   Generic by design — it already backfills every schema addition automatically:
   the merged 'back' pool (horiz_pull + vert_pull), and the promoted
   'rear_delts' / 'calves' pools (previously fixedSets, now landmark-tracked).
   Without this, a pre-change saved program would hit an undefined landmark on
   the next prescribe() for one of those exercises. */
function migrateProgram(program) {
  if (!program?.landmarks) return program;
  const canonical = landmarksForExperience(program.experience);
  const lm = { ...program.landmarks };
  let changed = false;
  for (const key of Object.keys(canonical)) if (!lm[key]) { lm[key] = canonical[key]; changed = true; }
  for (const key of Object.keys(lm)) if (!canonical[key]) { delete lm[key]; changed = true; }
  return changed ? { ...program, landmarks: lm } : program;
}

/* ════════════ COACH (Sonnet): narration + borderline tie-break only ════════════ */
const COACH_OFFLINE_NOTE = "Coach offline — deterministic engine applied.";
async function runCoach({ rx, fatigueIndex, e1rmSlope, rScore, transition, recent }) {
  const prompt = `You are a strength coach reviewing one session of an autoregulated block-periodization program. The math is already done by deterministic code — do NOT recompute loads or e1RMs. Your job: (1) write a 1-2 sentence plain-language read of how things are trending, and (2) if a block transition is flagged BORDERLINE, decide whether to confirm it.

Computed state this session:
- Current block: ${rx.block} (microcycle ${rx.cycle + 1})
- Fatigue index (0-1, higher = more accumulated fatigue): ${fatigueIndex.toFixed(2)}
- Normalized e1RM trend per session (>0 = gaining): ${(e1rmSlope * 100).toFixed(2)}%
- Today's readiness score (0-1): ${rScore.toFixed(2)}
- Transition flagged: ${transition ? `${transition.to} — ${transition.reason}${transition.borderline ? " (BORDERLINE — your call)" : ""}` : "none"}

Recent sessions (newest first):
${JSON.stringify(recent, null, 1)}

Respond ONLY with JSON, no prose, no code fences:
{"note":"1-2 sentence read for the athlete","confirmTransition":true,"override":null}
override: only set to a block name (accumulation|intensification|deload|realization) if you'd transition differently than flagged; otherwise null.`;
  try {
    const res = await fetch("/api/coach", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    const text = (data.content || []).map((c) => (c.type === "text" ? c.text : "")).join("").replace(/```json|```/g, "").trim();
    return { ok: true, ...JSON.parse(text) };
  } catch {
    return { ok: false, note: COACH_OFFLINE_NOTE, confirmTransition: true, override: null };
  }
}

/* ════════════ STORAGE ════════════ */
const K_PROGRAM = "strength.engine.program.v1";
const K_SESSIONS = "strength.engine.sessions.v1";
async function loadKey(k) { try { const r = await cloudStorage.get(k); return r ? JSON.parse(r.value) : null; } catch { return null; } }
async function saveKey(k, v) { try { await cloudStorage.set(k, JSON.stringify(v)); return true; } catch { return false; } }

/* ════════════ UI (functional; secondary to the engine) ════════════ */
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
function Barbell({ weight, bar = 45 }) {
  const side = platesForSide(weight, bar);
  return (
    <svg viewBox="0 0 320 70" width="100%" height="52" style={{ display: "block" }}>
      <rect x="40" y="32" width="240" height="6" rx="3" fill="#6B7280" />
      <rect x="44" y="28" width="6" height="14" rx="1" fill="#3A3F49" />
      <rect x="270" y="28" width="6" height="14" rx="1" fill="#3A3F49" />
      {side.map((p, i) => <rect key={"r" + i} x={200 + i * 13} y={35 - p.h / 2} width="11" height={p.h} rx="2" fill={p.c} stroke="#0E0F12" strokeWidth="1" />)}
      {side.map((p, i) => <rect key={"l" + i} x={109 - i * 13} y={35 - p.h / 2} width="11" height={p.h} rx="2" fill={p.c} stroke="#0E0F12" strokeWidth="1" />)}
      {side.length === 0 && <text x="160" y="54" textAnchor="middle" fontSize="10" fill="#8A909C" fontFamily="'JetBrains Mono',monospace">bar only</text>}
    </svg>
  );
}
function Stepper({ value, set, min = 0, max = 9999, step = 1, suffix, w }) {
  return (
    <div className="stepper">
      <button onClick={() => set(Math.max(min, +(value - step).toFixed(2)))}><Minus size={13} /></button>
      <span className="mono" style={{ minWidth: w || 56 }}>{value}{suffix || ""}</span>
      <button onClick={() => set(Math.min(max, +(value + step).toFixed(2)))}><Plus size={13} /></button>
    </div>
  );
}

/* Read-only landmarks view, shared by the onboarding preview and Settings.
   When `adjustments` is passed, the most-recent auto-tune delta per pattern is
   surfaced inline (e.g. "18 ▲1") so the automation is visible, not silent. */
function LandmarkTable({ landmarks, adjustments }) {
  const fmtDelta = (d) => (d > 0 ? `▲${d}` : `▼${Math.abs(d)}`);
  return (
    <div className="lmtable">
      <div className="lmtable-head mono"><span>PATTERN</span><span>MEV</span><span>MAV</span><span>MRV</span></div>
      {Object.entries(landmarks).map(([p, lm]) => {
        const adj = adjustments?.[p];
        return (
          <div key={p} className="lmrow">
            <div className="lmrow-main">
              <span className="lmrow-name">{lm.label}</span>
              <span className="mono">{lm.mev}{adj?.dMev ? <em className={"lmdelta" + (adj.dMev < 0 ? " dn" : "")}>{fmtDelta(adj.dMev)}</em> : null}</span>
              <span className="mono">{lm.mav}</span>
              <span className="mono">{lm.mrv}{adj?.dMrv ? <em className={"lmdelta" + (adj.dMrv < 0 ? " dn" : "")}>{fmtDelta(adj.dMrv)}</em> : null}</span>
            </div>
            {adj?.signal && <div className="lmsig mono">↳ last auto-tune: {adj.signal}</div>}
          </div>
        );
      })}
    </div>
  );
}

function Onboarding({ onDone }) {
  const [step, setStep] = useState(0);
  const [experience, setExperience] = useState("intermediate");
  const [bodyweight, setBodyweight] = useState(180);
  const [seeds, setSeeds] = useState({
    squat: { weight: 225, reps: 5, rpe: 8 }, bench: { weight: 155, reps: 5, rpe: 8 }, deadlift: { weight: 275, reps: 5, rpe: 8 },
  });
  const setSeed = (k, f, v) => setSeeds((s) => ({ ...s, [k]: { ...s[k], [f]: v } }));

  if (step === 0) return (
    <div className="screen">
      <div className="eyebrow">SETUP · 1 OF 2</div>
      <h1 className="display">Calibrate the lifts.</h1>
      <p className="lede">Bodyweight drives system-load math for bodyweight lifts (Pull-Up / Chin-Up) — added weight or assistance is tracked relative to it. Enter a recent honest top set for each main lift — weight, reps, and RPE (10 = no reps left, 8 = two left). The engine converts this to an estimated 1RM and prescribes every future load from it, re-reading your e1RM after each session.</p>
      <div className="panel">
        <label className="fieldrow sm"><span>Bodyweight</span><Stepper value={bodyweight} set={setBodyweight} min={80} max={400} step={1} suffix=" lb" /></label>
      </div>
      {["squat", "bench", "deadlift"].map((k) => (
        <div key={k} className="panel">
          <div className="exer-name" style={{ fontSize: 19, padding: "10px 0 4px" }}>{LIB[k].label}</div>
          <label className="fieldrow sm"><span>Weight</span><Stepper value={seeds[k].weight} set={(v) => setSeed(k, "weight", v)} step={5} suffix=" lb" /></label>
          <label className="fieldrow sm"><span>Reps</span><Stepper value={seeds[k].reps} set={(v) => setSeed(k, "reps", v)} min={1} max={12} /></label>
          <label className="fieldrow sm"><span>RPE</span><Stepper value={seeds[k].rpe} set={(v) => setSeed(k, "rpe", v)} min={6} max={10} step={0.5} /></label>
          <div className="est mono">≈ e1RM {Math.round(e1rmFrom(seeds[k].weight, seeds[k].reps, seeds[k].rpe))} lb</div>
        </div>
      ))}
      <button className="cta" onClick={() => setStep(1)}>Next — training experience</button>
    </div>
  );

  const preview = landmarksForExperience(experience);
  return (
    <div className="screen">
      <div className="eyebrow">SETUP · 2 OF 2</div>
      <h1 className="display sm">Training experience.</h1>
      <p className="lede">This seeds your starting weekly-volume landmarks — MEV (minimum effective), MAV (most growth), MRV (most you can recover from) hard sets per pattern. From here the engine auto-tunes them each block from your strength trend and fatigue; you won't set these by hand.</p>
      {Object.entries(EXPERIENCE_TIERS).map(([key, t]) => (
        <button key={key} type="button" className={"optcard" + (experience === key ? " on" : "")} onClick={() => setExperience(key)}>
          <div className="optcard-top">
            <span className="optcard-name">{t.label}</span>
            {experience === key && <Check size={16} />}
          </div>
          <span className="optcard-sub mono">{t.blurb}</span>
        </button>
      ))}
      <div className="eyebrow mt">SEEDED LANDMARKS</div>
      <LandmarkTable landmarks={preview} />
      <button className="cta" onClick={() => onDone(freshProgram({ seeds, experience, unit: "lb", goal: "hybrid", bodyweight }))}>Start program</button>
    </div>
  );
}

function ExerciseCard({ it, log, update, barWeight, onRest }) {
  const [open, setOpen] = useState(it.isMain);
  const [warmupOpen, setWarmupOpen] = useState(false);
  const bwScheme = it.assistanceNeeded ? "assistance needed" : it.repOnly ? "bodyweight only"
    : `BW${it.topLoad >= 0 ? "+" : ""}${it.topLoad} lb`;
  const loadScheme = it.bodyweight ? bwScheme
    : it.barbell ? `${it.topLoad} lb — ${plateText(it.topLoad, barWeight)}`
    : `${it.topLoad} lb`;
  const setWord = (n) => (n === 1 ? "set" : "sets");
  /* Unambiguous total-set breakdown for mains: `sets` is the FULL working-set
     count, never top-sets-plus-extra-backoff — see prescribe(). Only the
     first set is at topLoad; the rest (if any) are at the lower backoffLoad. */
  const scheme = it.isMain
    ? (it.backoffSetCount > 0
        ? `${it.topSetCount} ${setWord(it.topSetCount)} @ ${it.topLoad} lb, then ${it.backoffSetCount} ${setWord(it.backoffSetCount)} @ ${it.backoffLoad} lb (${it.reps} reps · RPE ${it.rpe})`
        : `${it.sets} ${setWord(it.sets)} of ${it.reps} @ ${it.topLoad} lb (RPE ${it.rpe})`)
    : `${it.sets} × ${it.reps} @ RPE ${it.rpe} · ${loadScheme}`;
  return (
    <div className="exer">
      <div className="exer-head" onClick={() => setOpen(!open)}>
        <div>
          <div className="exer-name">{it.label}{it.isMain && <span className="tag">MAIN</span>}</div>
          <div className="exer-scheme mono">{scheme}</div>
        </div>
        {open ? <ChevronDown size={17} color="#8A909C" /> : <ChevronRight size={17} color="#8A909C" />}
      </div>
      {it.barbell && (
        <div className="bar-wrap">
          <Barbell weight={log.topWeight} bar={barWeight} />
          {log.topWeight !== it.topLoad && <div className="plates mono">now {log.topWeight} lb — {plateText(log.topWeight, barWeight)}</div>}
        </div>
      )}
      {open && (
        <div className="exer-body">
          {it.warmup && (
            <div className="warmup">
              <button type="button" className="warmup-head mono" onClick={() => setWarmupOpen(!warmupOpen)}>
                <span className="warmup-label">
                  WARM-UP · {it.warmup.type === "full" ? "4-step ramp" : it.warmup.type === "short" ? "2-step ramp"
                    : it.warmup.type === "minimal" ? "1-step ramp" : "feeler set"}
                </span>
                {warmupOpen ? <ChevronDown size={14} color="#E8C547" /> : <ChevronRight size={14} color="#E8C547" />}
              </button>
              {warmupOpen && (
                <div className="warmup-body">
                  {it.warmup.note && <div className="warmup-row mono">{it.warmup.note}</div>}
                  {it.warmup.sets.map((s, i) => (
                    <div key={i} className="warmup-row mono">
                      {s.weight} lb{it.barbell ? ` — ${plateText(s.weight, barWeight)}` : ""} × {s.reps}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <label className="fieldrow sm"><span>{it.bodyweight ? "Added / assist weight" : "Top-set weight"}</span><Stepper value={log.topWeight} set={(v) => update({ topWeight: v })} min={it.bodyweight ? -200 : 0} step={5} suffix=" lb" /></label>
          <label className="fieldrow sm"><span>Top-set reps</span><Stepper value={log.topReps} set={(v) => update({ topReps: v })} min={1} max={15} /></label>
          <label className="fieldrow sm"><span>Top-set RPE</span><Stepper value={log.topRpe} set={(v) => update({ topRpe: v })} min={5} max={10} step={0.5} /></label>
          <label className="fieldrow sm"><span>Sets missed (reps short)</span><Stepper value={log.missedSets} set={(v) => update({ missedSets: v })} min={0} max={it.sets} /></label>
          {it.isMain && it.backoffSetCount > 0 && (
            <>
              <label className="fieldrow sm"><span>Backoff sets — reps (avg)</span><Stepper value={log.backoffReps} set={(v) => update({ backoffReps: v })} min={1} max={20} /></label>
              <label className="fieldrow sm"><span>Backoff sets — RPE (avg)</span><Stepper value={log.backoffRpe} set={(v) => update({ backoffRpe: v })} min={5} max={10} step={0.5} /></label>
            </>
          )}
          {it.bodyweight && <div className="est mono">negative = assistance used</div>}
          {Math.abs(log.topRpe - it.rpe) >= 1 && (
            <div className="warn mono">{log.topRpe > it.rpe ? "harder than target — engine notes fatigue" : "easier than target — e1RM will rise"}</div>
          )}
          <button className="restbtn mono" onClick={() => onRest(it)}><Timer size={13} /> REST {it.isMain ? "3:00" : "1:30"}</button>
        </div>
      )}
    </div>
  );
}

function Gauge({ value, label, color }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div className="gauge">
      <div className="gauge-label mono">{label}</div>
      <div className="gauge-bar"><div className="gauge-fill" style={{ width: `${pct * 100}%`, background: color }} /></div>
    </div>
  );
}

const fmtSecs = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function Today({ program, sessions, onLog }) {
  const [readiness, setReadiness] = useState({ trainingReadiness: 65 });
  const rx = useMemo(() => prescribe(program, readiness), [program, readiness]);
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [rest, setRest] = useState(null); // { label, left }

  useEffect(() => {
    if (!rest || rest.left <= 0) return;
    const id = setInterval(() => setRest((r) => (r ? { ...r, left: Math.max(0, r.left - 1) } : r)), 1000);
    return () => clearInterval(id);
  }, [rest !== null && rest.left > 0]);

  const startRest = (it) => setRest({ label: it.label, left: it.isMain ? 180 : 90 });
  const nudgeRest = (d) => setRest((r) => (r ? { ...r, left: Math.max(0, r.left + d) } : r));

  useEffect(() => {
    setLogs(rx.items.map((it) => ({ key: it.key, topWeight: it.topLoad, topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe, missedSets: 0, sets: it.sets, backoffSetCount: it.backoffSetCount, backoffReps: it.reps, backoffRpe: it.rpe })));
    // eslint-disable-next-line
  }, [program.sessionCount]);

  useEffect(() => {
    setLogs((L) => L.map((l, i) => (l && l._touched ? l : rx.items[i] ? { key: rx.items[i].key, topWeight: rx.items[i].topLoad, topReps: rx.items[i].reps, topRpe: rx.items[i].rpe, targetRpe: rx.items[i].rpe, missedSets: 0, sets: rx.items[i].sets, backoffSetCount: rx.items[i].backoffSetCount, backoffReps: rx.items[i].reps, backoffRpe: rx.items[i].rpe } : l)));
    // eslint-disable-next-line
  }, [rx.band]);

  const upd = (i, patch) => setLogs((L) => L.map((l, j) => (j === i ? { ...l, ...patch, _touched: true } : l)));
  const bandColor = rx.band === "green" ? "#3FA85F" : rx.band === "amber" ? "#E8C547" : "#D7443E";

  return (
    <div className="screen">
      <div className="eyebrow">SESSION {program.sessionCount + 1} · {rx.dayName.toUpperCase()}</div>
      <div className="blockrow">
        <span className="phase mono" style={{ borderColor: bandColor }}>{rx.block} · cycle {rx.cycle + 1}</span>
        <span className="mono dim">top RPE {rx.rpeTop}</span>
      </div>

      {program.lastCoach && (
        <div className={"coach " + (program.lastCoach === COACH_OFFLINE_NOTE ? "coach-off " : "") + (program.block.type === "deload" ? "coach-alert" : "")}>
          <div className="coach-top mono">{program.block.type === "deload" ? <AlertTriangle size={12} /> : <Check size={12} />} COACH</div>
          <p>{program.lastCoach}</p>
        </div>
      )}

      {program.lastPRs?.length > 0 && (
        <div className="prnote mono"><Award size={13} /> NEW e1RM {program.lastPRs.length > 1 ? "PRs" : "PR"} — {program.lastPRs.map((k) => LIB[k]?.label || k).join(", ")}</div>
      )}

      {program.lastRestUntil && (
        <div className="restnote mono">
          <Timer size={13} /> Rest until {new Date(program.lastRestUntil).toLocaleDateString("en-US", { month: "long", day: "numeric" })} — advisory only, log anytime
        </div>
      )}

      {rx.items.map((it, i) => logs[i] && <ExerciseCard key={it.key + i} it={it} log={logs[i]} update={(p) => upd(i, p)} barWeight={program.barWeight || 45} onRest={startRest} />)}

      <div className="eyebrow mt">READINESS — Garmin Training Readiness Score</div>
      <div className="panel">
        <label className="fieldrow sm"><span>Training Readiness Score</span><Stepper value={readiness.trainingReadiness} set={(v) => setReadiness({ ...readiness, trainingReadiness: v })} step={5} max={100} /></label>
      </div>
      <div className="readout mono" style={{ color: bandColor }}>
        readiness {rx.band.toUpperCase()} → {rx.band === "green" ? "session as prescribed" : rx.band === "amber" ? "load + volume trimmed slightly" : "auto mini-deload today"}
      </div>

      <button className="cta" disabled={busy} onClick={async () => { setBusy(true); await onLog(logs, readiness, rx); setBusy(false); }}>
        {busy ? "Coach reviewing…" : "Log session"}
      </button>

      {rest && (
        <div className={"resttimer mono" + (rest.left === 0 ? " done" : "")}>
          <Timer size={14} color={rest.left === 0 ? "#3FA85F" : "#8A909C"} />
          <span className="rt-label">{rest.left === 0 ? "REST DONE" : rest.label}</span>
          <span className="rt-time">{fmtSecs(rest.left)}</span>
          <button onClick={() => nudgeRest(-15)}>−15</button>
          <button onClick={() => nudgeRest(15)}>+15</button>
          <button onClick={() => setRest(null)}><X size={14} /></button>
        </div>
      )}
    </div>
  );
}

function Status({ program }) {
  const cyc = program.block.cycle;
  const rows = Object.entries(program.landmarks).map(([p, lm]) => {
    const wk = weeklyTarget(p, program.block.type, cyc, program.landmarks);
    const pctMrv = Math.min(1, wk / lm.mrv);
    const color = wk < lm.mev ? "#9AA0AC" : wk < lm.mav ? "#3FA85F" : wk < lm.mrv ? "#E8C547" : "#D7443E";
    return { p, label: lm.label, wk, lm, pctMrv, color };
  });
  return (
    <div className="screen">
      <div className="eyebrow">MESOCYCLE</div>
      <h1 className="display sm">{BLOCKS[program.block.type].label}</h1>
      <p className="lede" style={{ marginBottom: 14 }}>Microcycle {cyc + 1} · emphasis: {BLOCKS[program.block.type].emphasis}. Block length is decided live from your e1RM trend, RPE creep, and readiness — not a fixed calendar.</p>
      <div className="panel" style={{ padding: 14 }}>
        <Gauge value={program.fatigue.index} label={`FATIGUE INDEX  ${program.fatigue.index.toFixed(2)}`} color={program.fatigue.index >= 0.7 ? "#D7443E" : program.fatigue.index >= 0.55 ? "#E8C547" : "#3FA85F"} />
        <Gauge value={0.5 + program.fatigue.slope * 50} label={`e1RM TREND  ${(program.fatigue.slope * 100).toFixed(2)}%/session`} color="#2F6FB0" />
      </div>
      <div className="eyebrow mt">WEEKLY VOLUME vs LANDMARKS</div>
      {rows.map((r) => (
        <div key={r.p} className="volrow">
          <div className="volrow-top"><span className="mono">{r.label}</span><span className="mono" style={{ color: r.color }}>{r.wk} sets</span></div>
          <div className="vol-track">
            <div className="vol-fill" style={{ width: `${r.pctMrv * 100}%`, background: r.color }} />
            <div className="vol-tick" style={{ left: `${(r.lm.mev / r.lm.mrv) * 100}%` }} />
            <div className="vol-tick" style={{ left: `${(r.lm.mav / r.lm.mrv) * 100}%` }} />
          </div>
          <div className="vol-legend mono dim">MEV {r.lm.mev} · MAV {r.lm.mav} · MRV {r.lm.mrv}</div>
        </div>
      ))}
    </div>
  );
}

function Trends({ program }) {
  const lifts = [["squat", "Squat", "#D7443E"], ["bench", "Bench", "#2F6FB0"], ["deadlift", "Deadlift", "#3FA85F"]];
  const any = lifts.some(([k]) => (program.lifts[k].hist || []).length > 1);
  if (!any) return <div className="screen"><div className="empty">Estimated-1RM curves appear here once you've logged a few sessions.</div></div>;
  return (
    <div className="screen">
      <div className="eyebrow">ESTIMATED 1RM</div>
      <h1 className="display sm">Strength trend</h1>
      <p className="lede" style={{ marginBottom: 12 }}>Smoothed e1RM (bold) vs each session's raw reading (faint). The smoothed line drives load prescription and stall detection.</p>
      {lifts.map(([k, label, color]) => {
        const d = (program.lifts[k].hist || []).map((p, i) => ({ n: i + 1, e: p.e, raw: p.raw }));
        return (
          <div key={k} className="panel chart">
            <div className="chart-title mono" style={{ color }}>{label.toUpperCase()} · {Math.round(program.lifts[k].e1rm)} lb</div>
            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={d} margin={{ top: 6, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid stroke="#2E333D" vertical={false} />
                <XAxis dataKey="n" stroke="#5A6070" fontSize={10} />
                <YAxis stroke="#5A6070" fontSize={10} domain={["auto", "auto"]} />
                <Tooltip contentStyle={{ background: "#1C1F26", border: "1px solid #2E333D", borderRadius: 8, color: "#E6E8EC", fontSize: 12 }} />
                <Line type="monotone" dataKey="raw" stroke={color} strokeOpacity={0.25} strokeWidth={1} dot={false} />
                <Line type="monotone" dataKey="e" stroke={color} strokeWidth={2.5} dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        );
      })}
    </div>
  );
}

function History({ sessions }) {
  if (!sessions.length) return <div className="screen"><div className="empty">Logged sessions land here.</div></div>;
  return (
    <div className="screen">
      <div className="eyebrow">LOG</div>
      <h1 className="display sm">History</h1>
      {[...sessions].reverse().map((s, i) => (
        <div key={i} className="hist">
          <div className="hist-top"><span className="mono">{s.block} · {s.dayName}</span><span className="mono dim">{new Date(s.date).toLocaleDateString()}</span></div>
          <div className="hist-lifts mono">{s.logs.map((l) => `${LIB[l.key]?.label.split(" ")[0]} ${l.topWeight}×${l.topReps}@${l.topRpe}` + (l.backoffSetCount > 0 ? ` (+${l.backoffSetCount} backoff×${l.backoffReps}@${l.backoffRpe})` : "")).join("  ·  ")}</div>
          {s.prs?.length > 0 && <div className="hist-pr mono">★ e1RM PR — {s.prs.map((k) => LIB[k]?.label || k).join(", ")}</div>}
          {s.transition && <div className="hist-trans mono">→ {BLOCKS[s.transition]?.label || s.transition}</div>}
          {s.coach && s.coach !== COACH_OFFLINE_NOTE && <div className="hist-coach">{s.coach}</div>}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [program, setProgram] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("today");
  const [showSettings, setShowSettings] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetPhrase, setResetPhrase] = useState("");

  useEffect(() => { (async () => {
    const p = await loadKey(K_PROGRAM); const s = await loadKey(K_SESSIONS);
    if (p) { const mp = migrateProgram(p); setProgram(mp); if (mp !== p) saveKey(K_PROGRAM, mp); }
    if (s) setSessions(s); setReady(true);
  })(); }, []);

  const start = async (p) => { setProgram(p); await saveKey(K_PROGRAM, p); };

  const handleLog = async (logs, readiness, rx) => {
    const { next, transition, fatigueIndex, e1rmSlope, rScore, prs } = ingest(program, logs, readiness);
    const recent = [
      { block: rx.block, fatigue: +fatigueIndex.toFixed(2),
        lifts: logs.filter((l) => LIB[l.key]?.role === "main").map((l) => ({ lift: l.key, w: l.topWeight, reps: l.topReps, rpe: l.topRpe, target: l.targetRpe, missed: l.missedSets })),
        trainingReadiness: readiness.trainingReadiness },
      ...sessions.slice(-4).reverse().map((s) => ({ block: s.block, lifts: s.logs.filter((l) => LIB[l.key]?.role === "main").map((l) => ({ lift: l.key, w: l.topWeight, reps: l.topReps, rpe: l.topRpe })) })),
    ];

    const coach = await runCoach({ rx, fatigueIndex, e1rmSlope, rScore, transition, recent });

    let finalProgram = next, appliedTransition = null;
    if (transition) {
      let t = transition;
      if (t.borderline && coach.ok && coach.confirmTransition === false) t = null;
      else if (t.borderline && coach.ok && coach.override && coach.override !== "null" && BLOCKS[coach.override]) t = { ...transition, to: coach.override };
      if (t) { finalProgram = applyTransition(next, t); appliedTransition = t.to; }
    }
    finalProgram.lastCoach = coach.note;
    finalProgram.lastPRs = prs.length ? prs : null;
    const restDays = restDaysForFatigue(fatigueIndex);
    finalProgram.lastRestUntil = Date.now() + restDays * 86400000;

    const record = {
      date: Date.now(), block: rx.block, dayName: rx.dayName,
      logs: logs.map((l) => ({ key: l.key, topWeight: l.topWeight, topReps: l.topReps, topRpe: l.topRpe, missedSets: l.missedSets,
        backoffSetCount: l.backoffSetCount || 0, backoffReps: l.backoffReps, backoffRpe: l.backoffRpe })),
      readiness, coach: coach.note, transition: appliedTransition, prs: prs.length ? prs : null,
    };
    const newSessions = [...sessions, record];
    setProgram(finalProgram); setSessions(newSessions);
    await saveKey(K_PROGRAM, finalProgram); await saveKey(K_SESSIONS, newSessions);
    setTab("today");
  };

  const reset = async () => {
    if (resetPhrase !== "DELETE") return;
    await saveKey(K_PROGRAM, null); await saveKey(K_SESSIONS, []);
    setProgram(null); setSessions([]); setTab("today"); setConfirmingReset(false); setShowSettings(false); setResetPhrase("");
  };

  const setProgramField = async (field, v) => {
    const next = { ...program, [field]: v };
    setProgram(next);
    await saveKey(K_PROGRAM, next);
  };

  return (
    <div className="root">
      <style>{CSS}</style>
      {!ready ? <div className="screen"><div className="empty">Loading…</div></div>
        : !program ? <Onboarding onDone={start} />
        : <>
          <div className="topbar">
            <div className="brand mono"><Dumbbell size={15} /> IRON&nbsp;LOG</div>
            <button className="ghost" onClick={() => setShowSettings(true)}><Settings size={15} /></button>
          </div>
          {showSettings && (
            <div className="screen">
              <div className="eyebrow">SETTINGS</div>
              <div className="panel">
                <label className="fieldrow sm"><span>Bodyweight</span><Stepper value={program.bodyweight || 180} set={(v) => setProgramField("bodyweight", v)} min={80} max={400} step={1} suffix=" lb" /></label>
                <label className="fieldrow sm"><span>Bar weight</span><Stepper value={program.barWeight || 45} set={(v) => setProgramField("barWeight", v)} min={15} max={100} step={5} suffix=" lb" /></label>
              </div>
              <div className="est mono" style={{ padding: "0 0 14px" }}>Bodyweight drives Pull-Up / Chin-Up system-load math. Bar weight drives the plate-loading breakdown.</div>
              <div className="eyebrow">VOLUME LANDMARKS · {(EXPERIENCE_TIERS[program.experience] || EXPERIENCE_TIERS.intermediate).label.toUpperCase()} SEED</div>
              <p className="est mono" style={{ padding: "0 0 8px" }}>Weekly hard sets per pattern. Auto-tuned each block from your strength trend + fatigue — ▲/▼ marks the most recent change.</p>
              <LandmarkTable landmarks={program.landmarks} adjustments={program.landmarkAdjustments} />
              <div style={{ height: 16 }} />
              {!confirmingReset ? (
                <div style={{ display: "flex", gap: 10 }}>
                  <button className="cta" style={{ margin: 0, background: "#D7443E", color: "#2A0907" }} onClick={() => setConfirmingReset(true)}>Reset everything</button>
                  <button className="cta" style={{ margin: 0, background: "var(--surface2)", color: "var(--text)" }} onClick={() => setShowSettings(false)}>Done</button>
                </div>
              ) : (
                <div className="panel" style={{ padding: 16 }}>
                  <p style={{ margin: "4px 0 10px", fontSize: 13.5, lineHeight: 1.5, color: "var(--text)" }}>
                    This will permanently delete your program and all session history. There is no backup — this cannot be undone.
                  </p>
                  <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--dim)" }}>Type <b style={{ color: "var(--text)" }}>DELETE</b> to confirm.</p>
                  <input
                    className="textinput mono"
                    value={resetPhrase}
                    onChange={(e) => setResetPhrase(e.target.value)}
                    placeholder="DELETE"
                    autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  />
                  <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                    <button className="cta" disabled={resetPhrase !== "DELETE"} style={{ margin: 0, background: "#D7443E", color: "#2A0907" }} onClick={reset}>Confirm reset</button>
                    <button className="cta" style={{ margin: 0, background: "var(--surface2)", color: "var(--text)" }} onClick={() => { setConfirmingReset(false); setResetPhrase(""); }}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {tab === "today" && <Today program={program} sessions={sessions} onLog={handleLog} />}
          {tab === "status" && <Status program={program} />}
          {tab === "trends" && <Trends program={program} />}
          {tab === "history" && <History sessions={sessions} />}
          <nav className="tabs">
            {[["today", "Today", Activity], ["status", "Block", Layers], ["trends", "Trends", TrendingUp], ["history", "Log", HistoryIcon]].map(([t, l, Icon]) => (
              <button key={t} className={tab === t ? "tab-on" : ""} onClick={() => setTab(t)}><Icon size={17} /><span>{l}</span></button>
            ))}
          </nav>
        </>}
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
.root{--bg:#121419;--surface:#1A1D24;--surface2:#22262F;--line:#2E333D;--text:#E6E8EC;--dim:#8A909C;
  max-width:460px;margin:0 auto;min-height:100vh;background:var(--bg);color:var(--text);
  font-family:'Inter',system-ui,sans-serif;position:relative;padding-bottom:80px;}
.root *{box-sizing:border-box;}
.mono{font-family:'JetBrains Mono',monospace;}
.dim{color:var(--dim);}
.topbar{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line);
  position:sticky;top:0;background:rgba(18,20,25,.92);backdrop-filter:blur(8px);z-index:5;}
.brand{display:flex;align-items:center;gap:7px;font-weight:500;letter-spacing:.14em;font-size:13px;}
.ghost{background:none;border:none;color:var(--dim);cursor:pointer;width:44px;height:44px;display:flex;align-items:center;justify-content:center;margin:-10px 0;}
.screen{padding:18px 18px 8px;}
.eyebrow{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.16em;color:var(--dim);margin-bottom:8px;}
.eyebrow.mt{margin-top:24px;}
.display{font-family:'Saira Condensed',sans-serif;font-weight:700;letter-spacing:-.01em;line-height:.95;font-size:42px;margin:0 0 12px;}
.display.sm{font-size:32px;}
.lede{color:var(--dim);font-size:13.5px;line-height:1.5;margin:0 0 18px;}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:4px 14px;margin-bottom:8px;}
.fieldrow{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--line);font-size:14px;}
.panel .fieldrow:last-child{border-bottom:none;}
.fieldrow.sm{padding:6px 0;font-size:13px;}
.est{font-size:11.5px;color:var(--dim);padding:2px 0 10px;}
.textinput{width:100%;padding:12px 13px;border-radius:10px;border:1px solid var(--line);background:var(--surface2);color:var(--text);font-size:14.5px;height:44px;}
.textinput:focus{outline:none;border-color:#D7443E;}
.textinput::placeholder{color:var(--dim);opacity:.5;}
.stepper{display:flex;align-items:center;gap:6px;}
.stepper button{width:44px;height:44px;border-radius:10px;border:1px solid var(--line);background:var(--surface2);color:var(--text);display:flex;align-items:center;justify-content:center;cursor:pointer;}
.stepper button:active{background:var(--line);}
.stepper .mono{text-align:center;font-size:14.5px;font-weight:500;}
.cta{width:100%;margin:20px 0 6px;padding:15px;border:none;border-radius:12px;background:#3FA85F;color:#06210F;
  font-family:'Saira Condensed',sans-serif;font-weight:700;font-size:19px;letter-spacing:.03em;cursor:pointer;text-transform:uppercase;}
.cta:disabled{opacity:.6;cursor:wait;}
.blockrow{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;}
.phase{font-size:11.5px;padding:5px 10px;border:1px solid;border-radius:20px;letter-spacing:.06em;}
.exer{background:var(--surface);border:1px solid var(--line);border-radius:13px;margin-bottom:9px;overflow:hidden;}
.exer-head{display:flex;justify-content:space-between;align-items:center;padding:13px 15px;cursor:pointer;}
.exer-name{font-family:'Saira Condensed',sans-serif;font-weight:600;font-size:20px;line-height:1;display:flex;align-items:center;gap:8px;}
.tag{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;color:#06210F;background:#3FA85F;padding:2px 5px;border-radius:4px;}
.exer-scheme{font-size:11px;color:var(--dim);margin-top:5px;}
.bar-wrap{padding:0 10px 6px;}
.exer-body{padding:2px 15px 12px;border-top:1px solid var(--line);}
.warmup{background:var(--surface2);border:1px solid var(--line);border-radius:10px;margin:10px 0;overflow:hidden;}
.warmup-head{display:flex;width:100%;justify-content:space-between;align-items:center;padding:9px 12px;background:none;border:none;color:#E8C547;cursor:pointer;font-family:inherit;}
.warmup-label{font-size:10.5px;letter-spacing:.09em;}
.warmup-body{padding:2px 12px 9px;border-top:1px solid var(--line);}
.warmup-row{font-size:11.5px;color:var(--dim);padding:4px 0;}
.warn{color:#E8C547;font-size:11px;padding-top:8px;}
.coach{background:var(--surface);border:1px solid var(--line);border-left:3px solid #3FA85F;border-radius:11px;padding:11px 13px;margin-bottom:16px;}
.coach-alert{border-left-color:#D7443E;}
.coach-top{display:flex;align-items:center;gap:6px;font-size:10.5px;letter-spacing:.12em;color:var(--dim);margin-bottom:6px;}
.coach p{margin:0;font-size:13px;line-height:1.45;}
.coach-off{border-left-color:var(--line);}
.coach-off .coach-top{opacity:.65;}
.coach-off p{color:var(--dim);font-size:11.5px;font-family:'JetBrains Mono',monospace;}
.prnote{display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--line);border-left:3px solid #E8C547;border-radius:11px;padding:11px 13px;margin-bottom:16px;font-size:11.5px;letter-spacing:.05em;color:#E8C547;}
.restnote{display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--line);border-left:3px solid #E8C547;border-radius:11px;padding:11px 13px;margin-bottom:16px;font-size:11.5px;letter-spacing:.03em;color:var(--dim);}
.restnote svg{color:#E8C547;flex-shrink:0;}
.plates{font-size:10.5px;color:var(--dim);letter-spacing:.04em;padding:2px 4px 6px;}
.restbtn{width:100%;height:44px;margin-top:12px;border:1px solid var(--line);border-radius:10px;background:var(--surface2);color:var(--dim);font-size:11.5px;letter-spacing:.1em;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;}
.restbtn:active{background:var(--line);}
.resttimer{position:fixed;bottom:72px;left:50%;transform:translateX(-50%);width:calc(100% - 28px);max-width:432px;display:flex;align-items:center;gap:8px;background:var(--surface2);border:1px solid var(--line);border-radius:12px;padding:6px 10px;z-index:6;font-size:12px;box-shadow:0 8px 22px rgba(0,0,0,.45);}
.rt-label{flex:1;color:var(--dim);font-size:10.5px;letter-spacing:.08em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-transform:uppercase;}
.rt-time{font-size:17px;font-weight:500;min-width:48px;text-align:center;}
.resttimer.done .rt-time{color:#3FA85F;}
.resttimer button{min-width:44px;height:44px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--text);cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:11px;display:flex;align-items:center;justify-content:center;}
.readout{font-size:11.5px;text-align:center;padding:6px 0 0;}
.gauge{margin:10px 0;}
.gauge-label{font-size:10.5px;letter-spacing:.08em;color:var(--dim);margin-bottom:5px;}
.gauge-bar{height:7px;background:var(--surface2);border-radius:4px;overflow:hidden;}
.gauge-fill{height:100%;border-radius:4px;transition:width .3s;}
.optcard{display:block;width:100%;text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:13px 15px;margin-bottom:9px;cursor:pointer;color:var(--text);font-family:inherit;}
.optcard.on{border-color:#E8C547;box-shadow:inset 0 0 0 1px #E8C547;}
.optcard-top{display:flex;justify-content:space-between;align-items:center;color:#E8C547;}
.optcard-name{font-family:'Saira Condensed',sans-serif;font-weight:600;font-size:21px;line-height:1;color:var(--text);}
.optcard.on .optcard-name{color:#E8C547;}
.optcard-sub{display:block;font-size:11px;color:var(--dim);margin-top:5px;letter-spacing:.02em;}
.lmtable{background:var(--surface);border:1px solid var(--line);border-radius:13px;overflow:hidden;margin-bottom:8px;}
.lmtable-head{display:grid;grid-template-columns:1fr 52px 52px 52px;padding:10px 14px;font-size:10px;letter-spacing:.12em;color:var(--dim);border-bottom:1px solid var(--line);}
.lmtable-head span:not(:first-child){text-align:right;}
.lmrow{padding:9px 14px;border-bottom:1px solid var(--line);}
.lmtable .lmrow:last-child{border-bottom:none;}
.lmrow-main{display:grid;grid-template-columns:1fr 52px 52px 52px;align-items:center;font-size:13.5px;}
.lmrow-main span:not(:first-child){text-align:right;}
.lmrow-name{font-size:12.5px;}
.lmdelta{font-style:normal;font-size:9.5px;margin-left:3px;color:#3FA85F;letter-spacing:.02em;}
.lmdelta.dn{color:#D7443E;}
.lmsig{font-size:10px;color:var(--dim);margin-top:5px;letter-spacing:.02em;}
.volrow{margin-bottom:13px;}
.volrow-top{display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px;}
.vol-track{position:relative;height:8px;background:var(--surface2);border-radius:4px;}
.vol-fill{height:100%;border-radius:4px;}
.vol-tick{position:absolute;top:-2px;width:2px;height:12px;background:var(--dim);opacity:.6;}
.vol-legend{font-size:10px;margin-top:5px;}
.chart{padding:14px;}
.chart-title{font-size:11px;letter-spacing:.1em;margin-bottom:8px;}
.hist{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:9px;}
.hist-top{display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:7px;}
.hist-lifts{font-size:11.5px;line-height:1.5;}
.hist-trans{font-size:11px;color:#E8C547;margin-top:7px;}
.hist-pr{font-size:11px;color:#E8C547;margin-top:7px;letter-spacing:.04em;}
.hist-coach{font-size:11.5px;color:var(--dim);margin-top:7px;line-height:1.4;font-style:italic;}
.empty{color:var(--dim);font-size:14px;line-height:1.6;padding:40px 6px;text-align:center;}
.tabs{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:460px;display:flex;
  background:rgba(18,20,25,.95);backdrop-filter:blur(10px);border-top:1px solid var(--line);z-index:5;}
.tabs button{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 0 13px;background:none;border:none;color:var(--dim);cursor:pointer;font-family:inherit;font-size:10.5px;}
.tab-on{color:var(--text)!important;}
@media (prefers-reduced-motion:reduce){*{transition:none!important;}}
`;
