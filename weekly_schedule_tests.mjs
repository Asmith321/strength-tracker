/* ============================================================================
   Fixed weekly schedule (Mon-Fri, resting Sat/Sun) — verification.
   Run: node weekly_schedule_tests.mjs   (wired into `npm test`)

   THE BUG THIS EXISTS FOR. The 5-day rotation was built to be trained Monday
   to Friday, but the engine measured training frequency as an EWMA of
   inter-session GAPS. Mon-Fri is gaps of 1,1,1,1,3. Those average exactly 1.4
   — the design cadence — but an EWMA never SETTLES on 1.4, because the input
   is periodic rather than noisy around a mean. Measured, it cycled forever:

       1.173 -> 1.721 -> 1.505 -> 1.353 -> 1.247 -> 1.173 -> ...

   dragging freqScale between 0.838 and 1.229 and making per-session volume
   depend on which weekday it happened to be. End to end that cost six of the
   ten tracked groups their advanced MAV — chest 16/18, back 22/23, side delts
   16/18, calves 16/18, biceps 17/18, front delts 8/9 — on a schedule that is,
   by construction, exactly 5 sessions per week. The capacity warning did not
   catch it either, because it read the same instantaneous value.

   Separately, the advisory added a fractional gap to a running target, which
   walked straight through the weekend: followed from a Monday it produced
   Mon -> Wed -> Thu -> Fri -> SUNDAY -> Mon.

   Both are now measured against a REAL Mon-Fri pattern driven through
   prescribe/ingest with a pinned clock, rather than against the formulas.

   CLOCK. ingest() reads Date.now() directly, so the schedule must be simulated
   by overriding it. Without that every session lands at the same instant, the
   gaps are all zero, and this file would pass while testing nothing.
   ========================================================================== */
const REAL_NOW = Date.now;
let CLOCK = Date.UTC(2026, 0, 5, 18);
Date.now = () => CLOCK;

const {
  freshProgram, prescribe, ingest, migrateProgram, LIB, ROT, ROTATION,
  landmarksForExperience, weeklyFreqScale, effectiveGapDays, sessionsPerWeekObserved,
  nextSessionTargetAt, targetSessionsPerWeek, capacityShortfalls,
  TRAINING_WEEKDAYS, SESSION_RATE_WINDOW_WEEKS, SESSION_RATE_MIN_SESSIONS, SESSION_LOG_MAX,
} = await import("./src/engine.js");

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

const DAY = 86400000;
const seeds = { squat: { weight: 315, reps: 5, rpe: 8 }, bench: { weight: 225, reps: 5, rpe: 8 },
  rdl: { weight: 275, reps: 8, rpe: 8 }, tbarrow: { weight: 185, reps: 8, rpe: 8 } };

/* Training timestamps for an athlete who trains every configured weekday at
   18:00 and rests the others. Built from the calendar rather than by adding a
   gap, because the calendar IS the schedule under test. */
function weekdaySessions(startUTC, count) {
  const out = [];
  let t = startUTC;
  while (out.length < count) {
    if (TRAINING_WEEKDAYS.includes(new Date(t).getUTCDay())) out.push(t);
    t += DAY;
  }
  return out;
}

/* Runs the real engine across a supplied list of session timestamps. */
function runSchedule(experience, dates) {
  let p = freshProgram({ seeds, experience, unit: "lb", goal: "hypertrophy", bodyweight: 200 });
  const rows = [];
  for (const at of dates) {
    CLOCK = at;
    const rx = prescribe(p, { trainingReadiness: 80 });
    const g = {}, seen = {};
    rx.items.forEach((it) => {
      const k = LIB[it.key].volumeGroup;
      if (k) { g[k] = (g[k] || 0) + it.sets; seen[k] = 1; }
    });
    rows.push({ at, g, seen, fs: weeklyFreqScale(effectiveGapDays(p)), dow: new Date(at).getUTCDay(), day: p.cycleIndex });
    p = ingest(p, rx.items.map((it) => ({
      key: it.key, topWeight: it.topLoad, topReps: it.reps, topRpe: it.rpe,
      targetRpe: it.rpe, targetReps: it.reps, sets: it.sets, repsShort: 0, touched: true,
      backoffSetCount: it.backoffSetCount, backoffReps: it.reps,
      backoffRpe: it.backoffRpeCap ?? it.rpe, backoffRpeCap: it.backoffRpeCap,
    })), { trainingReadiness: 80 }).next;
  }
  return { rows, program: p };
}

