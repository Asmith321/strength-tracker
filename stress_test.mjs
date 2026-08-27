/* ============================================================================
   Engine stress-test / fuzz harness.       Run with:  node stress_test.mjs
   Read-only: drives the REAL freshProgram()/prescribe()/ingest()/applyTransition()
   from src/engine.js (no mocks) through a long randomized training history plus
   deliberately injected edge cases, and asserts a battery of invariants after
   every step. Any violation is recorded with the seed + session number + inputs
   so it is exactly reproducible.

   src/engine.js is plain JS (no JSX, no React) so it imports directly with no
   bundling step — nothing here mutates the engine source.
   ============================================================================ */
import {
  weeklyFreqScale, effectiveGapDays,
  freshProgram, ingest, prescribe, applyTransition,
  platesForSide, rpePct, LIB, ROTATION, BLOCKS,
} from "./src/engine.js";

const ROT = ROTATION.length;
const DAY = 86400000;

/* ---- deterministic PRNG (mulberry32) so every run is reproducible ---- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randint = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

/* ---- clock control: ingest()/applyTransition() call the global Date.now() ---- */
const RealNow = Date.now;
let CLOCK = RealNow();
function useSimClock() { Date.now = () => CLOCK; }
function restoreClock() { Date.now = RealNow; }

/* ---- plate validity: a barbell weight is valid iff it's an empty bar OR the
   greedy plate decomposition leaves no remainder (bar + 2*sum(plates)) ---- */
function plateValid(weight, bar) {
  if (weight <= bar) return true;                     // empty bar
  const side = platesForSide(weight, bar);
  const total = bar + 2 * side.reduce((s, p) => s + p.w, 0);
  return Math.abs(total - weight) < 0.01;
}

/* ---- violation collector ---- */
function makeReport(label, seed) {
  const byCode = new Map();
  return {
    label, seed, count: 0,
    add(code, session, detail) {
      this.count++;
      if (!byCode.has(code)) byCode.set(code, { n: 0, samples: [] });
      const e = byCode.get(code);
      e.n++;
      if (e.samples.length < 6) e.samples.push({ session, detail });
    },
    byCode,
  };
}
function isNum(x) { return typeof x === "number"; }
function bad(x) { return !isNum(x) || Number.isNaN(x) || !Number.isFinite(x); }

/* Recursively scan an object for any NaN / Infinity number (never valid anywhere). */
function scanNonFinite(obj, path, out) {
  if (obj == null) return;
  if (isNum(obj)) { if (Number.isNaN(obj) || !Number.isFinite(obj)) out.push(path); return; }
  if (Array.isArray(obj)) { obj.forEach((v, i) => scanNonFinite(v, `${path}[${i}]`, out)); return; }
  if (typeof obj === "object") { for (const k of Object.keys(obj)) scanNonFinite(obj[k], `${path}.${k}`, out); }
}

/* ---- expected warmup tier from %1RM (mirrors prescribe()'s own rule), used
   as an independent black-box check rather than trusting the engine's label.
   The "earlier exercise already primed this muscle" reduction can only ever
   drop the tier ONE step below the %1RM-driven base tier, never more — so
   the valid set for a given %1RM is {baseTier, oneStepDown(baseTier)}. ---- */
const TIER_ORDER = ["full", "short", "minimal"];
const RAMP_LEN = { full: 4, short: 2, minimal: 1 };
function tierFromPct(pct1rm) { return pct1rm >= 0.85 ? "full" : pct1rm >= 0.70 ? "short" : "minimal"; }
function oneStepDown(tier) { return TIER_ORDER[Math.min(TIER_ORDER.indexOf(tier) + 1, TIER_ORDER.length - 1)]; }

