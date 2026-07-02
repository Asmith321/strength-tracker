import React, { useState, useEffect, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  Dumbbell, TrendingUp, History as HistoryIcon, Activity, Layers,
  Minus, Plus, AlertTriangle, ChevronDown, ChevronRight, Settings, Check,
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

/* ---- movement patterns & landmark defaults (weekly hard sets) ---- */
const PATTERNS = {
  squat:       { label: "Squat / Quads",       mev: 8,  mav: 14, mrv: 20 },
  hinge:       { label: "Hinge / Post. chain", mev: 6,  mav: 12, mrv: 16 },
  horiz_press: { label: "Horizontal Press",    mev: 8,  mav: 14, mrv: 22 },
  vert_press:  { label: "Vertical Press",      mev: 6,  mav: 12, mrv: 18 },
  horiz_pull:  { label: "Horizontal Pull",     mev: 10, mav: 16, mrv: 22 },
  vert_pull:   { label: "Vertical Pull",       mev: 8,  mav: 14, mrv: 20 },
};

/* ---- exercise library ----
   fixedSets: accessory takes a flat set count (scaled by block volume tier
   + readiness) instead of drawing from the landmark/weeklyTarget pool, and
   is excluded from PATTERN_FREQ since it isn't sharing that pool.
   bodyweight: e1rm is tracked as SYSTEM load (bodyweight + added load); see
   e1rmFromBW() and the bodyweight branch in prescribe(). */
const LIB = {
  squat:        { label: "Back Squat",                    pattern: "squat",       role: "main", barbell: true },
  bench:        { label: "Bench Press",                   pattern: "horiz_press", role: "main", barbell: true },
  deadlift:     { label: "Deadlift",                      pattern: "hinge",       role: "main", barbell: true },
  rdl:          { label: "Romanian Deadlift",              pattern: "hinge",       role: "acc",  barbell: true },
  frontsquat:   { label: "Front Squat",                   pattern: "squat",       role: "acc",  barbell: true },
  legpress:     { label: "Leg Press",                     pattern: "squat",       role: "acc",  barbell: false },
  ohp:          { label: "Overhead Press",                pattern: "vert_press",  role: "acc",  barbell: true },
  row:          { label: "Barbell Row",                   pattern: "horiz_pull",  role: "acc",  barbell: true },
  cablerow:     { label: "Seated Cable Row",               pattern: "horiz_pull",  role: "acc",  barbell: false },
  pulldown:     { label: "Lat Pulldown",                  pattern: "vert_pull",   role: "acc",  barbell: false },
  pullup:       { label: "Pull-Up / Chin-Up",             pattern: "vert_pull",   role: "acc",  barbell: false, bodyweight: true },
  curl:         { label: "Incline Dumbbell Curl",         pattern: "horiz_pull",  role: "acc",  barbell: false, fixedSets: 3 },
  bsplit:       { label: "Bulgarian Split Sq",            pattern: "squat",       role: "acc",  barbell: false },
  triext:       { label: "Cable Overhead Triceps Extension", pattern: "vert_press", role: "acc", barbell: false, fixedSets: 3 },
  lateralraise: { label: "Cable Lateral Raise",           pattern: "vert_press",  role: "acc",  barbell: false, fixedSets: 3 },
  calfraise:    { label: "Standing Calf Raise",           pattern: "squat",       role: "acc",  barbell: false, fixedSets: 3 },
  inclinebench: { label: "Incline Dumbbell Press (~30°)", pattern: "horiz_press", role: "acc",  barbell: false },
};

/* ---- rotation: which lifts each training day trains ---- */
const ROTATION = [
  { name: "Squat",            items: ["squat", "rdl", "legpress", "calfraise"] },
  { name: "Bench",            items: ["bench", "ohp", "cablerow", "triext", "pullup", "inclinebench"] },
  { name: "Deadlift",         items: ["deadlift", "frontsquat", "pulldown", "curl", "row"] },
  { name: "Squat+Bench Vol.", items: ["squat", "bench", "bsplit", "curl", "lateralraise"] },
];
const ROT = ROTATION.length;
const PATTERN_FREQ = (() => {
  const f = {};
  ROTATION.forEach((d) => d.items.forEach((k) => {
    if (LIB[k].role === "main" || LIB[k].fixedSets) return;
    const p = LIB[k].pattern; f[p] = (f[p] || 0) + 1;
  }));
  return f;
})();
/* ---- fixedSets accessories still shrink with block volume tier + readiness ---- */
const VOL_SCALE = { ramp: 1, mev: 0.75, half: 0.5 };

/* ---- block configurations ---- */
const BLOCKS = {
  accumulation: {
    label: "Accumulation", emphasis: "volume",
    mainReps: { squat: 5, bench: 5, deadlift: 4 }, mainSets: 4,
    rpeBase: 7.0, rpeStep: 0.4, rpeCap: 8.5,
    backoffDrop: 0.06, backoffRpeCap: 8,
    accReps: [8, 12], accRpe: 8, volLevel: "ramp",
    minCycles: 3, maxCycles: 6,
  },
  intensification: {
    label: "Intensification", emphasis: "intensity",
    mainReps: { squat: 3, bench: 3, deadlift: 2 }, mainSets: 4,
    rpeBase: 8.5, rpeStep: 0.3, rpeCap: 9.5,
    backoffDrop: 0.08, backoffRpeCap: 8.5,
    accReps: [6, 10], accRpe: 8, volLevel: "mev",
    minCycles: 2, maxCycles: 4,
  },
  deload: {
    label: "Deload", emphasis: "recovery",
    mainReps: { squat: 4, bench: 4, deadlift: 3 }, mainSets: 2,
    rpeBase: 6, rpeStep: 0, rpeCap: 6,
    backoffDrop: 0.1, backoffRpeCap: 6,
    accReps: [8, 10], accRpe: 6, volLevel: "half",
    minCycles: 1, maxCycles: 1,
  },
  realization: {
    label: "Re-test", emphasis: "test",
    mainReps: { squat: 2, bench: 2, deadlift: 1 }, mainSets: 1,
    rpeBase: 9, rpeStep: 0.5, rpeCap: 9.5,
    backoffDrop: 0, backoffRpeCap: 9,
    accReps: [8, 10], accRpe: 6, volLevel: "half",
    minCycles: 1, maxCycles: 1,
  },
};

function weeklyTarget(pattern, blockType, cycleInBlock, landmarks) {
  const lm = landmarks[pattern];
  const cfg = BLOCKS[blockType];
  if (cfg.volLevel === "half") return Math.round(lm.mev * 0.5);
  if (cfg.volLevel === "mev") return lm.mev;
  const span = Math.max(1, cfg.maxCycles - 1);
  const frac = Math.min(1, cycleInBlock / span);
  return Math.round(lm.mev + (lm.mrv - lm.mev) * frac);
}

/* ---- readiness score (0–1) from Garmin Training Readiness Score ---- */
function readinessScore(r) {
  return Math.max(0, Math.min(1, r.trainingReadiness / 100));
}
const readinessBand = (s) => (s >= 0.60 ? "green" : s >= 0.40 ? "amber" : "red");

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

  const items = day.items.map((key) => {
    const L = LIB[key];
    const lift = program.lifts[key];
    const isMain = L.role === "main";
    const reps = isMain ? (cfg.mainReps[key] || 4) : Math.round((cfg.accReps[0] + cfg.accReps[1]) / 2);
    const rpe = isMain ? rpeTop : clampRpe(cfg.accRpe + rpeAdj);

    let sets;
    if (isMain) sets = Math.max(1, Math.round(cfg.mainSets * setMult));
    else if (L.fixedSets) sets = Math.max(1, Math.round(L.fixedSets * VOL_SCALE[cfg.volLevel] * setMult));
    else {
      const wk = weeklyTarget(L.pattern, program.block.type, cyc, program.landmarks);
      const freq = PATTERN_FREQ[L.pattern] || 1;
      const rawSets = Math.round((wk / freq) * setMult);
      sets = Math.max(1, Math.min(4, rawSets));
    }

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

    return { key, label: L.label, barbell: L.barbell, isMain, pattern: L.pattern,
      bodyweight: !!L.bodyweight, assistanceNeeded, repOnly,
      reps, rpe, sets, topLoad, backoffLoad, backoffRpeCap: cfg.backoffRpeCap };
  });

  return { dayName: day.name, block: cfg.label, cycle: cyc, rpeTop, band, items };
}

