/* ============================================================================
   Targeted regression tests for the methodology-review fixes (P0–P3).
   Run with: node engine_fix_tests.mjs   (also wired into `npm test`).
   Each assertion is written to FAIL on the pre-fix engine and pass after —
   these verify the fixes numerically, not just that the code runs.
   ============================================================================ */
import {
  freshProgram, prescribe, ingest, applyTransition, adjustLandmarks, migrateProgram, liftNormSlope,
  deliveredWeekly, effectiveCeiling, maxDeliverable, weeklyFreqScale, landmarksForExperience,
  BLOCKS, ROTATION, ROT, LIB, PATTERNS,
  E1RM_MIN_RPE, LAYOFF_THRESHOLD_DAYS, LAYOFF_MAX_DECAY, DP_MIN_REPS, STALL_STREAK_THRESHOLD,
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

console.log("\n== P0: MRV-raise gate stays in per-rotation units regardless of freqScale ==");
{
  /* The reachedCeiling comparison a few lines above in adjustLandmarks DOES
     convert through weeklyFreqScale (delivered volume and the ceiling are
     both per-calendar-week quantities being compared to MRV). But capA — the
     cap the MRV-RAISE gate (canRaiseMrv = lm.mrv + 1 <= capA) checks against
     — is deliberately left in raw per-rotation maxDeliverable() units,
     un-divided by freqScale: capA is a schedule-delivery ceiling (how many
     sets ONE rotation pass can prescribe), not a rate being compared to a
     weekly landmark, so scaling it would be a category error, not a fix.

     A test run at the SAME mrv as the freqScale=1 test above can't actually
     distinguish "correctly ignores freqScale" from "accidentally scaled but
     it happened not to matter here": that setup starts at mrv=20, capA=16,
     so mrv+1=21 already exceeds capA before any scaling is even in play —
     dividing capA by freqScale (16/1.333≈12) still blocks the raise, so a
     buggy scaled version and the correct unscaled version give the identical
     answer and the bug would ship invisibly. Closing that blind spot needs a
     landmark value where scaled vs. unscaled DISAGREE: with capA=16 and
     freqScale≈1.333, mrv=12 puts mrv+1=13, which is <= capA=16 (unscaled:
     raise allowed) but > capA/freqScale≈12 (a scaled gate would wrongly
     block it) — so this only passes if capA truly stays unscaled. */
  const p = fresh();
  p.lifts.squat.hist = [300, 304, 308, 312].map((r) => ({ e: r, raw: r, b: "accumulation" }));
  p.lifts.squat.e1rm = 312;
  p.avgSessionGapDays = 7 / 3; // ~3x/week -> freqScale = (ROT * gap) / 7 = (4 * 7/3) / 7 = 4/3 ≈ 1.333, not 1
  const scale = weeklyFreqScale(p.avgSessionGapDays);
  check(`sanity: this program's freqScale is not 1 (got ${scale.toFixed(3)})`, Math.abs(scale - 1) > 1e-9);

  const capA = maxDeliverable("quads", "accumulation");
  p.landmarks.quads.mrv = 12; // mrv+1=13 straddles capA (16) and capA/scale (~12) — see comment above
  p.landmarks.quads.mav = 11; // keep mav < mrv so the range clamp doesn't interfere
  check(`sanity: mrv+1 (13) is <= capA (${capA}) but > capA/scale (${(capA / scale).toFixed(2)}) — the two paths must disagree`,
    13 <= capA && 13 > capA / scale);

  const { adjustments } = adjustLandmarks(p);
  const adj = adjustments.quads;

  check(`quads adjustment exists at freqScale≈${scale.toFixed(3)} (growth strong)`, !!adj);
  check(`capA used unscaled: MRV DOES raise here (${p.landmarks.quads.mrv} -> ${adj?.after.mrv}) — would be blocked if capA were divided by freqScale`,
    adj && adj.dMrv === 1 && adj.after.mrv === 13);
  check(`signal reflects a normal (non-capacity-gated) raise ("${adj?.signal}")`,
    adj?.signal === "growth strong, fatigue in check");

  // Companion case: identical scenario at freqScale=1 must produce the SAME
  // capA-vs-mrv decision — proving the gate's behavior doesn't depend on
  // freqScale at all, not just that this one non-1 value happens to work.
  const p1 = fresh();
  p1.lifts.squat.hist = [300, 304, 308, 312].map((r) => ({ e: r, raw: r, b: "accumulation" }));
  p1.lifts.squat.e1rm = 312;
  p1.avgSessionGapDays = null; // freqScale = 1
  p1.landmarks.quads.mrv = 12;
  p1.landmarks.quads.mav = 11;
  const adj1 = adjustLandmarks(p1).adjustments.quads;
  check(`freqScale=1 companion case: byte-identical dMrv/after.mrv/signal (${adj1?.dMrv},${adj1?.after.mrv},"${adj1?.signal}")`,
    adj1 && adj1.dMrv === adj.dMrv && adj1.after.mrv === adj.after.mrv && adj1.signal === adj.signal);
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
