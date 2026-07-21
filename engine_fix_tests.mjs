/* ============================================================================
   Targeted regression tests for the methodology-review fixes (P0–P3).
   Run with: node engine_fix_tests.mjs   (also wired into `npm test`).
   Each assertion is written to FAIL on the pre-fix engine and pass after —
   these verify the fixes numerically, not just that the code runs.
   ============================================================================ */
import {
  freshProgram, prescribe, ingest, applyTransition, adjustLandmarks, liftNormSlope,
  deliveredWeekly, effectiveCeiling, maxDeliverable, weeklyFreqScale, landmarksForExperience,
  BLOCKS, ROTATION, ROT, LIB, PATTERNS,
  E1RM_MIN_RPE, LAYOFF_THRESHOLD_DAYS, LAYOFF_MAX_DECAY, DP_MIN_REPS,
  VOLUME_DAY_REP_BUMP, VOLUME_DAY_RPE_CAP,
} from "./src/engine.js";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};
const seeds = { squat: { weight: 315, reps: 5, rpe: 8 }, bench: { weight: 225, reps: 5, rpe: 8 }, deadlift: { weight: 405, reps: 5, rpe: 8 } };
const fresh = () => freshProgram({ seeds, experience: "intermediate", unit: "lb", goal: "strength", bodyweight: 200 });
const green = { trainingReadiness: 80 };

/* ---- sim clock so gap-sensitive logic is deterministic ---- */
const RealNow = Date.now;
let CLOCK = RealNow();
Date.now = () => CLOCK;

console.log("\n== P0: volume ramp is real and reaches its ceiling ==");
{
  const lm = landmarksForExperience("intermediate");
  for (const g of Object.keys(PATTERNS)) {
    const ceil = effectiveCeiling(g, "accumulation", lm);
    const series = [];
    for (let c = 0; c < BLOCKS.accumulation.maxCycles; c++) series.push(deliveredWeekly(g, "accumulation", c, lm));
    const nonDecreasing = series.every((v, i) => i === 0 || v >= series[i - 1]);
    check(`${g}: delivered ramp non-decreasing [${series.join(",")}]`, nonDecreasing);
    check(`${g}: ramp reaches its effective ceiling (${ceil})`, Math.max(...series) >= ceil, `max=${Math.max(...series)}`);
  }
  // the three previously-pinned groups must genuinely CLIMB, not sit flat
  for (const g of ["quads", "hamstrings", "chest"]) {
    const first = deliveredWeekly(g, "accumulation", 0, lm);
    const last = deliveredWeekly(g, "accumulation", BLOCKS.accumulation.maxCycles - 1, lm);
    check(`${g}: delivered volume increases across the block (${first} -> ${last})`, last > first);
  }
}

console.log("\n== P0: atVolCeiling transition actually fires ==");
{
  // Steadily-improving athlete, green readiness, RPE on target: no stall, no
  // fatigue spike — the ONLY trigger available before maxCycles is the volume
  // ceiling. Pre-fix this ran to "max accumulation length reached" at cyc 6.
  let p = fresh();
  let transition = null, sessions = 0;
  const gains = {};
  while (!transition && sessions < 40) {
    const rx = prescribe(p, green);
    const logs = rx.items.map((it) => {
      gains[it.key] = (gains[it.key] || 0) + 2; // +2 lb per exposure: slow steady progress
      return { key: it.key, topWeight: (it.bodyweight ? it.topLoad : it.topLoad + gains[it.key]),
        topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe, missedSets: 0,
        backoffSetCount: it.backoffSetCount, backoffReps: it.reps, backoffRpe: Math.min(it.rpe, it.backoffRpeCap), backoffRpeCap: it.backoffRpeCap };
    });
    CLOCK += 2 * 86400000;
    const r = ingest(p, logs, green);
    p = r.next; transition = r.transition; sessions++;
  }
  check("accumulation ends via a transition", !!transition, "none fired in 40 sessions");
  check(`transition reason is the volume ceiling ("${transition?.reason}")`, /ceiling/.test(transition?.reason || ""));
  check(`fires before maxCycles (cyc ${p.block.cycle} < ${BLOCKS.accumulation.maxCycles})`, p.block.cycle < BLOCKS.accumulation.maxCycles);
}

