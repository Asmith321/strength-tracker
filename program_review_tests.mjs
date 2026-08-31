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
  LIB, ROTATION, ROT, PATTERNS, PATTERN_FREQ, PATTERN_OF, PATTERN_RAMPED_ACC, PATTERN_MAIN,
  ACC_REP_TIERS, BLOCKS, LEGACY_BLOCK_TYPES, RETIRED_LABELS, ACC_SET_CAP, GROUP_SET_CAP, setCapFor, SAME_DAY_GROUP_CAP, TRAINING_WEEKDAYS,
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
  /* Added by the athlete after their first real session, extending the
     original list rather than working around it. Recorded here so the
     constraint stays a constraint: this test is what stops an exercise being
     slipped into the program without the athlete asking for it, and it did
     catch both of these before they shipped. */
  "triceppushdown", "nordic",
  /* Approved by the athlete when the 3-set ceiling left rear delts needing a
     second exercise. They were offered Face Pull, Single-Arm Cable Reverse Fly
     and this, and picked this one. */
  "dbreversefly",
]);

console.log("\n== Approved-exercise constraint ==");
{
  const strays = Object.keys(LIB).filter((k) => !APPROVED.has(k));
  check("every exercise defined in LIB is on the athlete's approved list", strays.length === 0, strays.join(","));
  const rotStrays = [...inRotation].filter((k) => !APPROVED.has(k));
  check("every exercise in the rotation is on the approved list", rotStrays.length === 0, rotStrays.join(","));
  check("deadlift is defined but carries NO rotation slot (dropped as a hypertrophy tool)",
    !!LIB.deadlift && !inRotation.has("deadlift"));
  /* Front squat, DB bench and incline BB all carry slots now. They were the
     spare capacity the 3-set ceiling needed: quads went from 4 slots to 6 and
     chest from 4 to 6, and rather than approve new exercises those three were
     brought in off the bench. Two approved exercises remain unslotted, each for
     its own reason: deadlift because it was dropped as a hypertrophy tool, and
     the BB wrist curl because forearms are a single fixedSets slot that the DB
     version already fills. Pinned as a SET so bringing either in — or dropping
     something out — has to be a deliberate edit here. */
  const unslotted = [...APPROVED].filter((k) => !inRotation.has(k)).sort();
  check(`exactly deadlift and the BB wrist curl are unslotted (${unslotted.join(", ")})`,
    unslotted.join(",") === "bbwristcurl,deadlift");
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
  check(`rotation is ${ROT} days`, ROT === 5);
  /* THE BALANCE CONSTRAINT, RESTATED (AGAIN) AS WHAT IT WAS ACTUALLY FOR.
     Originally "every day pairs an upper half with a lower half"; then, when
     the 5-day split broke that, "no day is more than 2 exercises longer than
     the shortest". Both were proxies for the one thing anybody cares about:
     SESSION LENGTH, so that no training day is twice the work of another.

     Exercise count stopped being a usable proxy at the 3-set ceiling. The
     athlete exempted Standing Calf Raise from the cap, so one exercise on the
     lower days carries 9 sets while a typical exercise carries 3 — the week is
     12/9/12/9/12 exercises but 36/33/36/33/35 SETS. Counting exercises calls
     that a spread of 3 and fails; counting sets calls it a spread of 3 sets out
     of 36 and passes, which is the truth. Measure the thing itself. */
  const daySets = ROTATION.map((_, i) => {
    const p = freshProgram({ seeds, experience: "advanced", unit: "lb", goal: "hypertrophy", bodyweight: 200 });
    p.cycleIndex = i;
    p.block = { type: "accumulation", cycle: BLOCKS.accumulation.maxCycles - 1, sessionsInBlock: 0, nextAfter: null };
    return prescribe(p, { trainingReadiness: 80 }).items.reduce((s, it) => s + it.sets, 0);
  });
  const spread = Math.max(...daySets) - Math.min(...daySets);
  check(`no training day is more than 25% longer than the shortest (${daySets.join(", ")} sets — spread ${spread})`,
    spread <= Math.ceil(Math.min(...daySets) * 0.25));
  const exposures = {};
  ROTATION.forEach((d) => {
    const seen = new Set(d.items.map((k) => LIB[k].volumeGroup));
    seen.forEach((g) => { exposures[g] = (exposures[g] || 0) + 1; });
  });
  Object.keys(PATTERNS).forEach((g) => {
    check(`${g} is trained on ${exposures[g]} separate days per rotation (>=2)`, exposures[g] >= 2, `got ${exposures[g]}`);
  });
  /* Exposure counts are now a CONSEQUENCE of the upper/lower split rather than
     per-muscle decisions, so they are asserted as the shape they must take: the
     upper groups sit on Mon/Wed/Fri (3 days) and the lower groups on Tue/Thu
     (2 days), because those are the only two non-adjacent day-sets available.
     The previous version pinned chest at exactly 2 and back at exactly 3, which
     were true statements about a rotation built muscle by muscle and became
     false the moment the split decided the counts. */
  check("back gets 3 training DAYS so its advanced MAV of 23 clears the same-day cap",
    exposures.back === 3, `got ${exposures.back}`);
  /* Landmark groups only. traps/forearms/abs are fixedSets pools carrying a
     single slot each and are deliberately not volume-tracked, so the 2-3 day
     shape does not apply to them. */
  const badExposure = Object.keys(PATTERNS).map((g) => [g, exposures[g]]).filter(([, n]) => n !== 2 && n !== 3);
  check(`every tracked muscle gets exactly 2 or 3 training days (${badExposure.map(([g, n]) => `${g}=${n}`).join(", ") || "all 2-3"})`,
    badExposure.length === 0);

  /* The two requirements the 5-day rotation exists to satisfy, asserted here
     against the SHIPPED program (engine_fix_tests asserts the same two against
     the capacity mechanism). At the design cadence one rotation spans exactly
     7 days, so exposures per rotation are exposures per week. */
  const advanced = landmarksForExperience("advanced");
  const underTwice = Object.keys(advanced).filter((g) => (exposures[g] || 0) < 2);
  check(`REQUIREMENT 2 — every tracked muscle trained >= 2x/week (${underTwice.join(", ") || "all >= 2x"})`,
    underTwice.length === 0);
  const shortOfMav = Object.keys(advanced).filter((g) => maxDeliverable(g, "accumulation") < advanced[g].mav);
  check(`REQUIREMENT 1 — every ADVANCED MAV is deliverable at the design cadence (${shortOfMav.join(", ") || "none short"})`,
    shortOfMav.length === 0);
}

