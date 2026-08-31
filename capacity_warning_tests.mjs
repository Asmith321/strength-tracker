/* ============================================================================
   Schedule-capacity warning — verification. Run: node capacity_warning_tests.mjs
   (wired into `npm test`).

   WHAT IS BEING GUARDED. capacityShortfalls() answers "is this athlete's MAV
   actually reachable at the cadence they train?" by comparing a per-ROTATION
   capacity against a per-CALENDAR-WEEK landmark, converting between the two
   with freqScale. That conversion is the single most likely thing to be wrong
   — it is the same units mismatch AUDIT 3.3 found inside adjustLandmarks,
   where a per-rotation capacity was compared directly against weekly MRV and
   was therefore correct only at exactly 4x/week.

   SO THE CENTRAL TEST IS BEHAVIORAL, NOT ALGEBRAIC. Asserting
   capacityWeekly === maxDeliverable / freqScale would restate the
   implementation and pass just as happily with the division inverted. Instead
   the first block RUNS the engine at each cadence and checks the prediction
   against the sets prescribe() actually hands out. That is the check that
   fails if the units are flipped.

   CLOCK. ingest() reads Date.now() directly (it does not accept an injected
   timestamp), so simulating a cadence REQUIRES overriding it. Without this the
   simulated gap is whatever wall-clock time elapsed between loop iterations —
   effectively zero — every cadence collapses to the same program, and the
   whole suite passes while testing one scenario four times. This bit once
   already during the mutation-testing work.
   ============================================================================ */
const REAL_NOW = Date.now;
let CLOCK = Date.UTC(2026, 0, 1);
Date.now = () => CLOCK;

const {
  capacityShortfalls, capacityPinned, TRAINING_WEEKDAYS, freshProgram, prescribe, ingest, landmarksForExperience,
  maxDeliverable, weeklyFreqScale, LIB, ROT, FREQ_SCALE_MIN, FREQ_SCALE_REACHABLE_MIN, PATTERN_FREQ, TARGET_SESSION_GAP_DAYS,
} = await import("./src/engine.js");

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

const seeds = { squat: { weight: 315, reps: 5, rpe: 8 }, bench: { weight: 225, reps: 5, rpe: 8 },
  deadlift: { weight: 405, reps: 5, rpe: 8 } };
const progAt = (experience, gap) => ({ landmarks: landmarksForExperience(experience), avgSessionGapDays: gap });

/* Runs the real engine at a fixed cadence and returns, per muscle, the highest
   sets-per-calendar-week it ever actually receives.

   MEASURED OVER WHOLE ROTATIONS, NOT A FIXED NUMBER OF DAYS. The window has to
   contain each rotation day an equal number of times or the result is an
   artifact of where the window happens to start: a muscle trained on 3 of 5
   days can appear 3 times in one 12-session window and twice in the next, and
   taking the MAX across windows then reports a rate the schedule never
   sustains. That is exactly what a 28-day window did once the rotation became
   5 days (28 / 1.4 = 20 sessions = 4 rotations is fine, but 28 / 2.33 = 12
   sessions = 2.4 rotations is not) — it reported back at 17 sets/week against
   a real capacity of 15.6, i.e. above the cap, which is impossible and was the
   measurement's fault rather than the engine's. Whole rotations make every day
   contribute equally, and dividing by the rotation's true length in weeks
   converts to the per-calendar-week rate the landmarks are in. */
function deliveredPeakWeekly(experience, gapDays, weeks = 26) {
  CLOCK = Date.UTC(2026, 0, 1);
  let p = freshProgram({ seeds, experience, unit: "lb", goal: "hypertrophy", bodyweight: 200 });
  const sessions = [];
  for (let i = 0; i < Math.round((weeks * 7) / gapDays); i++) {
    const rx = prescribe(p, { trainingReadiness: 80 });
    const g = {};
    rx.items.forEach((it) => {
      const k = LIB[it.key].volumeGroup;
      if (k) g[k] = (g[k] || 0) + it.sets;
    });
    sessions.push(g);
    const logs = rx.items.map((it) => ({
      key: it.key, topWeight: it.topLoad, topReps: it.reps, topRpe: it.rpe,
      targetRpe: it.rpe, targetReps: it.reps, sets: it.sets, repsShort: 0, touched: true,
      backoffSetCount: it.backoffSetCount, backoffReps: it.reps,
      backoffRpe: it.backoffRpeCap ?? it.rpe, backoffRpeCap: it.backoffRpeCap,
    }));
    CLOCK += gapDays * 86400000;
    p = ingest(p, logs, { trainingReadiness: 80 }).next;
  }
  /* Four whole rotations, and the window is stepped a whole rotation at a time
     so every window covers the same set of rotation days. */
  const rotations = 4;
  const n = ROT * rotations;
  const weeksSpanned = (n * gapDays) / 7;
  const peak = {};
  for (let i = 0; i + n <= sessions.length; i += ROT) {
    const acc = {};
    sessions.slice(i, i + n).forEach((g) => Object.entries(g).forEach(([k, v]) => { acc[k] = (acc[k] || 0) + v; }));
    Object.entries(acc).forEach(([k, v]) => { peak[k] = Math.max(peak[k] || 0, v / weeksSpanned); });
  }
  return peak;
}