const MON = Date.UTC(2026, 0, 5, 18); // a Monday

console.log("\n== The schedule the athlete actually trains ==");
{
  const dates = weekdaySessions(MON, 12);
  const gaps = dates.slice(1).map((d, i) => (d - dates[i]) / DAY);
  check(`Mon-Fri really does produce gaps of 1,1,1,1,3 (${gaps.slice(0, 5).join(",")})`,
    JSON.stringify(gaps.slice(0, 5)) === JSON.stringify([1, 1, 1, 1, 3]));
  /* The premise of the whole fix: those gaps average the design cadence, so an
     estimator that reports anything else is wrong about a schedule that is
     correct. Pinned as a literal 1.4 rather than read from the engine. */
  const mean = gaps.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  check(`...and they average exactly 1.4 days, the design cadence (${mean})`, Math.abs(mean - 1.4) < 1e-9);
  check("one training weekday per rotation day, so a rotation spans one calendar week",
    TRAINING_WEEKDAYS.length === ROT);
}

console.log("\n== Frequency is measured as a stable weekly rate ==");
{
  const { rows, program } = runSchedule("advanced", weekdaySessions(MON, 60));
  const settled = rows.slice(-25);
  const scales = [...new Set(settled.map((r) => r.fs.toFixed(6)))];
  check(`freqScale is CONSTANT once the pattern is established (${scales.join(", ")})`,
    scales.length === 1, JSON.stringify(scales));
  /* Pinned as the literal 1, not as weeklyFreqScale(TARGET_SESSION_GAP_DAYS) —
     that would be true by construction whatever the estimator returned. 1.0 is
     the unscaled centre of the entire volume system; anything else means the
     schedule is being dosed as though it were a different schedule. */
  check(`...and it is exactly 1.0, the unscaled centre of the volume system (${settled.at(-1).fs})`,
    settled.at(-1).fs === 1);
  check(`the observed rate is exactly ${TRAINING_WEEKDAYS.length} sessions/week (${sessionsPerWeekObserved(program)})`,
    sessionsPerWeekObserved(program) === TRAINING_WEEKDAYS.length);

  /* The regression guard, stated as the defect: the OLD estimator on this same
     schedule. Recomputed here from the program's own tracked mean gap so the
     comparison is against real engine state, and asserted to be the wrong
     answer — if avgSessionGapDays ever happened to equal the design cadence
     this test would be vacuous, and this says so out loud. */
  const oldWay = weeklyFreqScale(program.avgSessionGapDays);
  check(`the mean-gap estimator still disagrees on this schedule (${oldWay.toFixed(3)} != 1.0) — the fix is doing real work`,
    Math.abs(oldWay - 1) > 0.05, String(oldWay));
}