console.log("\n== Movement rules: the pairings the athlete rejects ==");
{
  /* WHY THIS BLOCK EXISTS. Every assertion above is about VOLUME — how many
     sets a muscle gets and on how many days. None of them can see that two
     slots serving the same muscle might be the same MOVEMENT. The first 5-day
     rotation shipped with Pull-Up immediately followed by Lat Pulldown, which
     the capacity math scored as a perfectly good pair of back slots.

     A first pass at fixing it over-corrected into "nothing same-pattern
     adjacent" and "no session repeats a compound pattern". The athlete
     rejected both: two presses or two pulls in a row is ordinary training.
     What follows is the narrower set they actually hold — written as their
     rules, not as a general theory of programming. */

  check("every exercise in the rotation has a declared movement pattern",
    [...new Set(ROTATION.flatMap((d) => d.items))].every((k) => PATTERN_OF[k]),
    [...new Set(ROTATION.flatMap((d) => d.items))].filter((k) => !PATTERN_OF[k]).join(","));

  /* RULE 1 — Pull-Up and Lat Pulldown never share a session. Not "not
     adjacent": never together at all. They are the same vertical pull against
     the same muscles, so one session holding both is one exercise done twice.
     Asserted over the specific pair rather than over the "vertical pull"
     pattern generally, because it IS the specific pair the athlete named. */
  const bothVerticals = ROTATION.filter((d) => d.items.includes("pullup") && d.items.includes("pulldown"));
  check("no session contains both Pull-Up and Lat Pulldown",
    bothVerticals.length === 0, bothVerticals.map((d) => d.name).join("; "));
  check("sanity: both are still in the program, on different days — the rule separates them rather than dropping one",
    ROTATION.some((d) => d.items.includes("pullup")) && ROTATION.some((d) => d.items.includes("pulldown")));

  /* RULE 4 — NO MUSCLE ON CONSECUTIVE DAYS. The athlete's rule, and the one
     that determines this rotation's whole shape. It is much stronger than it
     reads: in a Mon-Fri week there is exactly ONE set of three non-adjacent
     days, {Mon, Wed, Fri}, so every muscle needing three exposures must be on
     all three, and everything else takes a non-adjacent pair.
     The rotation this replaced violated it four times over — triceps Mon+Tue,
     side delts Wed+Thu, back and biceps Thu+Fri — while passing every other
     check in this file, because nothing here looked at WHICH days a muscle
     landed on, only how many. */
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const dayIdx = {};
  ROTATION.forEach((d, i) => new Set(d.items.map((k) => LIB[k].volumeGroup)).forEach((g) => {
    if (g) (dayIdx[g] = dayIdx[g] || []).push(i);
  }));
  const consecutive = [];
  Object.entries(dayIdx).forEach(([g, days]) => {
    const s = [...days].sort((a, b) => a - b);
    for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] === 1) consecutive.push(`${g} on ${DOW[s[i - 1]]}+${DOW[s[i]]}`);
  });
  check("no muscle is trained on consecutive days", consecutive.length === 0, consecutive.join("; "));
  /* Friday to Monday is three days apart, so the week wrapping is not a
     violation — asserted so nobody "fixes" it later. */
  check("sanity: the week wraps across a weekend, so Friday and Monday are not consecutive",
    TRAINING_WEEKDAYS[0] === 1 && TRAINING_WEEKDAYS[TRAINING_WEEKDAYS.length - 1] === 5);
  /* The structural consequence, asserted directly: anything on three days is on
     Mon/Wed/Fri, because no other non-adjacent triple exists. */
  const threeDay = Object.entries(dayIdx).filter(([, d]) => d.length >= 3);
  check(`every 3x-per-week muscle is on Mon/Wed/Fri (${threeDay.map(([g]) => g).join(", ")})`,
    threeDay.every(([, d]) => JSON.stringify([...d].sort((a, b) => a - b)) === "[0,2,4]"),
    threeDay.map(([g, d]) => `${g}: ${d.map((i) => DOW[i]).join("/")}`).join("; "));
  check("sanity: at least one muscle really does need three exposures, so the rule above is not vacuous",
    threeDay.length > 0);

  /* RULES 2 AND 3 WERE WITHDRAWN BY THE ATHLETE, and are recorded here rather
     than deleted silently, because both were added at their request and a
     future reader will otherwise re-derive them from the conversation history.

     RULE 2 was "no pressing on a lower-body day", added after an earlier pass
     parked the overhead press on leg day. Withdrawn verbatim: "scrap no push
     exercises on leg rule or anything like that ... I don't care what split I
     run as long as it's able to deliver the appropriate frequency and volume,
     no training the same muscle back to back days, and no more than 3 sets per
     exercise". The `lowerBody` flag on ROTATION days existed only to
     machine-check this rule and has been removed with it.

     RULE 3 was "no incline press in the same session as an overhead press".
     Withdrawn by the same message, but it is worth recording that it had ALSO
     become unsatisfiable: front delts have exactly one approved exercise and
     need three exposures at a 3-set cap, so the DB Overhead Press is on all
     three upper days and no incline can avoid it. Restoring the rule requires a
     second front-delt exercise or a GROUP_SET_CAP exemption like the calves'.
     This was flagged to the athlete rather than quietly absorbed.

     What survives is RULE 1 (Pull-Up / Lat Pulldown, above), RULE 4 (no muscle
     on consecutive days, above) and the same-movement stacking check below. */
  check("the withdrawn rules left no dead machinery behind: no rotation day still carries a lowerBody flag",
    ROTATION.every((d) => d.lowerBody === undefined));

  /* Guard against the rules going vacuous. If the rotation ever lost its
     multi-slot days these would pass while testing nothing, so assert the
     situation they police actually exists. */
  const stacked = [];
  ROTATION.forEach((d) => {
    const byGroup = {};
    d.items.forEach((k) => {
      const g = LIB[k].volumeGroup;
      if (g && !LIB[k].fixedSets) (byGroup[g] = byGroup[g] || []).push(k);
    });
    Object.entries(byGroup).forEach(([g, ks]) => { if (ks.length > 1) stacked.push({ day: d.name, g, ks }); });
  });
  check(`sanity: sessions really do stack two slots on one muscle, so these rules are load-bearing (${stacked.length} such pairs)`,
    stacked.length > 0);
  const sameMovement = stacked.filter(({ ks }) => new Set(ks.map((k) => PATTERN_OF[k])).size < ks.length);
  check("every stacked pair uses genuinely different movements",
    sameMovement.length === 0,
    sameMovement.map(({ day, g, ks }) => `${day}/${g}: ${ks.join("+")}`).join("; "));
}

