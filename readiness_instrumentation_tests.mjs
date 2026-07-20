/* ============================================================================
   Readiness decoupling + instrumentation — verification. Run:
     node readiness_instrumentation_tests.mjs   (wired into `npm test`)
   Covers: (1) the readSupp same-day/multi-session decoupling refactor is
   behavior-neutral, (2) prescribe()/ingest() populate the new per-session
   readiness/outcome fields, (3) analyzeReadiness() produces the right shape
   and correctly flags under-sampled bands.
   ============================================================================ */
import {
  freshProgram, prescribe, ingest,
  READINESS_RPE_ADJ, READINESS_SET_MULT, READINESS_FATIGUE_WEIGHT, READSUPP_EWMA_ALPHA,
} from "./src/engine.js";
import { analyzeReadiness, MIN_SESSIONS_FOR_SIGNAL } from "./readiness_analysis.mjs";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};
const seeds = { squat: { weight: 315, reps: 5, rpe: 8 }, bench: { weight: 225, reps: 5, rpe: 8 }, deadlift: { weight: 405, reps: 5, rpe: 8 } };
const fresh = () => freshProgram({ seeds, experience: "intermediate", unit: "lb", goal: "strength", bodyweight: 200 });

console.log("\n== Decoupling: same-day path vs multi-session path are independent ==");
{
  check("READINESS_RPE_ADJ/SET_MULT are keyed by band (same-day, prescribe-only)",
    READINESS_RPE_ADJ.green === 0 && READINESS_RPE_ADJ.amber === -0.5 && READINESS_RPE_ADJ.red === -1.5 &&
    READINESS_SET_MULT.green === 1 && READINESS_SET_MULT.amber === 0.85 && READINESS_SET_MULT.red === 0.6);
  check("READINESS_FATIGUE_WEIGHT and READSUPP_EWMA_ALPHA are distinct named constants",
    typeof READINESS_FATIGUE_WEIGHT === "number" && typeof READSUPP_EWMA_ALPHA === "number");
  // structural check: prescribe() must never read program.fatigue at all —
  // same-day softening depends only on the live readiness param
  const p1 = fresh(); const p2 = fresh();
  p2.fatigue.readSupp = 0.95; p2.fatigue.index = 0.9; // heavily "fatigued" on paper
  const rx1 = prescribe(p1, { trainingReadiness: 50 });
  const rx2 = prescribe(p2, { trainingReadiness: 50 });
  check("same readiness input -> identical rpeAdj/setMult regardless of accumulated fatigue.readSupp",
    rx1.rpeAdj === rx2.rpeAdj && rx1.setMult === rx2.setMult && rx1.band === rx2.band);
}

console.log("\n== prescribe() exposes the adjustment actually applied ==");
{
  for (const [tr, band] of [[80, "green"], [50, "amber"], [20, "red"]]) {
    const rx = prescribe(fresh(), { trainingReadiness: tr });
    check(`TR=${tr} -> band ${band}, rpeAdj=${READINESS_RPE_ADJ[band]}, setMult=${READINESS_SET_MULT[band]}`,
      rx.band === band && rx.rpeAdj === READINESS_RPE_ADJ[band] && rx.setMult === READINESS_SET_MULT[band]);
  }
}

console.log("\n== ingest() returns this session's raw outcome (not just smoothed fatigue state) ==");
{
  const p = fresh();
  const green = { trainingReadiness: 80 };
  const rx = prescribe(p, green);
  const logs = rx.items.map((it) => ({
    key: it.key, touched: true, topWeight: it.topLoad, topReps: it.reps,
    topRpe: it.rpe + 0.5, targetRpe: it.rpe, missedSets: 0,
    backoffSetCount: it.backoffSetCount, backoffReps: it.reps, backoffRpe: it.backoffRpeCap + 0.5, backoffRpeCap: it.backoffRpeCap,
  }));
  const r = ingest(p, logs, green);
  check("ingest() returns a non-null rpeMiss when touched main logs exist", r.rpeMiss != null && r.rpeMiss > 0);
  check("ingest() returns a non-null backoffDrift when backoff data exists", r.backoffDrift != null && r.backoffDrift > 0);
  check("ingest() returns missFreq for this session (0 here, no misses)", r.missFreq === 0);

  // no touched main logs this session -> rpeMiss/backoffDrift are null (no evidence), not a fake 0
  const untouched = rx.items.map((it) => ({ key: it.key, touched: false, topWeight: it.topLoad, topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe, missedSets: 0 }));
  const r2 = ingest(p, untouched, green);
  check("all-untouched session: rpeMiss is null (no evidence), not 0", r2.rpeMiss === null);
  check("all-untouched session: backoffDrift is null (no evidence), not 0", r2.backoffDrift === null);
}

console.log("\n== analyzeReadiness(): shape + under-sampled-band flagging ==");
{
  const mkSession = (band, rpeMiss, missFreq, backoffDrift, rpeAdj, setMult) =>
    ({ readinessOutcome: { band, score: 0.5, rpeAdj, setMult, rpeMiss, missFreq, backoffDrift } });
  const sessions = [
    ...Array.from({ length: 10 }, (_, i) => mkSession("green", 0.1 + i * 0.01, 0, 0.1, 0, 1)),
    ...Array.from({ length: 3 }, () => mkSession("amber", 0.05, 0, 0.05, -0.5, 0.85)), // below MIN_SESSIONS_FOR_SIGNAL
    { logs: [] }, // no readinessOutcome at all — must be excluded, not crash
  ];
  const report = analyzeReadiness(sessions);
  check(`totalSessions counts every record (${report.totalSessions})`, report.totalSessions === 14);
  check(`withOutcome excludes the record with no readinessOutcome (${report.withOutcome})`, report.withOutcome === 13);
  check(`green has enough data (n=${report.byBand.green.n} >= ${MIN_SESSIONS_FOR_SIGNAL})`, report.byBand.green.enoughData === true);
  check(`amber flagged as NOT enough data (n=${report.byBand.amber.n} < ${MIN_SESSIONS_FOR_SIGNAL})`, report.byBand.amber.enoughData === false);
  check("red band with zero sessions reports n=0, enoughData=false, no crash", report.byBand.red.n === 0 && report.byBand.red.enoughData === false);
  const expectedMean = Array.from({ length: 10 }, (_, i) => 0.1 + i * 0.01).reduce((a, b) => a + b, 0) / 10;
  check("green avgRpeMiss is the mean of its 10 sessions", Math.abs(report.byBand.green.avgRpeMiss - expectedMean) < 1e-9,
    `got ${report.byBand.green.avgRpeMiss}, expected ${expectedMean}`);

  // null-valued outcome fields (no evidence that session) must not corrupt the mean
  const withNulls = [...Array.from({ length: 8 }, () => mkSession("green", 0.2, 0, null, 0, 1)), mkSession("green", null, 0, null, 0, 1)];
  const r2 = analyzeReadiness(withNulls);
  check("null rpeMiss entries are excluded from the average, not treated as 0",
    Math.abs(r2.byBand.green.avgRpeMiss - 0.2) < 1e-9 && r2.byBand.green.rpeMissN === 8);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