console.log("\n== Both requirements hold under a real Mon-Fri pattern ==");
{
  for (const experience of ["intermediate", "advanced"]) {
    const { rows } = runSchedule(experience, weekdaySessions(MON, 90));
    const lm = landmarksForExperience(experience);
    /* Whole rotations only, stepped a rotation at a time — a window that is not
       a whole number of rotations over-samples whichever days it clips. */
    const n = ROT * 4, weeks = n / TRAINING_WEEKDAYS.length;
    const best = {}, bestDays = {};
    for (let i = Math.max(0, rows.length - n * 3); i + n <= rows.length; i += ROT) {
      const acc = {}, dc = {};
      rows.slice(i, i + n).forEach((r) => {
        Object.entries(r.g).forEach(([k, v]) => { acc[k] = (acc[k] || 0) + v; });
        Object.keys(r.seen).forEach((k) => { dc[k] = (dc[k] || 0) + 1; });
      });
      Object.entries(acc).forEach(([k, v]) => { best[k] = Math.max(best[k] || 0, v / weeks); });
      Object.entries(dc).forEach(([k, v]) => { bestDays[k] = Math.max(bestDays[k] || 0, v / weeks); });
    }
    const shortOfMav = Object.keys(lm).filter((k) => best[k] < lm[k].mav - 0.51);
    check(`${experience}: REQUIREMENT 1 — every MAV is reached training Mon-Fri (${shortOfMav.join(", ") || "all reached"})`,
      shortOfMav.length === 0,
      shortOfMav.map((k) => `${k} ${best[k].toFixed(1)}/${lm[k].mav}`).join("; "));
    const underTwice = Object.keys(lm).filter((k) => bestDays[k] < 2 - 1e-9);
    check(`${experience}: REQUIREMENT 2 — every muscle trained >= 2x/week (${underTwice.join(", ") || "all >= 2x"})`,
      underTwice.length === 0,
      underTwice.map((k) => `${k} ${bestDays[k].toFixed(2)}x`).join("; "));
  }
}

console.log("\n== The rotation lands on the same weekday every week ==");
{
  const { rows } = runSchedule("advanced", weekdaySessions(MON, 40));
  const byDow = {};
  rows.slice(-20).forEach((r) => { (byDow[r.dow] = byDow[r.dow] || new Set()).add(r.day); });
  const drifting = Object.entries(byDow).filter(([, s]) => s.size > 1);
  check("each weekday always holds the same rotation day — Monday is always Push",
    drifting.length === 0, drifting.map(([d, s]) => `dow ${d}: ${[...s].join("/")}`).join("; "));
  check(`Monday is rotation day 0 (${ROTATION[0].name})`, [...(byDow[1] || [])][0] === 0);
  check(`Friday is rotation day ${ROT - 1} (${ROTATION[ROT - 1].name})`, [...(byDow[5] || [])][0] === ROT - 1);
  check("no session is ever scheduled on a weekend",
    rows.every((r) => TRAINING_WEEKDAYS.includes(r.dow)));
}

console.log("\n== The capacity warning agrees with the schedule ==");
{
  const { program } = runSchedule("advanced", weekdaySessions(MON, 60));
  check("training Mon-Fri raises no capacity warning at the advanced landmarks",
    Object.keys(capacityShortfalls(program)).length === 0,
    JSON.stringify(capacityShortfalls(program)));
  /* And the contrast that makes that meaningful — dropping to 3 days a week
     SHOULD warn. Without this the assertion above could pass because the
     warning is broken rather than because the schedule is good. */
  const threeDay = runSchedule("advanced", weekdaySessions(MON, 60).filter((_, i) => i % 5 < 3)).program;
  check("...but training only 3 days a week does raise one",
    Object.keys(capacityShortfalls(threeDay)).length > 0);
}

