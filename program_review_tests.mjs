/* ============================================================================
   Hypertrophy program-design review — verification. Run: node program_review_tests.mjs
   (wired into `npm test`).

   This file checks the SHIPPED PROGRAM against its stated design, as opposed to
   engine_fix_tests.mjs which checks engine MECHANISMS. It was rewritten wholesale
   for the hypertrophy rebuild: the previous version verified a strength program
   (squat/bench/deadlift mains, block peaking into a 1-2 rep re-test, accessories
   filling the gaps) against that program's own mandates. Essentially none of
   those assertions describe the current program, so re-pointing them one by one
   would have produced a file that passed while testing nothing real.

   Every number asserted below was measured from the engine, not assumed — the
   session/volume budgets in particular are pulled from real prescribe() output.
   ============================================================================ */
import {
  freshProgram, prescribe, ingest, migrateProgram, applyTransition,
  LIB, ROTATION, ROT, PATTERNS, PATTERN_FREQ, PATTERN_RAMPED_ACC, PATTERN_MAIN,
  ACC_REP_TIERS, BLOCKS, LEGACY_BLOCK_TYPES, RETIRED_LABELS, ACC_SET_CAP, SAME_DAY_GROUP_CAP,
  deliveredWeekly, fixedWeeklySets, rampedSlotSets, maxDeliverable, landmarksForExperience,
} from "./src/engine.js";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};
const seeds = { squat: { weight: 315, reps: 5, rpe: 8 }, bench: { weight: 225, reps: 5, rpe: 8 },
  rdl: { weight: 275, reps: 8, rpe: 8 }, tbarrow: { weight: 185, reps: 8, rpe: 8 } };
const fresh = () => freshProgram({ seeds, experience: "intermediate", unit: "lb", goal: "hypertrophy", bodyweight: 200 });
const green = { trainingReadiness: 80 };
const inRotation = new Set(ROTATION.flatMap((d) => d.items));
const lm = landmarksForExperience("intermediate");

/* The athlete's approved exercise list, verbatim in spirit — nothing outside it
   may ever be prescribed. Keyed by LIB key so the constraint is machine-checked
   rather than left to a code comment. */
/* Entries written "A/B" on the athlete's list mean TWO SEPARATE exercises, not
   one slot with a slash label — DB bench and BB bench, machine and DB lateral
   raise, pull-up and lat pulldown, and so on. Each half gets its own LIB key,
   its own load scale, and its own e1RM history. */
const APPROVED = new Set([
  "cablefly", "dip", "dbshoulderpress", "triext", "latpullover", "shrug",
  "reversepecdeck", "bayesiancurl", "preachercurl", "tbarrow", "calfraise",
  "legcurl", "legext", "rdl", "bsplit", "cablecrunch", "deadlift",
  // DB/BB Bench Press -> two exercises
  "bench", "dbbench",
  // Incline BB/DB bench -> two exercises
  "inclinebb", "inclinebench",
  // Machine/DB Lateral Raise -> two exercises
  "lateralraise", "dblateralraise",
  // DB/BB wrist curls -> two exercises
  "wristcurl", "bbwristcurl",
  // Pull-ups / lat pulldown -> two exercises (and two different load models)
  "pullup", "pulldown",
  // front/back squat -> two exercises
  "squat", "frontsquat",
]);

console.log("\n== Approved-exercise constraint ==");
{
  const strays = Object.keys(LIB).filter((k) => !APPROVED.has(k));
  check("every exercise defined in LIB is on the athlete's approved list", strays.length === 0, strays.join(","));
  const rotStrays = [...inRotation].filter((k) => !APPROVED.has(k));
  check("every exercise in the rotation is on the approved list", rotStrays.length === 0, rotStrays.join(","));
  check("deadlift is defined but carries NO rotation slot (dropped as a hypertrophy tool)",
    !!LIB.deadlift && !inRotation.has("deadlift"));
  check("front squat is defined but carries no rotation slot (quads already have 4)",
    !!LIB.frontsquat && !inRotation.has("frontsquat"));
  check("retired exercises are gone from LIB entirely, kept only as history labels",
    !LIB.row && !LIB.cablerow && !LIB.ohp && !LIB.curl && !LIB.seatedcalf
    && !!RETIRED_LABELS.cablerow && !!RETIRED_LABELS.ohp);
  check("no LIB key is also claimed as a retired-only history label",
    Object.keys(RETIRED_LABELS).every((k) => !LIB[k]));
}

