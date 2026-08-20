/* ============================================================================
   Targeted regression tests for the methodology-review fixes (P0–P3).
   Run with: node engine_fix_tests.mjs   (also wired into `npm test`).
   Each assertion is written to FAIL on the pre-fix engine and pass after —
   these verify the fixes numerically, not just that the code runs.
   ============================================================================ */
import {
  freshProgram, prescribe, ingest, applyTransition, adjustLandmarks, migrateProgram, liftNormSlope,
  deliveredWeekly, effectiveCeiling, maxDeliverable, weeklyFreqScale, landmarksForExperience,
  BLOCKS, ROTATION, ROT, LIB, PATTERNS, ACC_REP_TIERS,
  buildRamp, FULL_RAMP, rpePct, repsAtPct, e1rmFromBW, BW_REPONLY_FLOOR,
  E1RM_MIN_RPE, LAYOFF_THRESHOLD_DAYS, LAYOFF_MAX_DECAY, DP_MIN_REPS, STALL_STREAK_THRESHOLD,
  VOLUME_DAY_REP_BUMP, VOLUME_DAY_RPE_CAP,
  DP_MAX_STEPS, DP_STALL_THRESHOLD, DP_STALL_DECAY, RETURN_RPE_CAP, RETURN_SET_MULT,
  FEELER_LOAD_FLOOR_LB, readinessScore, liftSlopeInfo, slope, weeklyFreqScale as wfs,
  FATIGUE_SPIKE, FATIGUE_STILL_ELEVATED,
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
  /* Steadily-improving athlete, green readiness, RPE on target: no stall, no
     fatigue spike — the ONLY trigger available before maxCycles is the volume
     ceiling.
     AUDIT 3.11: at the plain ~3.5x/week cadence this test used pre-3.11
     (CLOCK += 2 days/session, no pinning), quads/hamstrings are no longer
     capacity-frozen at all (the whole point of the capacity fix) and chest's
     capacity-driven saturation point now lands so close to its own ramp
     endpoint that it coincides with maxCycles by construction — weeklyTarget
     is a straight line from MEV at cyc 0 to MRV at cyc (maxCycles-1), so
     absent a capacity ceiling BELOW that line, "reached the ceiling" and
     "hit max block length" happen in the same session, and the code reports
     maxedTime (checked first). Demonstrating the ceiling trigger fires
     independently now needs a frequency where a still-capacity-frozen group
     (chest) saturates meaningfully before the ramp's own endpoint: pinning
     avgSessionGapDays to 2.2 (~3.2x/week, freqScale 1.257) puts chest's true
     weekly capacity at 15.9 — above its MAV of 14 (below MAV would trip the
     3.6 fix's "capacity saturation isn't ceiling evidence" gate) and below
     its MRV of 22 — so it saturates by cyc 3 and holds through cyc 5,
     firing one full cycle before maxCycles=6. */
  let p = fresh();
  const pinnedGap = 2.2;
  p.avgSessionGapDays = pinnedGap;
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
    CLOCK += pinnedGap * 86400000;
    const r = ingest(p, logs, green);
    r.next.avgSessionGapDays = pinnedGap; // keep pinned so the cadence stays exactly what the math above assumes
    p = r.next; transition = r.transition; sessions++;
  }
  check("accumulation ends via a transition", !!transition, "none fired in 40 sessions");
  check(`transition reason is the volume ceiling ("${transition?.reason}")`, /ceiling/.test(transition?.reason || ""));
  check(`fires before maxCycles (cyc ${p.block.cycle} < ${BLOCKS.accumulation.maxCycles})`, p.block.cycle < BLOCKS.accumulation.maxCycles);
}