/* ============================ INVARIANT CHECKS ============================ */
function checkPrescribe(rep, session, program, rx) {
  const bar = program.barWeight || 45;
  const phase = program.block.type;

  for (const it of rx.items) {
    const tag = `${it.key}@${phase}`;
    // sets > 0
    if (!isNum(it.sets) || it.sets <= 0 || !Number.isInteger(it.sets))
      rep.add("sets<=0", session, `${tag} sets=${it.sets}`);
    // reps sane
    if (bad(it.reps) || it.reps <= 0) rep.add("reps-bad", session, `${tag} reps=${it.reps}`);
    // rpe sane (clampRpe keeps 6..10)
    if (bad(it.rpe) || it.rpe < 6 || it.rpe > 10) rep.add("rpe-out-of-range", session, `${tag} rpe=${it.rpe}`);
    /* topLoad finite, and non-negative EXCEPT on an assisted bodyweight lift,
       where a negative value is the prescribed assistance magnitude (see the
       bodyweight branch in prescribe — it used to discard this and emit 0). */
    if (bad(it.topLoad) || (it.topLoad < 0 && !(it.bodyweight && it.assistanceNeeded)))
      rep.add("topLoad-bad", session, `${tag} topLoad=${it.topLoad}`);
    /* Same exemption as topLoad: for accessories backoffLoad is just an echo of
       topLoad (a distinct backoff weight is only meaningful for mains), so an
       assisted bodyweight lift carries the same negative assistance magnitude. */
    if (bad(it.backoffLoad) || (it.backoffLoad < 0 && !(it.bodyweight && it.assistanceNeeded)))
      rep.add("backoffLoad-bad", session, `${tag} backoffLoad=${it.backoffLoad}`);
    // every exercise is straight sets now: topSetCount === sets, backoffSetCount === 0
    if (it.topSetCount + it.backoffSetCount !== it.sets)
      rep.add("set-split-mismatch", session, `${tag} top=${it.topSetCount} backoff=${it.backoffSetCount} sets=${it.sets}`);

    // barbell load must resolve to a valid plate combination
    if (it.barbell) {
      if (!plateValid(it.topLoad, bar)) rep.add("bad-plate-topLoad", session, `${tag} topLoad=${it.topLoad} bar=${bar}`);
      if (!plateValid(it.backoffLoad, bar)) rep.add("bad-plate-backoff", session, `${tag} backoffLoad=${it.backoffLoad} bar=${bar}`);
    }

    // pull-up / bodyweight fallback must be coherent
    if (it.bodyweight) {
      // repOnly means literally unloaded; assisted means a negative (assistance) load
      if (it.repOnly && it.topLoad !== 0)
        rep.add("pullup-fallback-load", session, `${tag} repOnly topLoad=${it.topLoad}`);
      if (it.assistanceNeeded && !(it.topLoad < 0))
        rep.add("pullup-assist-no-magnitude", session, `${tag} assist topLoad=${it.topLoad} (expected negative)`);
      if (bad(it.topLoad)) rep.add("pullup-nan", session, `${tag} topLoad=${it.topLoad}`);
      /* PLAUSIBILITY (the gap that let the unguarded-bodyweight bug through):
         system load = bodyweight + added can never exceed the lift's own e1RM,
         since load = e1rm * pct and pct <= 1. Without this, a lost/zeroed
         bodyweight prescribed the entire system load as ADDED belt weight and
         nothing caught it — every existing check passed. */
      const bw = program.bodyweight;
      const e1 = program.lifts[it.key]?.e1rm;
      if (bw > 0 && e1 > 0 && it.topLoad > 0 && bw + it.topLoad > e1 * 1.001)
        rep.add("pullup-system-load-exceeds-e1rm", session,
          `${tag} bw=${bw} + added=${it.topLoad} = ${bw + it.topLoad} > e1rm=${e1.toFixed(1)}`);
    }

    // warmup ramp checks
    if (it.warmup) {
      const w = it.warmup;
      const wsets = w.sets || [];
      if (w.type !== "feeler") {
        /* Ramp array must never be LONGER than its tier, and must be non-empty.
           It may be SHORTER: steps are floored at the bar and deduped, so a
           light top set legitimately yields fewer loadable steps than the tier
           nominally specifies (see buildRamp). Relabelling to a shorter tier
           isn't possible in general — collapsing can leave 3 steps and the
           tiers are 4/2/1 — so the label describes the tier the %1RM earned
           and the array describes what's actually loadable. */
        if (wsets.length === 0 || wsets.length > RAMP_LEN[w.type])
          rep.add("ramp-length-mismatch", session, `${tag} type=${w.type} len=${wsets.length} allowed=1..${RAMP_LEN[w.type]}`);
        // tier must be driven by %1RM (not block phase): either the base tier
        // for this top set's %1RM, or exactly one step down from it (the
        // earlier-primed reduction) — never higher, never more than one step lower.
        // AUDIT 2.9 exception: the day's first barbell lift gets one step UP
        // from "minimal" to "short" (never opens cold on a single warmup set).
        const pct1rm = rpePct(it.reps, it.rpe);
        const baseTier = tierFromPct(pct1rm);
        const allowed = new Set([baseTier, oneStepDown(baseTier)]);
        const itIdx = rx.items.indexOf(it);
        const isFirstBarbell = it.barbell && !rx.items.slice(0, itIdx).some((o) => o.barbell);
        if (isFirstBarbell && baseTier === "minimal") allowed.add("short");
        if (!allowed.has(w.type))
          rep.add("ramp-tier-mismatch", session, `${tag} pct1rm=${(pct1rm * 100).toFixed(1)}% baseTier=${baseTier} actualType=${w.type}`);
      }
      let prev = -Infinity;
      for (const s of wsets) {
        if (bad(s.weight) || s.weight < 0) rep.add("warmup-weight-bad", session, `${tag} w=${s.weight}`);
        if (bad(s.reps) || s.reps <= 0) rep.add("warmup-reps-bad", session, `${tag} reps=${s.reps}`);
        if (s.weight >= it.topLoad && it.topLoad > 0) {
          const code = w.type === "feeler" ? "feeler>=topLoad" : "RAMP-warmup>=topLoad";
          rep.add(code, session, `${tag} type=${w.type} barbell=${it.barbell} warm=${s.weight} top=${it.topLoad}`);
        }
        if (s.weight < prev) rep.add("warmup-not-ascending", session, `${tag} ${prev}->${s.weight}`);
        prev = s.weight;
        if (it.barbell && !plateValid(s.weight, bar)) rep.add("bad-plate-warmup", session, `${tag} warm=${s.weight} bar=${bar}`);
        /* A barbell warmup step below the bar isn't loadable. plateValid alone
           can't catch this — it short-circuits `weight <= bar` to true as
           "empty bar", so sub-bar steps passed silently before buildRamp
           started flooring them. */
        if (it.barbell && s.weight < bar)
          rep.add("warmup-below-bar", session, `${tag} warm=${s.weight} bar=${bar} top=${it.topLoad}`);
      }
    }
  }
}