/* ════════════ INGEST + STATE MACHINE ════════════ */
function ingest(program, logs, readiness) {
  const next = structuredClone(program);

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
  });

  const rScore = readinessScore(readiness);

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

  const slopes = ["squat", "bench", "deadlift"].map((k) => {
    const h = (next.lifts[k].hist || []).map((p) => p.e);
    const base = next.lifts[k].e1rm || 1;
    return slope(h.slice(-8)) / base;
  });
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
      transition = { to: next.block.nextAfter || "intensification", reason: "deload complete — fatigue dissipated" };
    } else if (t === "realization") {
      transition = { to: "accumulation", reason: "maxes re-tested — new accumulation block" };
    }
  }

  return { next, transition, fatigueIndex, rScore, e1rmSlope };
}

function applyTransition(program, transition) {
  const next = structuredClone(program);
  next.block = {
    type: transition.to, cycle: 0, sessionsInBlock: 0,
    nextAfter: transition.nextAfter || (transition.to === "deload" ? next.block.nextAfter : null),
  };
  if (transition.to === "accumulation")
    next.fatigue = { index: 0, rpeCreep: 0, readSupp: next.fatigue.readSupp, missFreq: 0, slope: 0 };
  next.blockHistory = [...(next.blockHistory || []), { type: transition.to, at: Date.now(), reason: transition.reason }];
  return next;
}