console.log("\n== P0: auto-tune won't drift MRV past deliverable capacity ==");
{
  /* AUDIT 3.11: quads is no longer capacity-frozen at intermediate defaults
     (RP-aligned MRV 18 <= the ACC_SET_CAP=6 capacity of 23) — the whole point
     of that fix. chest still is (MRV 22 > capA 20), so this test moved to
     chest/bench, the same pattern (a PATTERN_MAIN-driven group with a clean
     growth signal on its main lift) applied to a group the fix didn't reach. */
  const p = fresh();
  p.lifts.bench.hist = [225, 227, 229, 231].map((r) => ({ e: r, raw: r, b: "accumulation" }));
  p.lifts.bench.e1rm = 231;
  const { adjustments } = adjustLandmarks(p);
  const adj = adjustments.chest;
  const capA = maxDeliverable("chest", "accumulation");
  check(`chest adjustment exists (growth strong)`, !!adj);
  check(`sanity: chest really is still capacity-frozen post-3.11 (capA=${capA} < mrv=${p.landmarks.chest.mrv})`, capA < p.landmarks.chest.mrv);
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
  p.lifts.squat.hist = [300, 304, 308, 312].map((r) => ({ e: r, raw: r, b: "accumulation" }));
  p.lifts.squat.e1rm = 312;
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
  const flatHist = () => [300, 300, 300].map((r) => ({ e: r, raw: r, b: "accumulation" }));
  const risingHist = () => [300, 304, 308, 312].map((r) => ({ e: r, raw: r, b: "accumulation" }));

  // 1. all three gates clear (volume>=mav, fatigue comfortable, not at ceiling) -> streak increments
  {
    const p = fresh();
    p.lifts.squat.hist = flatHist(); p.lifts.squat.e1rm = 300;
    p.fatigue.index = 0.3; // comfortable (< FATIGUE_SPIKE 0.7)
    p.landmarks.quads.mav = 8; // <= deliveredWeekly(10): volume gate clears
    const { stallStreaks } = adjustLandmarks(p);
    check(`flat growth + volume>=mav + fatigue ok + not at ceiling -> streak increments (0 -> ${stallStreaks.quads})`,
      stallStreaks.quads === 1);
  }

  // 2. growth resumes -> streak resets to 0 and any live notice is cleared,
  //    regardless of how high the streak already was
  {
    const p = fresh();
    p.lifts.squat.hist = risingHist(); p.lifts.squat.e1rm = 312; // real growth
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
    p.lifts.squat.hist = flatHist(); p.lifts.squat.e1rm = 300;
    p.fatigue.index = 0.3;
    // default quads mav=14 > deliveredWeekly(10): volume gate fails, no landmark edit needed
    p.stallStreaks = { quads: 2 };
    const { stallStreaks } = adjustLandmarks(p);
    check(`volume below MAV -> streak unchanged (stayed 2, got ${stallStreaks.quads})`, stallStreaks.quads === 2);
  }

  // 4. flat growth, volume clears, but fatigue is SPIKED -> streak left unchanged
  {
    const p = fresh();
    p.lifts.squat.hist = flatHist(); p.lifts.squat.e1rm = 300;
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
    p.lifts.squat.hist = flatHist(); p.lifts.squat.e1rm = 300;
    p.fatigue.index = 0.3;
    p.landmarks.quads.mav = 8;
    p.landmarks.quads.mrv = 10; // effectiveCeiling(10,16)=10 <= deliveredWeekly(10): reachedCeiling=true
    p.stallStreaks = { quads: 2 };
    const { stallStreaks } = adjustLandmarks(p);
    check(`at ceiling -> streak unchanged (stayed 2, got ${stallStreaks.quads})`, stallStreaks.quads === 2);
  }

  // 6. notice appears exactly at STALL_STREAK_THRESHOLD, not before, across
  //    consecutive all-clear calls (simulating consecutive stalled blocks) —
  //    plus migrateProgram backfills the two new fields for an old save.
  {
    let p = fresh();
    p.lifts.squat.hist = flatHist(); p.lifts.squat.e1rm = 300;
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
    const flatHist = () => [300, 300, 300].map((r) => ({ e: r, raw: r, b: "accumulation" }));
    const p = fresh();
    p.lifts.squat.hist = flatHist(); p.lifts.squat.e1rm = 300;
    p.fatigue.index = 0.3;
    p.landmarks.quads.mav = 8; // volume gate clears (deliveredWeekly(quads, cyc0)=10 >= 8)
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

    const flatHist = () => [300, 300, 300].map((r) => ({ e: r, raw: r, b: "accumulation" }));
    const p = fresh();
    p.lifts.squat.hist = flatHist(); p.lifts.squat.e1rm = 300;
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
    const flatHist = () => [300, 300, 300].map((r) => ({ e: r, raw: r, b: "accumulation" }));
    const p = fresh();
    p.lifts.squat.hist = flatHist(); p.lifts.squat.e1rm = 300;
    p.fatigue.index = 0.3;
    p.avgSessionGapDays = 7 / 3;
    p.landmarks.quads.mav = 8; // below both old(10) and new(9.00) -> both agree it clears
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
  // pre-fix a 45-day layoff returning into intensification prescribed full reps/RPE/sets —
  // only the load itself was cut. Intensification: mainSets=4, rpeBase=8.5 (cyc0).
  const intens = { type: "intensification", cycle: 0, sessionsInBlock: 0, nextAfter: null };
  const mk = (daysAgo, sessionsSinceLayoff) => { const p = fresh(); p.cycleIndex = 0; p.block = intens;
    if (daysAgo != null) p.lastSessionAt = Date.now() - daysAgo * 86400000;
    if (sessionsSinceLayoff !== undefined) p.sessionsSinceLayoff = sessionsSinceLayoff;
    return p; };
  const baseline = prescribe(mk(2), green);
  const comeback = prescribe(mk(45), green);
  const sq = (rx) => rx.items.find((i) => i.key === "squat");
  check(`baseline (no layoff) runs the block's full RPE ceiling (${baseline.rpeTop})`, baseline.rpeTop > RETURN_RPE_CAP);
  check(`live comeback session caps RPE at RETURN_RPE_CAP (${comeback.rpeTop} <= ${RETURN_RPE_CAP})`, comeback.rpeTop === RETURN_RPE_CAP);
  check(`live comeback session cuts sets by RETURN_SET_MULT (${sq(baseline).sets} -> ${sq(comeback).sets})`,
    sq(comeback).sets === Math.max(1, Math.round(sq(baseline).sets * RETURN_SET_MULT)));
  // stored counter carries the cap into the session AFTER the live comeback, then clears
  const second = prescribe(mk(2, 1), green); // recent gap, but still session 2 of the return window
  check(`stored sessionsSinceLayoff=1 still caps the FOLLOWING session (${second.rpeTop} <= ${RETURN_RPE_CAP})`, second.rpeTop === RETURN_RPE_CAP);
  const third = prescribe(mk(2, 2), green); // window closed
  check(`sessionsSinceLayoff=2 closes the window — full RPE ceiling returns (${third.rpeTop})`, third.rpeTop === baseline.rpeTop);

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
  const simSeeds = { squat: { weight: 315, reps: 5, rpe: 8 }, bench: { weight: 225, reps: 5, rpe: 8 }, deadlift: { weight: 405, reps: 5, rpe: 8 } };
  const runCadence = (gapDays, pinnedGap = gapDays) => {
    let p = freshProgram({ seeds: simSeeds, experience: "intermediate", unit: "lb", goal: "strength", bodyweight: 200 });
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
  /* REVISED AGAIN BY AUDIT 3.6, then AGAIN BY 3.11. The 3.6 pass established
     that capacity saturation below MAV must never masquerade as "reached its
     volume ceiling" (see ceilingHit's MAV floor). 3.11 then raised
     ACC_SET_CAP and corrected the landmark table to RP's published numbers,
     which pushed true schedule capacity well past MRV for several groups —
     including the 4x/week and 5x/week cases here, which now run the FULL
     accumulation length with no early ceiling at all (verified by direct
     sweep from 2x to 6x/week: only the frequency extremes, 3x/week and
     6x/week, still saturate a still-capacity-frozen group — chest — early;
     everything from 2x through 5x/week now runs the full block). 3x/week
     remains a useful case precisely because chest (capA 20, MRV 22) is still
     capacity-frozen post-3.11 — see the "P0: atVolCeiling transition
     actually fires" test above for the same mechanism at a nearby frequency
     (gap 2.2, chosen to land capacity between chest's MAV and MRV). */
  check(`3x/week still fires the ceiling early via a still-capacity-frozen group (cyc ${c3?.cyc}, "${c3?.reason}")`,
    c3?.cyc === 5 && /ceiling/.test(c3?.reason || ""));
  check(`4x/week (freqScale=1): post-3.11 capacity now covers the full ramp — runs to maxCycles (cyc ${c4?.cyc}, "${c4?.reason}")`,
    c4?.cyc === 6 && /max accumulation length/.test(c4?.reason || ""));
  check(`5x/week: also runs the full accumulation length now (cyc ${c5?.cyc}, "${c5?.reason}")`,
    c5?.cyc === 6 && /max accumulation length/.test(c5?.reason || ""));

  // control: with no frequency info the OLD (pre-fix, per-rotation-only) behavior is preserved
  const cNull = runCadence(1.75, null);
  check(`null avgSessionGapDays reproduces 4x/week timing exactly (${cNull?.cyc} === ${c4?.cyc}, "${cNull?.reason}") — freqScale 1 is a no-op`,
    cNull?.cyc === c4.cyc && cNull?.reason === c4.reason);
}

console.log("\n== CRITICAL VERIFICATION 1: prescribe() output is byte-identical at freqScale=1 ==");
{
  /* Snapshot across 3 cycles x all 4 rotation days — every exercise's sets/
     topLoad/reps. Originally captured to prove freqScale=1 is a no-op for
     weeklyTarget/rampedSlotSets, then rebaselined once for the Tier 1 audit
     fixes (see git history for that diff).
     REBASELINED AGAIN for Tier 2 audit changes 2.2/2.4/2.5, which touch
     prescribe()'s real output directly — each diff enumerated and confirmed
     intended before regenerating:
       - legext rejoins the D0 rotation (2.5): new row on Squat day, and the
         quad ramped-slot residual (bsplit/frontsquat) shrinks because
         fixedWeeklySets(quads) rose 8 -> 11 — this is the exact mechanism
         flagged when the change was proposed, not a bug.
       - D2's calfraise -> seatedcalf (2.4): same pool, one row swaps label
         and its (rougher, unanchored) seed load.
       - D3 gains a second triceps slot, triext (2.2): new row on Volume day.
     REBASELINED A THIRD TIME for audit 2.7 (per-exercise load increments):
     lateralraise/reversepecdeck now carry increment: 2.5, so their rounding
     step changes from the unit-default 5 lb to 2.5 lb. Diffed old vs. new —
     only those two exercises' topLoad moved (8 of 96 rows, all later cycles
     where the finer step actually changes the rounded value), sets/reps
     untouched. cablerow/pulldown (increment: 10) never differ here because
     5 already divides 10 evenly. Block type is "accumulation" throughout
     this snapshot, so audit 2.1(a) (intensification rep-tier change) has no
     surface here — it's covered by its own dedicated test instead.
     REBASELINED A FOURTH TIME for audit 3.11 (RP-aligned landmarks,
     ACC_SET_CAP 4->6, second RDL exposure on Volume day). Diffed old vs.
     new: every topLoad/reps value is untouched (nothing about load-rounding
     or rep targets changed); the only diffs are (a) sets counts moving —
     down at cyc0 for several fixedSets/early-ramp accessories (lower MEV
     baseline shrinks the block's starting point) and up at cyc5 to the new
     ACC_SET_CAP=6 ceiling for groups that were previously capacity-capped
     at 4, and (b) a new `rdl` row on the three Volume-day sessions (cyc
     0/2/5 index 3) from the added second hamstrings exposure. No exercise
     lost a row, no topLoad/reps moved outside that pattern — confirmed by
     enumerating all 30 diffs individually before accepting this snapshot. */
  const EXPECTED = [[{"key":"squat","sets":4,"topLoad":305,"reps":5},{"key":"rdl","sets":1,"topLoad":305,"reps":8},{"key":"bsplit","sets":1,"topLoad":55,"reps":8},{"key":"legcurl","sets":3,"topLoad":125,"reps":12},{"key":"legext","sets":3,"topLoad":160,"reps":12},{"key":"calfraise","sets":2,"topLoad":290,"reps":12},{"key":"triext","sets":3,"topLoad":80,"reps":12},{"key":"wristcurl","sets":3,"topLoad":25,"reps":12},{"key":"cablecrunch","sets":3,"topLoad":70,"reps":12}],[{"key":"bench","sets":4,"topLoad":220,"reps":5},{"key":"cablerow","sets":2,"topLoad":150,"reps":8},{"key":"pullup","sets":2,"topLoad":-55,"reps":8},{"key":"inclinebench","sets":1,"topLoad":110,"reps":8},{"key":"dbshoulderpress","sets":2,"topLoad":120,"reps":8},{"key":"reversepecdeck","sets":2,"topLoad":25,"reps":12},{"key":"lateralraise","sets":3,"topLoad":20,"reps":12}],[{"key":"deadlift","sets":4,"topLoad":405,"reps":4},{"key":"frontsquat","sets":1,"topLoad":225,"reps":8},{"key":"pulldown","sets":2,"topLoad":140,"reps":8},{"key":"row","sets":2,"topLoad":150,"reps":8},{"key":"curl","sets":3,"topLoad":60,"reps":12},{"key":"shrug","sets":3,"topLoad":110,"reps":12},{"key":"seatedcalf","sets":2,"topLoad":145,"reps":12},{"key":"reversepecdeck","sets":2,"topLoad":25,"reps":12}],[{"key":"squat","sets":4,"topLoad":275,"reps":8},{"key":"rdl","sets":1,"topLoad":305,"reps":8},{"key":"bench","sets":4,"topLoad":195,"reps":8},{"key":"curl","sets":3,"topLoad":60,"reps":12},{"key":"triext","sets":3,"topLoad":80,"reps":12},{"key":"lateralraise","sets":3,"topLoad":20,"reps":12},{"key":"cablefly","sets":1,"topLoad":50,"reps":12},{"key":"calfraise","sets":2,"topLoad":290,"reps":12}],[{"key":"squat","sets":4,"topLoad":315,"reps":5},{"key":"rdl","sets":1,"topLoad":305,"reps":8},{"key":"bsplit","sets":1,"topLoad":55,"reps":8},{"key":"legcurl","sets":3,"topLoad":130,"reps":12},{"key":"legext","sets":3,"topLoad":165,"reps":12},{"key":"calfraise","sets":4,"topLoad":305,"reps":12},{"key":"triext","sets":3,"topLoad":80,"reps":12},{"key":"wristcurl","sets":3,"topLoad":25,"reps":12},{"key":"cablecrunch","sets":3,"topLoad":70,"reps":12}],[{"key":"bench","sets":4,"topLoad":225,"reps":5},{"key":"cablerow","sets":4,"topLoad":150,"reps":8},{"key":"pullup","sets":4,"topLoad":-55,"reps":8},{"key":"inclinebench","sets":2,"topLoad":110,"reps":8},{"key":"dbshoulderpress","sets":6,"topLoad":120,"reps":8},{"key":"reversepecdeck","sets":5,"topLoad":27.5,"reps":12},{"key":"lateralraise","sets":6,"topLoad":22.5,"reps":12}],[{"key":"deadlift","sets":4,"topLoad":420,"reps":4},{"key":"frontsquat","sets":1,"topLoad":225,"reps":8},{"key":"pulldown","sets":4,"topLoad":140,"reps":8},{"key":"row","sets":4,"topLoad":150,"reps":8},{"key":"curl","sets":3,"topLoad":65,"reps":12},{"key":"shrug","sets":3,"topLoad":115,"reps":12},{"key":"seatedcalf","sets":4,"topLoad":150,"reps":12},{"key":"reversepecdeck","sets":5,"topLoad":27.5,"reps":12}],[{"key":"squat","sets":4,"topLoad":285,"reps":8},{"key":"rdl","sets":1,"topLoad":305,"reps":8},{"key":"bench","sets":4,"topLoad":205,"reps":8},{"key":"curl","sets":3,"topLoad":65,"reps":12},{"key":"triext","sets":3,"topLoad":80,"reps":12},{"key":"lateralraise","sets":6,"topLoad":22.5,"reps":12},{"key":"cablefly","sets":2,"topLoad":55,"reps":12},{"key":"calfraise","sets":4,"topLoad":305,"reps":12}],[{"key":"squat","sets":4,"topLoad":320,"reps":5},{"key":"rdl","sets":3,"topLoad":305,"reps":8},{"key":"bsplit","sets":4,"topLoad":55,"reps":8},{"key":"legcurl","sets":3,"topLoad":135,"reps":12},{"key":"legext","sets":3,"topLoad":170,"reps":12},{"key":"calfraise","sets":6,"topLoad":315,"reps":12},{"key":"triext","sets":3,"topLoad":85,"reps":12},{"key":"wristcurl","sets":3,"topLoad":30,"reps":12},{"key":"cablecrunch","sets":3,"topLoad":75,"reps":12}],[{"key":"bench","sets":4,"topLoad":230,"reps":5},{"key":"cablerow","sets":6,"topLoad":150,"reps":8},{"key":"pullup","sets":6,"topLoad":-55,"reps":8},{"key":"inclinebench","sets":6,"topLoad":110,"reps":8},{"key":"dbshoulderpress","sets":6,"topLoad":120,"reps":8},{"key":"reversepecdeck","sets":6,"topLoad":27.5,"reps":12},{"key":"lateralraise","sets":6,"topLoad":22.5,"reps":12}],[{"key":"deadlift","sets":4,"topLoad":425,"reps":4},{"key":"frontsquat","sets":4,"topLoad":225,"reps":8},{"key":"pulldown","sets":6,"topLoad":140,"reps":8},{"key":"row","sets":6,"topLoad":150,"reps":8},{"key":"curl","sets":3,"topLoad":65,"reps":12},{"key":"shrug","sets":3,"topLoad":120,"reps":12},{"key":"seatedcalf","sets":6,"topLoad":160,"reps":12},{"key":"reversepecdeck","sets":6,"topLoad":27.5,"reps":12}],[{"key":"squat","sets":4,"topLoad":285,"reps":8},{"key":"rdl","sets":3,"topLoad":305,"reps":8},{"key":"bench","sets":4,"topLoad":205,"reps":8},{"key":"curl","sets":3,"topLoad":65,"reps":12},{"key":"triext","sets":3,"topLoad":85,"reps":12},{"key":"lateralraise","sets":6,"topLoad":22.5,"reps":12},{"key":"cablefly","sets":6,"topLoad":55,"reps":12},{"key":"calfraise","sets":6,"topLoad":315,"reps":12}]];
  const snapSeeds = { squat: { weight: 315, reps: 5, rpe: 8 }, bench: { weight: 225, reps: 5, rpe: 8 }, deadlift: { weight: 405, reps: 5, rpe: 8 } };
  let idx = 0, allMatch = true;
  for (const cyc of [0, 2, 5]) {
    for (let d = 0; d < 4; d++) {
      const p = freshProgram({ seeds: snapSeeds, experience: "intermediate", unit: "lb", goal: "strength", bodyweight: 200 });
      p.cycleIndex = d;
      p.block = { type: "accumulation", cycle: cyc, sessionsInBlock: cyc * 4, nextAfter: null };
      const rx = prescribe(p, green);
      const actual = rx.items.map((i) => ({ key: i.key, sets: i.sets, topLoad: i.topLoad, reps: i.reps }));
      if (JSON.stringify(actual) !== JSON.stringify(EXPECTED[idx])) allMatch = false;
      idx++;
    }
  }
  check(`prescribe() sets/topLoad/reps byte-identical to pre-fix across ${idx} full sessions (3 cycles × 4 rotation days)`, allMatch);
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
    p.cycleIndex = 1;             // Bench day carries pullup
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
  p.lifts.pullup.e1rm = 240;   // rawSys ~173.5 -> inside the repOnly band (>= 0.85*200)
  p.cycleIndex = 1;
  const it = prescribe(p, green).items.find((i) => i.key === "pullup");
  check(`lands in the repOnly band (repOnly=${it.repOnly}, topLoad=${it.topLoad})`, it.repOnly && it.topLoad === 0);
  /* The athlete's actual load is their bodyweight (200), heavier than the
     ~173.5 the RPE math asked for. Holding the prescribed 8 reps would ship a
     set ~15% heavier than its RPE label. The rep target must come DOWN. */
  const accumTierReps = ACC_REP_TIERS.accumulation.compound.reps;
  check(`reps reduced below the tier default (${it.reps} < ${accumTierReps}) so the set matches its RPE label`,
    it.reps < accumTierReps);
  // and the reduced rep count should be the table's best match for bw/e1rm
  const want = repsAtPct(200 / 240, it.rpe);
  check(`reps equals the inverted-table answer for bw/e1rm (${it.reps} === ${want})`, it.reps === want);
}

console.log("\n== AUDIT 1.4: assistanceNeeded carries the magnitude ==");
{
  const p = fresh();
  p.bodyweight = 200;
  p.lifts.pullup.e1rm = 200;   // rawSys well under 0.85*bw -> assistance
  p.cycleIndex = 1;
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

console.log("\n== AUDIT 1.7: row precedes curl on Deadlift day ==");
{
  const day = ROTATION.find((d) => d.name === "Deadlift");
  const iRow = day.items.indexOf("row"), iCurl = day.items.indexOf("curl");
  check(`row (${iRow}) comes before curl (${iCurl}) — compound before its own weak link`, iRow < iCurl);
  check("both still present exactly once", day.items.filter((k) => k === "row").length === 1 && day.items.filter((k) => k === "curl").length === 1);
  // the reorder must not perturb either exercise's own prescription
  const p = fresh(); p.cycleIndex = 2;
  const items = prescribe(p, green).items;
  const row = items.find((i) => i.key === "row"), curl = items.find((i) => i.key === "curl");
  check(`row unchanged (sets=${row.sets} reps=${row.reps} load=${row.topLoad} warmup=${row.warmup?.type})`,
    row.reps === 8 && row.topLoad === 150 && row.warmup?.type === "minimal");
  check(`curl unchanged (sets=${curl.sets} reps=${curl.reps} load=${curl.topLoad})`,
    curl.reps === 12 && curl.topLoad === 60 && !curl.warmup);
}

console.log("\n== AUDIT 2.1(a): compound/unilateral accessory reps hold at 8 through intensification ==");
{
  // pre-fix intensification dropped compound accessories to 6 reps, unilateral to 7 —
  // stacking a rep cut on the block's existing mains-reps/RPE/volLevel intensity levers.
  const rowDay = (block, reps) => { const p = fresh(); p.cycleIndex = 1; p.block = block; return prescribe(p, green).items.find(reps); };
  const cablerow = rowDay({ type: "intensification", cycle: 0, sessionsInBlock: 0, nextAfter: null }, (i) => i.key === "cablerow");
  check(`intensification compound accessory (cablerow) holds 8 reps (got ${cablerow.reps}), RPE still climbs to 8 (got ${cablerow.rpe})`,
    cablerow.reps === 8 && cablerow.rpe === 8);
  const squatDay = (block) => { const p = fresh(); p.cycleIndex = 0; p.block = block; return prescribe(p, green).items.find((i) => i.key === "bsplit"); };
  const bsplit = squatDay({ type: "intensification", cycle: 0, sessionsInBlock: 0, nextAfter: null });
  check(`intensification unilateral accessory (bsplit) holds 8 reps (got ${bsplit.reps}), RPE still climbs to 8.5 (got ${bsplit.rpe})`,
    bsplit.reps === 8 && bsplit.rpe === 8.5);
}

console.log("\n== AUDIT 2.7: per-exercise load increments override the unit-default rounding step ==");
{
  // late-block loads where the finer step actually changes the rounded value vs. the old 5 lb default
  const p = fresh(); p.cycleIndex = 1;
  p.block = { type: "accumulation", cycle: 5, sessionsInBlock: 20, nextAfter: null };
  const items = prescribe(p, green).items;
  const cablerow = items.find((i) => i.key === "cablerow");
  const lateralraise = items.find((i) => i.key === "lateralraise");
  const reversepecdeck = items.find((i) => i.key === "reversepecdeck");
  check(`cablerow (increment: 10) rounds to a multiple of 10 (got ${cablerow.topLoad})`, cablerow.topLoad % 10 === 0);
  check(`lateralraise (increment: 2.5) lands on a non-5-multiple value the old step couldn't produce (got ${lateralraise.topLoad})`,
    lateralraise.topLoad === 22.5 && lateralraise.topLoad % 5 !== 0);
  check(`reversepecdeck (increment: 2.5) lands on a non-5-multiple value the old step couldn't produce (got ${reversepecdeck.topLoad})`,
    reversepecdeck.topLoad === 27.5 && reversepecdeck.topLoad % 5 !== 0);
  // exercises without an `increment` still use the old unit-based step
  const bench = items.find((i) => i.key === "bench");
  check(`bench (no increment set) still rounds to the unit-default 5 lb step (got ${bench.topLoad})`, bench.topLoad % 5 === 0);
}

console.log("\n== AUDIT 2.6: RPE-aware double-progression rep bump ==");
{
  // accumulation cyc1 isolation target: rpe = min(10, 8 + 0.5*1) = 8.5, rep target 12
  const rx = (last) => { const p = fresh(); p.cycleIndex = 3; p.block = { type: "accumulation", cycle: 1, sessionsInBlock: 4, nextAfter: null };
    p.lifts.lateralraise.last = last; return prescribe(p, green).items.find((i) => i.key === "lateralraise"); };
  const big = rx({ w: 30, reps: 9, rpe: 6 });     // gap 8.5-6=2.5 >= 1.5 -> bump 3
  check(`big RPE reserve earns a 3-rep bump (9 -> ${big.reps})`, big.reps === 12 && big.topLoad === 30);
  const med = rx({ w: 30, reps: 9, rpe: 7.7 });   // gap 0.8 -> bump 2
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
  check("non-isolation item (main lift) is not flagged", items.find((i) => i.key === "squat").dpMode === false);
}

console.log("\n== AUDIT 2.9: the session's first barbell lift never opens on a single warmup set ==");
{
  /* No combination of reps/RPE reachable through the real block schedule
     (BLOCKS' mainReps/rpeBase/rpeStep, clamped at RPE>=6 by clampRpe) drives
     a MAIN lift's %1RM below the 70% "minimal" boundary — every real block
     already lands mains at "short" or "full" from cold. That's exactly why
     this floor is cheap insurance rather than a live bug today: it's still
     correct to add, but proving it end-to-end needs a %1RM the real block
     table can't produce. rpePct(8,6)=0.68 (< the 0.70 boundary) is reachable
     with an 8-rep/RPE6 main set, so a synthetic block config (never used by
     ROTATION/BLOCKS) drives that combination through the real prescribe()
     path to confirm the floor logic itself, not just its current
     reachability. */
  BLOCKS.__test29 = { label: "Test", emphasis: "volume", mainReps: { squat: 8 }, mainSets: 4,
    rpeBase: 6, rpeStep: 0, rpeCap: 6, backoffDrop: 0.06, backoffRpeCap: 6, volLevel: "mev", minCycles: 1, maxCycles: 1 };
  ACC_REP_TIERS.__test29 = ACC_REP_TIERS.accumulation;
  const p = fresh(); p.cycleIndex = 0; p.block = { type: "__test29", cycle: 0, sessionsInBlock: 0, nextAfter: null };
  const squat = prescribe(p, green).items.find((i) => i.key === "squat");
  check(`baseTier without the floor would be "minimal" (pct=${rpePct(squat.reps, squat.rpe).toFixed(3)} < 0.70)`,
    rpePct(squat.reps, squat.rpe) < 0.70);
  check(`first-barbell floor bumps it to short instead (type=${squat.warmup?.type}, ${squat.warmup?.sets?.length} sets)`,
    squat.warmup?.type === "short" && squat.warmup.sets.length === 2);
  delete BLOCKS.__test29;
  delete ACC_REP_TIERS.__test29;

  // in the REAL rotation, the day's later barbell lifts are never floored — verify the floor
  // doesn't leak past the first exercise on a normal accumulation-block session.
  const p2 = fresh(); p2.cycleIndex = 3; p2.block = { type: "accumulation", cycle: 0, sessionsInBlock: 0, nextAfter: null };
  const items = prescribe(p2, green).items;
  const squatReal = items.find((i) => i.key === "squat"), bench = items.find((i) => i.key === "bench");
  check(`real volume-day squat (idx0) is unaffected either way (type=${squatReal.warmup?.type}, already >= short)`, squatReal.warmup?.type === "short");
  check(`bench (idx1, not the day's first barbell lift) keeps its own unmodified tier (type=${bench.warmup?.type})`, bench.warmup?.type != null);
}

console.log("\n== AUDIT 2.10: feeler steps track priming — cold gets 2, primed gets 1 ==");
{
  const p = fresh(); p.cycleIndex = 1; p.block = { type: "accumulation", cycle: 0, sessionsInBlock: 0, nextAfter: null };
  const items = prescribe(p, green).items;
  const cablerow = items.find((i) => i.key === "cablerow");         // back, nothing primes it before idx1
  const inclinebench = items.find((i) => i.key === "inclinebench"); // chest, primed by bench at idx0
  const dbshoulderpress = items.find((i) => i.key === "dbshoulderpress"); // front_delts, cold
  check(`cold accessory (cablerow) gets a 2-step feeler (${cablerow.warmup?.sets?.length} steps: ${JSON.stringify(cablerow.warmup?.sets)})`,
    cablerow.warmup?.sets?.length === 2 && cablerow.warmup.sets[0].weight < cablerow.warmup.sets[1].weight);
  check(`primed accessory (inclinebench) keeps the original 1-step feeler (${inclinebench.warmup?.sets?.length} steps)`,
    inclinebench.warmup?.sets?.length === 1);
  check(`another cold accessory (dbshoulderpress) also gets 2 steps (${dbshoulderpress.warmup?.sets?.length} steps)`,
    dbshoulderpress.warmup?.sets?.length === 2);
  // every feeler step must still land strictly below the working load
  for (const it of [cablerow, inclinebench, dbshoulderpress])
    check(`${it.key}: every feeler step < topLoad (${it.warmup.sets.map((s) => s.weight)} < ${it.topLoad})`,
      it.warmup.sets.every((s) => s.weight < it.topLoad));
}

console.log("\n== AUDIT 2.12: isolation accessories earn a feeler once load crosses the absolute floor ==");
{
  const p = fresh(); p.cycleIndex = 0; p.block = { type: "accumulation", cycle: 0, sessionsInBlock: 0, nextAfter: null };
  const items = prescribe(p, green).items;
  const legcurl = items.find((i) => i.key === "legcurl");     // 125 lb >= floor
  const calfraise = items.find((i) => i.key === "calfraise"); // 290 lb >= floor
  const triext = items.find((i) => i.key === "triext");       // 80 lb < floor
  const wristcurl = items.find((i) => i.key === "wristcurl"); // 25 lb < floor
  check(`legcurl (${legcurl.topLoad} lb, >= ${FEELER_LOAD_FLOOR_LB}) now earns a feeler`, legcurl.warmup?.type === "feeler");
  check(`calfraise (${calfraise.topLoad} lb, >= ${FEELER_LOAD_FLOOR_LB}) now earns a feeler`, calfraise.warmup?.type === "feeler");
  check(`triext (${triext.topLoad} lb, < ${FEELER_LOAD_FLOOR_LB}) stays exempt (self-warms)`, triext.warmup == null);
  check(`wristcurl (${wristcurl.topLoad} lb, < ${FEELER_LOAD_FLOOR_LB}) stays exempt (self-warms)`, wristcurl.warmup == null);
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

  /* End-to-end: an athlete whose 8-rep sets read ~3.9% low relative to their
     5-rep sets, with genuine +0.4%/wk progress. Pre-fix the sawtooth put
     squat's slope at 0.000991 against GROWTH_POS=0.001 — failing the growth
     gate by a hair and suppressing that group's landmark raises. */
  const p0 = fresh(); const trueE1 = {};
  Object.keys(p0.lifts).forEach((k) => { trueE1[k] = p0.lifts[k].e1rm; });
  let p = p0;
  for (let i = 0; i < 16; i++) {
    const rx = prescribe(p, green);
    const logs = rx.items.map((it) => {
      const real = trueE1[it.key] * rpePct(it.reps, it.rpe) * (it.reps >= 7 ? 0.961 : 1);
      return { key: it.key, topWeight: LIB[it.key].bodyweight ? it.topLoad : Math.round(real / 5) * 5,
        topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe, missedSets: 0, touched: true,
        backoffSetCount: it.backoffSetCount, backoffReps: it.reps,
        backoffRpe: Math.min(it.rpe, it.backoffRpeCap ?? it.rpe), backoffRpeCap: it.backoffRpeCap };
    });
    CLOCK += 1.75 * 86400000;
    Object.keys(trueE1).forEach((k) => { trueE1[k] *= (1 + 0.004 * 1.75 / 7); });
    p = ingest(p, logs, green).next;
  }
  const sq = liftSlopeInfo(p.lifts.squat);
  check(`offset athlete with real growth clears GROWTH_POS (g=${sq.g.toFixed(6)} > 0.001, n=${sq.n}) — pre-fix g=0.000991 at n=8 failed it`,
    sq.g > 0.001 && sq.n % 2 === 1);
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
  /* AUDIT 3.11: quads is no longer capacity-frozen (RP-aligned MRV 18 <=
     the ACC_SET_CAP=6 capacity of 23) — moved to chest/bench, still frozen
     post-3.11 (capA 20 < MRV 22), same pattern as the P0 test above. */
  const mk = () => { const p = fresh();
    p.lifts.bench.hist = [225, 227, 229, 231].map((r) => ({ e: r, raw: r, b: "accumulation" }));
    p.lifts.bench.e1rm = 231; return p; };
  // headroom case: MEV well below MAV still raises normally
  const below = adjustLandmarks(mk()).adjustments.chest;
  check(`MEV still raises when it sits below MAV (${below?.before.mev} -> ${below?.after.mev})`, below && below.dMev === 1);
  // at-MAV case: the new guard blocks it
  const p2 = mk(); p2.landmarks.chest.mev = p2.landmarks.chest.mav; // 14/14
  const atMav = adjustLandmarks(p2).adjustments.chest;
  check(`MEV at MAV (${p2.landmarks.chest.mev}/${p2.landmarks.chest.mav}) is NOT raised further (adjustment: ${atMav ? `dMev ${atMav.dMev}` : "none"})`,
    !atMav || atMav.dMev === 0);
  /* the ratchet this prevents: several groups still have MRV frozen by
     schedule capacity even after 3.11's capacity increase — chest is one. */
  check("sanity: chest MRV really is still capacity-frozen post-3.11 (maxDeliverable < MRV)",
    maxDeliverable("chest", "accumulation") < landmarksForExperience("intermediate").chest.mrv);
}

console.log("\n== AUDIT 3.6/3.8: capacity saturation is not mistaken for volume evidence ==");
{
  const lm = landmarksForExperience("intermediate");
  /* 3.6: AUDIT 3.11 raised capacity enough that hamstrings is no longer the
     MAV-starved example (it now clears its own MAV comfortably) — front_delts
     is the one group still short of MAV post-3.11 (capA 6 < MAV 7), so a
     saturated front_delts ramp must NOT be reported as "reached its ceiling". */
  const fdCap = maxDeliverable("front_delts", "accumulation");
  check(`front_delts' reachable ceiling (${fdCap}) is below its MAV (${lm.front_delts.mav}) — saturation there is a capacity limit, not volume tolerance`,
    fdCap < lm.front_delts.mav);
  /* 3.8 is documented as a KNOWN LIMITATION rather than fixed — this locks in
     WHY, so the inert repair isn't attempted again. Substituting
     min(mav, capW) for mav in the stall gate changes the gate's value but
     never the streak outcome, because reachedCeiling then fires in lockstep. */
  let unreachable = 0, gateDiffers = 0, streakDiffers = 0;
  for (const g of Object.keys(lm)) {
    if (maxDeliverable(g, "accumulation") < lm[g].mav) unreachable++;
    const capW = maxDeliverable(g, "accumulation"); // freqScale 1 here
    for (let cyc = 0; cyc < 6; cyc++) {
      const d = deliveredWeekly(g, "accumulation", cyc, lm, 1);
      const oldGate = d >= lm[g].mav, newGate = d >= Math.min(lm[g].mav, capW);
      const reached = d >= Math.min(lm[g].mrv, capW);
      if (oldGate !== newGate) gateDiffers++;
      if ((oldGate && !reached) !== (newGate && !reached)) streakDiffers++;
    }
  }
  /* AUDIT 3.11: the capacity fix closed this gap for all but front_delts —
     still worth locking in as a KNOWN LIMITATION (not silently "fixed") for
     the one group it didn't reach, and the no-op proof below (the obvious
     min(mav,capW) repair changes the gate but never the streak outcome)
     is a structural property of reachedCeiling's math, unaffected by how
     many groups happen to be short. */
  check(`${unreachable} of ${Object.keys(lm).length} groups have MAV above what the schedule can deliver — the gate is unsatisfiable for them`,
    unreachable === 1);
  check(`the obvious min(mav,capW) repair changes the gate in ${gateDiffers} cases but the streak outcome in ${streakDiffers} — it is a no-op, so the real blocker is reachedCeiling, not this gate`,
    gateDiffers > 0 && streakDiffers === 0);
}

Date.now = RealNow;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