console.log("\n== The prediction matches what the engine actually prescribes ==");
{
  /* The anti-self-consistency check. If capacityWeekly were computed with
     freqScale multiplied instead of divided, every one of these would fail at
     the non-4x cadences while still passing at 1.75d — which is exactly how
     the AUDIT 3.3 bug hid. */
  for (const experience of ["intermediate", "advanced"]) {
    for (const gap of [TARGET_SESSION_GAP_DAYS, 1.75, 2.33]) {
      const delivered = deliveredPeakWeekly(experience, gap);
      const short = capacityShortfalls(progAt(experience, gap));
      const lm = landmarksForExperience(experience);
      const flagged = Object.keys(short);

      /* A flagged group must genuinely fall short of its MAV in practice. */
      const wronglyFlagged = flagged.filter((k) => delivered[k] >= lm[k].mav);
      check(`${experience} @ ${gap}d — every flagged group really does miss its MAV`,
        wronglyFlagged.length === 0,
        wronglyFlagged.map((k) => `${k}: got ${delivered[k]} >= mav ${lm[k].mav}`).join("; "));

      /* And an unflagged group must genuinely reach it. This is the direction
         that catches an inverted comparison: with the units flipped, the
         schedule-bound groups go unflagged and this fails. Tolerance is one
         set — allocation is integer-valued per session and the weekly figure
         is a rate. */
      const missed = Object.keys(lm).filter((k) => !short[k] && delivered[k] != null && delivered[k] < lm[k].mav - 1);
      check(`${experience} @ ${gap}d — every UNflagged group reaches its MAV`,
        missed.length === 0,
        missed.map((k) => `${k}: got ${delivered[k]} vs mav ${lm[k].mav}`).join("; "));

      /* The predicted capacity should be what a shortfall group actually gets,
         not merely "less than MAV" — that pins the magnitude, so a prediction
         that is directionally right but numerically nonsense still fails. */
      const offBy = flagged.filter((k) => Math.abs(delivered[k] - short[k].capacityWeekly) > 1);
      check(`${experience} @ ${gap}d — predicted capacity matches delivered volume (±1 set)`,
        offBy.length === 0,
        offBy.map((k) => `${k}: predicted ${short[k].capacityWeekly.toFixed(1)}, got ${delivered[k]}`).join("; "));
    }
  }
}