function freshProgram({ seeds, landmarks, unit, goal, bodyweight }) {
  const lifts = {};
  Object.keys(LIB).forEach((k) => {
    let e1rm;
    if (LIB[k].bodyweight) {
      e1rm = seeds[k] ? e1rmFromBW(bodyweight, seeds[k].weight, seeds[k].reps, seeds[k].rpe) : bodyweight;
    } else if (seeds[k]) {
      e1rm = e1rmFrom(seeds[k].weight, seeds[k].reps, seeds[k].rpe);
    } else {
      const ref = { rdl: "deadlift", frontsquat: "squat", legpress: "squat", ohp: "bench",
        row: "bench", cablerow: "bench", pulldown: "bench", curl: "bench", bsplit: "squat",
        triext: "bench", lateralraise: "bench", calfraise: "squat", inclinebench: "bench" }[k];
      const base = seeds[ref] ? e1rmFrom(seeds[ref].weight, seeds[ref].reps, seeds[ref].rpe) : 100;
      const mult = { rdl: 0.85, frontsquat: 0.8, legpress: 1.6, ohp: 0.62, row: 0.75,
        cablerow: 0.75, pulldown: 0.7, curl: 0.35, bsplit: 0.4,
        triext: 0.45, lateralraise: 0.12, calfraise: 1.2, inclinebench: 0.55 }[k] || 0.6;
      e1rm = base * mult;
    }
    lifts[k] = { e1rm, e1rmRaw: e1rm, hist: [{ e: Math.round(e1rm), raw: Math.round(e1rm) }], pattern: LIB[k].pattern };
  });
  return {
    unit, goal, landmarks, lifts, bodyweight,
    cycleIndex: 0, sessionCount: 0,
    fatigue: { index: 0, rpeCreep: 0, readSupp: 0, missFreq: 0, slope: 0 },
    block: { type: "accumulation", cycle: 0, sessionsInBlock: 0, nextAfter: null },
    blockHistory: [{ type: "accumulation", at: Date.now(), reason: "program start" }],
  };
}