console.log("\n== P0: auto-tune won't drift MRV past deliverable capacity ==");
{
  const p = fresh();
  // strong same-block growth signal on squat (quads driver), low fatigue
  p.lifts.squat.hist = [300, 304, 308, 312].map((r) => ({ e: r, raw: r, b: "accumulation" }));
  p.lifts.squat.e1rm = 312;
  const { adjustments } = adjustLandmarks(p);
  const adj = adjustments.quads;
  const capA = maxDeliverable("quads", "accumulation");
  check(`quads adjustment exists (growth strong)`, !!adj);
  check(`MRV not raised past schedule capacity (mrv ${adj?.after.mrv} stays ${p.landmarks.quads.mrv}, capA=${capA})`,
    adj && adj.dMrv === 0 && adj.after.mrv === p.landmarks.quads.mrv);
  check(`MEV still allowed to rise (${adj?.before.mev} -> ${adj?.after.mev})`, adj && adj.dMev === 1);
  check(`signal explains the capacity gate ("${adj?.signal}")`, /capacity/.test(adj?.signal || ""));
}

console.log("\n== P1.1: sub-RPE-7 readings don't move e1RM/trend/PRs ==");
{
  const p = fresh();
  const before = { e1rm: p.lifts.squat.e1rm, hist: p.lifts.squat.hist.length };
  const r = ingest(p, [{ key: "squat", topWeight: 500, topReps: 4, topRpe: 6, targetRpe: 6, missedSets: 0 }], green);
  check(`deload-RPE (6) log leaves e1RM unchanged (${before.e1rm.toFixed(1)})`, r.next.lifts.squat.e1rm === before.e1rm);
  check("deload-RPE log adds no hist entry", r.next.lifts.squat.hist.length === before.hist);
  check("deload-RPE log can't set a PR", r.prs.length === 0);
  const r2 = ingest(p, [{ key: "squat", topWeight: 320, topReps: 5, topRpe: E1RM_MIN_RPE, targetRpe: 7, missedSets: 0 }], green);
  check(`RPE ${E1RM_MIN_RPE} log DOES update e1RM`, r2.next.lifts.squat.e1rm !== before.e1rm);
}

console.log("\n== P1.2: untouched (prescription-echo) logs don't count as measurements ==");
{
  const p = fresh();
  const before = { e1rm: p.lifts.squat.e1rm, hist: p.lifts.squat.hist.length, best: p.lifts.squat.best };
  const r = ingest(p, [{ key: "squat", topWeight: 400, topReps: 5, topRpe: 8, targetRpe: 8, missedSets: 1, touched: false }], green);
  check("untouched log leaves e1RM unchanged", r.next.lifts.squat.e1rm === before.e1rm);
  check("untouched log adds no hist entry", r.next.lifts.squat.hist.length === before.hist);
  check("untouched log can't set a PR", r.prs.length === 0);
  check("untouched log still counts for adherence (missFreq moved)", r.next.fatigue.missFreq > 0);
  const r2 = ingest(p, [{ key: "squat", topWeight: 400, topReps: 5, topRpe: 8, targetRpe: 8, missedSets: 0, touched: true }], green);
  check("identical but touched log DOES update e1RM", r2.next.lifts.squat.e1rm !== before.e1rm);
}

console.log("\n== P1.3: slope window doesn't straddle block boundaries, uses raw ==");
{
  // 8 rising accumulation entries, then an intensification rep-range step DOWN
  // 20 lb with its own rising trend. Pre-fix (smoothed series, straddling
  // window) this read strongly negative; the real current-block trend is +1/session.
  const hist = [];
  for (let i = 0; i < 8; i++) hist.push({ e: 300 + i, raw: 300 + i, b: "accumulation" });
  for (let i = 0; i < 4; i++) hist.push({ e: 285 + i, raw: 285 + i, b: "intensification" });
  const s = liftNormSlope({ hist, e1rm: 290 });
  check(`slope over current-block raw readings is positive (${(s * 100).toFixed(3)}%/session)`, s > 0);
  // pre-`b` entries (migrated data) still contribute
  const s2 = liftNormSlope({ hist: [{ e: 300, raw: 300 }, { e: 302, raw: 302 }, { e: 304, raw: 304 }], e1rm: 304 });
  check("legacy hist entries without block tag still produce a slope", s2 > 0);
}

