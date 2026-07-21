/* ============================================================================
   Readiness-adjustment retrospective analysis.     Run with:
     node readiness_analysis.mjs path/to/iron-log-backup-*.json   (real data)
     node readiness_analysis.mjs --demo                            (synthetic)

   engine-research-summary.md documents rpeAdj/setMult (the same-day RPE cut /
   set reduction on amber/red readiness days) and the 0.3 fatigue-index weight
   on readSupp as "a reasonable starting parameterization intended to be
   tuned against actual logged sessions over time, not a proven-optimal set
   of constants." This script IS that tuning mechanism — it reads session
   history (each record now carries `readinessOutcome`, see ingest()/
   prescribe() in src/engine.js and its wiring in App.jsx's handleLog) and
   reports, per readiness band, what actually happened: average RPE
   overshoot vs. target, average missed-set frequency, average backoff RPE
   drift, and the sample size behind each number.

   This script does NOT change rpeAdj/setMult/the fatigue weight itself, and
   does NOT draw conclusions from too little data — see MIN_SESSIONS_FOR_SIGNAL
   below. Read the numbers, don't guess from them.
   ============================================================================ */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* Minimum sessions in a band before its averages are treated as meaning
   anything at all — below this, the script explicitly says so rather than
   reporting a number that invites over-reading. Not research-derived; a
   plain statistical judgment call (a handful of sessions is dominated by
   day-to-day noise no adjustment tuning should react to). */
const MIN_SESSIONS_FOR_SIGNAL = 8;

const BANDS = ["green", "amber", "red"];

function fmt(n, digits = 3) { return n == null ? "—" : n.toFixed(digits); }

/* Pure — takes a sessions array (the same shape App.jsx persists/exports),
   returns the per-band report. Exported so both the CLI below and tests can
   drive it directly without going through file I/O. */
function analyzeReadiness(sessions) {
  const withOutcome = sessions.filter((s) => s?.readinessOutcome?.band);
  const byBand = {};
  for (const band of BANDS) {
    const rows = withOutcome.filter((s) => s.readinessOutcome.band === band);
    const rpeMisses = rows.map((s) => s.readinessOutcome.rpeMiss).filter((v) => v != null);
    const backoffDrifts = rows.map((s) => s.readinessOutcome.backoffDrift).filter((v) => v != null);
    const missFreqs = rows.map((s) => s.readinessOutcome.missFreq).filter((v) => v != null);
    const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    byBand[band] = {
      n: rows.length,
      enoughData: rows.length >= MIN_SESSIONS_FOR_SIGNAL,
      avgRpeMiss: mean(rpeMisses), rpeMissN: rpeMisses.length,
      avgMissFreq: mean(missFreqs), missFreqN: missFreqs.length,
      avgBackoffDrift: mean(backoffDrifts), backoffDriftN: backoffDrifts.length,
      // the adjustment actually applied on this band, for reference alongside the outcome
      rpeAdj: rows[0]?.readinessOutcome.rpeAdj ?? null,
      setMult: rows[0]?.readinessOutcome.setMult ?? null,
    };
  }
  return { totalSessions: sessions.length, withOutcome: withOutcome.length, byBand };
}

function printReport(report, label) {
  console.log(`\n==== READINESS ADJUSTMENT ANALYSIS (${label}) ====`);
  console.log(`Total sessions in history: ${report.totalSessions}  (${report.withOutcome} carry readiness instrumentation)`);
  console.log(`Minimum sessions/band to treat an average as meaningful: ${MIN_SESSIONS_FOR_SIGNAL}\n`);
  console.log("band   n   rpeAdj  setMult | avg RPE overshoot | avg missed-set freq | avg backoff RPE drift");
  console.log("-----  --  ------  ------- | ----------------- | -------------------- | ----------------------");
  for (const band of BANDS) {
    const b = report.byBand[band];
    const adj = b.rpeAdj == null ? "  —  " : (b.rpeAdj >= 0 ? " " : "") + b.rpeAdj.toFixed(1);
    const mult = b.setMult == null ? "  —  " : b.setMult.toFixed(2);
    console.log(`${band.padEnd(5)}  ${String(b.n).padStart(2)}  ${adj.padStart(6)}  ${mult.padStart(7)} | ${fmt(b.avgRpeMiss).padStart(17)} (n=${b.rpeMissN}) | ${fmt(b.avgMissFreq).padStart(11)} (n=${b.missFreqN}) | ${fmt(b.avgBackoffDrift).padStart(11)} (n=${b.backoffDriftN})`);
    if (!b.enoughData) console.log(`       ↳ only ${b.n} session(s) in this band — NOT ENOUGH DATA to conclude anything yet (need ${MIN_SESSIONS_FOR_SIGNAL}+)`);
  }
  const green = report.byBand.green, amber = report.byBand.amber, red = report.byBand.red;
  console.log("\n---- reading the comparison (once every band has enough data) ----");
  if (green.enoughData && (amber.enoughData || red.enoughData)) {
    for (const [name, b] of [["amber", amber], ["red", red]]) {
      if (!b.enoughData) continue;
      if (green.avgRpeMiss == null || b.avgRpeMiss == null) continue;
      const delta = b.avgRpeMiss - green.avgRpeMiss;
      console.log(`  ${name}: RPE overshoot vs. green is ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} despite a ${(b.rpeAdj ?? 0)} RPE / ${((1 - (b.setMult ?? 1)) * 100).toFixed(0)}% set cut already applied.`);
      console.log(`    delta near 0 or negative → current adjustment looks sized about right for this athlete.`);
      console.log(`    delta clearly positive (athlete still overshooting despite the cut) → current adjustment may be undersized.`);
      console.log(`    delta clearly negative and large → current adjustment may be oversized (band days ending up easier than green days).`);
    }
  } else {
    console.log("  Not enough data across bands yet — re-run this script after a few more weeks of logged sessions.");
  }
  console.log("\nReminder: this script only REPORTS. Any change to rpeAdj/setMult or the fatigue-index");
  console.log("readiness weight (0.3) should be driven by this report once real bands have");
  console.log(`${MIN_SESSIONS_FOR_SIGNAL}+ sessions each — not by this run alone, and not by guesswork.`);
}