function checkProgram(rep, session, program, tag) {
  // NaN / Infinity anywhere
  const nf = [];
  scanNonFinite(program, `${tag}`, nf);
  for (const p of nf.slice(0, 3)) rep.add("non-finite-value", session, p);

  // e1RM positivity / finiteness
  for (const k of Object.keys(program.lifts)) {
    const L = program.lifts[k];
    if (bad(L.e1rm) || L.e1rm <= 0) rep.add("e1rm-nonpositive", session, `${k} e1rm=${L.e1rm}`);
    if (bad(L.e1rmRaw) || L.e1rmRaw <= 0) rep.add("e1rmRaw-nonpositive", session, `${k} e1rmRaw=${L.e1rmRaw}`);
    if (L.best != null && (bad(L.best) || L.best <= 0)) rep.add("best-nonpositive", session, `${k} best=${L.best}`);
    for (const h of (L.hist || [])) {
      if (bad(h.e) || h.e <= 0 || bad(h.raw) || h.raw <= 0) rep.add("hist-nonpositive", session, `${k} hist e=${h.e} raw=${h.raw}`);
    }
  }

  // fatigue bounds
  const f = program.fatigue;
  if (bad(f.index) || f.index < 0 || f.index > 1) rep.add("fatigue-index-out-of-bounds", session, `index=${f.index}`);
  if (bad(f.rpeCreep) || f.rpeCreep < 0) rep.add("fatigue-rpeCreep-neg", session, `rpeCreep=${f.rpeCreep}`);
  if (bad(f.readSupp) || f.readSupp < 0) rep.add("fatigue-readSupp-neg", session, `readSupp=${f.readSupp}`);
  if (bad(f.missFreq) || f.missFreq < 0) rep.add("fatigue-missFreq-neg", session, `missFreq=${f.missFreq}`);
  if (bad(f.slope)) rep.add("fatigue-slope-nan", session, `slope=${f.slope}`);

  // landmark sanity, every pattern
  for (const p of Object.keys(program.landmarks)) {
    const lm = program.landmarks[p];
    if (bad(lm.mev) || bad(lm.mav) || bad(lm.mrv)) rep.add("landmark-nan", session, `${p} ${JSON.stringify(lm)}`);
    if (!(lm.mev < lm.mrv)) rep.add("MEV>=MRV", session, `${p} mev=${lm.mev} mrv=${lm.mrv}`);
    if (lm.mev < 2) rep.add("MEV<2", session, `${p} mev=${lm.mev}`);
    if (!(lm.mev <= lm.mav && lm.mav <= lm.mrv)) rep.add("MAV-out-of-order", session, `${p} ${lm.mev}/${lm.mav}/${lm.mrv}`);
  }

  // structural counters
  if (bad(program.block.cycle) || program.block.cycle < 0) rep.add("block-cycle-bad", session, `${program.block.cycle}`);
  if (bad(program.block.sessionsInBlock) || program.block.sessionsInBlock < 0) rep.add("sessionsInBlock-bad", session, `${program.block.sessionsInBlock}`);
  if (bad(program.bodyweight) || program.bodyweight <= 0) rep.add("bodyweight-bad", session, `${program.bodyweight}`);
}

