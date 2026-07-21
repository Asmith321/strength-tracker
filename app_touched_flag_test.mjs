/* ============================================================================
   App-level regression test for the handleLog `touched` data-loss bug.
   Run with: node app_touched_flag_test.mjs   (wired into `npm test`)

   Bug: handleLog computed `touched: !!l._touched`. Today's UI only sets
   `_touched: true` on a log row when the athlete EDITS a field (see `upd` in
   src/App.jsx) — a zero-edit, submit-as-prescribed log row never carries
   `_touched` at all. That made every as-prescribed session look like an
   echoed placeholder to ingest(), silently excluding it from e1RM/trend/PR
   tracking even though the athlete genuinely trained that session.

   This can't drive the real React component (no jsdom/testing-library in
   this project — see stress_test.mjs/engine_fix_tests.mjs for the existing
   pure-engine testing convention this follows), so it replicates the exact
   boundary: log rows shaped exactly as Today's initial useEffect produces
   them (src/App.jsx, the `setLogs(rx.items.map(...))` call — no `_touched`
   key at all, i.e. a genuine zero-edit submission) fed through handleLog's
   FIXED ingestLogs mapping (`touched: true` unconditionally) into the real
   ingest(). ============================================================================ */
import { freshProgram, prescribe, ingest } from "./src/engine.js";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

const seeds = { squat: { weight: 315, reps: 5, rpe: 8 }, bench: { weight: 225, reps: 5, rpe: 8 }, deadlift: { weight: 405, reps: 5, rpe: 8 } };
const green = { trainingReadiness: 80 };

console.log("\n== zero-edit submission through the fixed handleLog boundary ==");
{
  const program = freshProgram({ seeds, experience: "intermediate", unit: "lb", goal: "strength", bodyweight: 200 });
  const rx = prescribe(program, green);
  // Exactly Today's initial (never-edited) log shape: no _touched key present.
  const logs = rx.items.map((it) => ({
    key: it.key, topWeight: it.topLoad, topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe,
    missedSets: 0, sets: it.sets, backoffSetCount: it.backoffSetCount, backoffReps: it.reps,
    backoffRpe: it.rpe, backoffRpeCap: it.backoffRpeCap,
  }));
  check("sanity: none of the unedited rows carry _touched (matches real UI state)", logs.every((l) => !("_touched" in l)));

  // The fixed handleLog logic (src/App.jsx): every submitted log is real data.
  const ingestLogs = logs.map((l) => ({ ...l, touched: true }));
  const before = program.lifts.squat.hist.length;
  const r = ingest(program, ingestLogs, green);

  const squatLog = rx.items.find((it) => it.isMain && it.key === "squat");
  check(`squat logged at RPE ${squatLog.rpe} (>=7) in accumulation: hist entry IS recorded`,
    r.next.lifts.squat.hist.length === before + 1);
  check("squat e1RM was updated from the zero-edit submission", r.next.lifts.squat.e1rm !== program.lifts.squat.e1rm);
  const rdlLog = rx.items.find((it) => it.key === "rdl"); // an accessory on the same (Squat) day, also unedited
  check(`rdl (accessory, also unedited, RPE ${rdlLog.rpe}) got a hist entry too`,
    r.next.lifts.rdl.hist.length === program.lifts.rdl.hist.length + 1);
  check("no session was silently dropped: rpeMiss reflects real evidence, not null (touched mains exist)", r.rpeMiss != null);

  // The old (buggy) boundary, for contrast — confirms this test would have
  // caught the regression.
  const buggyIngestLogs = logs.map((l) => ({ ...l, touched: !!l._touched }));
  const rBuggy = ingest(program, buggyIngestLogs, green);
  check("OLD buggy mapping would have dropped the hist entry (regression check)",
    rBuggy.next.lifts.squat.hist.length === before);
}

console.log("\n== edited submission still works exactly as before ==");
{
  const program = freshProgram({ seeds, experience: "intermediate", unit: "lb", goal: "strength", bodyweight: 200 });
  const rx = prescribe(program, green);
  // Simulates `upd`: an edited row carries _touched: true.
  const logs = rx.items.map((it) => ({
    key: it.key, topWeight: it.topLoad + 5, topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe,
    missedSets: 0, sets: it.sets, backoffSetCount: it.backoffSetCount, backoffReps: it.reps,
    backoffRpe: it.rpe, backoffRpeCap: it.backoffRpeCap, _touched: true,
  }));
  const ingestLogs = logs.map((l) => ({ ...l, touched: true }));
  const before = program.lifts.squat.hist.length;
  const r = ingest(program, ingestLogs, green);
  check("edited submission still records a hist entry (unaffected by the fix)", r.next.lifts.squat.hist.length === before + 1);
}

console.log("\n== sub-RPE-7 sessions still correctly excluded (data-quality gate, unaffected) ==");
{
  const program = freshProgram({ seeds, experience: "intermediate", unit: "lb", goal: "strength", bodyweight: 200 });
  const before = program.lifts.squat.hist.length;
  const ingestLogs = [{ key: "squat", topWeight: 500, topReps: 4, topRpe: 6, targetRpe: 6, missedSets: 0, touched: true }];
  const r = ingest(program, ingestLogs, green);
  check("submission itself doesn't override the RPE>=7 data-quality gate", r.next.lifts.squat.hist.length === before);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
