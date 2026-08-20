/* ============================================================================
   Targeted regression tests for the methodology-review fixes (P0–P3).
   Run with: node engine_fix_tests.mjs   (also wired into `npm test`).
   Each assertion is written to FAIL on the pre-fix engine and pass after —
   these verify the fixes numerically, not just that the code runs.
   ============================================================================ */
import {
  freshProgram, prescribe, ingest, applyTransition, adjustLandmarks, migrateProgram, liftNormSlope,
  deliveredWeekly, effectiveCeiling, maxDeliverable, weeklyFreqScale, landmarksForExperience, rampedSlotSets,
  BLOCKS, ROTATION, ROT, LIB, PATTERNS, ACC_REP_TIERS, PATTERN_RAMPED_ACC, GROWTH_POS, patternGrowth,
  buildRamp, FULL_RAMP, rpePct, repsAtPct, e1rmFromBW, BW_REPONLY_FLOOR,
  E1RM_MIN_RPE, LAYOFF_THRESHOLD_DAYS, LAYOFF_MAX_DECAY, DP_MIN_REPS, STALL_STREAK_THRESHOLD,
  DP_MAX_STEPS, DP_STALL_THRESHOLD, DP_STALL_DECAY, RETURN_RPE_CAP, RETURN_SET_MULT,
  FEELER_LOAD_FLOOR_LB, readinessScore, liftSlopeInfo, slope, weeklyFreqScale as wfs,
  FATIGUE_SPIKE, FATIGUE_STILL_ELEVATED, SAME_DAY_GROUP_CAP,
} from "./src/engine.js";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};
const seeds = { squat: { weight: 315, reps: 5, rpe: 8 }, bench: { weight: 225, reps: 5, rpe: 8 }, rdl: { weight: 275, reps: 8, rpe: 8 }, tbarrow: { weight: 185, reps: 8, rpe: 8 } };
const fresh = () => freshProgram({ seeds, experience: "intermediate", unit: "lb", goal: "hypertrophy", bodyweight: 200 });
const green = { trainingReadiness: 80 };
/* Resolve the rotation day that carries a given exercise rather than hardcoding
   a day index. The hypertrophy rebuild moved every exercise, and a stale index
   fails loudly (item not found) only if you're lucky — otherwise it quietly
   asserts against the wrong day. */
const dayWith = (key) => ROTATION.findIndex((d) => d.items.includes(key));
/* Drive a landmark group's growth signal. Before the hypertrophy rebuild,
   quads/hamstrings/chest each had a single main lift whose e1RM WAS the group's
   signal, so a test could set squat's hist and be done. PATTERN_MAIN is empty
   now — every pool reads a precision-weighted average over ALL its ramped
   accessories — so a fixture has to move the whole pool or the untouched
   members dilute it back toward zero. */
const setPoolHist = (p, group, readings) => {
  for (const k of PATTERN_RAMPED_ACC[group] || []) {
    p.lifts[k].hist = readings.map((r) => ({ e: r, raw: r, b: "accumulation" }));
    p.lifts[k].e1rm = readings[readings.length - 1];
  }
  return p;
};
/* Prescribe the day that carries `key` and return that item. Saves every
   caller from having to know which day an exercise lives on. */
const itemOn = (key, block = { type: "accumulation", cycle: 0, sessionsInBlock: 0, nextAfter: null }, mut = null) => {
  const p = fresh(); p.cycleIndex = dayWith(key); p.block = block;
  if (mut) mut(p);
  return prescribe(p, green).items.find((i) => i.key === key);
};

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
  /* Steadily-improving athlete, green readiness, RPE on target: no stall, no
     fatigue spike — the ONLY trigger available before maxCycles is the volume
     ceiling.
     REWRITTEN for the hypertrophy rebuild. The ramp now runs MEV -> MAV and
     reaches MAV in its FINAL cycle by construction, so from the shipped
     landmark defaults "saturated the ceiling" and "hit max block length"
     coincide, and the code reports maxedTime (checked first). That is correct
     behaviour, not a dead trigger — the trigger's real job is the state the
     AUTO-TUNE can drift a program into: MEV ratchets upward block over block
     (canRaiseMev), and once MEV reaches MAV the ramp is flat, so the athlete is
     at their full adaptive volume from cycle 0 and there is nothing left to
     ramp into. Verified reachable: with quads at mev == mav the block ends at
     cycle 3 (minCycles) on "weekly volume reached its ceiling", three cycles
     before maxCycles. */
  const runToTransition = (mutate) => {
    let p = fresh();
    mutate(p);
    const pinnedGap = 1.75;
    p.avgSessionGapDays = pinnedGap;
    let transition = null, sessions = 0;
    const gains = {};
    while (!transition && sessions < 40) {
      const rx = prescribe(p, green);
      const logs = rx.items.map((it) => {
        gains[it.key] = (gains[it.key] || 0) + 2; // +2 lb per exposure: slow steady progress
        return { key: it.key, topWeight: (it.bodyweight ? it.topLoad : it.topLoad + gains[it.key]),
          topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe, missedSets: 0, touched: true,
          backoffSetCount: it.backoffSetCount, backoffReps: it.reps, backoffRpe: Math.min(it.rpe, it.backoffRpeCap), backoffRpeCap: it.backoffRpeCap };
      });
      CLOCK += pinnedGap * 86400000;
      const r = ingest(p, logs, green);
      r.next.avgSessionGapDays = pinnedGap; // keep the cadence exactly what the math above assumes
      p = r.next; transition = r.transition; sessions++;
    }
    return { p, transition };
  };

  // fully-ratcheted quads: MEV has climbed to MAV, so the ramp is flat at the ceiling
  const ratcheted = runToTransition((p) => { p.landmarks.quads = { ...p.landmarks.quads, mev: 14, mav: 14 }; });
  check("accumulation ends via a transition", !!ratcheted.transition, "none fired in 40 sessions");
  check(`transition reason is the volume ceiling ("${ratcheted.transition?.reason}")`, /ceiling/.test(ratcheted.transition?.reason || ""));
  check(`fires before maxCycles (cyc ${ratcheted.p.block.cycle} < ${BLOCKS.accumulation.maxCycles})`,
    ratcheted.p.block.cycle < BLOCKS.accumulation.maxCycles);
  check(`fires no earlier than minCycles (cyc ${ratcheted.p.block.cycle} >= ${BLOCKS.accumulation.minCycles})`,
    ratcheted.p.block.cycle >= BLOCKS.accumulation.minCycles);

  // and the control: from the shipped defaults the ramp has room, so the block
  // runs its full length instead and says so honestly
  const normal = runToTransition(() => {});
  check(`from shipped landmarks the same athlete runs the full block instead (cyc ${normal.p.block.cycle}, "${normal.transition?.reason}")`,
    normal.p.block.cycle === BLOCKS.accumulation.maxCycles && /max accumulation length/.test(normal.transition?.reason || ""));
}

console.log("\n== P0: auto-tune won't drift MRV past deliverable capacity ==");
{
  /* The hypertrophy rebuild sized the rotation so that NO group is capacity-
     starved from the shipped defaults (that is the point — see the AUDIT
     3.6/3.8 section). The gate this test covers is still load-bearing though:
     the auto-tune can raise MRV over many blocks until it does exceed what the
     schedule can deliver, and at that point it must stop. So the starvation is
     now constructed explicitly rather than borrowed from a group that happened
     to be short — chest's MRV is pushed just past its real capacity, and the
     growth signal is driven across the whole chest pool (PATTERN_MAIN is empty
     now, so no single lift carries a group's slope). */
  const p = fresh();
  setPoolHist(p, "chest", [225, 227, 229, 231]);
  const capA = maxDeliverable("chest", "accumulation");
  p.landmarks.chest = { ...p.landmarks.chest, mrv: capA }; // exactly at capacity: mrv+1 > capW, raise must be refused
  const { adjustments } = adjustLandmarks(p);
  const adj = adjustments.chest;
  check(`chest adjustment exists (growth strong)`, !!adj);
  check(`sanity: chest MRV is pinned at schedule capacity (mrv=${p.landmarks.chest.mrv} === capA=${capA})`,
    p.landmarks.chest.mrv === capA);
  check(`MRV not raised past schedule capacity (mrv ${adj?.after.mrv} stays ${p.landmarks.chest.mrv}, capA=${capA})`,
    adj && adj.dMrv === 0 && adj.after.mrv === p.landmarks.chest.mrv);
  check(`MEV still allowed to rise (${adj?.before.mev} -> ${adj?.after.mev})`, adj && adj.dMev === 1);
  check(`signal explains the capacity gate ("${adj?.signal}")`, /capacity/.test(adj?.signal || ""));
}

console.log("\n== P0: MRV-raise gate stays in per-rotation units regardless of freqScale ==");
{
  /* REVERSED BY AUDIT 3.3 — this block previously asserted the OPPOSITE.
     It used to lock in capA staying in raw per-rotation units inside the
     MRV-raise gate, on the reasoning that capA is "a schedule-delivery
     ceiling, not a rate being compared to a weekly landmark, so scaling it
     would be a category error." That reasoning does not survive inspection:
     the gate compares capA to `lm.mrv`, and mrv IS a per-calendar-week rate,
     so both sides have to be in weekly units or the comparison is
     meaningless. maxDeliverable() counts sets across ONE ROTATION, which
     spans freqScale weeks — so the weekly capacity is capA/freqScale, and
     they coincide only at exactly 4x/week.

     The gate's own stated purpose is "don't drift MRV above a number no
     prescription can ever reach". Measured with the unscaled comparison, at
     beginner quads (mrv 15, capA 19) it permitted exactly that:
       freqScale 1.00 (4x/wk): weekly capacity 19.0 -> mrv 16 IS deliverable
       freqScale 1.33 (3x/wk): weekly capacity 14.3 -> mrv 16 is NOT
       freqScale 1.80 (~2.2x/wk): weekly capacity 10.6 -> mrv 16 is NOT
     i.e. below 4x/week the gate re-opened the exact failure mode it exists
     to prevent. The straddle construction below is kept — it's still the
     right way to build a case where scaled and unscaled DISAGREE — but the
     expected answer is now the scaled one. */
  const p = fresh();
  setPoolHist(p, "quads", [300, 304, 308, 312]);
  p.avgSessionGapDays = 7 / 3; // ~3x/week -> freqScale = (ROT * gap) / 7 = (4 * 7/3) / 7 = 4/3 ≈ 1.333, not 1
  const scale = weeklyFreqScale(p.avgSessionGapDays);
  check(`sanity: this program's freqScale is not 1 (got ${scale.toFixed(3)})`, Math.abs(scale - 1) > 1e-9);

  const capA = maxDeliverable("quads", "accumulation");
  const straddleMrv = Math.floor(capA / scale); // mrv+1 lands just above capA/scale, still under capA
  p.landmarks.quads.mrv = straddleMrv;
  p.landmarks.quads.mav = straddleMrv - 1; // keep mav < mrv so the range clamp doesn't interfere
  check(`sanity: mrv+1 (${straddleMrv + 1}) is <= capA (${capA}) but > capA/scale (${(capA / scale).toFixed(2)}) — the two paths must disagree`,
    straddleMrv + 1 <= capA && straddleMrv + 1 > capA / scale);

  const { adjustments } = adjustLandmarks(p);
  const adj = adjustments.quads;

  check(`quads adjustment exists at freqScale≈${scale.toFixed(3)} (growth strong)`, !!adj);
  check(`capA is converted to a weekly rate: MRV raise is BLOCKED here (stays ${adj?.after.mrv}) because ${straddleMrv + 1} > capA/scale ${(capA / scale).toFixed(2)}`,
    adj && adj.dMrv === 0 && adj.after.mrv === straddleMrv);
  check(`signal reports the capacity gate ("${adj?.signal}")`,
    /capacity/.test(adj?.signal || ""));

  /* Companion case: the SAME landmarks at freqScale=1, where one rotation is
     exactly one week, must now DIFFER — the raise is allowed there because
     the schedule really can deliver it weekly. Under the old unscaled gate
     both cases answered identically, which is precisely what hid the bug. */
  const p1 = fresh();
  p1.lifts.squat.hist = [300, 304, 308, 312].map((r) => ({ e: r, raw: r, b: "accumulation" }));
  p1.lifts.squat.e1rm = 312;
  p1.avgSessionGapDays = null; // freqScale = 1
  p1.landmarks.quads.mrv = straddleMrv;
  p1.landmarks.quads.mav = straddleMrv - 1;
  const adj1 = adjustLandmarks(p1).adjustments.quads;
  check(`freqScale=1 companion case DOES raise MRV (${straddleMrv} -> ${adj1?.after.mrv}) — same landmarks, genuinely deliverable at 4x/week`,
    adj1 && adj1.dMrv === 1 && adj1.after.mrv === straddleMrv + 1);
  check("the two frequencies now reach DIFFERENT decisions (the unscaled gate could not tell them apart)",
    adj.dMrv !== adj1.dMrv);
}