/* ============================ LOG GENERATION ============================ */
function makeLog(rng, it, program, session, forces) {
  // performed reps: usually prescribed, occasionally short
  let topReps = it.reps;
  if (rng() < 0.18) topReps = Math.max(1, it.reps - randint(rng, 1, 3)); // missed reps
  // performed RPE: centered near target, slight easy bias, occasional grind bias
  let topRpe = it.rpe + (rng() - 0.55) * 1.0;
  if (rng() < 0.10) topRpe += randint(rng, 1, 2);   // much harder than target (bias/noise)
  if (rng() < 0.06) topRpe -= randint(rng, 1, 2);   // much easier
  topRpe = Math.max(5, Math.min(10, Math.round(topRpe * 2) / 2));
  // missed sets
  let missedSets = 0;
  if (rng() < 0.15) missedSets = randint(rng, 1, it.sets);

  // weight
  let topWeight;
  if (it.bodyweight) {
    if (it.assistanceNeeded) topWeight = -randint(rng, 15, 70);   // band/machine assistance (negative added)
    else if (it.repOnly) topWeight = 0;
    else topWeight = it.topLoad;                                   // added weight
  } else {
    topWeight = it.topLoad;
  }

  // ---- forced overrides for injected scenarios ----
  // freeze the compound (multi-joint) lifts -> flat e1RM. Was keyed on isMain
  // before the hypertrophy rebuild removed main lifts; compounds are what the
  // e1RM trend and the fatigue channel now read, so they are what must freeze.
  if (forces.plateau && it.repTier === "compound") { topReps = it.reps; topRpe = it.rpe; topWeight = it.topLoad; }
  if (forces.forceNegPullup && it.key === "pullup") topWeight = -randint(rng, 30, 90);             // force assistance path

  return { key: it.key, topWeight, topReps, topRpe, targetRpe: it.rpe, missedSets,
    backoffSetCount: it.backoffSetCount || 0, backoffReps: it.reps, backoffRpe: it.rpe };
}

/* ============================ THE LONGITUDINAL SIM ============================ */
const SEEDS = {
  beginner:     { squat: { weight: 135, reps: 5, rpe: 8 }, bench: { weight: 95,  reps: 5, rpe: 8 }, rdl: { weight: 115, reps: 8, rpe: 8 }, tbarrow: { weight: 80,  reps: 8, rpe: 8 } },
  intermediate: { squat: { weight: 275, reps: 5, rpe: 8 }, bench: { weight: 185, reps: 5, rpe: 8 }, rdl: { weight: 225, reps: 8, rpe: 8 }, tbarrow: { weight: 155, reps: 8, rpe: 8 } },
  advanced:     { squat: { weight: 425, reps: 3, rpe: 8 }, bench: { weight: 315, reps: 3, rpe: 8 }, rdl: { weight: 350, reps: 8, rpe: 8 }, tbarrow: { weight: 245, reps: 8, rpe: 8 } },
};
const START_BW = { beginner: 160, intermediate: 185, advanced: 215 };