function loadSessions(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const sessions = Array.isArray(raw) ? raw : raw.sessions;
  if (!Array.isArray(sessions)) throw new Error(`${path}: expected an array of sessions, or an export file with a "sessions" array (see Settings → Export my data)`);
  return sessions;
}

/* ---- synthetic demo: same PRNG-driven simulation approach as stress_test.mjs ---- */
async function buildSyntheticHistory() {
  const { freshProgram, prescribe, ingest, applyTransition } = await import("./src/engine.js");
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rng = mulberry32(20260720);
  const randint = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const seeds = { squat: { weight: 225, reps: 5, rpe: 8 }, bench: { weight: 165, reps: 5, rpe: 8 }, deadlift: { weight: 275, reps: 5, rpe: 8 } };
  let p = freshProgram({ seeds, experience: "intermediate", unit: "lb", goal: "strength", bodyweight: 180 });
  const sessions = [];
  const RealNow = Date.now; let clock = RealNow();
  Date.now = () => clock;
  try {
    for (let i = 0; i < 90; i++) {
      const readiness = { trainingReadiness: randint(35, 95) }; // deliberately spans red/amber/green
      const rx = prescribe(p, readiness);
      const logs = rx.items.map((it) => ({
        key: it.key, touched: true,
        topWeight: it.bodyweight ? it.topLoad : Math.max(0, it.topLoad + randint(-10, 10)),
        topReps: it.reps, topRpe: Math.min(10, Math.max(6, it.rpe + (rng() < 0.5 ? 0 : randint(-1, 1) * 0.5))),
        targetRpe: it.rpe, missedSets: rng() < 0.1 ? 1 : 0,
        backoffSetCount: it.backoffSetCount, backoffReps: it.reps,
        backoffRpe: Math.min(10, it.backoffRpeCap + (rng() < 0.3 ? 0.5 : 0)), backoffRpeCap: it.backoffRpeCap,
      }));
      const r = ingest(p, logs, readiness);
      p = r.transition ? applyTransition(r.next, r.transition) : r.next;
      sessions.push({
        date: clock, block: rx.block, dayName: rx.dayName,
        readinessOutcome: {
          band: rx.band, score: readiness.trainingReadiness / 100,
          rpeAdj: rx.rpeAdj, setMult: rx.setMult,
          rpeMiss: r.rpeMiss, backoffDrift: r.backoffDrift, missFreq: r.missFreq,
        },
      });
      clock += 2 * 86400000;
    }
  } finally { Date.now = RealNow; }
  return sessions;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.log("Usage:");
    console.log("  node readiness_analysis.mjs path/to/iron-log-backup-*.json   (real exported data)");
    console.log("  node readiness_analysis.mjs --demo                            (synthetic data, shape-check only)");
    process.exit(1);
  }
  if (arg === "--demo") {
    const sessions = await buildSyntheticHistory();
    printReport(analyzeReadiness(sessions),
      "SYNTHETIC DATA — randomly generated, no real signal to find. This run only confirms the report has the right shape.");
    return;
  }
  const sessions = loadSessions(arg);
  printReport(analyzeReadiness(sessions), `real session history: ${arg}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) await main();

export { analyzeReadiness, MIN_SESSIONS_FOR_SIGNAL };