console.log("\n== P1.4: backoff RPE drift feeds the fatigue index ==");
{
  const mk = (backoffRpe) => [{ key: "squat", topWeight: 315, topReps: 5, topRpe: 7.5, targetRpe: 7.5, missedSets: 0,
    backoffSetCount: 3, backoffReps: 5, backoffRpe, backoffRpeCap: 8, touched: true }];
  const drift = ingest(fresh(), mk(9.5), green).next.fatigue;
  const ctrl = ingest(fresh(), mk(8), green).next.fatigue;
  check(`backoff drift raises rpeCreep (${drift.rpeCreep.toFixed(3)} > ${ctrl.rpeCreep.toFixed(3)})`, drift.rpeCreep > ctrl.rpeCreep);
  check("backoffDrift is surfaced on the fatigue state", drift.backoffDrift > 0 && ctrl.backoffDrift === 0);
}

console.log("\n== P1.5: isolation effort ramps to failure instead of starting there ==");
{
  const at = (cyc) => {
    const p = fresh(); p.cycleIndex = 3; p.block = { type: "accumulation", cycle: cyc, sessionsInBlock: cyc * 4, nextAfter: null };
    return prescribe(p, green).items.find((i) => i.key === "lateralraise").rpe;
  };
  check(`cycle 0 isolation RPE is 8, not 10 (got ${at(0)})`, at(0) === 8);
  check(`cycle 2 isolation RPE is 9 (got ${at(2)})`, at(2) === 9);
  check(`cycle 4 isolation RPE reaches 10 (got ${at(4)})`, at(4) === 10);
}

console.log("\n== P1.6: double progression for isolation accessories ==");
{
  const rx = (last, blockType = "accumulation") => {
    const p = fresh(); p.cycleIndex = 3; p.block = { type: blockType, cycle: 1, sessionsInBlock: 4, nextAfter: null };
    if (last) p.lifts.lateralraise.last = last;
    return prescribe(p, green).items.find((i) => i.key === "lateralraise");
  };
  const hit = rx({ w: 30, reps: 12, rpe: 10 });
  check(`top-of-range last session earns one load step (30 -> ${hit.topLoad}) and resets reps to ${DP_MIN_REPS}`,
    hit.topLoad === 35 && hit.reps === DP_MIN_REPS);
  const mid = rx({ w: 30, reps: 9, rpe: 9 });
  check(`mid-range last session holds load (${mid.topLoad}) and climbs reps (9 -> ${mid.reps})`,
    mid.topLoad === 30 && mid.reps === 10);
  const dl = rx({ w: 30, reps: 12, rpe: 10 }, "deload");
  check(`deload prescribes ~15% off the last working load (got ${dl.topLoad})`, dl.topLoad === 25);
  const noHistory = rx(null);
  check("first-ever session falls back to e1RM-derived load", noHistory.topLoad > 0);
  // ingest only anchors `last` from training blocks — deload can't poison it
  const p = fresh(); p.block.type = "deload";
  const r = ingest(p, [{ key: "lateralraise", topWeight: 20, topReps: 10, topRpe: 7, targetRpe: 7, missedSets: 0 }], green);
  check("deload session does not overwrite the double-progression anchor", r.next.lifts.lateralraise.last == null);
}

console.log("\n== P2.1: layoffs gate the comeback prescription ==");
{
  const mk = (daysAgo) => { const p = fresh(); p.lastSessionAt = Date.now() - daysAgo * 86400000; return p; };
  const normal = prescribe(mk(2), green);
  const back20 = prescribe(mk(20), green);
  const back60 = prescribe(mk(60), green);
  const sq = (rx) => rx.items.find((i) => i.key === "squat").topLoad;
  check(`no layoff flag within ${LAYOFF_THRESHOLD_DAYS} days`, normal.layoff == null);
  check(`20-day gap flags a layoff (days=${back20.layoff?.days}, factor=${back20.layoff?.factor})`, back20.layoff?.days === 20 && back20.layoff.factor < 1);
  check(`20-day comeback load is reduced (${sq(back20)} < ${sq(normal)})`, sq(back20) < sq(normal));
  check(`decay is capped at ${LAYOFF_MAX_DECAY * 100}% (60-day factor ${back60.layoff?.factor})`, back60.layoff?.factor === 1 - LAYOFF_MAX_DECAY);
  check("stored e1RM itself is not mutated by prescribing", mk(60).lifts.squat.e1rm === fresh().lifts.squat.e1rm);
}