function runLongSim(tier, seed, N = 450) {
  const rng = mulberry32(seed);
  const rep = makeReport(`long/${tier}`, seed);
  useSimClock();
  CLOCK = Date.UTC(2024, 0, 1);

  let program;
  try {
    program = freshProgram({ seeds: SEEDS[tier], experience: tier, unit: "lb", goal: "hypertrophy", bodyweight: START_BW[tier] });
  } catch (e) { rep.add("freshProgram-crash", 0, e.message); restoreClock(); return { rep }; }
  program.barWeight = 45;

  // landmark range tracking
  const lmRange = {};
  for (const p of Object.keys(program.landmarks)) lmRange[p] = { mev: [Infinity, -Infinity], mrv: [Infinity, -Infinity], mav: [Infinity, -Infinity] };
  const noteLm = (prog) => { for (const p of Object.keys(prog.landmarks)) { const lm = prog.landmarks[p]; for (const f of ["mev", "mav", "mrv"]) { lmRange[p][f][0] = Math.min(lmRange[p][f][0], lm[f]); lmRange[p][f][1] = Math.max(lmRange[p][f][1], lm[f]); } } };
  noteLm(program);

  // block tracking
  const blockVisits = {};
  let curBlock = program.block.type, runLen = 0, maxRun = 0, maxRunBlock = curBlock;
  let transitions = 0;
  let sawAssist = false, sawRepOnly = false, sawNegPullupIngest = false, sawLongGap = false, sawSameDay = false;
  /* A gap longer than this is an absence rather than a cadence; the established
     rate must not move for this many sessions afterwards. 8 is the boundary,
     found by measurement rather than chosen: at this harness's ~2-day mean
     spacing that is ~16 days, so the layoff is still inside the estimator's
     21-day window and the rate genuinely must not have moved. Removing the
     engine's gap-awareness produces 16 violations here; the fixed build
     produces 0. Watching longer (10, 12) starts flagging the legitimate
     re-establishment of the rate once clean history rebuilds. */
  const LAYOFF_WATCH_DAYS = 5, LAYOFF_WATCH_SESSIONS = 8;
  let rateBeforeGap = null, gapWatch = 0;

  for (let s = 1; s <= N; s++) {
    // ---- advance clock (gaps + injected long gaps / same-day doubles) ----
    let gapDays;
    if (s === 1) gapDays = 0;
    else if ([50, 130, 260, 380].includes(s)) { gapDays = randint(rng, 14, 31); sawLongGap = true; }   // long layoffs
    else if ([70, 205, 340].includes(s)) { gapDays = 0; sawSameDay = true; }                            // same-day double log
    else gapDays = randint(rng, 1, 3);
    CLOCK += gapDays * DAY;

    // ---- bodyweight drift (loss then gain) ----
    if (s >= 80 && s <= 140) program.bodyweight = Math.max(120, program.bodyweight - 0.3);
    if (s >= 300 && s <= 360) program.bodyweight = program.bodyweight + 0.2;

    // ---- readiness (full range; sustained low stretch) ----
    let tr;
    if (s >= 120 && s <= 150) tr = randint(rng, 8, 32);          // sustained low readiness
    else tr = randint(rng, 20, 100);
    if (rng() < 0.05) tr = randint(rng, 0, 100);                 // full-range noise
    const readiness = { trainingReadiness: tr };

    const forces = {
      plateau: s >= 200 && s <= 245,                              // total e1RM plateau stretch
      forceNegPullup: (s >= 160 && s <= 175),                     // force pull-up assistance path
    };

    // ---- prescribe ----
    let rx;
    try { rx = prescribe(program, readiness); }
    catch (e) { rep.add("prescribe-crash", s, `${e.message} | block=${program.block.type} bw=${program.bodyweight}`); break; }
    checkPrescribe(rep, s, program, rx);
    /* VOLUME CONTINUITY — the invariant this harness was missing.
       It already injects 14-31 day layoffs at sessions 50/130/260/380 and
       same-day double-logs at 70/205/340: the exact inputs behind the worst
       bug this engine has shipped. It reported 0 violations through all of it,
       because every check here was about finiteness, bounds, plate validity
       and ordering — nothing asserted HOW MANY SETS were prescribed. Underneath
       that clean bill of health, one layoff was walking freqScale
       1.36 -> 1.80 and prescribing 44-set sessions against a normal 35.
       Session volume may rise when the block ramp advances, and it may fall for
       any reason. What it may never do is JUMP without the ramp advancing —
       that signature is a frequency-estimate error, and it is what the
       athlete actually feels. */
    /* AUDIT 3.7's PROPERTY, ASSERTED ON THE MECHANISM RATHER THAN THE OUTCOME.
       This harness already injects 14-31 day layoffs at sessions 50/130/260/380
       — the exact input behind the worst bug this engine has shipped — and
       reported 0 violations through all of them, because every check here was
       about finiteness, bounds, plate validity and ordering. Nothing watched
       the frequency estimate, so a layoff walking freqScale 1.36 -> 1.80 and
       prescribing 44-set sessions passed as healthy.

       WHY NOT ASSERT ON freqScale DIRECTLY. Tried first, and it measures this
       harness rather than the engine: sessions here are spaced by random 1-3
       day gaps, so freqScale legitimately oscillates between 1.0 and 1.25.
       Verified by counterfactual — running the identical seed with and without
       the injected gap produces the same oscillation, and at sessions 262-265
       the WITH-gap run is actually lower. There is no stable cadence here for a
       layoff to disturb, so any threshold is tuned to noise.

       The mechanism is testable without that confound. The established rate is
       only rewritten from a REPRESENTATIVE window, and a window containing a
       layoff is not representative — so a layoff must leave program
       .sessionsPerWeek untouched until clean history rebuilds. On the broken
       build the estimator had no such notion and the stored rate moved
       immediately. */
    if (gapDays > LAYOFF_WATCH_DAYS) { rateBeforeGap = program.sessionsPerWeek ?? null; gapWatch = LAYOFF_WATCH_SESSIONS; }
    if (gapWatch > 0) {
      if (rateBeforeGap != null && program.sessionsPerWeek !== rateBeforeGap)
        rep.add("layoff-moved-established-rate", s,
          `sessionsPerWeek ${rateBeforeGap} -> ${program.sessionsPerWeek} `
          + `(${LAYOFF_WATCH_SESSIONS - gapWatch + 1} sessions after a long gap)`);
      gapWatch--;
    }
    for (const it of rx.items) { if (it.assistanceNeeded) sawAssist = true; if (it.repOnly) sawRepOnly = true; }

    // ---- build logs & ingest ----
    const logs = rx.items.map((it) => makeLog(rng, it, program, s, forces));
    if (logs.some((l) => l.key === "pullup" && l.topWeight < 0)) sawNegPullupIngest = true;

    let r;
    try { r = ingest(program, logs, readiness); }
    catch (e) { rep.add("ingest-crash", s, `${e.message} | logs=${JSON.stringify(logs.slice(0, 2))}`); break; }
    checkProgram(rep, s, r.next, "next");
    if (bad(r.fatigueIndex) || r.fatigueIndex < 0 || r.fatigueIndex > 1) rep.add("returned-fatigueIndex-oob", s, `${r.fatigueIndex}`);
    if (bad(r.e1rmSlope)) rep.add("returned-e1rmSlope-nan", s, `${r.e1rmSlope}`);

    // ---- apply transition (offline coach -> always applied) ----
    let finalProgram = r.next;
    if (r.transition) {
      try { finalProgram = applyTransition(r.next, r.transition); }
      catch (e) { rep.add("applyTransition-crash", s, `${e.message} | ${JSON.stringify(r.transition)}`); break; }
      transitions++;
    }
    checkProgram(rep, s, finalProgram, "final");
    noteLm(finalProgram);

    // ---- block run-length tracking (infinite-loop detection) ----
    if (finalProgram.block.type === curBlock) runLen++;
    else { blockVisits[curBlock] = (blockVisits[curBlock] || 0) + 1; curBlock = finalProgram.block.type; runLen = 1; }
    if (runLen > maxRun) { maxRun = runLen; maxRunBlock = curBlock; }

    program = finalProgram;
  }
  blockVisits[curBlock] = (blockVisits[curBlock] || 0) + 1;

  restoreClock();
  return { rep, lmRange, blockVisits, transitions, maxRun, maxRunBlock,
    edge: { sawAssist, sawRepOnly, sawNegPullupIngest, sawLongGap, sawSameDay },
    finalLandmarks: program.landmarks, sessions: N };
}