console.log("\n== The cases the athlete asked about ==");
{
  /* Thresholds written as LITERALS. Reading them back out of
     landmarksForExperience() would make the assertion true by construction
     whatever the tier tables said — the self-consistency trap this project
     keeps rediscovering. If a tier table or the rotation moves, these SHOULD
     fail and be re-read by a human.

     REBASELINED FOR THE 5-DAY ROTATION. The old expectations described the
     4-day program: "back and biceps are the only groups short at 4x/week" and
     "intermediate every-other-day: only back". Both were accurate then and
     both are the limitation the 5-day split was built to remove, so they are
     replaced rather than adjusted. */
  const design = capacityShortfalls(progAt("advanced", TARGET_SESSION_GAP_DAYS));
  check("advanced at the design cadence: NOTHING is schedule-limited — the whole point of the 5-day rotation",
    Object.keys(design).length === 0, JSON.stringify(design));
  const designInter = capacityShortfalls(progAt("intermediate", TARGET_SESSION_GAP_DAYS));
  check("intermediate at the design cadence: nothing is schedule-limited",
    Object.keys(designInter).length === 0, JSON.stringify(Object.keys(designInter)));
  /* NO LONGER CLEAR — and correctly so. The evidence-based landmark rewrite
     removed the advanced tier's MAV multiplier entirely (see EXPERIENCE_TIERS):
     intermediate and advanced now share the SAME seeded MAV, differing only in
     how wide their MEV-MRV band is for adjustLandmarks to explore. Since the
     rotation's slot counts were sized against that shared MAV, intermediate is
     exactly as exposed to a slow cadence as advanced now — there is no longer
     a tier where the design cadence's whole point (schedule capacity clearing
     MAV) creates extra slack for a slower one. That is a direct, intended
     consequence of removing an unsourced multiplier, not a regression. */
  check("intermediate at 4x/week is now flagged too — it shares advanced's MAV since the multiplier was removed",
    Object.keys(capacityShortfalls(progAt("intermediate", 1.75))).length === 9);

  /* The counterpart, and the reason the warning exists: running a FIVE-day
     program four days a week strands most of the landmarks.
     THE NUMBERS BELOW MOVED WITH THE EVIDENCE-BASED LANDMARK REWRITE. Back's
     MAV dropped 23 -> 18 and its rotation capacity 24 -> 18 (6 slots x 3, no
     longer 8), so at 4x/week its weekly capacity is 18 / 1.25 = 14.4 rather
     than 19.2. Front delts, which used to clear the design cadence by a wide
     margin (mav 9, capacity way above it), now needs exactly what its 2 slots
     deliver (mav 6 = capacity 6), so it joins the flagged set at any slower
     cadence — the shortfall list is 9 groups at 4x/week, not all 10: calves is
     the one group with real headroom left (mav 14 against a 18-set capacity,
     the GROUP_SET_CAP exemption's slack), so it clears 4x/week and only joins
     at every-other-day. */
  const adv4x = capacityShortfalls(progAt("advanced", 1.75));
  check("advanced running this 5-day program only 4x/week: back (MAV 18) drops to 14.4 of its 18-set capacity",
    adv4x.back && adv4x.back.mav === 18 && Math.abs(adv4x.back.capacityWeekly - 14.4) < 1e-9,
    JSON.stringify(adv4x.back));
  check("...and chest / side delts (MAV 16) drop to 14.4",
    ["chest", "side_delts"].every((g) => adv4x[g] && Math.abs(adv4x[g].capacityWeekly - 14.4) < 1e-9),
    JSON.stringify(Object.keys(adv4x)));
  check("...affecting 9 of the 10 tracked groups — calves is the one with real headroom left (the GROUP_SET_CAP exemption)",
    Object.keys(adv4x).length === 9 && !adv4x.calves, String(Object.keys(adv4x).length));

  const advEod = capacityShortfalls(progAt("advanced", 2.0));
  check("advanced every-other-day is worse still — every tracked group short, calves included",
    Object.keys(advEod).length === 10, JSON.stringify(Object.keys(advEod)));
  check("advanced every-other-day: back short by more than 5 sets/week",
    advEod.back.shortfall > 5, String(advEod.back?.shortfall));
}

console.log("\n== Slowing the cadence can only make a shortfall worse ==");
{
  /* Monotonicity. This is what actually dies if the division is inverted:
     with freqScale multiplied, training LESS often would appear to raise
     weekly capacity, and the ordering below reverses. */
  const gaps = [1.4, 1.75, 2.0, 2.33, 3.0];
  const caps = gaps.map((g) => capacityShortfalls(progAt("advanced", g)).back?.capacityWeekly
    ?? maxDeliverable("back") / weeklyFreqScale(g));
  check(`weekly back capacity falls monotonically as the gap grows (${caps.map((c) => c.toFixed(1)).join(" > ")})`,
    caps.every((c, i) => i === 0 || c <= caps[i - 1] + 1e-9), JSON.stringify(caps));

  const counts = gaps.map((g) => Object.keys(capacityShortfalls(progAt("advanced", g))).length);
  check(`the number of short groups never falls as the gap grows (${counts.join(" <= ")})`,
    counts.every((c, i) => i === 0 || c >= counts[i - 1]), JSON.stringify(counts));
}

console.log("\n== The prescribed fix actually fixes it ==");
{
  /* sessionsPerWeekNeeded is only useful if training at that cadence really
     clears the group. Applying the engine's own advice back to the engine is a
     genuine round-trip here (not self-consistency) because the two sides are
     different computations: one solves for a cadence, the other re-derives the
     shortfall from scratch at that cadence. */
  let checked = 0, bad = [];
  for (const experience of ["intermediate", "advanced"]) {
    for (const gap of [TARGET_SESSION_GAP_DAYS, 1.75, 2.33]) {
      const short = capacityShortfalls(progAt(experience, gap));
      Object.entries(short).forEach(([k, v]) => {
        if (!v.fixableByCadence) return;
        checked++;
        const fixedGap = 7 / v.sessionsPerWeekNeeded;
        const after = capacityShortfalls(progAt(experience, fixedGap));
        if (after[k]) bad.push(`${experience}/${gap}d ${k} still short at ${v.sessionsPerWeekNeeded.toFixed(2)}x/wk`);
      });
    }
  }
  check(`training at sessionsPerWeekNeeded clears the group in all ${checked} flagged cases`,
    bad.length === 0, bad.join("; "));
  check("that actually exercised a meaningful number of cases", checked >= 8, String(checked));
}