console.log("\n== P2.2: inter-session gap is tracked for the rotation≈week assumption ==");
{
  let p = fresh();
  for (let i = 0; i < 4; i++) {
    const rx = prescribe(p, green);
    const logs = rx.items.map((it) => ({ key: it.key, topWeight: it.topLoad, topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe, missedSets: 0 }));
    CLOCK += 3 * 86400000;
    p = ingest(p, logs, green).next;
  }
  check(`avgSessionGapDays converges toward the real 3-day cadence (${p.avgSessionGapDays?.toFixed(2)})`,
    p.avgSessionGapDays > 2 && p.avgSessionGapDays <= 3);
}

console.log("\n== P3: volume day is a differentiated second exposure ==");
{
  const at = (dayIdx, cyc) => {
    const p = fresh(); p.cycleIndex = dayIdx; p.block = { type: "accumulation", cycle: cyc, sessionsInBlock: cyc * 4, nextAfter: null };
    return prescribe(p, green).items.find((i) => i.key === "squat");
  };
  const heavy0 = at(0, 0), vol0 = at(3, 0);
  check(`volume-day squat reps = heavy + ${VOLUME_DAY_REP_BUMP} (${heavy0.reps} vs ${vol0.reps})`, vol0.reps === heavy0.reps + VOLUME_DAY_REP_BUMP);
  const heavy4 = at(0, 4), vol4 = at(3, 4);
  check(`late-block volume-day RPE capped at ${VOLUME_DAY_RPE_CAP} while heavy day climbs (${vol4.rpe} vs ${heavy4.rpe})`,
    vol4.rpe === VOLUME_DAY_RPE_CAP && heavy4.rpe > VOLUME_DAY_RPE_CAP);
  check("volume-day top load is lighter than heavy-day top load", vol4.topLoad < heavy4.topLoad);
}

console.log("\n== Frequency-aware volume comparison (weeklyFreqScale) ==");
{
  // unit conversion: how many calendar weeks one ROT-session rotation spans
  check("weeklyFreqScale(null) === 1 (no gap history → behaves as before)", weeklyFreqScale(null) === 1);
  check("weeklyFreqScale(undefined) === 1", weeklyFreqScale(undefined) === 1);
  const s4 = weeklyFreqScale(7 / 4); // ~4x/week: gap 1.75d
  check(`~4x/week (gap 1.75d) ≈ 1.0 (got ${s4.toFixed(3)})`, Math.abs(s4 - 1) < 1e-9);
  const s3 = weeklyFreqScale(7 / 3); // ~3x/week: gap 2.33d, rotation spans >1 wk → schedule under-delivers vs true week
  check(`~3x/week (gap 2.33d) > 1 (got ${s3.toFixed(3)})`, s3 > 1);
  const s5 = weeklyFreqScale(7 / 5); // ~5x/week: gap 1.4d, rotation spans <1 wk → over-delivers vs true week
  check(`~5x/week (gap 1.4d) < 1 (got ${s5.toFixed(3)})`, s5 < 1);
  check("clamped to [0.6, 1.8] at extreme gaps", weeklyFreqScale(0.1) === 0.6 && weeklyFreqScale(99) === 1.8);
  check("ROT is the rotation length used (formula = ROT*gap/7)", Math.abs(weeklyFreqScale(3.5) - Math.max(0.6, Math.min(1.8, ROT * 3.5 / 7))) < 1e-12);
}