console.log("\n== The strength skeleton is gone ==");
{
  check("no exercise carries role 'main' any more", Object.values(LIB).every((L) => L.role !== "main"));
  check("every LIB entry has a repTier (nothing falls through the accessory path)",
    Object.values(LIB).every((L) => ["compound", "unilateral", "isolation"].includes(L.repTier)));
  check("PATTERN_MAIN is empty — every pool reads its growth from accessory slopes",
    Object.keys(PATTERN_MAIN).length === 0);
  check("every landmark group resolves to at least one ramped accessory for its growth signal",
    Object.keys(PATTERNS).every((g) => (PATTERN_RAMPED_ACC[g] || []).length > 0),
    Object.keys(PATTERNS).filter((g) => !(PATTERN_RAMPED_ACC[g] || []).length).join(","));
  check("only accumulation and deload blocks exist", Object.keys(BLOCKS).sort().join(",") === "accumulation,deload");
  check("intensification/realization are recorded as legacy-only block types",
    !!LEGACY_BLOCK_TYPES.intensification && !!LEGACY_BLOCK_TYPES.realization
    && !BLOCKS.intensification && !BLOCKS.realization);
  check("no block config carries main-lift rep/set schemes",
    Object.values(BLOCKS).every((b) => b.mainReps === undefined && b.mainSets === undefined));
  const rx = prescribe(fresh(), green);
  check("every prescribed item is straight sets (topSetCount === sets, backoffSetCount 0)",
    rx.items.every((it) => it.topSetCount === it.sets && it.backoffSetCount === 0));
  check("no prescribed item carries a backoff load distinct from its working load",
    rx.items.every((it) => it.backoffLoad === it.topLoad));
}

console.log("\n== Rotation shape: every muscle trained 2-3x per rotation ==");
{
  check(`rotation is ${ROT} days`, ROT === 4);
  check("each day pairs an upper half with a lower half (no upper-only or lower-only day)", ROTATION.every((d) => {
    const groups = new Set(d.items.map((k) => LIB[k].volumeGroup));
    const lower = ["quads", "hamstrings", "calves"].some((g) => groups.has(g));
    const upper = ["chest", "back", "front_delts", "side_delts", "rear_delts", "biceps", "triceps"].some((g) => groups.has(g));
    return lower && upper;
  }));
  const exposures = {};
  ROTATION.forEach((d) => {
    const seen = new Set(d.items.map((k) => LIB[k].volumeGroup));
    seen.forEach((g) => { exposures[g] = (exposures[g] || 0) + 1; });
  });
  Object.keys(PATTERNS).forEach((g) => {
    check(`${g} is trained on ${exposures[g]} separate days per rotation (>=2)`, exposures[g] >= 2, `got ${exposures[g]}`);
  });
  check("chest and back each get 2 training DAYS, not 2 slots on one day",
    exposures.chest === 2 && exposures.back === 2);
}

console.log("\n== Schedule capacity vs. landmarks ==");
{
  Object.keys(PATTERNS).forEach((g) => {
    const cap = maxDeliverable(g, "accumulation");
    check(`${g}: schedule capacity ${cap} covers its MAV of ${lm[g].mav}`, cap >= lm[g].mav);
  });
  check("no landmark group is left without ramped slots", Object.keys(PATTERNS).every((g) => PATTERN_FREQ[g] >= 2));
  check("triceps has 3 slots so its MAV is not forced into 6 sets of one movement in one session",
    PATTERN_FREQ.triceps === 3);
}

console.log("\n== The ramp: MEV -> MAV, with MRV as the recovery bound ==");
{
  Object.keys(PATTERNS).forEach((g) => {
    const atStart = deliveredWeekly(g, "accumulation", 0, lm, 1);
    const atEnd = deliveredWeekly(g, "accumulation", BLOCKS.accumulation.maxCycles - 1, lm, 1);
    check(`${g} ramps ${atStart} -> ${atEnd}, reaching MAV ${lm[g].mav} and staying under MRV ${lm[g].mrv}`,
      atEnd > atStart && atEnd >= lm[g].mav && atEnd <= lm[g].mrv);
  });
  check("MAV sits strictly between MEV and MRV for every group",
    Object.keys(PATTERNS).every((g) => lm[g].mev < lm[g].mav && lm[g].mav < lm[g].mrv));
}