console.log("\n== Stall notice: observation-only tracking (does not change MEV/MRV/exercises) ==");
{
  /* Shared fixture: flat-growth squat (quads driver) with n=3 evidence points
     — enough for patternGrowth to act on, slope ~0 either way. Individual
     tests below vary landmarks/fatigue to flip exactly one gate at a time.
     Reference values at cyc=0 with default intermediate quads landmarks
     (mev 8/mav 14/mrv 20): deliveredWeekly=10, effectiveCeiling=16. */
  const FLAT = [300, 300, 300];
  const RISING = [300, 304, 308, 312];

  // 1. all three gates clear (volume>=mav, fatigue comfortable, not at ceiling) -> streak increments
  {
    const p = fresh();
    setPoolHist(p, "quads", FLAT);
    p.fatigue.index = 0.3; // comfortable (< FATIGUE_SPIKE 0.7)
    p.landmarks.quads.mav = 8; // <= deliveredWeekly: volume gate clears
    const { stallStreaks } = adjustLandmarks(p);
    check(`flat growth + volume>=mav + fatigue ok + not at ceiling -> streak increments (0 -> ${stallStreaks.quads})`,
      stallStreaks.quads === 1);
  }

  // 2. growth resumes -> streak resets to 0 and any live notice is cleared,
  //    regardless of how high the streak already was
  {
    const p = fresh();
    setPoolHist(p, "quads", RISING); // real growth
    p.fatigue.index = 0.3;
    p.stallStreaks = { quads: 5 };
    p.stallNotices = { quads: { cyclesStalled: 5, sinceCycle: 0 } };
    const { stallStreaks, stallNotices } = adjustLandmarks(p);
    check(`growth resumed -> streak resets to 0 (was 5, got ${stallStreaks.quads})`, stallStreaks.quads === 0);
    check("growth resumed -> the live notice is cleared", !("quads" in stallNotices));
  }

  // 3. flat growth but volume BELOW mav -> streak left unchanged (no increment, no reset)
  {
    const p = fresh();
    setPoolHist(p, "quads", FLAT);
    p.fatigue.index = 0.3;
    // default quads mav is above what cyc-0 delivers: volume gate fails
    p.stallStreaks = { quads: 2 };
    const { stallStreaks } = adjustLandmarks(p);
    check(`volume below MAV -> streak unchanged (stayed 2, got ${stallStreaks.quads})`, stallStreaks.quads === 2);
  }

  // 4. flat growth, volume clears, but fatigue is SPIKED -> streak left unchanged
  {
    const p = fresh();
    setPoolHist(p, "quads", FLAT);
    p.fatigue.index = 0.85; // >= FATIGUE_SPIKE 0.7
    p.landmarks.quads.mav = 8; // volume gate would clear on its own
    p.stallStreaks = { quads: 2 };
    const { stallStreaks } = adjustLandmarks(p);
    check(`fatigue spiked -> streak unchanged (stayed 2, got ${stallStreaks.quads})`, stallStreaks.quads === 2);
  }

  // 5. flat growth, volume clears, fatigue ok, but the pattern IS at its own
  //    ceiling this block -> streak left unchanged (this is a capacity
  //    story, not evidence the exercise stopped working)
  {
    const p = fresh();
    setPoolHist(p, "quads", FLAT);
    p.fatigue.index = 0.3;
    /* reachedCeiling now means "schedule capacity, not the plan, limited this
       group" (see adjustLandmarks) — so the confound is constructed by pushing
       MAV above what the rotation can deliver, not by lowering MRV. */
    p.landmarks.quads = { ...p.landmarks.quads, mav: maxDeliverable("quads", "accumulation") + 4, mrv: maxDeliverable("quads", "accumulation") + 6 };
    p.stallStreaks = { quads: 2 };
    const { stallStreaks } = adjustLandmarks(p);
    check(`capacity-limited -> streak unchanged (stayed 2, got ${stallStreaks.quads})`, stallStreaks.quads === 2);
  }

  // 6. notice appears exactly at STALL_STREAK_THRESHOLD, not before, across
  //    consecutive all-clear calls (simulating consecutive stalled blocks) —
  //    plus migrateProgram backfills the two new fields for an old save.
  {
    let p = fresh();
    setPoolHist(p, "quads", FLAT);
    p.fatigue.index = 0.3;
    p.landmarks.quads.mav = 8;
    const seenNotice = [];
    for (let i = 0; i < STALL_STREAK_THRESHOLD; i++) {
      const { stallStreaks, stallNotices } = adjustLandmarks(p);
      p = { ...p, stallStreaks, stallNotices };
      seenNotice.push("quads" in stallNotices);
    }
    check(`no notice before the threshold [${seenNotice.join(",")}]`,
      seenNotice.slice(0, -1).every((v) => v === false));
    check(`notice appears exactly at the ${STALL_STREAK_THRESHOLD}rd call`, seenNotice[seenNotice.length - 1] === true);
    check(`notice shape: cyclesStalled=${STALL_STREAK_THRESHOLD}, sinceCycle is a number`,
      p.stallNotices.quads.cyclesStalled === STALL_STREAK_THRESHOLD && typeof p.stallNotices.quads.sinceCycle === "number");

    const old = fresh();
    delete old.stallStreaks;
    delete old.stallNotices;
    const migrated = migrateProgram(old);
    check("migrateProgram backfills stallStreaks as {} for an old-schema save",
      migrated.stallStreaks && typeof migrated.stallStreaks === "object");
    check("migrateProgram backfills stallNotices as {} for an old-schema save",
      migrated.stallNotices && typeof migrated.stallNotices === "object");
  }
}