console.log("\n== Frequency scaling changes the ceiling-transition timing ==");
{
  /* Longitudinal sim: a steadily-growing, green-readiness athlete whose ONLY
     available early transition trigger is the volume ceiling (no stall, no
     fatigue spike). Runs the SAME program at three cadences, pinning
     avgSessionGapDays, and records the block.cycle at which the "weekly volume
     reached its ceiling" transition fires.

     NOTE ON DIRECTION — this is where the fix's real behavior differs from a
     naive expectation. The three trigger groups (quads/chest/hamstrings) are
     all SCHEDULE-SATURATED below their MRV (maxDeliverable < mrv), so at ≤4x/
     week both delivered volume and the schedule cap scale by the same
     freqScale and cancel: 3x/week fires at the SAME cyc as 4x/week, not
     earlier. The timing shift surfaces at the HIGH-frequency end — at 5x/week,
     maxDeliverable/freqScale rises up to MRV, flipping the group into the
     "fire the cycle MRV is reached" regime one cycle sooner. So higher true
     weekly frequency → ceiling reached at a LOWER cyc, which is the
     physiologically-correct direction (more true weekly volume → hit the
     ceiling sooner). See PR notes: the task brief's "3x lower than 4x" is
     inverted relative to the specified formula's actual behaviour. */
  const simSeeds = { squat: { weight: 315, reps: 5, rpe: 8 }, bench: { weight: 225, reps: 5, rpe: 8 }, deadlift: { weight: 405, reps: 5, rpe: 8 } };
  const runCadence = (gapDays) => {
    let p = freshProgram({ seeds: simSeeds, experience: "intermediate", unit: "lb", goal: "strength", bodyweight: 200 });
    p.avgSessionGapDays = gapDays;
    const green = { trainingReadiness: 85 };
    const gains = {};
    let fired = null, n = 0;
    while (!fired && n < 60) {
      const rx = prescribe(p, green);
      const logs = rx.items.map((it) => {
        gains[it.key] = (gains[it.key] || 0) + 2; // steady growth: never stalls
        return { key: it.key, touched: true,
          topWeight: it.bodyweight ? it.topLoad : it.topLoad + gains[it.key],
          topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe, missedSets: 0,
          backoffSetCount: it.backoffSetCount, backoffReps: it.reps,
          backoffRpe: Math.min(it.rpe, it.backoffRpeCap), backoffRpeCap: it.backoffRpeCap };
      });
      CLOCK += gapDays * 86400000;
      const r = ingest(p, logs, green);
      r.next.avgSessionGapDays = gapDays; // keep frequency pinned for a deterministic comparison
      if (r.transition && /ceiling/.test(r.transition.reason)) fired = { cyc: r.next.block.cycle };
      p = r.transition ? applyTransition(r.next, r.transition) : r.next;
      p.avgSessionGapDays = gapDays;
      n++;
    }
    return fired;
  };
  const c5 = runCadence(7 / 5), c4 = runCadence(7 / 4), c3 = runCadence(7 / 3);
  check(`all three cadences hit the volume ceiling (5x@cyc${c5?.cyc}, 4x@cyc${c4?.cyc}, 3x@cyc${c3?.cyc})`,
    c5 && c4 && c3);
  check(`5x/week reaches the ceiling at a LOWER cyc than 4x/week (${c5?.cyc} < ${c4?.cyc}) — frequency changes timing`,
    c5.cyc < c4.cyc);
  check(`3x/week never fires EARLIER than 4x/week (${c3?.cyc} >= ${c4?.cyc}) — lower frequency can't shorten the block`,
    c3.cyc >= c4.cyc);
  // control: with no frequency info the pre-fix per-rotation behaviour is preserved
  const cNull = (() => {
    let p = freshProgram({ seeds: simSeeds, experience: "intermediate", unit: "lb", goal: "strength", bodyweight: 200 });
    const green = { trainingReadiness: 85 }; const gains = {}; let fired = null, n = 0;
    while (!fired && n < 60) {
      const rx = prescribe(p, green);
      const logs = rx.items.map((it) => {
        gains[it.key] = (gains[it.key] || 0) + 2;
        return { key: it.key, touched: true, topWeight: it.bodyweight ? it.topLoad : it.topLoad + gains[it.key],
          topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe, missedSets: 0,
          backoffSetCount: it.backoffSetCount, backoffReps: it.reps, backoffRpe: Math.min(it.rpe, it.backoffRpeCap), backoffRpeCap: it.backoffRpeCap };
      });
      CLOCK += 1.75 * 86400000;
      const r = ingest(p, logs, green);
      r.next.avgSessionGapDays = null; // force "no history" every step
      if (r.transition && /ceiling/.test(r.transition.reason)) fired = { cyc: r.next.block.cycle };
      p = r.transition ? applyTransition(r.next, r.transition) : r.next;
      p.avgSessionGapDays = null;
      n++;
    }
    return fired;
  })();
  check(`null avgSessionGapDays reproduces 4x/week timing exactly (${cNull?.cyc} === ${c4?.cyc}) — freqScale 1 is a no-op`,
    cNull.cyc === c4.cyc);
}

Date.now = RealNow;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