console.log("\n== Effort progression: 3 RIR -> 0-1 RIR, compounds never to failure ==");
{
  const A = ACC_REP_TIERS.accumulation;
  check(`compounds open at RPE ${A.compound.rpe} (~3 RIR)`, A.compound.rpe === 7);
  check(`compounds cap at RPE ${A.compound.rpeCap} — never true failure on multi-joint work`, A.compound.rpeCap === 9);
  check(`isolation caps at RPE ${A.isolation.rpeCap} (~0-1 RIR), not a hard 10`, A.isolation.rpeCap === 9.5);
  check("every accumulation tier ramps effort across the block (all have rpeStep)",
    ["compound", "unilateral", "isolation"].every((t) => A[t].rpeStep > 0));
  check("deload drops effort to RPE <= 6.5 on every tier",
    ["compound", "unilateral", "isolation"].every((t) => ACC_REP_TIERS.deload[t].rpe <= 6.5));
  // real prescribe() output, not just the table
  const p = fresh();
  const first = prescribe({ ...p, block: { ...p.block, cycle: 0 } }, green);
  const last = prescribe({ ...p, block: { ...p.block, cycle: BLOCKS.accumulation.maxCycles - 1 } }, green);
  check("no prescribed set anywhere in an accumulation block sits at RPE 10",
    [first, last].every((rx) => rx.items.every((it) => it.rpe <= 9.5)));
  const maxFirst = Math.max(...first.items.map((it) => it.rpe));
  const maxLast = Math.max(...last.items.map((it) => it.rpe));
  check(`prescribed effort really climbs across the block (max RPE ${maxFirst} -> ${maxLast})`, maxLast > maxFirst);
  /* The band this guards is the ~5-30 rep zone the evidence says is flat for
     hypertrophy, NOT a narrower "hypertrophy rep range" — no such thing exists.
     Written as 8-12 it was really pinning the then-current targets, so scaling
     them by -2 broke it even though the program stayed comfortably inside the
     evidence-supported zone. Asserted against the zone the comment actually
     names, with a floor at 5 that would catch a genuine drift into strength
     territory (triples and below) where the load-equivalence finding no longer
     holds. */
  check("every prescribed rep target sits inside the flat 5-30 zone",
    [first, last].every((rx) => rx.items.every((it) => it.reps >= 5 && it.reps <= 30)));
  /* Across the WHOLE rotation, not just the default day — the unilateral tier
     has a single exercise (bsplit, day 2), so a one-day sample silently misses
     it and this assertion would claim two tiers where there are three. */
  const allReps = [...new Set(Array.from({ length: ROT }, (_, d) =>
    prescribe({ ...p, cycleIndex: d, block: { ...p.block, cycle: 0 } }, green).items.map((it) => it.reps)).flat())]
    .sort((a, b) => a - b);
  check(`the program's actual rep targets are ${allReps.join("/")} (compound/unilateral/isolation, scaled -2 at athlete request)`,
    allReps.length === 3 && allReps[0] === 6 && allReps[1] === 8 && allReps[2] === 10);
}

console.log("\n== Session and weekly budget (measured from real prescribe output) ==");
{
  const p = fresh();
  let peakSession = 0, peakRotation = 0, minSetsAnyItem = Infinity;
  for (let c = 0; c < BLOCKS.accumulation.maxCycles; c++) {
    let rot = 0;
    for (let d = 0; d < ROT; d++) {
      const rx = prescribe({ ...p, cycleIndex: d, block: { ...p.block, cycle: c } }, green);
      const t = rx.items.reduce((s, it) => s + it.sets, 0);
      rx.items.forEach((it) => { minSetsAnyItem = Math.min(minSetsAnyItem, it.sets); });
      peakSession = Math.max(peakSession, t); rot += t;
    }
    peakRotation = Math.max(peakRotation, rot);
  }
  check(`peak accumulation session stays at or under 40 sets (measured ${peakSession})`, peakSession <= 40);
  check(`peak rotation total stays at or under 150 sets (measured ${peakRotation})`, peakRotation <= 150);
  check(`no accumulation exercise is ever prescribed a single working set (min ${minSetsAnyItem})`, minSetsAnyItem >= 2);

  // same-day stacking really is capped
  for (let d = 0; d < ROT; d++) {
    const rx = prescribe({ ...p, cycleIndex: d, block: { ...p.block, cycle: BLOCKS.accumulation.maxCycles - 1 } }, green);
    const byGroup = {};
    rx.items.forEach((it) => { if (!LIB[it.key].fixedSets) byGroup[it.volumeGroup] = (byGroup[it.volumeGroup] || 0) + it.sets; });
    const over = Object.entries(byGroup).filter(([, v]) => v > SAME_DAY_GROUP_CAP);
    check(`day ${d} (${rx.dayName}): no muscle exceeds the same-session ramped cap of ${SAME_DAY_GROUP_CAP}`,
      over.length === 0, over.map(([g, v]) => `${g}=${v}`).join(","));
  }
  check(`no single slot is ever prescribed more than ACC_SET_CAP (${ACC_SET_CAP})`, (() => {
    for (let c = 0; c < BLOCKS.accumulation.maxCycles; c++)
      for (let d = 0; d < ROT; d++)
        if (prescribe({ ...p, cycleIndex: d, block: { ...p.block, cycle: c } }, green).items.some((it) => it.sets > ACC_SET_CAP)) return false;
    return true;
  })());
}