console.log("\n== The estimator degrades sensibly ==");
{
  check("a program with no session log falls back rather than throwing",
    sessionsPerWeekObserved({ sessionLog: [] }) === null && effectiveGapDays({ avgSessionGapDays: 2 }) === 2);
  check("a null program is handled", sessionsPerWeekObserved(null) === null && effectiveGapDays(null) === null);
  /* Below the minimum the rate is not reported at all — a handful of sessions
     is not a weekly pattern, and reporting one would let a new athlete's first
     week dictate their dosing. */
  const few = { sessionLog: weekdaySessions(MON, SESSION_RATE_MIN_SESSIONS - 1), avgSessionGapDays: 2 };
  check(`fewer than ${SESSION_RATE_MIN_SESSIONS} sessions falls back to the tracked mean gap`,
    sessionsPerWeekObserved(few) === null && effectiveGapDays(few) === 2);
  /* Enough history means BOTH enough sessions and enough calendar coverage —
     the count is divided by the window's nominal width, so a window holding
     only its newest week reports a third of the true rate. 18 weekday sessions
     span 24 days, comfortably covering the window. */
  const enough = { sessionLog: weekdaySessions(MON, 18), avgSessionGapDays: 2 };
  check("...and once there is enough history the rate takes over from it",
    sessionsPerWeekObserved(enough) !== null && effectiveGapDays(enough) !== 2);
  /* The coverage rule itself, which is what a returning athlete hits once their
     layoff ages past the far edge of the window. Enough sessions, not enough
     span: this must NOT report a collapse in frequency. */
  const sparseButRecent = { sessionLog: weekdaySessions(MON, 8), avgSessionGapDays: 2 };
  check("a window with enough sessions but too little calendar span yields nothing rather than a low rate",
    sessionsPerWeekObserved(sparseButRecent) === null);

  /* Time off must not read as a collapse in training frequency — AUDIT 3.7
     established that layoffs are handled by layoffFactor and the
     sessionsSinceLayoff return window, NOT by the frequency estimate, because
     freqScale multiplies the volume target and a layoff-inflated gap
     prescribed MORE sets on the comeback. */
  const { program } = runSchedule("advanced", weekdaySessions(MON, 40));
  const before = sessionsPerWeekObserved(program);
  CLOCK = program.sessionLog.at(-1) + 21 * DAY;
  check(`a three-week layoff leaves the established rate intact (${before} -> ${sessionsPerWeekObserved(program)})`,
    sessionsPerWeekObserved(program) === before);

  check(`the session log stays bounded at ${SESSION_LOG_MAX}`,
    program.sessionLog.length <= SESSION_LOG_MAX, String(program.sessionLog.length));
  check("the log holds enough history to fill the rate window",
    SESSION_LOG_MAX >= SESSION_RATE_WINDOW_WEEKS * 7);
}

console.log("\n== A program saved before this change still works ==");
{
  const { program } = runSchedule("advanced", weekdaySessions(MON, 30));
  const legacy = { ...program };
  delete legacy.sessionLog;
  delete legacy.sessionsPerWeek;   // a program saved before this change had neither field
  const m = migrateProgram(legacy);
  check("migration backfills an empty session log rather than leaving it undefined",
    Array.isArray(m.sessionLog) && m.sessionLog.length === 0);
  /* Backfilled EMPTY on purpose: the athlete keeps their existing mean-gap
     dosing until real sessions accumulate. Inventing timestamps would hand the
     new estimator fabricated evidence about a schedule it never saw. */
  check("...so dosing falls back to the tracked mean gap, unchanged from before the migration",
    effectiveGapDays(m) === legacy.avgSessionGapDays);
  CLOCK = program.sessionLog.at(-1) + DAY;
  check("and it prescribes without crashing", prescribe(m, { trainingReadiness: 80 }).items.length > 0);
}

console.log("\n== The advisory and the advertised rate agree ==");
{
  const DOWN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let t = MON;
  const advised = [];
  for (let i = 0; i < 12; i++) {
    const nxt = nextSessionTargetAt(null, t, 0.3);
    advised.push(new Date(nxt).getUTCDay());
    const d = new Date(nxt);
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 18);
  }
  check(`following the advisory walks Mon-Fri and skips the weekend (${advised.slice(0, 6).map((d) => DOWN[d]).join(" ")})`,
    advised.every((d) => TRAINING_WEEKDAYS.includes(d)));
  check(`it visits every training weekday rather than settling on a subset (${new Set(advised).size} distinct)`,
    new Set(advised).size === TRAINING_WEEKDAYS.length);
  check(`the advertised rate matches the dates handed out (${targetSessionsPerWeek(0.3)}/week)`,
    targetSessionsPerWeek(0.3) === TRAINING_WEEKDAYS.length);
}

