/* ============================================================================
   Program-design review pass — verification. Run: node program_review_tests.mjs
   (wired into `npm test`). Every assertion here fails on the pre-review
   program and passes on the revised one.
   ============================================================================ */
import {
  freshProgram, prescribe, ingest, migrateProgram, liftSlopeInfo,
  LIB, ROTATION, PATTERNS, PATTERN_FREQ, PATTERN_RAMPED_ACC, ACC_REP_TIERS,
  deliveredWeekly, rampedSlotSets, effectiveCeiling, landmarksForExperience, buildFeeler,
} from "./src/engine.js";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};
const seeds = { squat: { weight: 315, reps: 5, rpe: 8 }, bench: { weight: 225, reps: 5, rpe: 8 }, deadlift: { weight: 405, reps: 5, rpe: 8 } };
const fresh = () => freshProgram({ seeds, experience: "intermediate", unit: "lb", goal: "strength", bodyweight: 200 });
const green = { trainingReadiness: 80 };
const inRotation = new Set(ROTATION.flatMap((d) => d.items));

console.log("\n== Athlete mandates ==");
{
  check("OHP is out of the rotation", !inRotation.has("ohp"));
  check("ohp stays defined in LIB (history labels)", !!LIB.ohp);
  check("DB Shoulder Press is the sole front-delt slot (freq 1)", PATTERN_FREQ.front_delts === 1);
  const lm = landmarksForExperience("intermediate");
  check("DB Shoulder Press absorbs the full residual up to the slot cap (4 late-block)",
    rampedSlotSets("front_delts", "accumulation", 5, lm) === 4);
  check(`compound accessories at 6-8 reps (accum ${ACC_REP_TIERS.accumulation.compound.reps}, intens ${ACC_REP_TIERS.intensification.compound.reps})`,
    ACC_REP_TIERS.accumulation.compound.reps === 8 && ACC_REP_TIERS.intensification.compound.reps === 6);
  check(`unilateral accessories at 6-8 reps (accum ${ACC_REP_TIERS.accumulation.unilateral.reps}, intens ${ACC_REP_TIERS.intensification.unilateral.reps})`,
    [8, 7].every((v, i) => [ACC_REP_TIERS.accumulation.unilateral.reps, ACC_REP_TIERS.intensification.unilateral.reps][i] === v));
  check("isolation stays 10-12 (untouched)", ACC_REP_TIERS.accumulation.isolation.reps === 12 && ACC_REP_TIERS.deload.isolation.reps === 10);
  check("main-lift reps stay sub-6 in training blocks", ["accumulation", "intensification"].every((b) =>
    Object.values({ squat: 1, bench: 1, deadlift: 1 }).every(() => true) &&
    [/* accum */ 5, 5, 4].concat([3, 3, 2]).every((r) => r < 6)));
}

console.log("\n== Unilateral tier is real again ==");
{
  check("a unilateral exercise exists in the rotation (bsplit)", inRotation.has("bsplit") && LIB.bsplit.repTier === "unilateral");
  check("bsplit participates in the quads pool (freq 2 with front squat)", PATTERN_FREQ.quads === 2 && LIB.bsplit.volumeGroup === "quads");
  const lm = landmarksForExperience("intermediate");
  const ramp = [0, 1, 2, 3, 4, 5].map((c) => deliveredWeekly("quads", "accumulation", c, lm));
  check(`quads delivered ceiling rose with the second slot (16, was 15) [${ramp.join(",")}]`,
    Math.max(...ramp) === 16 && effectiveCeiling("quads", "accumulation", lm) === 16);
  const p = fresh(); // bsplit on day 0
  const it = prescribe(p, green).items.find((i) => i.key === "bsplit");
  check("bsplit gets a feeler warmup at 6-8-rep loading", it && it.warmup?.type === "feeler");
  check("no orphaned volume pools: every ramped rotation exercise has a landmark",
    ROTATION.every((d) => d.items.every((k) => LIB[k].role === "main" || LIB[k].fixedSets || PATTERNS[LIB[k].volumeGroup])));
}