/* ════════════ COACH (Sonnet): narration + borderline tie-break only ════════════ */
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
    return { ok: false, note: "Coach offline — deterministic engine applied.", confirmTransition: true, override: null };
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
function Barbell({ weight }) {
  const side = platesForSide(weight);
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

function Onboarding({ onDone }) {
  const [step, setStep] = useState(0);
  const [bodyweight, setBodyweight] = useState(180);
  const [seeds, setSeeds] = useState({
    squat: { weight: 225, reps: 5, rpe: 8 }, bench: { weight: 155, reps: 5, rpe: 8 }, deadlift: { weight: 275, reps: 5, rpe: 8 },
  });
  const [landmarks, setLandmarks] = useState(() => structuredClone(PATTERNS));
  const setSeed = (k, f, v) => setSeeds((s) => ({ ...s, [k]: { ...s[k], [f]: v } }));
  const setLM = (p, f, v) => setLandmarks((l) => ({ ...l, [p]: { ...l[p], [f]: v } }));

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
      <button className="cta" onClick={() => setStep(1)}>Next — volume landmarks</button>
    </div>
  );

  return (
    <div className="screen">
      <div className="eyebrow">SETUP · 2 OF 2</div>
      <h1 className="display sm">Volume landmarks.</h1>
      <p className="lede">Weekly hard sets per movement pattern: MEV (minimum effective), MAV (where most growth happens), MRV (most you can recover from). Defaults are research-based starting points — edit to your experience. Accessory volume ramps MEV→MRV across each accumulation block.</p>
      {Object.entries(landmarks).map(([p, lm]) => (
        <div key={p} className="panel">
          <div className="exer-name" style={{ fontSize: 17, padding: "10px 0 6px" }}>{lm.label}</div>
          <label className="fieldrow sm"><span>MEV</span><Stepper value={lm.mev} set={(v) => setLM(p, "mev", v)} min={2} max={40} w={40} /></label>
          <label className="fieldrow sm"><span>MAV</span><Stepper value={lm.mav} set={(v) => setLM(p, "mav", v)} min={2} max={40} w={40} /></label>
          <label className="fieldrow sm"><span>MRV</span><Stepper value={lm.mrv} set={(v) => setLM(p, "mrv", v)} min={2} max={40} w={40} /></label>
        </div>
      ))}
      <button className="cta" onClick={() => onDone(freshProgram({ seeds, landmarks, unit: "lb", goal: "hybrid", bodyweight }))}>Start program</button>
    </div>
  );
}