console.log("\n== Exercise selection loads the target at long muscle length ==");
{
  // The specific stretch-biased choices the design comment claims, machine-checked
  // so a future edit can't quietly swap one out and leave the rationale stranded.
  check("overhead triceps extension is the triceps slot (not a pressdown)",
    (PATTERN_RAMPED_ACC.triceps || []).includes("triext") && LIB.triext.label.includes("Overhead"));
  check("seated leg curl is the hamstring isolation (hip flexed = lengthened)",
    LIB.legcurl.label.startsWith("Seated") && LIB.legcurl.volumeGroup === "hamstrings");
  check("machine lat pullover carries lat work in the lengthened position",
    inRotation.has("latpullover") && LIB.latpullover.volumeGroup === "back");
  check("Bayesian cable curl is a biceps slot (elbow behind the torso)", inRotation.has("bayesiancurl"));
  check("RDL is the hamstring compound", LIB.rdl.volumeGroup === "hamstrings" && inRotation.has("rdl"));
  check("Bulgarian split squat is the unilateral quad slot", LIB.bsplit.repTier === "unilateral" && inRotation.has("bsplit"));
}

console.log("\n== Block cycling: accumulation <-> deload only ==");
{
  const p = fresh();
  // deload always routes back into accumulation, never into a removed block type
  // sessionsInBlock = ROT-1 so ingest()'s increment lands on an end-of-cycle
  // boundary (sessionsInBlock % ROT === 0), which is the only point transitions
  // are evaluated at.
  const deloaded = { ...p, block: { type: "deload", cycle: 1, sessionsInBlock: ROT - 1, nextAfter: "realization" },
    fatigue: { ...p.fatigue, index: 0 } };
  const rx = prescribe(deloaded, green);
  const logs = rx.items.map((it) => ({ key: it.key, topWeight: it.topLoad, topReps: it.reps, topRpe: it.rpe,
    targetRpe: it.rpe, missedSets: 0, touched: true, backoffSetCount: it.backoffSetCount,
    backoffReps: it.reps, backoffRpe: it.rpe, backoffRpeCap: it.backoffRpeCap }));
  const { transition } = ingest(deloaded, logs, green);
  check("deload transitions to accumulation even when a stale nextAfter says 'realization'",
    transition && transition.to === "accumulation", JSON.stringify(transition));
  check("deload prescribes materially less volume than late accumulation", (() => {
    const dl = prescribe({ ...p, block: { type: "deload", cycle: 0, sessionsInBlock: 0, nextAfter: null } }, green)
      .items.reduce((s, it) => s + it.sets, 0);
    const acc = prescribe({ ...p, block: { ...p.block, cycle: BLOCKS.accumulation.maxCycles - 1 } }, green)
      .items.reduce((s, it) => s + it.sets, 0);
    return dl < acc * 0.6;
  })());
}