console.log("\n== Schedule capacity vs. landmarks ==");
{
  Object.keys(PATTERNS).forEach((g) => {
    const cap = maxDeliverable(g, "accumulation");
    check(`${g}: schedule capacity ${cap} covers its MAV of ${lm[g].mav}`, cap >= lm[g].mav);
  });
  check("no landmark group is left without ramped slots", Object.keys(PATTERNS).every((g) => PATTERN_FREQ[g] >= 2));
  /* Generalised from a hardcoded "triceps has 3 slots". The property was never
     about triceps: it is that no group's MAV is forced through so few slots
     that one appearance would have to exceed the per-exposure cap. Stated that
     way it holds for every group at any cap, instead of naming one muscle and a
     slot count that the 3-set ceiling changed from 3 to 5. */
  const forcedOverCap = Object.keys(PATTERNS).filter((g) =>
    lm[g].mav > PATTERN_FREQ[g] * setCapFor(g));
  check(`no group's MAV needs more sets per appearance than its cap allows (${forcedOverCap.join(", ") || "none"})`,
    forcedOverCap.length === 0);
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

  /* MAV MUST SIT IN A SANE FRACTION OF MRV — and this is a REGRESSION GUARD for
     a defect that shipped and was caught by the athlete looking at the screen,
     not by this suite.
     Removing the advanced-tier MAV multiplier while leaving the MRV one at 1.3x
     inflated MRV relative to everything measured against it. Two consequences,
     neither of which any of the 883 existing assertions could see, because they
     all check RELATIONSHIPS (mev < mav < mrv, ramp stays under MRV) and every
     one of those still held:
       1. Advanced MRVs went above RP's published ceilings (back 33 vs ~25,
          chest 29 vs ~22, triceps 23 vs ~18) — the same unsourced-multiplier
          error that had just been fixed one column over.
       2. The Status screen scales each volume bar's whole track to MRV, so at
          the TOP of the ramp — maximum programmed volume — bars filled only
          46-62% (averaging 53%) and both ticks crowded into the left half.
          Every muscle read as perpetually half-trained.
     The band is two-sided on purpose. Too LOW and the bar is unreadable and MRV
     is probably unsourced; too HIGH (say MRV = MAV + 1) and MRV has stopped
     being a meaningful recovery ceiling at all, which would also be wrong.

     CHECKED AT EVERY TIER, not just the one this file's `lm` happens to hold.
     The first version of this guard read the intermediate table and passed
     happily with the bug re-introduced — the defect only ever existed at the
     ADVANCED tier, because that is the only tier the MRV multiplier applies
     to. A regression guard that cannot see the regression it was written for
     is worse than no guard, so it iterates the tiers instead. */
  ["beginner", "intermediate", "advanced"].forEach((tier) => {
    const tl = landmarksForExperience(tier);
    const ratios = Object.keys(PATTERNS).map((g) => [g, tl[g].mav / tl[g].mrv]);
    const outOfBand = ratios.filter(([, r]) => r < 0.55 || r > 0.85);
    check(`${tier}: MAV is 55-85% of MRV for every group (${ratios.map(([g, r]) => `${g} ${Math.round(r * 100)}%`).join(", ")})`,
      outOfBand.length === 0, outOfBand.map(([g, r]) => `${g}=${Math.round(r * 100)}%`).join(", "));
  });
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
  /* A SINGLE WORKING SET IS NOW LEGAL, and only in the opening cycle of a
     block. RAMPED_SET_FLOOR dropped from 2 to 1 with the 3-set ceiling: at 6-8
     slots per muscle a floor of 2 opened every block at roughly double the
     group's own MEV, which is not a ramp from MEV. The old assertion was
     written when a pool had 3-4 slots and a 1-set prescription really was a
     rounding artifact; now it is the MEV end of a deliberate 1->3 ramp on an
     exercise appearing 2-3x that week. What must still hold is that it is
     confined to the START of the block — a single set at the TOP of the ramp
     would mean the ramp is not climbing. */
  check(`a single working set appears only at the MEV end of the block (min ${minSetsAnyItem})`, minSetsAnyItem >= 1);
  const topMin = Math.min(...Array.from({ length: ROT }, (_, d) =>
    Math.min(...prescribe({ ...p, cycleIndex: d, block: { ...p.block, cycle: BLOCKS.accumulation.maxCycles - 1 } }, green)
      .items.filter((it) => !LIB[it.key].fixedSets).map((it) => it.sets))));
  check(`no ramped slot is still on a single set at the top of the ramp (min ${topMin})`, topMin >= 2);

  // same-day stacking really is capped
  for (let d = 0; d < ROT; d++) {
    const rx = prescribe({ ...p, cycleIndex: d, block: { ...p.block, cycle: BLOCKS.accumulation.maxCycles - 1 } }, green);
    const byGroup = {};
    rx.items.forEach((it) => { if (!LIB[it.key].fixedSets) byGroup[it.volumeGroup] = (byGroup[it.volumeGroup] || 0) + it.sets; });
    const over = Object.entries(byGroup).filter(([, v]) => v > SAME_DAY_GROUP_CAP);
    check(`day ${d} (${rx.dayName}): no muscle exceeds the same-session ramped cap of ${SAME_DAY_GROUP_CAP}`,
      over.length === 0, over.map(([g, v]) => `${g}=${v}`).join(","));
  }
  /* THE ATHLETE'S HARD RULE: no more than 3 sets of any one exercise, with a
     single exemption they granted by name. Checked per exercise against
     setCapFor(its group) so the exemption cannot silently widen — if a second
     calf exercise is ever approved, or GROUP_SET_CAP grows another key, the
     offenders are named in the failure rather than waved through. */
  const overCap = [];
  for (let c = 0; c < BLOCKS.accumulation.maxCycles; c++)
    for (let d = 0; d < ROT; d++)
      prescribe({ ...p, cycleIndex: d, block: { ...p.block, cycle: c } }, green).items.forEach((it) => {
        const cap = LIB[it.key].fixedSets ? LIB[it.key].fixedSets : setCapFor(it.volumeGroup);
        if (it.sets > cap) overCap.push(`${it.key} ${it.sets}>${cap} (cyc ${c} day ${d})`);
      });
  check(`no exercise ever exceeds its own set cap — ${ACC_SET_CAP} for everything except ${Object.entries(GROUP_SET_CAP).map(([g, n]) => `${g} (${n})`).join(", ")}`,
    overCap.length === 0, overCap.slice(0, 5).join("; "));
  const exempt = Object.keys(GROUP_SET_CAP);
  check(`sanity: the exemption is exercised — ${exempt.join(", ")} really is prescribed above ${ACC_SET_CAP}`,
    exempt.every((g) => {
      const rx = prescribe({ ...p, cycleIndex: ROTATION.findIndex((day) => day.items.some((k) => LIB[k].volumeGroup === g)), block: { ...p.block, cycle: BLOCKS.accumulation.maxCycles - 1 } }, green);
      return rx.items.some((it) => it.volumeGroup === g && it.sets > ACC_SET_CAP);
    }));
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