console.log("\n== A break does not change the dose — measured in SETS, not in stored state ==");
{
  /* THE TEST THAT SHOULD HAVE EXISTED. The previous AUDIT 3.7 regression
     asserted that `avgSessionGapDays` was unmoved by a layoff and stopped
     there. It never called prescribe() afterwards — so when the rate estimator
     was introduced and reintroduced the exact failure AUDIT 3.7 was about, that
     test stayed green. Measured on the broken build: a single 10-day break sent
     freqScale from 1.0 to 1.5 and held it there for 21 days, prescribing 44-set
     sessions against a normal 35. A 21-day layoff was worse — it fell through
     to the EWMA and walked freqScale 0.744 -> 1.800 between two consecutive
     sessions.
     So this asserts what the ATHLETE receives. Stored state is not the
     deliverable; prescribed sets are. */
  const sessionTotals = (rows) => rows.map((r) => Object.values(r.g).reduce((a, b) => a + b, 0));

  for (const breakDays of [3, 10, 21, 45]) {
    const settled = runSchedule("advanced", weekdaySessions(MON, 40));
    const baseline = sessionTotals(settled.rows.slice(-10));
    const peakBefore = Math.max(...baseline);

    /* Resume the SAME program on the same weekday pattern after the break. */
    let p = settled.program;
    const resumeFrom = settled.rows.at(-1).at + breakDays * DAY;
    const after = [];
    for (const at of weekdaySessions(resumeFrom, 15)) {
      CLOCK = at;
      const rx = prescribe(p, { trainingReadiness: 80 });
      after.push({ fs: weeklyFreqScale(effectiveGapDays(p)), tot: rx.items.reduce((s, i) => s + i.sets, 0) });
      p = ingest(p, rx.items.map((it) => ({
        key: it.key, topWeight: it.topLoad, topReps: it.reps, topRpe: it.rpe,
        targetRpe: it.rpe, targetReps: it.reps, sets: it.sets, repsShort: 0, touched: true,
        backoffSetCount: it.backoffSetCount, backoffReps: it.reps,
        backoffRpe: it.backoffRpeCap ?? it.rpe, backoffRpeCap: it.backoffRpeCap,
      })), { trainingReadiness: 80 }).next;
    }
    const peakAfter = Math.max(...after.map((a) => a.tot));
    check(`a ${breakDays}-day break never RAISES the prescribed session volume (peak ${peakBefore} -> ${peakAfter})`,
      peakAfter <= peakBefore, `freqScale reached ${Math.max(...after.map((a) => a.fs)).toFixed(4)}`);
    /* And the mechanism behind it, so a future change that fixes the symptom by
       some other route still has to keep this property. */
    const fsRange = [Math.min(...after.map((a) => a.fs)), Math.max(...after.map((a) => a.fs))];
    check(`  ...because freqScale never moves off 1.0 across the comeback (${fsRange.map((f) => f.toFixed(3)).join(" .. ")})`,
      fsRange[0] === 1 && fsRange[1] === 1);
  }

  /* The contrast that keeps the above from being satisfied by an estimator that
     simply never updates: a REAL change of cadence must still be picked up. */
  const settled = runSchedule("advanced", weekdaySessions(MON, 40));
  let p = settled.program;
  let t = settled.rows.at(-1).at + DAY;
  const mwf = [];
  while (mwf.length < 15) { if ([1, 3, 5].includes(new Date(t).getUTCDay())) mwf.push(t); t += DAY; }
  for (const at of mwf) {
    CLOCK = at;
    const rx = prescribe(p, { trainingReadiness: 80 });
    p = ingest(p, rx.items.map((it) => ({
      key: it.key, topWeight: it.topLoad, topReps: it.reps, topRpe: it.rpe,
      targetRpe: it.rpe, targetReps: it.reps, sets: it.sets, repsShort: 0, touched: true,
      backoffSetCount: it.backoffSetCount, backoffReps: it.reps,
      backoffRpe: it.backoffRpeCap ?? it.rpe, backoffRpeCap: it.backoffRpeCap,
    })), { trainingReadiness: 80 }).next;
  }
  check(`moving permanently to Mon/Wed/Fri IS picked up (${sessionsPerWeekObserved(p)}/week)`,
    sessionsPerWeekObserved(p) === 3);
}

Date.now = REAL_NOW;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