console.log("\n== Migration from a saved strength-era program ==");
{
  // A program as it would have been saved by the pre-rebuild engine.
  const old = {
    unit: "lb", goal: "hybrid", experience: "intermediate", bodyweight: 200,
    landmarks: { quads: { label: "Quads", mev: 5, mav: 14, mrv: 18 }, hamstrings: { label: "Ham", mev: 3, mav: 6, mrv: 12 },
      chest: { label: "Chest", mev: 5, mav: 14, mrv: 22 }, front_delts: { label: "FD", mev: 2, mav: 7, mrv: 12 },
      back: { label: "Back", mev: 7, mav: 18, mrv: 25 }, rear_delts: { label: "RD", mev: 4, mav: 10, mrv: 16 },
      side_delts: { label: "SD", mev: 6, mav: 12, mrv: 18 }, calves: { label: "Calves", mev: 5, mav: 14, mrv: 20 } },
    lifts: {
      squat: { e1rm: 400, e1rmRaw: 400, hist: [{ e: 400, raw: 400 }] },
      bench: { e1rm: 280, e1rmRaw: 280, hist: [{ e: 280, raw: 280 }] },
      deadlift: { e1rm: 480, e1rmRaw: 480, hist: [{ e: 480, raw: 480 }] },
      rdl: { e1rm: 408, e1rmRaw: 408, hist: [{ e: 408, raw: 408 }] },
      row: { e1rm: 210, e1rmRaw: 210, hist: [{ e: 210, raw: 210 }] },
      cablerow: { e1rm: 210, e1rmRaw: 210, hist: [{ e: 210, raw: 210 }] },
      pulldown: { e1rm: 196, e1rmRaw: 196, hist: [{ e: 196, raw: 196 }] },
      curl: { e1rm: 98, e1rmRaw: 98, hist: [{ e: 98, raw: 98 }] },
      inclinebench: { e1rm: 154, e1rmRaw: 154, hist: [{ e: 154, raw: 154 }] },
      pullup: { e1rm: 240, e1rmRaw: 240, hist: [{ e: 240, raw: 240 }] },
      legext: { e1rm: 260, e1rmRaw: 260, hist: [{ e: 260, raw: 260 }] },
      legcurl: { e1rm: 192, e1rmRaw: 192, hist: [{ e: 192, raw: 192 }] },
      calfraise: { e1rm: 480, e1rmRaw: 480, hist: [{ e: 480, raw: 480 }] },
      bsplit: { e1rm: 80, e1rmRaw: 80, hist: [{ e: 80, raw: 80 }] },
      lateralraise: { e1rm: 34, e1rmRaw: 34, hist: [{ e: 34, raw: 34 }] },
      reversepecdeck: { e1rm: 42, e1rmRaw: 42, hist: [{ e: 42, raw: 42 }] },
      cablefly: { e1rm: 84, e1rmRaw: 84, hist: [{ e: 84, raw: 84 }] },
      dbshoulderpress: { e1rm: 168, e1rmRaw: 168, hist: [{ e: 168, raw: 168 }] },
      triext: { e1rm: 126, e1rmRaw: 126, hist: [{ e: 126, raw: 126 }] },
      shrug: { e1rm: 168, e1rmRaw: 168, hist: [{ e: 168, raw: 168 }] },
      wristcurl: { e1rm: 42, e1rmRaw: 42, hist: [{ e: 42, raw: 42 }] },
      cablecrunch: { e1rm: 112, e1rmRaw: 112, hist: [{ e: 112, raw: 112 }] },
      seatedcalf: { e1rm: 240, e1rmRaw: 240, hist: [{ e: 240, raw: 240 }] },
    },
    cycleIndex: 2, sessionCount: 40, lastSessionAt: null, avgSessionGapDays: 1.8, sessionsSinceLayoff: null,
    fatigue: { index: 0.2, rpeCreep: 0, readSupp: 0, missFreq: 0, slope: 0, backoffDrift: 0 },
    block: { type: "intensification", cycle: 2, sessionsInBlock: 8, nextAfter: "realization" },
    blockHistory: [], landmarkAdjustments: {}, landmarkLog: [], stallStreaks: {}, stallNotices: {},
  };
  const m = migrateProgram(old);
  check("a program saved mid-intensification lands in a fresh accumulation block",
    m.block.type === "accumulation" && m.block.cycle === 0);
  check("every rotation exercise has a lift record after migration",
    [...inRotation].every((k) => m.lifts[k]?.e1rm > 0), [...inRotation].filter((k) => !(m.lifts[k]?.e1rm > 0)).join(","));
  check("T-Bar Row seeds off the old Barbell Row, not off a pressing lift or the 100 fallback",
    Math.abs(m.lifts.tbarrow.e1rm - 210) < 1, String(m.lifts.tbarrow.e1rm));
  check("lat pullover seeds off the old Seated Cable Row", Math.abs(m.lifts.latpullover.e1rm - 210 * 0.8) < 1);
  check("Lat Pulldown is now its own exercise, seeded off T-Bar Row", m.lifts.pulldown?.e1rm > 0);
  check("both curls seed off the old Incline DB Curl", m.lifts.bayesiancurl.e1rm === 98 && Math.abs(m.lifts.preachercurl.e1rm - 98 * 1.1) < 1);
  check("dip seeds off bench", Math.abs(m.lifts.dip.e1rm - 280 * 0.75) < 1);
  check("biceps and triceps landmarks are backfilled for a program that predates them",
    m.landmarks.biceps?.mav > 0 && m.landmarks.triceps?.mav > 0);
  check("retired lifts keep their records (history still resolves)", !!m.lifts.row && !!m.lifts.deadlift);
  check("the migrated program prescribes without crashing on every rotation day", (() => {
    for (let d = 0; d < ROT; d++) { const r = prescribe({ ...m, cycleIndex: d }, green); if (!r.items.length) return false; }
    return true;
  })());
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