/* ====== targeted: sustained monotonic strong growth to probe MRV drift ceiling ====== */
function runMonotonicGrowth(tier, seed, N = 500) {
  const rng = mulberry32(seed);
  const rep = makeReport(`growth/${tier}`, seed);
  useSimClock();
  CLOCK = Date.UTC(2024, 0, 1);
  let program = freshProgram({ seeds: SEEDS[tier], experience: tier, unit: "lb", goal: "hypertrophy", bodyweight: START_BW[tier] });
  program.barWeight = 45;
  const lmRange = {};
  for (const p of Object.keys(program.landmarks)) lmRange[p] = { mev: [Infinity, -Infinity], mrv: [Infinity, -Infinity] };
  const noteLm = (prog) => { for (const p of Object.keys(prog.landmarks)) { const lm = prog.landmarks[p]; lmRange[p].mev[0] = Math.min(lmRange[p].mev[0], lm.mev); lmRange[p].mev[1] = Math.max(lmRange[p].mev[1], lm.mev); lmRange[p].mrv[0] = Math.min(lmRange[p].mrv[0], lm.mrv); lmRange[p].mrv[1] = Math.max(lmRange[p].mrv[1], lm.mrv); } };

  for (let s = 1; s <= N; s++) {
    CLOCK += 2 * DAY;
    const readiness = { trainingReadiness: 88 };                 // always fresh -> fatigue comfortable
    const rx = prescribe(program, readiness);
    checkPrescribe(rep, s, program, rx);
    // beat every target by 0.5 RPE => e1RM steadily rises (strong growth) with no fatigue
    const logs = rx.items.map((it) => ({ key: it.key,
      topWeight: it.bodyweight ? (it.assistanceNeeded ? -20 : it.topLoad) : it.topLoad,
      topReps: it.reps, topRpe: Math.max(6, it.rpe - 0.5), targetRpe: it.rpe, missedSets: 0 }));
    const r = ingest(program, logs, readiness);
    checkProgram(rep, s, r.next, "next");
    let finalProgram = r.next;
    if (r.transition) finalProgram = applyTransition(r.next, r.transition);
    checkProgram(rep, s, finalProgram, "final");
    noteLm(finalProgram);
    program = finalProgram;
  }
  restoreClock();
  return { rep, lmRange, finalLandmarks: program.landmarks, sessions: N };
}