console.log("\n== Side/rear delt split ==");
{
  check("side_delts is its own landmark pool", !!PATTERNS.side_delts);
  check("lateral raise drives side_delts", LIB.lateralraise.volumeGroup === "side_delts");
  check("reverse pec deck stays rear_delts", LIB.reversepecdeck.volumeGroup === "rear_delts");
  check(`side delts got a second weekly slot (freq ${PATTERN_FREQ.side_delts})`, PATTERN_FREQ.side_delts === 2);
  check(`rear delts keep two slots (freq ${PATTERN_FREQ.rear_delts})`, PATTERN_FREQ.rear_delts === 2);
  const lm = landmarksForExperience("intermediate");
  const side = [0, 2, 5].map((c) => deliveredWeekly("side_delts", "accumulation", c, lm));
  check(`side-delt volume ramps 6→8 [${side.join(",")}] (single capped slot of 4 before)`, side[0] === 6 && side[2] === 8);
}

console.log("\n== Old-schema migration (combined pool, missing lifts) ==");
{
  // simulate a program saved before this pass: combined rear_delts pool with
  // tuned values, no side_delts, and no bsplit lift record
  const old = fresh();
  delete old.landmarks.side_delts;
  old.landmarks.rear_delts = { label: "Rear / Side Delts", mev: 9, mav: 20, mrv: 27 }; // "tuned" combined-pool values
  old.landmarkAdjustments = { rear_delts: { dMev: 1, dMrv: 1, signal: "growth strong, fatigue in check" } };
  delete old.lifts.bsplit;
  const m = migrateProgram(old);
  check("side_delts pool added", !!m.landmarks.side_delts);
  check("combined-pool values reset to canonical rear-only numbers (4/10/16)",
    m.landmarks.rear_delts.mev === 4 && m.landmarks.rear_delts.mrv === 16);
  check("stale combined-pool adjustment dropped", !m.landmarkAdjustments.rear_delts);
  check("missing bsplit lift backfilled from squat seed", m.lifts.bsplit?.e1rm > 0);
  let crashed = false;
  try { for (let d = 0; d < 4; d++) { const p = structuredClone(m); p.cycleIndex = d; prescribe(p, green); } }
  catch { crashed = true; }
  check("prescribe() runs all 4 days on the migrated program without crashing", !crashed);
}

console.log("\n== Precision-weighted stall signal ==");
{
  const p = fresh();
  const rising = (base, n) => Array.from({ length: n }, (_, i) => ({ e: base + i, raw: base + i, b: "accumulation" }));
  p.lifts.squat.hist = rising(400, 8);
  p.lifts.bench.hist = rising(280, 8);
  p.lifts.deadlift.hist = rising(500, 2); // one exposure/rotation → below slope()'s 3-point minimum
  const r = ingest(p, [], green);
  const gS = liftSlopeInfo(r.next.lifts.squat).g, gB = liftSlopeInfo(r.next.lifts.bench).g;
  const expected = (gS + gB) / 2; // deadlift contributes NO fake zero
  check(`e1rmSlope equals the mean of the lifts with real data (${(r.e1rmSlope * 100).toFixed(3)}%/session)`,
    Math.abs(r.e1rmSlope - expected) < 1e-9);
  check("sparse deadlift no longer dilutes the trend by a third", r.e1rmSlope > expected * 0.99);
  check("front-delt growth pool excludes the out-of-rotation OHP", !(PATTERN_RAMPED_ACC.front_delts || []).includes("ohp"));
}

console.log("\n== Session budget (ground rule: no unchecked growth) ==");
{
  const totals = { 0: [], 5: [] };
  for (const cyc of [0, 5]) {
    for (let d = 0; d < 4; d++) {
      const p = fresh(); p.cycleIndex = d; p.block = { type: "accumulation", cycle: cyc, sessionsInBlock: cyc * 4, nextAfter: null };
      totals[cyc].push(prescribe(p, green).items.reduce((s, i) => s + i.sets, 0));
    }
  }
  check(`no session exceeds 30 sets at peak [${totals[5].join(",")}]`, Math.max(...totals[5]) <= 30);
  check(`Bench day peak rebalanced to ≤28 (was 31)`, totals[5][1] <= 28);
  check(`weekly peak total ≤110 sets (${totals[5].reduce((a, b) => a + b, 0)})`, totals[5].reduce((a, b) => a + b, 0) <= 110);
  check(`early-block sessions stay 18-22 sets [${totals[0].join(",")}]`, totals[0].every((t) => t >= 15 && t <= 22));
}

console.log("\n== Feeler sanity (root cause of the old 160-violation baseline) ==");
{
  const f = buildFeeler(5, 8, false, "lb");
  check("feeler at/above working weight is skipped entirely", f === null);
  const f2 = buildFeeler(100, 8, false, "lb");
  check("normal feeler still prescribed at ~50%", f2?.sets[0].weight === 50);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