function ExerciseCard({ it, log, update }) {
  const [open, setOpen] = useState(it.isMain);
  const bwScheme = it.assistanceNeeded ? "assistance needed" : it.repOnly ? "bodyweight only"
    : `BW${it.topLoad >= 0 ? "+" : ""}${it.topLoad} lb`;
  return (
    <div className="exer">
      <div className="exer-head" onClick={() => setOpen(!open)}>
        <div>
          <div className="exer-name">{it.label}{it.isMain && <span className="tag">MAIN</span>}</div>
          <div className="exer-scheme mono">{it.sets} × {it.reps} @ RPE {it.rpe} · {it.bodyweight ? bwScheme : `${it.topLoad} lb`}{it.isMain && it.sets > 1 ? `  ·  back-off ${it.backoffLoad}` : ""}</div>
        </div>
        {open ? <ChevronDown size={17} color="#8A909C" /> : <ChevronRight size={17} color="#8A909C" />}
      </div>
      {it.barbell && <div className="bar-wrap"><Barbell weight={log.topWeight} /></div>}
      {open && (
        <div className="exer-body">
          <label className="fieldrow sm"><span>{it.bodyweight ? "Added / assist weight" : "Top-set weight"}</span><Stepper value={log.topWeight} set={(v) => update({ topWeight: v })} min={it.bodyweight ? -200 : 0} step={5} suffix=" lb" /></label>
          <label className="fieldrow sm"><span>Top-set reps</span><Stepper value={log.topReps} set={(v) => update({ topReps: v })} min={1} max={15} /></label>
          <label className="fieldrow sm"><span>Top-set RPE</span><Stepper value={log.topRpe} set={(v) => update({ topRpe: v })} min={5} max={10} step={0.5} /></label>
          <label className="fieldrow sm"><span>Sets missed (reps short)</span><Stepper value={log.missedSets} set={(v) => update({ missedSets: v })} min={0} max={it.sets} /></label>
          {it.bodyweight && <div className="est mono">negative = assistance used</div>}
          {Math.abs(log.topRpe - it.rpe) >= 1 && (
            <div className="warn mono">{log.topRpe > it.rpe ? "harder than target — engine notes fatigue" : "easier than target — e1RM will rise"}</div>
          )}
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

function Today({ program, sessions, onLog }) {
  const [readiness, setReadiness] = useState({ trainingReadiness: 65 });
  const rx = useMemo(() => prescribe(program, readiness), [program, readiness]);
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLogs(rx.items.map((it) => ({ key: it.key, topWeight: it.topLoad, topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe, missedSets: 0, sets: it.sets })));
    // eslint-disable-next-line
  }, [program.sessionCount]);

  useEffect(() => {
    setLogs((L) => L.map((l, i) => (l && l._touched ? l : rx.items[i] ? { key: rx.items[i].key, topWeight: rx.items[i].topLoad, topReps: rx.items[i].reps, topRpe: rx.items[i].rpe, targetRpe: rx.items[i].rpe, missedSets: 0, sets: rx.items[i].sets } : l)));
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
        <div className={"coach " + (program.block.type === "deload" ? "coach-alert" : "")}>
          <div className="coach-top mono">{program.block.type === "deload" ? <AlertTriangle size={12} /> : <Check size={12} />} COACH</div>
          <p>{program.lastCoach}</p>
        </div>
      )}

      {rx.items.map((it, i) => logs[i] && <ExerciseCard key={it.key + i} it={it} log={logs[i]} update={(p) => upd(i, p)} />)}

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
          <div className="hist-lifts mono">{s.logs.map((l) => `${LIB[l.key]?.label.split(" ")[0]} ${l.topWeight}×${l.topReps}@${l.topRpe}`).join("  ·  ")}</div>
          {s.transition && <div className="hist-trans mono">→ {BLOCKS[s.transition]?.label || s.transition}</div>}
          {s.coach && <div className="hist-coach">{s.coach}</div>}
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

  useEffect(() => { (async () => {
    const p = await loadKey(K_PROGRAM); const s = await loadKey(K_SESSIONS);
    if (p) setProgram(p); if (s) setSessions(s); setReady(true);
  })(); }, []);

  const start = async (p) => { setProgram(p); await saveKey(K_PROGRAM, p); };

  const handleLog = async (logs, readiness, rx) => {
    const { next, transition, fatigueIndex, e1rmSlope, rScore } = ingest(program, logs, readiness);
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
      else if (coach.ok && coach.override && coach.override !== "null" && BLOCKS[coach.override]) t = { ...transition, to: coach.override };
      if (t) { finalProgram = applyTransition(next, t); appliedTransition = t.to; }
    }
    finalProgram.lastCoach = coach.note;

    const record = {
      date: Date.now(), block: rx.block, dayName: rx.dayName,
      logs: logs.map((l) => ({ key: l.key, topWeight: l.topWeight, topReps: l.topReps, topRpe: l.topRpe, missedSets: l.missedSets })),
      readiness, coach: coach.note, transition: appliedTransition,
    };
    const newSessions = [...sessions, record];
    setProgram(finalProgram); setSessions(newSessions);
    await saveKey(K_PROGRAM, finalProgram); await saveKey(K_SESSIONS, newSessions);
    setTab("today");
  };

  const reset = async () => {
    await saveKey(K_PROGRAM, null); await saveKey(K_SESSIONS, []);
    setProgram(null); setSessions([]); setTab("today"); setConfirmingReset(false); setShowSettings(false);
  };

  const setBodyweight = async (v) => {
    const next = { ...program, bodyweight: v };
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
                <label className="fieldrow sm"><span>Bodyweight</span><Stepper value={program.bodyweight || 180} set={setBodyweight} min={80} max={400} step={1} suffix=" lb" /></label>
              </div>
              <div className="est mono" style={{ padding: "0 0 14px" }}>Drives system-load math for Pull-Up / Chin-Up.</div>
              {!confirmingReset ? (
                <div style={{ display: "flex", gap: 10 }}>
                  <button className="cta" style={{ margin: 0, background: "#D7443E", color: "#2A0907" }} onClick={() => setConfirmingReset(true)}>Reset everything</button>
                  <button className="cta" style={{ margin: 0, background: "var(--surface2)", color: "var(--text)" }} onClick={() => setShowSettings(false)}>Done</button>
                </div>
              ) : (
                <div className="panel" style={{ padding: 16 }}>
                  <p style={{ margin: "4px 0 14px", fontSize: 13.5, lineHeight: 1.5, color: "var(--text)" }}>
                    Reset the program and all logged history? This cannot be undone.
                  </p>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button className="cta" style={{ margin: 0, background: "#D7443E", color: "#2A0907" }} onClick={reset}>Confirm reset</button>
                    <button className="cta" style={{ margin: 0, background: "var(--surface2)", color: "var(--text)" }} onClick={() => setConfirmingReset(false)}>Cancel</button>
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
.ghost{background:none;border:none;color:var(--dim);cursor:pointer;padding:4px;}
.screen{padding:18px 18px 8px;}
.eyebrow{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.16em;color:var(--dim);margin-bottom:8px;}
.eyebrow.mt{margin-top:24px;}
.display{font-family:'Saira Condensed',sans-serif;font-weight:700;letter-spacing:-.01em;line-height:.95;font-size:42px;margin:0 0 12px;}
.display.sm{font-size:32px;}
.lede{color:var(--dim);font-size:13.5px;line-height:1.5;margin:0 0 18px;}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:4px 14px;margin-bottom:8px;}
.fieldrow{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--line);font-size:14px;}
.panel .fieldrow:last-child{border-bottom:none;}
.fieldrow.sm{padding:10px 0;font-size:13px;}
.est{font-size:11.5px;color:var(--dim);padding:2px 0 10px;}
.stepper{display:flex;align-items:center;gap:9px;}
.stepper button{width:29px;height:29px;border-radius:8px;border:1px solid var(--line);background:var(--surface2);color:var(--text);display:flex;align-items:center;justify-content:center;cursor:pointer;}
.stepper button:active{background:var(--line);}
.stepper .mono{text-align:center;font-size:14.5px;font-weight:500;}
.seg{display:flex;gap:6px;background:var(--surface);border:1px solid var(--line);border-radius:11px;padding:4px;margin-bottom:6px;}
.seg.sm{margin:0;padding:3px;}
.seg button{flex:1;padding:8px 4px;border:none;border-radius:8px;background:none;color:var(--dim);font-size:11.5px;font-weight:500;cursor:pointer;font-family:inherit;}
.seg-on{background:var(--surface2)!important;color:var(--text)!important;}
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
.warn{color:#E8C547;font-size:11px;padding-top:8px;}
.coach{background:var(--surface);border:1px solid var(--line);border-left:3px solid #3FA85F;border-radius:11px;padding:11px 13px;margin-bottom:16px;}
.coach-alert{border-left-color:#D7443E;}
.coach-top{display:flex;align-items:center;gap:6px;font-size:10.5px;letter-spacing:.12em;color:var(--dim);margin-bottom:6px;}
.coach p{margin:0;font-size:13px;line-height:1.45;}
.readout{font-size:11.5px;text-align:center;padding:6px 0 0;}
.gauge{margin:10px 0;}
.gauge-label{font-size:10.5px;letter-spacing:.08em;color:var(--dim);margin-bottom:5px;}
.gauge-bar{height:7px;background:var(--surface2);border-radius:4px;overflow:hidden;}
.gauge-fill{height:100%;border-radius:4px;transition:width .3s;}
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
.hist-coach{font-size:11.5px;color:var(--dim);margin-top:7px;line-height:1.4;font-style:italic;}
.empty{color:var(--dim);font-size:14px;line-height:1.6;padding:40px 6px;text-align:center;}
.tabs{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:460px;display:flex;
  background:rgba(18,20,25,.95);backdrop-filter:blur(10px);border-top:1px solid var(--line);z-index:5;}
.tabs button{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 0 13px;background:none;border:none;color:var(--dim);cursor:pointer;font-family:inherit;font-size:10.5px;}
.tab-on{color:var(--text)!important;}
@media (prefers-reduced-motion:reduce){*{transition:none!important;}}
`;