/* ====== targeted: extreme-load sweep to stress plate rounding + warmup ====== */
function stressExtremes(seed) {
  const rep = makeReport("extremes", seed);
  useSimClock(); CLOCK = Date.UTC(2024, 0, 1);
  const base = freshProgram({ seeds: SEEDS.intermediate, experience: "intermediate", unit: "lb", goal: "hypertrophy", bodyweight: 185 });
  const phases = ["accumulation", "deload"];
  let checked = 0;
  for (const bar of [35, 45]) {
    for (const e1rm of [1, 5, 12, 33, 47, 95, 135, 225, 405, 605, 1005, 2005, 3000]) {
      for (const phase of phases) {
        for (let cyc = 0; cyc <= 4; cyc++) {
          for (let cycleIndex = 0; cycleIndex < ROT; cycleIndex++) {   // sweep all 4 rotation days -> every exercise
            const p = structuredCloneSafe(base);
            p.barWeight = bar;
            p.cycleIndex = cycleIndex;
            for (const k of Object.keys(p.lifts)) { p.lifts[k].e1rm = e1rm; p.lifts[k].e1rmRaw = e1rm; } // slam every lift to the extreme
            p.block = { type: phase, cycle: cyc, sessionsInBlock: cyc * ROT, nextAfter: null };
            let rx;
            try { rx = prescribe(p, { trainingReadiness: 70 }); }
            catch (e) { rep.add("prescribe-crash-extreme", checked, `${e.message} e1rm=${e1rm} bar=${bar} phase=${phase} day=${cycleIndex}`); continue; }
            checkPrescribe(rep, checked, p, rx);
            checked++;
          }
        }
      }
    }
  }
  restoreClock();
  return { rep, checked };
}
function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }

/* ====== targeted: pull-up assistance / negative-added edge cases ====== */
function stressPullup(seed) {
  const rep = makeReport("pullup", seed);
  useSimClock(); CLOCK = Date.UTC(2024, 0, 1);
  let flagged = { assist: 0, repOnly: 0, added: 0 };
  // pull-up lives on the "Bench" rotation day; find its index so prescribe() actually returns it
  const puDay = ROTATION.findIndex((d) => d.items.includes("pullup"));
  // sweep bodyweight vs pull-up system strength to hit all three branches
  for (const bw of [120, 160, 200, 260, 320]) {
    for (const sysMult of [0.5, 0.7, 0.85, 1.0, 1.3, 1.8]) {
      const p = freshProgram({ seeds: SEEDS.beginner, experience: "beginner", unit: "lb", goal: "hypertrophy", bodyweight: bw });
      p.barWeight = 45;
      p.cycleIndex = puDay;
      p.lifts.pullup.e1rm = bw * sysMult;      // pull-up system load relative to bodyweight
      p.lifts.pullup.e1rmRaw = bw * sysMult;
      for (const phase of ["accumulation", "deload"]) {
        p.block = { type: phase, cycle: 1, sessionsInBlock: ROT, nextAfter: null };
        const rx = prescribe(p, { trainingReadiness: 65 });
        checkPrescribe(rep, 0, p, rx);
        const pu = rx.items.find((it) => it.key === "pullup");
        if (pu) {
          if (pu.assistanceNeeded) flagged.assist++;
          else if (pu.repOnly) flagged.repOnly++;
          else flagged.added++;
          // now ingest a NEGATIVE added-weight log (band assistance) and ensure it doesn't corrupt state
          const logs = rx.items.map((it) => ({ key: it.key, topWeight: it.key === "pullup" ? -randint(mulberry32(seed + bw), 20, 80) : it.topLoad,
            topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe, missedSets: 0 }));
          const r = ingest(p, logs, { trainingReadiness: 65 });
          checkProgram(rep, 0, r.next, "pullup-ingest");
        }
      }
    }
  }
  restoreClock();
  return { rep, flagged };
}