console.log("\n== Stall notice: volumeAtMav now uses the same call-then-divide freqScale pattern as reachedCeiling ==");
{
  /* Fixes a units inconsistency this section's own PR left behind:
     reachedCeiling (a few lines above volumeAtMav inside adjustLandmarks)
     already called deliveredWeekly WITH freqScale and divided the result by
     freqScale, so it reflects what prescribe() actually delivers at the
     athlete's real frequency. volumeAtMav still called deliveredWeekly
     unscaled — a hypothetical "at 4x/week" number — which was defensible
     only while prescribe() itself ignored frequency, and stopped being once
     prescribe() started scaling its own output. */

  // 1. freqScale=1 (no avgSessionGapDays): byte-identical to before this fix —
  //    dividing by 1 is a no-op, but assert it explicitly rather than assume.
  {
    const p = fresh();
    setPoolHist(p, "quads", [300, 300, 300]);
    p.fatigue.index = 0.3;
    p.landmarks.quads.mav = 8; // volume gate clears (delivered at cyc0 >= 8)
    const { stallStreaks } = adjustLandmarks(p);
    check(`freqScale=1: volumeAtMav gate still clears and increments the streak exactly as before (0 -> ${stallStreaks.quads})`,
      stallStreaks.quads === 1);
  }

  // 2. freqScale != 1: a case constructed so the OLD unscaled deliveredThis
  //    and the NEW scaled-then-divided deliveredThis land on OPPOSITE sides
  //    of mav — not a case where both happen to agree. Computed at runtime
  //    (not hardcoded) so this stays correct if quad accounting shifts again;
  //    mav is set to the midpoint, guaranteed to sit strictly between them.
  const fs733 = weeklyFreqScale(7 / 3);
  const oldValCyc0 = deliveredWeekly("quads", "accumulation", 0, landmarksForExperience("intermediate"));
  const newValCyc0 = deliveredWeekly("quads", "accumulation", 0, landmarksForExperience("intermediate"), fs733) / fs733;
  const straddleMav = (oldValCyc0 + newValCyc0) / 2;
  {
    check(`sanity: old (${oldValCyc0}) and new (${newValCyc0.toFixed(2)}) deliveredThis land on opposite sides of mav=${straddleMav.toFixed(2)}`,
      oldValCyc0 !== newValCyc0);

    const p = fresh();
    setPoolHist(p, "quads", [300, 300, 300]);
    p.fatigue.index = 0.3;
    p.avgSessionGapDays = 7 / 3; // freqScale ≈ 1.333
    p.landmarks.quads.mav = straddleMav; // midpoint of old/new — see above
    const { stallStreaks } = adjustLandmarks(p);
    // "leave the streak unchanged" from a never-touched {} means the key stays
    // absent (undefined), not 0 — asserting undefined here, not === 0, is the
    // correct expectation for the "gate fails, no evidence" path.
    check(`freqScale≈1.333: volumeAtMav correctly reads FALSE (streak never incremented, stays undefined/absent) — the OLD unscaled code would have wrongly cleared this gate`,
      stallStreaks.quads === undefined);
  }

  // 3. the flip side: a threshold where BOTH old and new agree the gate
  //    clears, confirming the fix isn't just suppressing every increment.
  {
    const p = fresh();
    setPoolHist(p, "quads", [300, 300, 300]);
    p.fatigue.index = 0.3;
    p.avgSessionGapDays = 7 / 3;
    /* Derived from the real delivered figure rather than hardcoded, so this
       stays a genuine "both old and new agree the gate clears" case if quad
       accounting or the ramp endpoint moves again. MEV is dropped alongside it
       purely to keep mev < mav after the derivation. */
    const deliveredHere = deliveredWeekly("quads", "accumulation", 0, landmarksForExperience("intermediate"), fs733) / fs733;
    p.landmarks.quads = { ...p.landmarks.quads, mev: 3, mav: Math.floor(Math.min(deliveredHere, oldValCyc0)) };
    const { stallStreaks } = adjustLandmarks(p);
    check(`freqScale≈1.333, low mav: gate still correctly clears and increments (0 -> ${stallStreaks.quads})`,
      stallStreaks.quads === 1);
  }
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
  // 8 rising accumulation entries, then a DELOAD step DOWN 20 lb with its own
  // rising trend. Pre-fix (smoothed series, straddling window) this read
  // strongly negative; the real current-block trend is +1/session. (Was written
  // against an intensification block, which the hypertrophy rebuild removed —
  // deload is now the block whose loads step down relative to accumulation.)
  const hist = [];
  for (let i = 0; i < 8; i++) hist.push({ e: 300 + i, raw: 300 + i, b: "accumulation" });
  for (let i = 0; i < 4; i++) hist.push({ e: 285 + i, raw: 285 + i, b: "deload" });
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

console.log("\n== P1.5: isolation effort RAMPS across the block instead of starting at failure ==");
{
  /* Values moved in the hypertrophy rebuild: isolation now runs 7.5 -> 9.5
     rather than 8 -> 10. The property under test is unchanged — effort is
     earned across the block, not issued at maximum from cycle 0 — but the top
     of the ramp is deliberately no longer true failure. See ACC_REP_TIERS. */
  const at = (cyc) => {
    const p = fresh(); p.cycleIndex = dayWith("lateralraise");
    p.block = { type: "accumulation", cycle: cyc, sessionsInBlock: cyc * ROT, nextAfter: null };
    return prescribe(p, green).items.find((i) => i.key === "lateralraise").rpe;
  };
  check(`cycle 0 isolation RPE is 7.5 (~2.5 RIR), not failure (got ${at(0)})`, at(0) === 7.5);
  check(`cycle 2 isolation RPE is 8.5 (got ${at(2)})`, at(2) === 8.5);
  check(`cycle 4 isolation RPE reaches its 9.5 cap (got ${at(4)})`, at(4) === 9.5);
  check(`the cap holds — cycle 5 does not push past 9.5 (got ${at(5)})`, at(5) === 9.5);
  check("isolation never reaches RPE 10 anywhere in the block", [0, 1, 2, 3, 4, 5].every((c) => at(c) < 10));
}

console.log("\n== P1.6: double progression for isolation accessories ==");
{
  const rx = (last, blockType = "accumulation") => {
    const p = fresh(); p.cycleIndex = 3; p.block = { type: blockType, cycle: 1, sessionsInBlock: 4, nextAfter: null };
    if (last) p.lifts.lateralraise.last = last;
    return prescribe(p, green).items.find((i) => i.key === "lateralraise");
  };
  const hit = rx({ w: 30, reps: 12, rpe: 10 });
  // audit 2.7: lateralraise now carries increment: 2.5 (cable-stack pin spacing), so the
  // DP load step is 30 -> 32.5, not the old unit-default 5 lb step (30 -> 35).
  check(`top-of-range last session earns one load step (30 -> ${hit.topLoad}) and resets reps to ${DP_MIN_REPS}`,
    hit.topLoad === 32.5 && hit.reps === DP_MIN_REPS);
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

console.log("\n== AUDIT 2.8: layoff caps effort/volume for the return window, not just load ==");
{
  /* Pre-fix, a 45-day layoff returning into a hard block prescribed full
     reps/RPE/sets — only the load itself was cut. Uses a LATE accumulation
     cycle because that is where the effort ramp has climbed above
     RETURN_RPE_CAP and the cap therefore has something to bite on. (Was
     written against an intensification block; the hypertrophy rebuild removed
     it, and the return cap now applies to each item's own tier RPE rather than
     to a single main-lift rpeTop.) */
  const hardBlock = { type: "accumulation", cycle: BLOCKS.accumulation.maxCycles - 1, sessionsInBlock: 0, nextAfter: null };
  const mk = (daysAgo, sessionsSinceLayoff) => { const p = fresh(); p.cycleIndex = 0; p.block = hardBlock;
    if (daysAgo != null) p.lastSessionAt = Date.now() - daysAgo * 86400000;
    if (sessionsSinceLayoff !== undefined) p.sessionsSinceLayoff = sessionsSinceLayoff;
    return p; };
  const baseline = prescribe(mk(2), green);
  const comeback = prescribe(mk(45), green);
  const sq = (rx) => rx.items.find((i) => i.key === "squat");
  check(`baseline (no layoff) runs the block's full RPE ceiling (${sq(baseline).rpe})`, sq(baseline).rpe > RETURN_RPE_CAP);
  check(`live comeback session caps RPE at RETURN_RPE_CAP (${sq(comeback).rpe} <= ${RETURN_RPE_CAP})`, sq(comeback).rpe === RETURN_RPE_CAP);
  check(`live comeback session cuts sets by RETURN_SET_MULT (${sq(baseline).sets} -> ${sq(comeback).sets})`,
    sq(comeback).sets === Math.max(1, Math.round(sq(baseline).sets * RETURN_SET_MULT)));
  // stored counter carries the cap into the session AFTER the live comeback, then clears
  const second = prescribe(mk(2, 1), green); // recent gap, but still session 2 of the return window
  check(`stored sessionsSinceLayoff=1 still caps the FOLLOWING session (${sq(second).rpe} <= ${RETURN_RPE_CAP})`, sq(second).rpe === RETURN_RPE_CAP);
  const third = prescribe(mk(2, 2), green); // window closed
  check(`sessionsSinceLayoff=2 closes the window — full RPE ceiling returns (${sq(third).rpe})`, sq(third).rpe === sq(baseline).rpe);

  // ingest state machine: comeback -> 1, next session -> 2, session after that -> cleared
  let p = fresh(); p.lastSessionAt = Date.now() - 45 * 86400000;
  const log = () => [{ key: "squat", topWeight: 300, topReps: 3, topRpe: 8, targetRpe: 8, missedSets: 0 }];
  let r = ingest(p, log(), green);
  check(`comeback session sets sessionsSinceLayoff=1 (got ${r.next.sessionsSinceLayoff})`, r.next.sessionsSinceLayoff === 1);
  r = ingest(r.next, log(), green);
  check(`second session advances it to 2 (got ${r.next.sessionsSinceLayoff})`, r.next.sessionsSinceLayoff === 2);
  r = ingest(r.next, log(), green);
  check(`third session clears it (got ${r.next.sessionsSinceLayoff})`, r.next.sessionsSinceLayoff == null);
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

console.log("\n== P3 (rewritten): repeated exposures are identical straight sets, and effort ramps ==");
{
  /* The old "volume day" concept is gone with the main lifts: it gave squat and
     bench a differentiated SECOND weekly exposure (rep bump + RPE cap) so the
     week wasn't two identical heavy top sets. With every exercise now on
     straight sets at a tier-driven rep/RPE target, an exercise appearing twice
     in a rotation should get the SAME prescription both times — anything else
     would be an unexplained asymmetry. */
  const at = (dayIdx, cyc, key) => {
    const p = fresh(); p.cycleIndex = dayIdx; p.block = { type: "accumulation", cycle: cyc, sessionsInBlock: cyc * 4, nextAfter: null };
    return prescribe(p, green).items.find((i) => i.key === key);
  };
  // dbshoulderpress appears on both push days (0 and 2)
  const d0 = at(0, 4, "dbshoulderpress"), d2 = at(2, 4, "dbshoulderpress");
  check(`a twice-weekly exercise is prescribed identically on both days (${d0.sets}x${d0.reps}@${d0.rpe} vs ${d2.sets}x${d2.reps}@${d2.rpe})`,
    d0.sets === d2.sets && d0.reps === d2.reps && d0.rpe === d2.rpe && d0.topLoad === d2.topLoad);
  check("no rotation day is flagged as a volumeDay any more", ROTATION.every((d) => !d.volumeDay));
  // effort and volume both climb across the block for the same exercise
  const early = at(0, 0, "squat"), late = at(0, BLOCKS.accumulation.maxCycles - 1, "squat");
  check(`squat effort climbs across the block (RPE ${early.rpe} -> ${late.rpe})`, late.rpe > early.rpe);
  check(`squat volume climbs across the block (${early.sets} -> ${late.sets} sets)`, late.sets > early.sets);
  check(`squat reps hold constant while effort/volume climb (${early.reps} -> ${late.reps})`, early.reps === late.reps);
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

console.log("\n== Frequency scaling changes real prescribe()-driven transition timing ==");
{
  /* Longitudinal sim: a steadily-growing, green-readiness athlete whose ONLY
     available early transition trigger is the volume ceiling (no stall, no
     fatigue spike). Runs the SAME program at several cadences, pinning
     avgSessionGapDays, and records the block.cycle + reason at which the
     block transitions.

     REVISED FOR THE PRESCRIBE()-LEVEL FREQUENCY FIX. This test previously
     asserted "5x/week fires the ceiling at a lower cyc than 4x, 3x never
     fires earlier than 4x" — that held when only the DECISION sites
     (ceilingHit/adjustLandmarks) were frequency-aware and prescribe() itself
     still assumed 4x/week. Now that prescribe() ALSO scales the ramped-
     accessory count it actually delivers, the real relationship is the
     OPPOSITE and is driven by a different mechanism: ACC_SET_CAP (the per-
     exposure schedule-capacity ceiling) is deliberately NOT frequency-scaled
     (see the comment above weeklyTarget) — so at LOW frequency, prescribe()
     needs MORE sets per rotation to hit the same true-weekly rate, and hits
     that unscaled per-exposure cap SOONER in raw cycle terms. A schedule that
     saturates sooner reaches its (now lower, capacity-limited) true ceiling
     sooner too. Verified empirically across a sweep of frequencies
     (4.1x-4.5x tie with 4x itself; 3.8x/3.5x/3.2x file downward with
     frequency exactly like 3x below; the relationship is monotonic and
     reproduces on repeat runs) before picking these three concrete points. */
  const simSeeds = { squat: { weight: 315, reps: 5, rpe: 8 }, bench: { weight: 225, reps: 5, rpe: 8 }, rdl: { weight: 275, reps: 8, rpe: 8 }, tbarrow: { weight: 185, reps: 8, rpe: 8 } };
  const runCadence = (gapDays, pinnedGap = gapDays) => {
    let p = freshProgram({ seeds: simSeeds, experience: "intermediate", unit: "lb", goal: "hypertrophy", bodyweight: 200 });
    p.avgSessionGapDays = pinnedGap;
    const green = { trainingReadiness: 85 };
    const gains = {};
    let fired = null, n = 0;
    while (!fired && n < 80) {
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
      r.next.avgSessionGapDays = pinnedGap; // keep frequency pinned for a deterministic comparison
      if (r.transition) fired = { cyc: r.next.block.cycle, reason: r.transition.reason };
      p = r.transition ? applyTransition(r.next, r.transition) : r.next;
      p.avgSessionGapDays = pinnedGap;
      n++;
    }
    return fired;
  };
  const c3 = runCadence(7 / 3), c4 = runCadence(7 / 4), c5 = runCadence(7 / 5);
  /* REVISED AGAIN BY THE HYPERTROPHY REBUILD. Earlier passes tracked which
     cadences still saturated a capacity-frozen group early; with the rotation
     rebuilt around its own landmark table, no group is capacity-frozen at any
     of these cadences, so every one of them now runs the full accumulation
     block. That is the intended end state of the 3.6/3.11 work, not a
     regression — the ramp's endpoint is MAV, capacity exceeds MAV everywhere,
     so nothing saturates before the block's own length runs out.
     What this test still pins is the property that matters: frequency changes
     the per-session prescription (see the freqScale plumbing) WITHOUT changing
     block timing, so an athlete's cadence never silently shortens or lengthens
     their mesocycle. The early-ceiling path itself is covered by the "P0:
     atVolCeiling transition actually fires" test, which reaches it through a
     fully-ratcheted landmark state instead of through a cadence. */
  for (const [label, c] of [["3x/week", c3], ["4x/week", c4], ["5x/week", c5]]) {
    check(`${label}: runs the full accumulation length (cyc ${c?.cyc}, "${c?.reason}")`,
      c?.cyc === BLOCKS.accumulation.maxCycles && /max accumulation length/.test(c?.reason || ""));
  }
  check(`block timing is identical across 3x/4x/5x cadence (${c3?.cyc}/${c4?.cyc}/${c5?.cyc}) — frequency changes dosing, not periodization`,
    c3?.cyc === c4?.cyc && c4?.cyc === c5?.cyc);

  // control: with no frequency info the OLD (pre-fix, per-rotation-only) behavior is preserved
  const cNull = runCadence(1.75, null);
  check(`null avgSessionGapDays reproduces 4x/week timing exactly (${cNull?.cyc} === ${c4?.cyc}, "${cNull?.reason}") — freqScale 1 is a no-op`,
    cNull?.cyc === c4.cyc && cNull?.reason === c4.reason);
}

console.log("\n== CRITICAL VERIFICATION 1: prescribe() output matches its pinned snapshot ==");
{
  /* Snapshot across 3 cycles x all 4 rotation days — every exercise's sets/
     topLoad/reps. Originally captured to prove freqScale=1 is a no-op for
     weeklyTarget/rampedSlotSets, then rebaselined once for the Tier 1 audit
     fixes (see git history for that diff).
RE-CAPTURED WHOLESALE for the hypertrophy rebuild. Every previous
     rebaseline of this snapshot was a diff-and-verify exercise: a handful of
     rows moved and each diff was enumerated and justified before acceptance.
     That is not possible here and it would be dishonest to pretend otherwise —
     the rebuild changed the exercise library, the rotation, the rep/RPE tables
     and the ramp endpoint all at once, so 100% of the rows differ and there is
     no meaningful row-level diff against the old program to audit. What this
     snapshot is still good for is its ACTUAL job from here on: pinning
     prescribe()'s complete output so any future change that perturbs it has to
     be deliberate. The values were generated from the engine and spot-checked
     against the hand-computed slot budget in the ROTATION comment (chest 4
     slots, back 4, quads 4, triceps 3, ...) plus the MEV/MAV endpoints in
     PATTERNS. */
  const EXPECTED = [[{"key":"bench","sets":2,"topLoad":195,"reps":8},{"key":"dbshoulderpress","sets":2,"topLoad":120,"reps":8},{"key":"cablefly","sets":2,"topLoad":50,"reps":12},{"key":"lateralraise","sets":2,"topLoad":20,"reps":12},{"key":"triext","sets":2,"topLoad":75,"reps":12},{"key":"squat","sets":2,"topLoad":275,"reps":8},{"key":"legext","sets":2,"topLoad":150,"reps":12},{"key":"calfraise","sets":2,"topLoad":285,"reps":12},{"key":"cablecrunch","sets":3,"topLoad":70,"reps":12}],[{"key":"tbarrow","sets":2,"topLoad":180,"reps":8},{"key":"latpullover","sets":2,"topLoad":90,"reps":12},{"key":"reversepecdeck","sets":2,"topLoad":30,"reps":12},{"key":"bayesiancurl","sets":2,"topLoad":62.5,"reps":12},{"key":"rdl","sets":2,"topLoad":265,"reps":8},{"key":"legcurl","sets":2,"topLoad":110,"reps":12},{"key":"calfraise","sets":2,"topLoad":285,"reps":12},{"key":"shrug","sets":3,"topLoad":85,"reps":12}],[{"key":"inclinebench","sets":2,"topLoad":155,"reps":8},{"key":"dip","sets":2,"topLoad":150,"reps":8},{"key":"dbshoulderpress","sets":2,"topLoad":120,"reps":8},{"key":"lateralraise","sets":2,"topLoad":20,"reps":12},{"key":"triext","sets":2,"topLoad":75,"reps":12},{"key":"bsplit","sets":2,"topLoad":50,"reps":10},{"key":"legext","sets":2,"topLoad":150,"reps":12},{"key":"calfraise","sets":2,"topLoad":285,"reps":12},{"key":"cablecrunch","sets":3,"topLoad":70,"reps":12}],[{"key":"pullup","sets":2,"topLoad":-60,"reps":8},{"key":"latpullover","sets":2,"topLoad":90,"reps":12},{"key":"reversepecdeck","sets":2,"topLoad":30,"reps":12},{"key":"preachercurl","sets":2,"topLoad":70,"reps":12},{"key":"bayesiancurl","sets":2,"topLoad":62.5,"reps":12},{"key":"triext","sets":2,"topLoad":75,"reps":12},{"key":"legcurl","sets":2,"topLoad":110,"reps":12},{"key":"lateralraise","sets":2,"topLoad":20,"reps":12},{"key":"wristcurl","sets":3,"topLoad":25,"reps":12}],[{"key":"bench","sets":2,"topLoad":205,"reps":8},{"key":"dbshoulderpress","sets":2,"topLoad":125,"reps":8},{"key":"cablefly","sets":2,"topLoad":50,"reps":12},{"key":"lateralraise","sets":3,"topLoad":22.5,"reps":12},{"key":"triext","sets":3,"topLoad":80,"reps":12},{"key":"squat","sets":2,"topLoad":285,"reps":8},{"key":"legext","sets":2,"topLoad":160,"reps":12},{"key":"calfraise","sets":3,"topLoad":300,"reps":12},{"key":"cablecrunch","sets":3,"topLoad":70,"reps":12}],[{"key":"tbarrow","sets":3,"topLoad":190,"reps":8},{"key":"latpullover","sets":3,"topLoad":100,"reps":12},{"key":"reversepecdeck","sets":3,"topLoad":32.5,"reps":12},{"key":"bayesiancurl","sets":3,"topLoad":65,"reps":12},{"key":"rdl","sets":2,"topLoad":275,"reps":8},{"key":"legcurl","sets":2,"topLoad":110,"reps":12},{"key":"calfraise","sets":3,"topLoad":300,"reps":12},{"key":"shrug","sets":3,"topLoad":90,"reps":12}],[{"key":"inclinebench","sets":2,"topLoad":165,"reps":8},{"key":"dip","sets":2,"topLoad":150,"reps":8},{"key":"dbshoulderpress","sets":2,"topLoad":125,"reps":8},{"key":"lateralraise","sets":3,"topLoad":22.5,"reps":12},{"key":"triext","sets":3,"topLoad":80,"reps":12},{"key":"bsplit","sets":2,"topLoad":55,"reps":10},{"key":"legext","sets":2,"topLoad":160,"reps":12},{"key":"calfraise","sets":3,"topLoad":300,"reps":12},{"key":"cablecrunch","sets":3,"topLoad":70,"reps":12}],[{"key":"pullup","sets":3,"topLoad":-50,"reps":8},{"key":"latpullover","sets":3,"topLoad":100,"reps":12},{"key":"reversepecdeck","sets":3,"topLoad":32.5,"reps":12},{"key":"preachercurl","sets":3,"topLoad":72.5,"reps":12},{"key":"bayesiancurl","sets":3,"topLoad":65,"reps":12},{"key":"triext","sets":3,"topLoad":80,"reps":12},{"key":"legcurl","sets":2,"topLoad":110,"reps":12},{"key":"lateralraise","sets":3,"topLoad":22.5,"reps":12},{"key":"wristcurl","sets":3,"topLoad":25,"reps":12}],[{"key":"bench","sets":4,"topLoad":210,"reps":8},{"key":"dbshoulderpress","sets":4,"topLoad":125,"reps":8},{"key":"cablefly","sets":4,"topLoad":60,"reps":12},{"key":"lateralraise","sets":5,"topLoad":22.5,"reps":12},{"key":"triext","sets":4,"topLoad":85,"reps":12},{"key":"squat","sets":4,"topLoad":295,"reps":8},{"key":"legext","sets":4,"topLoad":170,"reps":12},{"key":"calfraise","sets":5,"topLoad":310,"reps":12},{"key":"cablecrunch","sets":3,"topLoad":75,"reps":12}],[{"key":"tbarrow","sets":5,"topLoad":190,"reps":8},{"key":"latpullover","sets":5,"topLoad":100,"reps":12},{"key":"reversepecdeck","sets":5,"topLoad":32.5,"reps":12},{"key":"bayesiancurl","sets":5,"topLoad":67.5,"reps":12},{"key":"rdl","sets":3,"topLoad":285,"reps":8},{"key":"legcurl","sets":3,"topLoad":120,"reps":12},{"key":"calfraise","sets":5,"topLoad":310,"reps":12},{"key":"shrug","sets":3,"topLoad":90,"reps":12}],[{"key":"inclinebench","sets":4,"topLoad":170,"reps":8},{"key":"dip","sets":4,"topLoad":160,"reps":8},{"key":"dbshoulderpress","sets":4,"topLoad":125,"reps":8},{"key":"lateralraise","sets":5,"topLoad":22.5,"reps":12},{"key":"triext","sets":4,"topLoad":85,"reps":12},{"key":"bsplit","sets":4,"topLoad":55,"reps":10},{"key":"legext","sets":4,"topLoad":170,"reps":12},{"key":"calfraise","sets":5,"topLoad":310,"reps":12},{"key":"cablecrunch","sets":3,"topLoad":75,"reps":12}],[{"key":"pullup","sets":5,"topLoad":-50,"reps":8},{"key":"latpullover","sets":5,"topLoad":100,"reps":12},{"key":"reversepecdeck","sets":5,"topLoad":32.5,"reps":12},{"key":"preachercurl","sets":5,"topLoad":75,"reps":12},{"key":"bayesiancurl","sets":5,"topLoad":67.5,"reps":12},{"key":"triext","sets":4,"topLoad":85,"reps":12},{"key":"legcurl","sets":3,"topLoad":120,"reps":12},{"key":"lateralraise","sets":5,"topLoad":22.5,"reps":12},{"key":"wristcurl","sets":3,"topLoad":30,"reps":12}]];
  const snapSeeds = { squat: { weight: 315, reps: 5, rpe: 8 }, bench: { weight: 225, reps: 5, rpe: 8 }, rdl: { weight: 275, reps: 8, rpe: 8 }, tbarrow: { weight: 185, reps: 8, rpe: 8 } };
  let idx = 0, allMatch = true;
  for (const cyc of [0, 2, 5]) {
    for (let d = 0; d < 4; d++) {
      const p = freshProgram({ seeds: snapSeeds, experience: "intermediate", unit: "lb", goal: "hypertrophy", bodyweight: 200 });
      p.cycleIndex = d;
      p.block = { type: "accumulation", cycle: cyc, sessionsInBlock: cyc * 4, nextAfter: null };
      const rx = prescribe(p, green);
      const actual = rx.items.map((i) => ({ key: i.key, sets: i.sets, topLoad: i.topLoad, reps: i.reps }));
      if (JSON.stringify(actual) !== JSON.stringify(EXPECTED[idx])) allMatch = false;
      idx++;
    }
  }
  check(`prescribe() sets/topLoad/reps match the pinned snapshot across ${idx} full sessions (3 cycles × 4 rotation days)`, allMatch);
}

console.log("\n== CRITICAL VERIFICATION 2: deliveredWeekly does not double-apply freqScale ==");
{
  // reuse the p1 setup style already used in the freqScale MRV-gate test above: 7/3 days -> freqScale ≈ 1.333
  const lm = landmarksForExperience("intermediate");
  const fs = weeklyFreqScale(7 / 3);
  check(`sanity: freqScale is not 1 (got ${fs.toFixed(3)})`, Math.abs(fs - 1) > 1e-9);
  for (const g of ["quads", "chest", "hamstrings", "back", "calves"]) {
    for (const cyc of [0, 2, 5]) {
      const referenceUnscaled = deliveredWeekly(g, "accumulation", cyc, lm); // freqScale defaults to 1 == frequency-independent reference
      const scaledThenDivided = deliveredWeekly(g, "accumulation", cyc, lm, fs) / fs;
      // Not asserting exact equality: clamps (ACC_SET_CAP, the floor of 1) mean the
      // round-trip isn't a pure no-op — that's correct, capacity limits shouldn't
      // net out. Asserting it lands CLOSE, not scaled by an extra factor of fs or
      // 1/fs (which double-scaling would produce and which would be a large, easily
      // distinguished miss, not a small clamp-driven rounding difference).
      const ratio = scaledThenDivided / referenceUnscaled;
      check(`${g} cyc${cyc}: deliveredWeekly(fs)/fs (${scaledThenDivided.toFixed(2)}) stays near the frequency-independent reference (${referenceUnscaled}), ratio=${ratio.toFixed(3)} (not ×${fs.toFixed(2)} or ×${(1 / fs).toFixed(2)} off)`,
        ratio > 0.7 && ratio < 1.3);
    }
  }
}

console.log("\n== AUDIT 1.1: bodyweight lift refuses to guess when bodyweight is missing ==");
{
  /* The dangerous pre-fix path: `program.bodyweight || 0` made addedRaw =
     rawSys - 0 >= 0, so the "added weight" branch prescribed the athlete's
     ENTIRE system load as weight hung off a belt. Every existing invariant
     passed — it's finite, non-negative, plate-valid — which is why the stress
     suite never caught it. */
  const mk = (bw) => {
    const p = fresh();
    p.bodyweight = bw;            // simulate loss AFTER e1rm was established
    p.lifts.pullup.e1rm = 240;    // athlete really does BW200 + ~40
    p.cycleIndex = dayWith("pullup");
    return prescribe(p, green).items.find((i) => i.key === "pullup");
  };
  const good = mk(200);
  check(`sane bodyweight still prescribes normally (topLoad=${good.topLoad}, assist=${good.assistanceNeeded}, repOnly=${good.repOnly})`,
    !good.bodyweightUnknown && good.topLoad <= 0);
  for (const bad of [0, null, undefined, NaN, -10]) {
    const it = mk(bad);
    check(`bodyweight=${String(bad)}: falls back to unloaded reps, never prescribes added load (topLoad=${it.topLoad})`,
      it.topLoad === 0 && it.repOnly === true && it.bodyweightUnknown === true);
  }
  // the specific pre-fix failure, asserted directly
  const zero = mk(0);
  check("bodyweight=0 does NOT prescribe the full system load as added weight (was 175 lb)", zero.topLoad !== 175);
}

console.log("\n== AUDIT 1.2: warmup ramp steps are loadable (never below the bar) ==");
{
  for (const [top, bar] of [[95, 45], [105, 45], [50, 45], [135, 45], [225, 45]]) {
    const r = buildRamp(top, FULL_RAMP, "lb", bar);
    if (!r) { check(`topLoad=${top} bar=${bar}: no ramp (top too light)`, top <= bar); continue; }
    const weights = r.map((s) => s.weight);
    check(`topLoad=${top} bar=${bar}: every step >= bar [${weights.join(",")}]`, weights.every((w) => w >= bar));
    check(`topLoad=${top} bar=${bar}: every step < topLoad`, weights.every((w) => w < top));
    check(`topLoad=${top} bar=${bar}: strictly ascending (no collapsed duplicates)`,
      weights.every((w, i) => i === 0 || w > weights[i - 1]));
    check(`topLoad=${top} bar=${bar}: never longer than the tier (${weights.length} <= ${FULL_RAMP.length})`,
      weights.length >= 1 && weights.length <= FULL_RAMP.length);
  }
  // the specific pre-fix failure
  const r95 = buildRamp(95, FULL_RAMP, "lb", 45);
  check("topLoad=95 no longer emits a 40 lb step under a 45 lb bar", !r95.some((s) => s.weight === 40));
}

console.log("\n== AUDIT 1.3: repOnly moves the REP target instead of shipping a heavier-than-labelled set ==");
{
  const p = fresh();
  p.bodyweight = 200;
  /* e1RM chosen so rawSys = e1rm * rpePct(8, 7) lands INSIDE the repOnly band
     [0.85*bw, bw). At the rebuilt compound target of 8 reps @ RPE 7 that pct is
     0.707, so the band is e1RM ~240.5 .. ~282.9 — 260 sits mid-band. (The old
     value of 240 was mid-band under the previous main-lift rep/RPE scheme and
     now falls just below it, into the assistance branch.) */
  p.lifts.pullup.e1rm = 260;
  p.cycleIndex = dayWith("pullup");
  const it = prescribe(p, green).items.find((i) => i.key === "pullup");
  check(`lands in the repOnly band (repOnly=${it.repOnly}, topLoad=${it.topLoad})`, it.repOnly && it.topLoad === 0);
  /* The athlete's actual load is their bodyweight (200), heavier than the
     ~184 the RPE math asked for. Holding the prescribed 8 reps would ship a
     set meaningfully heavier than its RPE label. The rep target must come DOWN. */
  const accumTierReps = ACC_REP_TIERS.accumulation.compound.reps;
  check(`reps reduced below the tier default (${it.reps} < ${accumTierReps}) so the set matches its RPE label`,
    it.reps < accumTierReps);
  // and the reduced rep count should be the table's best match for bw/e1rm
  const want = repsAtPct(200 / 260, it.rpe);
  check(`reps equals the inverted-table answer for bw/e1rm (${it.reps} === ${want})`, it.reps === want);
}

console.log("\n== AUDIT 1.4: assistanceNeeded carries the magnitude ==");
{
  const p = fresh();
  p.bodyweight = 200;
  p.lifts.pullup.e1rm = 200;   // rawSys well under 0.85*bw -> assistance
  p.cycleIndex = dayWith("pullup");
  const it = prescribe(p, green).items.find((i) => i.key === "pullup");
  check(`assistance is flagged (assist=${it.assistanceNeeded})`, it.assistanceNeeded === true);
  check(`magnitude surfaced as a negative load (topLoad=${it.topLoad}), not discarded as 0`, it.topLoad < 0);
  /* It should equal bodyweight minus the prescribed system load, rounded to
     the loading step — i.e. exactly how much help the athlete needs. */
  const rawSys = 200 * rpePct(it.reps, it.rpe);
  const expected = -(Math.round((200 - rawSys) / 5) * 5);
  check(`magnitude equals -(bw - prescribed system load) = ${expected}`, it.topLoad === expected);
  check("sign convention matches e1rmFromBW's documented negative-added input",
    e1rmFromBW(200, it.topLoad, it.reps, it.rpe) > 0);
}

console.log("\n== AUDIT 1.7: no biceps isolation is scheduled ahead of a compound pull ==");
{
  /* Originally "row precedes curl on Deadlift day". Both of those exercises are
     retired, but the PRINCIPLE is a property of the rotation, not of those two
     movements: a compound pull depends on the elbow flexors as a link in the
     chain, so curling to a hard RPE first pre-fatigues the weakest link and
     caps the pull before the lats do. Asserted across every day so a future
     rotation edit can't reintroduce the mistake anywhere. */
  const compoundPulls = new Set(["tbarrow", "pullup"]);
  const curls = new Set(["bayesiancurl", "preachercurl"]);
  ROTATION.forEach((d, di) => {
    const firstCurl = d.items.findIndex((k) => curls.has(k));
    const lastPull = d.items.reduce((acc, k, i) => (compoundPulls.has(k) ? i : acc), -1);
    check(`day ${di} (${d.name}): no curl precedes a compound pull (curl@${firstCurl}, pull@${lastPull})`,
      firstCurl === -1 || lastPull === -1 || firstCurl > lastPull);
  });
  // and the same rule for triceps ahead of a compound press
  const presses = new Set(["bench", "inclinebench", "dip", "dbshoulderpress"]);
  ROTATION.forEach((d, di) => {
    const firstTri = d.items.indexOf("triext");
    const lastPress = d.items.reduce((acc, k, i) => (presses.has(k) ? i : acc), -1);
    check(`day ${di} (${d.name}): triceps isolation never precedes a compound press (tri@${firstTri}, press@${lastPress})`,
      firstTri === -1 || lastPress === -1 || firstTri > lastPress);
  });
}

console.log("\n== AUDIT 2.1(a): rep targets hold constant across a block; only EFFORT ramps ==");
{
  /* Originally: "intensification must not cut accessory reps on top of its
     other intensity levers". Intensification is gone, but the underlying rule
     survives and is now the shape of the whole accumulation block — progression
     within a block comes from added sets and added effort, never from silently
     moving the rep target underneath the athlete. */
  const at = (key, cyc) => {
    const p = fresh(); p.cycleIndex = dayWith(key);
    p.block = { type: "accumulation", cycle: cyc, sessionsInBlock: cyc * ROT, nextAfter: null };
    return prescribe(p, green).items.find((i) => i.key === key);
  };
  const last = BLOCKS.accumulation.maxCycles - 1;
  for (const key of ["tbarrow", "bsplit", "lateralraise"]) {
    const a = at(key, 0), b = at(key, last);
    check(`${key}: reps constant across the block (${a.reps} -> ${b.reps}), effort climbs (${a.rpe} -> ${b.rpe})`,
      a.reps === b.reps && b.rpe > a.rpe);
  }
  check(`compound tier is 8 reps, unilateral 10, isolation 12`,
    ACC_REP_TIERS.accumulation.compound.reps === 8 && ACC_REP_TIERS.accumulation.unilateral.reps === 10
    && ACC_REP_TIERS.accumulation.isolation.reps === 12);
}

console.log("\n== AUDIT 2.7: per-exercise load increments override the unit-default rounding step ==");
{
  // late-block loads where the finer step actually changes the rounded value vs. the old 5 lb default
  const late = { type: "accumulation", cycle: 5, sessionsInBlock: 20, nextAfter: null };
  const latpullover = itemOn("latpullover", late);
  const lateralraise = itemOn("lateralraise", late);
  const reversepecdeck = itemOn("reversepecdeck", late);
  check(`latpullover (increment: 10) rounds to a multiple of 10 (got ${latpullover.topLoad})`, latpullover.topLoad % 10 === 0);
  check(`lateralraise (increment: 2.5) lands on a non-5-multiple value the old step couldn't produce (got ${lateralraise.topLoad})`,
    lateralraise.topLoad % 2.5 === 0 && lateralraise.topLoad % 5 !== 0);
  check(`reversepecdeck (increment: 2.5) rounds to a multiple of 2.5 (got ${reversepecdeck.topLoad})`,
    reversepecdeck.topLoad % 2.5 === 0);
  // exercises without an `increment` still use the old unit-based step
  const bench = itemOn("bench", late);
  check(`bench (no increment set) still rounds to the unit-default 5 lb step (got ${bench.topLoad})`, bench.topLoad % 5 === 0);
}

console.log("\n== AUDIT 2.6: RPE-aware double-progression rep bump ==");
{
  /* accumulation cyc1 isolation target after the rebuild: rpe = min(9.5, 7.5 +
     0.5*1) = 8, rep target 12. The logged RPEs below are re-derived from that 8
     (they were derived from the old 8.5) so each still lands in the intended
     DP_RPE_GAP band — the bands themselves are unchanged. */
  const rx = (last) => { const p = fresh(); p.cycleIndex = dayWith("lateralraise");
    p.block = { type: "accumulation", cycle: 1, sessionsInBlock: ROT, nextAfter: null };
    p.lifts.lateralraise.last = last; return prescribe(p, green).items.find((i) => i.key === "lateralraise"); };
  const big = rx({ w: 30, reps: 9, rpe: 6 });     // gap 8-6=2.0 >= 1.5 -> bump 3
  check(`big RPE reserve earns a 3-rep bump (9 -> ${big.reps})`, big.reps === 12 && big.topLoad === 30);
  const med = rx({ w: 30, reps: 9, rpe: 7 });     // gap 1.0 -> in [0.5, 1.5) -> bump 2
  check(`medium RPE reserve earns a 2-rep bump (9 -> ${med.reps})`, med.reps === 11);
  const small = rx({ w: 30, reps: 9, rpe: 9.5 }); // gap -1 -> bump 1
  check(`set logged above target RPE earns only the old flat 1-rep bump (9 -> ${small.reps})`, small.reps === 10);
}

console.log("\n== AUDIT 2.6: overshoot converts to more than one load step, capped ==");
{
  const p = fresh(); p.cycleIndex = 3; p.block = { type: "accumulation", cycle: 1, sessionsInBlock: 4, nextAfter: null };
  p.lifts.lateralraise.last = { w: 30, reps: 20, rpe: 10 }; // target 12, overshoot 8 -> floor(8/2)+1=5, capped at DP_MAX_STEPS
  const hit = prescribe(p, green).items.find((i) => i.key === "lateralraise");
  check(`overshoot steps clamp at DP_MAX_STEPS (${DP_MAX_STEPS}) instead of jumping 5 steps (30 -> ${hit.topLoad}) and resets reps to ${DP_MIN_REPS}`,
    hit.topLoad === 30 + 2.5 * DP_MAX_STEPS && hit.reps === DP_MIN_REPS);
}

console.log("\n== AUDIT 2.6: stall-break cuts load after repeated non-advancing sessions ==");
{
  // athlete logs the exact same reps every session — the pre-fix engine reissues
  // "9 -> 10" forever with the load frozen; dpStalls should climb then trigger a cut.
  // The FIRST log has no prior `last` to compare against, so it can't count as a
  // stall by definition — reaching the threshold takes DP_STALL_THRESHOLD+1 sessions.
  let p = fresh();
  p.block = { type: "accumulation", cycle: 1, sessionsInBlock: 4, nextAfter: null };
  const log = (reps) => [{ key: "lateralraise", topWeight: 30, topReps: reps, topRpe: 8, targetRpe: 8, missedSets: 0 }];
  for (let i = 0; i < DP_STALL_THRESHOLD + 1; i++) { const r = ingest(p, log(9), green); p = r.next; }
  check(`dpStalls reaches the threshold after ${DP_STALL_THRESHOLD} non-advancing sessions (got ${p.lifts.lateralraise.dpStalls})`,
    p.lifts.lateralraise.dpStalls === DP_STALL_THRESHOLD);
  const rxAt = prescribe({ ...p, cycleIndex: 3 }, green).items.find((i) => i.key === "lateralraise");
  check(`load cuts by DP_STALL_DECAY once the threshold is hit (30 -> ${rxAt.topLoad}) and reps reset to ${DP_MIN_REPS}`,
    rxAt.topLoad === Math.round((30 * DP_STALL_DECAY) / 2.5) * 2.5 && rxAt.reps === DP_MIN_REPS);
  // logging that stall-break session resets the counter rather than letting it climb forever
  const r2 = ingest(p, log(9), green);
  check(`dpStalls resets after the stall-break session is served (got ${r2.next.lifts.lateralraise.dpStalls})`, r2.next.lifts.lateralraise.dpStalls === 0);
}

console.log("\n== AUDIT 2.6: honest RPE display flag ==");
{
  const p = fresh(); p.cycleIndex = 3; p.block = { type: "accumulation", cycle: 1, sessionsInBlock: 4, nextAfter: null };
  p.lifts.lateralraise.last = { w: 30, reps: 9, rpe: 8 };
  const items = prescribe(p, green).items;
  check("DP-mode isolation item is flagged dpMode:true", items.find((i) => i.key === "lateralraise").dpMode === true);
  check("isolation item with no DP history (first-ever session) is not flagged", items.find((i) => i.key === "triext").dpMode === false);
  check("compound item is never DP-flagged (double progression is isolation-only)", items.find((i) => i.key === "pullup").dpMode === false);
}

console.log("\n== AUDIT 2.9: the session's first barbell lift never opens on a single warmup set ==");
{
  /* Previously this needed a synthetic block config to reach a %1RM below the
     0.70 "minimal" boundary, because no real block put a MAIN lift there. The
     hypertrophy rebuild makes the case REAL and reachable: a deload compound is
     8 reps at RPE 6, and rpePct(8,6)=0.68. Day 0 in a deload block is therefore
     a natural experiment — bench is the day's FIRST barbell lift and gets
     floored up to "short", while squat sits later on the same day at the very
     same 0.68 and correctly stays "minimal". No synthetic block needed. */
  const dl = { type: "deload", cycle: 0, sessionsInBlock: 0, nextAfter: null };
  const p = fresh(); p.cycleIndex = 0; p.block = dl;
  const items = prescribe(p, green).items;
  const bench = items.find((i) => i.key === "bench");     // day 0's FIRST barbell lift
  const squat = items.find((i) => i.key === "squat");     // a LATER barbell lift, same day
  check(`baseTier without the floor would be "minimal" (pct=${rpePct(bench.reps, bench.rpe).toFixed(3)} < 0.70)`,
    rpePct(bench.reps, bench.rpe) < 0.70);
  check(`first-barbell floor bumps it to short instead (type=${bench.warmup?.type}, ${bench.warmup?.sets?.length} sets)`,
    bench.warmup?.type === "short" && bench.warmup.sets.length === 2);
  check(`a LATER barbell lift at the identical %1RM is NOT floored (squat pct=${rpePct(squat.reps, squat.rpe).toFixed(3)}, type=${squat.warmup?.type})`,
    rpePct(squat.reps, squat.rpe) === rpePct(bench.reps, bench.rpe) && squat.warmup?.type === "minimal");
  check("the floor is about session position, not the exercise — same lift, different index, different tier",
    bench.warmup.sets.length > squat.warmup.sets.length);
}

console.log("\n== AUDIT 2.10: feeler steps track priming — cold gets 2, primed gets 1 ==");
{
  const p = fresh(); p.cycleIndex = 2; p.block = { type: "accumulation", cycle: 0, sessionsInBlock: 0, nextAfter: null };
  const items = prescribe(p, green).items;
  const dip = items.find((i) => i.key === "dip");                         // chest, primed by inclinebench at idx0
  const dbshoulderpress = items.find((i) => i.key === "dbshoulderpress"); // front_delts, cold
  const bsplit = items.find((i) => i.key === "bsplit");                   // quads, cold
  check(`primed accessory (dip, after inclinebench) keeps the 1-step feeler (${dip.warmup?.sets?.length} steps)`,
    dip.warmup?.sets?.length === 1);
  check(`cold accessory (dbshoulderpress) gets a 2-step feeler (${dbshoulderpress.warmup?.sets?.length} steps)`,
    dbshoulderpress.warmup?.sets?.length === 2 && dbshoulderpress.warmup.sets[0].weight < dbshoulderpress.warmup.sets[1].weight);
  check(`another cold accessory (bsplit) also gets 2 steps (${bsplit.warmup?.sets?.length} steps)`,
    bsplit.warmup?.sets?.length === 2);
  // every feeler step must still land strictly below the working load
  for (const it of [dip, dbshoulderpress, bsplit])
    check(`${it.key}: every feeler step < topLoad (${it.warmup.sets.map((s) => s.weight)} < ${it.topLoad})`,
      it.warmup.sets.every((s) => s.weight < it.topLoad));
}

console.log("\n== AUDIT 2.12: isolation accessories earn a feeler once load crosses the absolute floor ==");
{
  const p = fresh(); p.cycleIndex = 0; p.block = { type: "accumulation", cycle: 0, sessionsInBlock: 0, nextAfter: null };
  const items = prescribe(p, green).items;
  const legext = items.find((i) => i.key === "legext");           // >= floor
  const calfraise = items.find((i) => i.key === "calfraise");     // >= floor
  const triext = items.find((i) => i.key === "triext");           // < floor
  const cablecrunch = items.find((i) => i.key === "cablecrunch"); // < floor
  check(`legext (${legext.topLoad} lb, >= ${FEELER_LOAD_FLOOR_LB}) earns a feeler`, legext.warmup?.type === "feeler");
  check(`calfraise (${calfraise.topLoad} lb, >= ${FEELER_LOAD_FLOOR_LB}) earns a feeler`, calfraise.warmup?.type === "feeler");
  check(`triext (${triext.topLoad} lb, < ${FEELER_LOAD_FLOOR_LB}) stays exempt (self-warms)`, triext.warmup == null);
  check(`cablecrunch (${cablecrunch.topLoad} lb, < ${FEELER_LOAD_FLOOR_LB}) stays exempt (self-warms)`, cablecrunch.warmup == null);
  check("the floor is about absolute load, not tier — both sides here are isolation",
    LIB.legext.repTier === "isolation" && LIB.triext.repTier === "isolation");
}

console.log("\n== AUDIT 3.1/3.9: absent or malformed readiness is 'no evidence', never max deficit or NaN ==");
{
  const mkLogs = (p) => prescribe(p, green).items.map((it) => ({ key: it.key, topWeight: it.topLoad,
    topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe, missedSets: 0, touched: true,
    backoffSetCount: it.backoffSetCount, backoffReps: it.reps, backoffRpe: it.rpe, backoffRpeCap: it.backoffRpeCap }));
  check("readinessScore({}) is null, not NaN", readinessScore({}) === null);
  check("readinessScore({trainingReadiness:null}) is null, not 0 (0 would read as MAXIMUM deficit)",
    readinessScore({ trainingReadiness: null }) === null);
  check("readinessScore still maps a real reading normally (65 -> 0.65)", readinessScore({ trainingReadiness: 65 }) === 0.65);

  // ingest must not throw on a missing readiness arg (prescribe already guards it)
  let threw = false;
  try { ingest(fresh(), mkLogs(fresh()), undefined); } catch { threw = true; }
  check("ingest() with no readiness argument does not throw", !threw);

  // the critical property: one malformed session must not permanently poison the index
  { let p = ingest(fresh(), mkLogs(fresh()), {}).next;
    check(`malformed readiness leaves a finite index (got ${p.fatigue.index})`, Number.isFinite(p.fatigue.index));
    for (let i = 0; i < 5; i++) p = ingest(p, mkLogs(p), green).next;
    check(`index stays finite after 5 later GOOD sessions (got ${p.fatigue.index.toFixed(4)}) — pre-fix this was NaN forever`,
      Number.isFinite(p.fatigue.index)); }

  // same defect class, second entry point: a main log missing targetRpe
  { const noTarget = (p) => mkLogs(p).map((l) => { const { targetRpe, ...rest } = l; return rest; });
    let p = ingest(fresh(), noTarget(fresh()), green).next;
    check(`main log missing targetRpe leaves rpeCreep finite (got ${p.fatigue.rpeCreep})`, Number.isFinite(p.fatigue.rpeCreep));
    for (let i = 0; i < 5; i++) p = ingest(p, mkLogs(p), green).next;
    check(`index recovers after later well-formed sessions (got ${p.fatigue.index.toFixed(4)})`, Number.isFinite(p.fatigue.index)); }

  // and a null reading must not silently cut the session like a red-band day would
  const rxNull = prescribe(fresh(), { trainingReadiness: null });
  const rxNone = prescribe(fresh(), null);
  check(`null readiness prescribes the same as no readiness at all (band green, not red): ${rxNull.band}`,
    rxNull.band === "green" && rxNull.band === rxNone.band && rxNull.setMult === rxNone.setMult);
}

console.log("\n== AUDIT 3.2: e1RM slope window is odd-length, cancelling the heavy/volume-day sawtooth ==");
{
  /* squat/bench log TWO readings per rotation at different rep targets, so a
     rep-profile mismatch makes the raw series alternate. An even-length OLS
     window leaks that into the slope; an odd one cancels it exactly. */
  const alt = (n) => { const ys = []; for (let i = 0; i < n; i++) ys.push(1 + ((n - 1 - i) % 2 === 0 ? -1 : 1)); return ys; };
  check(`even window leaks the alternation (n=4 -> ${slope(alt(4)).toFixed(4)}, n=6 -> ${slope(alt(6)).toFixed(4)}, n=8 -> ${slope(alt(8)).toFixed(4)})`,
    slope(alt(4)) < -0.3 && slope(alt(6)) < -0.1 && slope(alt(8)) < -0.05);
  check("odd windows cancel it exactly (n=3,5,7 all 0)",
    slope(alt(3)) === 0 && slope(alt(5)) === 0 && slope(alt(7)) === 0);

  // liftSlopeInfo must hand slope() an odd-length series at every run length
  const mkHist = (n) => ({ e1rm: 100, hist: Array.from({ length: n }, (_, i) => ({ e: 100, raw: 100 + (i % 2 ? 5 : -5), b: "accumulation" })) });
  for (const n of [4, 6, 8, 12]) {
    const info = liftSlopeInfo(mkHist(n));
    check(`hist run of ${n} yields an ODD fit window (n=${info.n})`, info.n % 2 === 1);
  }
  check("a run too short to fit still reports n=0 (unchanged)", liftSlopeInfo(mkHist(2)).n === 0);

  /* End-to-end. The original scenario here was specific to the strength
     program: squat and bench each logged TWO readings per rotation at
     DIFFERENT rep targets (heavy day 5s, volume day 8s), and a rep-profile
     mismatch made the raw e1RM series alternate, which an even-length OLS
     window leaked into the slope. The hypertrophy rebuild removed the volume
     day — every exercise now runs one rep target every time it appears — so
     that particular sawtooth cannot occur. The odd-window property is still
     verified above against alternation from ANY source, which is the durable
     part of the fix.
     What is worth pinning end-to-end is the property the sawtooth was breaking:
     a genuinely progressing athlete's growth signal must clear GROWTH_POS, both
     per-lift and at the POOL level (which is what the landmark auto-tune
     actually reads now that PATTERN_MAIN is empty). +0.4%/wk of real progress,
     logged honestly through the real prescribe/ingest path. */
  const p0 = fresh(); const trueE1 = {};
  Object.keys(p0.lifts).forEach((k) => { trueE1[k] = p0.lifts[k].e1rm; });
  let p = p0;
  for (let i = 0; i < 16; i++) {
    const rx = prescribe(p, green);
    const logs = rx.items.map((it) => {
      const real = trueE1[it.key] * rpePct(it.reps, it.rpe);
      return { key: it.key, topWeight: LIB[it.key].bodyweight ? it.topLoad : Math.round(real / 5) * 5,
        topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe, missedSets: 0, touched: true,
        backoffSetCount: it.backoffSetCount, backoffReps: it.reps,
        backoffRpe: Math.min(it.rpe, it.backoffRpeCap ?? it.rpe), backoffRpeCap: it.backoffRpeCap };
    });
    CLOCK += 1.75 * 86400000;
    Object.keys(trueE1).forEach((k) => { trueE1[k] *= (1 + 0.004 * 1.75 / 7); });
    p = ingest(p, logs, green).next;
  }
  for (const k of ["squat", "bench", "tbarrow"]) {
    const info = liftSlopeInfo(p.lifts[k]);
    check(`${k}: a real +0.4%/wk athlete clears GROWTH_POS (g=${info.g.toFixed(6)} > ${GROWTH_POS}, n=${info.n})`,
      info.g > GROWTH_POS);
    check(`${k}: the fit window is odd-length end-to-end (n=${info.n})`, info.n % 2 === 1);
  }
  for (const g of ["quads", "chest", "back"]) {
    const info = patternGrowth(p, g);
    check(`${g} POOL slope clears GROWTH_POS (g=${info.g.toFixed(6)} > ${GROWTH_POS}, n=${info.n}) — this is what the auto-tune reads`,
      info.g > GROWTH_POS);
  }
}

console.log("\n== AUDIT 3.7: a layoff is excluded from the frequency estimate, so it can't inflate comeback volume ==");
{
  const mkLogs = (p) => prescribe(p, green).items.map((it) => ({ key: it.key, topWeight: it.topLoad,
    topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe, missedSets: 0, touched: true,
    backoffSetCount: it.backoffSetCount, backoffReps: it.reps, backoffRpe: it.rpe, backoffRpeCap: it.backoffRpeCap }));
  let p = fresh();
  for (let i = 0; i < 12; i++) { CLOCK += 1.75 * 86400000; p = ingest(p, mkLogs(p), green).next; }
  const settledGap = p.avgSessionGapDays, settledScale = wfs(settledGap);
  check(`settled 4x/week athlete sits at freqScale 1 (gap=${settledGap.toFixed(2)}, fs=${settledScale.toFixed(3)})`,
    Math.abs(settledScale - 1) < 1e-9);

  CLOCK += 21 * 86400000; // 3-week layoff, then the comeback session is logged
  p = ingest(p, mkLogs(p), green).next;
  check(`the 21-day gap does NOT move the frequency estimate (gap still ${p.avgSessionGapDays.toFixed(2)})`,
    Math.abs(p.avgSessionGapDays - settledGap) < 1e-9);
  check(`freqScale is unchanged after the layoff (fs=${wfs(p.avgSessionGapDays).toFixed(3)}) — pre-fix it hit the 1.8 clamp and PRESCRIBED MORE SETS on the comeback`,
    Math.abs(wfs(p.avgSessionGapDays) - 1) < 1e-9);

  // normal gaps must still be tracked — the fix must not freeze the estimator
  let q = fresh();
  for (let i = 0; i < 12; i++) { CLOCK += 3 * 86400000; q = ingest(q, mkLogs(q), green).next; }
  check(`a genuine 3-day cadence is still learned (gap=${q.avgSessionGapDays.toFixed(2)} -> fs=${wfs(q.avgSessionGapDays).toFixed(2)})`,
    q.avgSessionGapDays > 2.9 && wfs(q.avgSessionGapDays) > 1.2);
}

console.log("\n== AUDIT 3.4: fatigue channels can reach their nominal weights (recovery is no longer double-applied) ==");
{
  /* An EWMA already carries its own retention term, so the old pre-EWMA
     `*= (1 - recoveryFactor)` applied recovery twice and pinned every channel
     to a fraction of its input: readSupp settled at 0.424x the readiness
     deficit at 4x/week, rpeCreep at 0.533x its input. The composite index
     therefore could not reach the thresholds written against it. */
  const drive = ({ rpeOver, readiness, missFrac, sessions = 50 }) => {
    let p = fresh();
    const rd = { trainingReadiness: readiness };
    for (let i = 0; i < sessions; i++) {
      const rx = prescribe(p, rd);
      const logs = rx.items.map((it, j) => ({ key: it.key, topWeight: it.topLoad, topReps: it.reps,
        topRpe: it.rpe + rpeOver, targetRpe: it.rpe, missedSets: (j / rx.items.length) < missFrac ? 1 : 0, touched: true,
        backoffSetCount: it.backoffSetCount, backoffReps: it.reps,
        backoffRpe: (it.backoffRpeCap ?? it.rpe) + rpeOver, backoffRpeCap: it.backoffRpeCap }));
      CLOCK += 1.75 * 86400000;
      p = ingest(p, logs, rd).next;
    }
    return p.fatigue;
  };
  // readSupp must converge on the FULL deficit, not ~0.42x of it
  const steady = drive({ rpeOver: 0, readiness: 50, missFrac: 0 });
  check(`readSupp converges on the true readiness deficit (got ${steady.readSupp.toFixed(3)}, deficit 0.500; pre-fix ~0.212)`,
    Math.abs(steady.readSupp - 0.5) < 0.02);

  const healthy = drive({ rpeOver: 0, readiness: 80, missFrac: 0 });
  const bad = drive({ rpeOver: 1, readiness: 45, missFrac: 0.4 });
  check(`healthy training stays well clear of every threshold (index ${healthy.index.toFixed(3)} < ${FATIGUE_STILL_ELEVATED})`,
    healthy.index < FATIGUE_STILL_ELEVATED);
  check(`a realistically bad week now REACHES the deload trigger (index ${bad.index.toFixed(3)} >= ${FATIGUE_SPIKE}) — pre-fix it peaked at 0.427 and the trigger was unreachable`,
    bad.index >= FATIGUE_SPIKE);
  check(`the two regimes are cleanly separated (${healthy.index.toFixed(3)} vs ${bad.index.toFixed(3)})`,
    bad.index - healthy.index > 0.5);

  /* the one place the recovery decay still belongs: no touched mains means
     nothing supersedes the stored creep, so time decays it — ONCE. */
  { const p = fresh(); p.fatigue.rpeCreep = 1.2; p.lastSessionAt = CLOCK;
    CLOCK += 3 * 86400000; // full recoveryFactor of 1
    const r = ingest(p, [{ key: "curl", topWeight: 60, topReps: 12, topRpe: 8, targetRpe: 8, missedSets: 0, touched: true }], green);
    check(`no touched mains: creep decays by recovery alone (1.2 -> ${r.next.fatigue.rpeCreep.toFixed(3)})`,
      r.next.fatigue.rpeCreep === 0); }
}

console.log("\n== AUDIT 3.5: MEV cannot ratchet past MAV ==");
{
  /* Growth is driven across the whole chest pool: PATTERN_MAIN is empty since
     the hypertrophy rebuild, so no single lift carries a group's slope. */
  const mk = () => { const p = fresh(); setPoolHist(p, "chest", [225, 227, 229, 231]); return p; };
  // headroom case: MEV well below MAV still raises normally
  const below = adjustLandmarks(mk()).adjustments.chest;
  check(`MEV still raises when it sits below MAV (${below?.before.mev} -> ${below?.after.mev})`, below && below.dMev === 1);
  // at-MAV case: the new guard blocks it
  const p2 = mk(); p2.landmarks.chest.mev = p2.landmarks.chest.mav; // 14/14
  const atMav = adjustLandmarks(p2).adjustments.chest;
  check(`MEV at MAV (${p2.landmarks.chest.mev}/${p2.landmarks.chest.mav}) is NOT raised further (adjustment: ${atMav ? `dMev ${atMav.dMev}` : "none"})`,
    !atMav || atMav.dMev === 0);
  /* The ratchet this guard prevents: MEV climbing until it swallows the whole
     MEV->MAV ramp. The rebuild makes that MORE important, not less — MAV is now
     the ramp's endpoint, so an unbounded MEV would collapse the block into a
     flat line at MAV from cycle 0 (exactly the fully-ratcheted state the
     atVolCeiling test constructs on purpose). Verified directly: repeated
     auto-tune passes on a strongly-growing pool never push MEV past MAV. */
  let ratchet = mk();
  for (let i = 0; i < 12; i++) {
    const { landmarks } = adjustLandmarks(ratchet);
    ratchet = { ...ratchet, landmarks };
  }
  check(`after 12 auto-tune passes on strong growth, chest MEV (${ratchet.landmarks.chest.mev}) never exceeds MAV (${ratchet.landmarks.chest.mav})`,
    ratchet.landmarks.chest.mev <= ratchet.landmarks.chest.mav);
  check(`and MAV itself stays under MRV (${ratchet.landmarks.chest.mav} < ${ratchet.landmarks.chest.mrv})`,
    ratchet.landmarks.chest.mav < ratchet.landmarks.chest.mrv);
  check(`MAV did rise over those passes (progression across mesocycles is real: ${landmarksForExperience("intermediate").chest.mav} -> ${ratchet.landmarks.chest.mav})`,
    ratchet.landmarks.chest.mav > landmarksForExperience("intermediate").chest.mav);
}

console.log("\n== AUDIT 3.6/3.8 (resolved by the rebuild): the schedule can deliver every group's target ==");
{
  const lm = landmarksForExperience("intermediate");
  /* These two audits documented a program whose ROTATION could not deliver the
     volume its own landmark table asked for. 3.6 guarded against reporting that
     shortfall as "reached its volume ceiling"; 3.8 recorded, as a KNOWN
     LIMITATION, that the stall-notice gate was unsatisfiable for the starved
     groups and that the obvious min(mav, capW) repair was an inert no-op.
     The hypertrophy rebuild resolves the underlying condition rather than
     working around it: the rotation was rebuilt around slot counts derived FROM
     the landmark table (see the slot budget in the ROTATION comment), and the
     ramp now tops out at MAV. So the assertions here invert — the property
     worth pinning is that NO group is capacity-starved any more. The guard code
     itself is still exercised below against a synthetic starved landmark set,
     so removing the real starvation doesn't quietly drop its coverage. */
  const starved = Object.keys(lm).filter((g) => maxDeliverable(g, "accumulation") < lm[g].mav);
  check(`no group's MAV is above what the schedule can deliver (${starved.length} starved: [${starved.join(",")}])`,
    starved.length === 0);
  Object.keys(lm).forEach((g) => {
    const cap = maxDeliverable(g, "accumulation");
    check(`${g}: capacity ${cap} >= MAV ${lm[g].mav}`, cap >= lm[g].mav);
  });

  /* The 3.6 guard, exercised on a SYNTHETIC starved group: if capacity can't
     reach the ramp's top, saturation must not be read as volume tolerance. */
  {
    const p = fresh();
    setPoolHist(p, "front_delts", [100, 100, 100]);
    p.fatigue.index = 0.3;
    const capW = maxDeliverable("front_delts", "accumulation");
    p.landmarks.front_delts = { ...p.landmarks.front_delts, mav: capW + 5, mrv: capW + 8 };
    const { stallStreaks } = adjustLandmarks(p);
    check(`a capacity-starved group (cap ${capW} < mav ${capW + 5}) does NOT accrue a stall streak — saturation there is a capacity story`,
      !stallStreaks.front_delts);
  }
  /* ...and the same group, once its MAV is inside capacity, DOES accrue one.
     This is the case AUDIT 3.8 recorded as unreachable; the rebuild's
     reachedCeiling redefinition (capacity-limited, not "ramp completed") makes
     it reachable, which is the whole point of the stall notice. */
  {
    const p = fresh();
    setPoolHist(p, "front_delts", [100, 100, 100]);
    p.fatigue.index = 0.3;
    p.landmarks.front_delts = { ...p.landmarks.front_delts, mav: 4, mrv: 12 };
    const { stallStreaks } = adjustLandmarks(p);
    check(`the same group with an in-capacity MAV DOES accrue a stall streak (got ${stallStreaks.front_delts}) — AUDIT 3.8's unreachable case is now reachable`,
      stallStreaks.front_delts === 1);
  }
}

console.log("\n== AUDIT 3.12 (re-derived): true-weekly volume is frequency-INDEPENDENT now that capacity has headroom ==");
{
  /* The original 3.12 finding was that an athlete could reach a volume target
     the schedule otherwise couldn't deliver simply by training more often —
     because fixedWeeklySets/ACC_SET_CAP are unscaled by freqScale, so a faster
     rotation delivers each contribution more times per real week. That was a
     workaround for a capacity-starved rotation, and it is why no tier-based
     capacity scaling was ever added.
     With the rebuilt rotation the starvation is gone, and the mechanism's
     CORRECT behavior surfaces instead: freqScale's two halves (scale the target
     up, divide the delivered total back down) are inverse operations, so the
     true-weekly rate an athlete receives is approximately the same at any
     sustainable cadence. That is the right answer — a weekly landmark should
     mean the same number of weekly sets whether you train 3x or 6x — and it
     only holds because capacity no longer clamps the ramp. Frequency remains a
     distribution tool (it keeps per-SESSION volume under the diminishing-returns
     ceiling), not a lever on weekly totals. */
  const lm = landmarksForExperience("advanced");
  const last = BLOCKS.accumulation.maxCycles - 1;
  const trueWeekly = (g, gap) => { const fs = wfs(gap); return deliveredWeekly(g, "accumulation", last, lm, fs) / fs; };
  const cadences = [7 / 3, 1.75, 7 / 5, 7 / 6]; // 3x .. 6x per week
  for (const g of ["chest", "back", "quads", "biceps"]) {
    const rates = cadences.map((c) => trueWeekly(g, c));
    const spread = Math.max(...rates) - Math.min(...rates);
    /* Tolerance, not equality: freqScale's two halves are exact inverses only
       before rounding, and rampedSlotSets rounds to whole sets per slot, so a
       group with 4 slots can drift a few sets either way. 8 is ~1 set per slot
       per rotation — enough headroom for that rounding, tight enough that a
       real regression to frequency-dependent volume would break it. */
    check(`${g}: true-weekly volume is stable across 3x-6x cadence (${rates.map((r) => r.toFixed(1)).join(", ")}; spread ${spread.toFixed(1)} <= 8)`,
      spread <= 8);
    check(`${g}: every cadence still delivers at least MEV (${lm[g].mev})`, rates.every((r) => r >= lm[g].mev));
  }
  // and the reason it can hold: capacity is above the ramp's endpoint everywhere
  const headroom = Object.keys(lm).every((g) => maxDeliverable(g, "accumulation") >= lm[g].mav);
  check("frequency-independence is possible because capacity >= MAV for every group at the advanced tier", headroom);

  // per-SESSION volume still falls as frequency rises — the actual job frequency does
  const perSession = (gap) => {
    const p = freshProgram({ seeds, experience: "advanced", unit: "lb", goal: "hypertrophy", bodyweight: 220 });
    p.avgSessionGapDays = gap;
    p.block = { type: "accumulation", cycle: last, sessionsInBlock: last * ROT, nextAfter: null };
    let mx = 0;
    for (let d = 0; d < ROT; d++) { p.cycleIndex = d; mx = Math.max(mx, prescribe(p, green).items.reduce((s, it) => s + it.sets, 0)); }
    return mx;
  };
  const at3x = perSession(7 / 3), at6x = perSession(7 / 6);
  check(`peak session shrinks as cadence rises (3x/wk=${at3x} sets -> 6x/wk=${at6x}) — frequency spreads volume, it doesn't add it`,
    at6x <= at3x);
}

console.log("\n== AUDIT 3.13: same-day same-muscle volume is capped, not multiplied by stacked slots ==");
{
  const mk = (dayIdx, cyc) => { const p = fresh(); p.cycleIndex = dayIdx; p.block = { type: "accumulation", cycle: cyc, sessionsInBlock: cyc * ROT, nextAfter: null }; return prescribe(p, green); };
  const last = BLOCKS.accumulation.maxCycles - 1;
  const groupSets = (rx, g) => rx.items.filter((it) => it.volumeGroup === g && !LIB[it.key].fixedSets);
  const sum = (arr) => arr.reduce((s, i) => s + i.sets, 0);

  /* Which (day, group) pairs actually stack more than one ramped slot — derived
     from ROTATION rather than hardcoded, so this keeps testing the real stacking
     sites if the rotation is edited again. */
  const stacked = [];
  ROTATION.forEach((d, di) => {
    const counts = {};
    d.items.forEach((k) => { if (!LIB[k].fixedSets) counts[LIB[k].volumeGroup] = (counts[LIB[k].volumeGroup] || 0) + 1; });
    Object.entries(counts).forEach(([g, n]) => { if (n > 1) stacked.push([di, d.name, g, n]); });
  });
  check(`the rotation really does stack some muscles on a day (${stacked.length} site(s))`, stacked.length > 0);
  stacked.forEach(([di, name, g, n]) => {
    const items = groupSets(mk(di, last), g);
    check(`day ${di} (${name}) ${g}: ${n} stacked slots total ${sum(items)} <= cap ${SAME_DAY_GROUP_CAP} (${items.map((i) => i.sets).join("+")})`,
      sum(items) <= SAME_DAY_GROUP_CAP);
    check(`day ${di} (${name}) ${g}: the cap splits across slots, never zeroing one out`, items.every((i) => i.sets >= 1));
  });

  // early block (under the cap) must be untouched
  stacked.forEach(([di, name, g]) => {
    const early = groupSets(mk(di, 0), g);
    check(`day ${di} (${name}) ${g}: early-block volume is under the cap and unmodified (${sum(early)} < ${SAME_DAY_GROUP_CAP})`,
      sum(early) < SAME_DAY_GROUP_CAP);
  });

  // groups that don't stack (only ever one ramped slot/day) must be completely unaffected
  const bsplit = mk(dayWith("bsplit"), last).items.find((it) => it.key === "bsplit");
  const uncappedShare = rampedSlotSets("quads", "accumulation", last, landmarksForExperience("intermediate"), 1);
  check(`a non-stacked slot keeps its full uncapped share (bsplit=${bsplit.sets}, share=${uncappedShare})`,
    bsplit.sets === uncappedShare);
}

Date.now = RealNow;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