console.log("\n== A slot shortage is reported differently from a cadence shortage ==");
{
  /* freqScale clamps at FREQ_SCALE_MIN, so capacity tops out at
     maxDeliverable / FREQ_SCALE_MIN. Past that, more training days provably
     cannot deliver the MAV and the athlete needs a rotation change instead.
     Telling them to add days would be actively wrong advice. */
  const capBack = maxDeliverable("back");
  /* Measured against the floor the RATE ESTIMATOR can reach, not the clamp.
     FREQ_SCALE_MIN (0.6) sits below anything sessionsPerWeekObserved can
     produce — it counts distinct calendar days, so it tops out at 7/week, a
     freqScale of ROT/7 — and computing advice against the clamp promised
     cadences that do not exist. */
  const impossible = Math.ceil(capBack / FREQ_SCALE_REACHABLE_MIN) + 5;
  const p = { landmarks: { back: { label: "Back", mev: 8, mav: impossible, mrv: impossible + 4 } }, avgSessionGapDays: 1.75 };
  const s = capacityShortfalls(p);
  check(`a MAV of ${impossible} (above the ${(capBack / FREQ_SCALE_REACHABLE_MIN).toFixed(1)} reachable ceiling) is not blamed on cadence`,
    s.back && s.back.fixableByCadence === false && s.back.sessionsPerWeekNeeded === null,
    JSON.stringify(s.back));

  /* The boundary itself: exactly at the clamp ceiling it IS still fixable. */
  const atCeiling = { landmarks: { back: { label: "Back", mev: 8, mav: capBack / FREQ_SCALE_REACHABLE_MIN, mrv: 40 } }, avgSessionGapDays: 1.75 };
  check("a MAV sitting exactly at the clamp ceiling is still reported as cadence-fixable",
    capacityShortfalls(atCeiling).back?.fixableByCadence === true);

  check("the reported slot count is the group's real ramped-slot count",
    s.back.slots === PATTERN_FREQ.back, `${s.back.slots} vs ${PATTERN_FREQ.back}`);
}

console.log("\n== Degenerate input degrades quietly ==");
{
  /* This feeds a UI panel. A program mid-migration, or one whose cadence isn't
     established yet, must not throw on the Status screen. */
  check("a null program yields no warnings rather than throwing", Object.keys(capacityShortfalls(null)).length === 0);
  check("a program with no landmarks yields no warnings", Object.keys(capacityShortfalls({})).length === 0);
  check("an athlete with no tracked cadence yet is assessed at freqScale 1 (the 4x baseline)",
    JSON.stringify(capacityShortfalls({ landmarks: landmarksForExperience("advanced"), avgSessionGapDays: null }))
    === JSON.stringify(capacityShortfalls(progAt("advanced", 7 / ROT))));
  check("a brand-new program reports nothing before it has trained",
    Object.keys(capacityShortfalls(freshProgram({ seeds, experience: "intermediate", unit: "lb", goal: "hypertrophy", bodyweight: 200 }))).length === 0);
}