/* ================================ RUN + REPORT ================================ */
function printReport(rep) {
  if (rep.count === 0) { console.log(`  ✅ ${rep.label} (seed ${rep.seed}): 0 violations`); return 0; }
  console.log(`  ❌ ${rep.label} (seed ${rep.seed}): ${rep.count} violation(s)`);
  for (const [code, e] of rep.byCode) {
    console.log(`     • ${code} ×${e.n}`);
    for (const s of e.samples) console.log(`         session ${s.session}: ${s.detail}`);
  }
  return rep.count;
}

console.log("═".repeat(78));
console.log("ENGINE STRESS TEST — real freshProgram/prescribe/ingest/applyTransition");
console.log("═".repeat(78));

let totalViolations = 0;
const tiers = ["beginner", "intermediate", "advanced"];
const longResults = {};

console.log("\n#### 1. LONGITUDINAL RANDOMIZED SIMS (edge cases injected) ####");
for (const tier of tiers) {
  const seed = 1000 + tiers.indexOf(tier);
  const res = runLongSim(tier, seed, 450);
  longResults[tier] = res;
  totalViolations += printReport(res.rep);
  console.log(`     sessions=${res.sessions}  transitions=${res.transitions}  blockVisits=${JSON.stringify(res.blockVisits)}  maxSameBlockRun=${res.maxRun}(${res.maxRunBlock})`);
  console.log(`     edge coverage: ${JSON.stringify(res.edge)}`);
}

console.log("\n#### 2. SUSTAINED MONOTONIC-GROWTH SIMS (probe MRV drift ceiling) ####");
const growthResults = {};
for (const tier of tiers) {
  const seed = 2000 + tiers.indexOf(tier);
  const res = runMonotonicGrowth(tier, seed, 500);
  growthResults[tier] = res;
  totalViolations += printReport(res.rep);
}

console.log("\n#### 3. EXTREME-LOAD SWEEP (plate rounding + warmup) ####");
{
  const res = stressExtremes(3000);
  totalViolations += printReport(res.rep);
  console.log(`     prescriptions checked: ${res.checked}`);
}

console.log("\n#### 4. PULL-UP ASSISTANCE / NEGATIVE-ADDED EDGE CASES ####");
{
  const res = stressPullup(4000);
  totalViolations += printReport(res.rep);
  console.log(`     branch coverage: ${JSON.stringify(res.flagged)}`);
}

/* ---- landmark drift summary ---- */
console.log("\n#### 5. VOLUME-LANDMARK DRIFT SUMMARY ####");
function lmSummary(label, res, withMav) {
  console.log(`\n  ${label}:`);
  let worstMrv = 0, collapse = false;
  for (const p of Object.keys(res.lmRange)) {
    const r = res.lmRange[p];
    const fin = res.finalLandmarks[p];
    worstMrv = Math.max(worstMrv, r.mrv[1]);
    if (fin.mrv - fin.mev < 2) collapse = true;
    const mav = withMav ? `  MAV[${r.mav[0]}..${r.mav[1]}]` : "";
    console.log(`    ${p.padEnd(12)} MEV[${r.mev[0]}..${r.mev[1]}]${mav}  MRV[${r.mrv[0]}..${r.mrv[1]}]  final=${fin.mev}/${fin.mav}/${fin.mrv}`);
  }
  return { worstMrv, collapse };
}
for (const tier of tiers) {
  const r = lmSummary(`LONG · ${tier}`, longResults[tier], true);
  console.log(`      -> peak MRV seen: ${r.worstMrv}${r.collapse ? "  ⚠ RANGE COLLAPSE (mrv-mev<2)" : ""}`);
}
for (const tier of tiers) {
  const r = lmSummary(`MONOTONIC-GROWTH · ${tier}`, growthResults[tier], false);
  console.log(`      -> peak MRV seen: ${r.worstMrv}${r.worstMrv > 40 ? "  ⚠ MRV exceeded 40 (possibly unbounded)" : ""}`);
}

console.log("\n" + "═".repeat(78));
console.log(`TOTAL INVARIANT VIOLATIONS ACROSS ALL RUNS: ${totalViolations}`);
console.log("═".repeat(78));