console.log("\n== Groups pinned AT the ceiling, where the auto-tune can no longer raise them ==");
{
  /* capacityShortfalls asks "is this MAV out of reach?" (mav > capW).
     capacityPinned asks the question one step earlier: "has it arrived AT the
     ceiling, so it can never be raised again?" (mav === capW). At equality
     nothing is short, so the shortfall warning is silent — while
     adjustLandmarks' raise gate (mav + 1 <= capW) is permanently false. That
     gap is why nine of ten groups could end up frozen with nothing said. */
  const adv = landmarksForExperience("advanced");
  const atDesign = { landmarks: adv, sessionsPerWeek: TRAINING_WEEKDAYS.length };
  const pinned = capacityPinned(atDesign);
  /* Literals, not values read back from the tier table.

     THREE groups are pinned now, not seven — the evidence-based landmark
     rewrite gave most groups a MAV that doesn't divide evenly by the 3-set
     cap, which is exactly what leaves them slack: every group's slot count is
     still sized as ceil(MAV / 3), so capacity is 3 x that ceiling, which
     equals MAV only when MAV is itself a multiple of 3. Back (18), front delts
     (6) and triceps (12) all are; the rest land on a remainder of 1 or 2 and
     get 2-4 sets of headroom for free. Calves escapes by a much wider margin
     (its GROUP_SET_CAP exemption gives it 18 sets of capacity against a MAV of
     14, not the ceil(MAV/3) sizing every other group uses). */
  check(`three of ten groups are pinned exactly at schedule capacity (${Object.keys(pinned).sort().join(", ")})`,
    Object.keys(pinned).sort().join(",") === "back,front_delts,triceps"
    && Object.values(pinned).every((v) => Math.abs(v.capacityWeekly - v.mav) < 1e-9),
    JSON.stringify(pinned));
  check("the pinned three are exactly those whose MAV divides evenly by the 3-set cap (back 18, front delts 6, triceps 12)",
    ["back", "front_delts", "triceps"].every((g) => pinned[g] && adv[g].mav % 3 === 0));
  check("every other tracked group has at least a set of headroom (not pinned)",
    Object.keys(adv).filter((g) => !["back", "front_delts", "triceps"].includes(g)).every((g) => !pinned[g]));
  check("and none of them is reported as a shortfall — they are not short, they are finished",
    Object.keys(capacityShortfalls(atDesign)).every((g) => !pinned[g]));

  /* THE PROPERTY THAT MAKES THIS WORTH REPORTING: the auto-tune's raise gate
     really is dead for exactly these groups. Recomputed here from the gate's
     own arithmetic rather than trusting the flag. */
  Object.keys(pinned).forEach((g) => {
    check(`  ${g}: the raise gate (mav + 1 <= capW) is false, so MAV can never climb again`,
      !(adv[g].mav + 1 <= maxDeliverable(g)));
  });

  /* The two states must be mutually exclusive, or the Status screen would tell
     the athlete to add training days AND change the rotation for one muscle. */
  for (const gap of [TARGET_SESSION_GAP_DAYS, 1.75, 2.33]) {
    const p = progAt("advanced", gap);
    const both = Object.keys(capacityPinned(p)).filter((g) => capacityShortfalls(p)[g]);
    check(`@${gap}d no group is reported as BOTH pinned and short (${both.join(", ") || "none"})`, both.length === 0);
  }

  check("a group with real headroom is not reported at all",
    capacityPinned({ landmarks: { back: { label: "Back", mev: 8, mav: 10, mrv: 30 } }, sessionsPerWeek: 5 }).back === undefined);
  check("a null program is handled", Object.keys(capacityPinned(null)).length === 0);
}

console.log("\n== Advice is measured against a cadence that actually exists ==");
{
  /* FREQ_SCALE_MIN is 0.6, but sessionsPerWeekObserved counts distinct calendar
     days and so cannot exceed 7 sessions/week — a freqScale of ROT/7. Computing
     "fixable by training more" against the clamp advertised a capacity ceiling
     ~19% above anything the estimator can produce. Pinned as literals: the
     clamp is 0.6, the reachable floor is 5/7. */
  check(`the clamp floor is 0.6 and the reachable floor is ${(5 / 7).toFixed(4)} — they differ`,
    FREQ_SCALE_MIN === 0.6 && Math.abs(FREQ_SCALE_REACHABLE_MIN - 5 / 7) < 1e-9,
    `${FREQ_SCALE_MIN} / ${FREQ_SCALE_REACHABLE_MIN}`);
  /* A MAV between the two floors: reachable if you believe the clamp, not
     reachable in fact. It must be reported as a slot problem, not a cadence one. */
  const capBack = maxDeliverable("back");
  const between = Math.floor((capBack / FREQ_SCALE_REACHABLE_MIN + capBack / FREQ_SCALE_MIN) / 2);
  const s = capacityShortfalls({ landmarks: { back: { label: "Back", mev: 8, mav: between, mrv: between + 5 } }, sessionsPerWeek: 5 });
  check(`a MAV of ${between} sits between the reachable floor (${(capBack / FREQ_SCALE_REACHABLE_MIN).toFixed(1)}) and the clamp (${(capBack / FREQ_SCALE_MIN).toFixed(1)})`,
    between > capBack / FREQ_SCALE_REACHABLE_MIN && between < capBack / FREQ_SCALE_MIN);
  check("...and is reported as needing a rotation change, not more training days",
    s.back && s.back.fixableByCadence === false, JSON.stringify(s.back));
}

Date.now = REAL_NOW;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
