/* ============================================================================
   Tests for the in-progress session draft (src/draft.js) and for the skipped-
   exercise rule in handleLog.

   These import the REAL draft module rather than replicating it. That is the
   whole reason the logic was pulled out of App.jsx: a replicated test only
   proves the replica behaves, which is the self-consistency failure this
   project's audit kept surfacing.

   Run with: node draft_tests.mjs
   ========================================================================== */
import { readDraft, writeDraft, clearDraft, draftMatches, K_DRAFT } from "./src/draft.js";
import { freshProgram, prescribe, ingest } from "./src/engine.js";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

/* A minimal localStorage stand-in. Injected explicitly rather than assigned to
   globalThis so a throwing store can be simulated in the same run. */
const memStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _size: () => m.size,
  };
};
const throwingStore = {
  getItem() { throw new Error("SecurityError: storage denied"); },
  setItem() { throw new Error("QuotaExceededError"); },
  removeItem() { throw new Error("SecurityError: storage denied"); },
};

console.log("\n== Draft survives the app being backgrounded ==");
{
  const s = memStore();
  const logs = [{ key: "bench", topWeight: 225, topReps: 6, topRpe: 8, repsShort: 2 }];
  writeDraft({ sessionCount: 7, logs, readiness: { trainingReadiness: 72 }, savedAt: 1 }, s);
  const back = readDraft(s);
  check("a written draft reads back intact", back && back.logs[0].topWeight === 225 && back.logs[0].repsShort === 2);
  check("readiness is carried with it", back.readiness.trainingReadiness === 72);
  check("clearing removes it", (clearDraft(s), readDraft(s) === null));
}

console.log("\n== A draft is only restored onto the session it belongs to ==");
{
  const keys = ["bench", "squat", "cablefly"];
  const draft = { sessionCount: 7, logs: keys.map((k) => ({ key: k, topReps: 6 })) };
  check("restores onto the same session with the same exercises", draftMatches(draft, 7, keys));
  /* The failure this prevents: finishing session 7 and opening 8 with a stale
     draft still on disk would silently pre-fill session 8 with session 7's
     numbers. */
  check("a draft from a COMPLETED session is not restored onto the next one", !draftMatches(draft, 8, keys));
  /* And the worse one: the rotation changing under a stored draft. Restoring
     by position alone would attribute logged numbers to a different lift. */
  check("a draft is rejected when an exercise was swapped out",
    !draftMatches(draft, 7, ["bench", "frontsquat", "cablefly"]));
  check("a draft is rejected when the session length changed",
    !draftMatches(draft, 7, ["bench", "squat"]));
  check("a malformed draft is rejected rather than throwing", !draftMatches({ sessionCount: 7 }, 7, keys));
  check("no draft at all is simply not a match", !draftMatches(null, 7, keys));
}

console.log("\n== Storage failure degrades, it does not crash ==");
{
  /* Safari private mode throws on write; an embedded webview can deny access
     outright. Losing the crash-mat is acceptable; taking down the logging
     screen mid-workout is not. */
  check("reading from a denied store returns null instead of throwing", readDraft(throwingStore) === null);
  check("writing to a full store reports failure instead of throwing", writeDraft({ a: 1 }, throwingStore) === false);
  check("clearing a denied store reports failure instead of throwing", clearDraft(throwingStore) === false);
  check("a successful write reports success", writeDraft({ a: 1 }, memStore()) === true);
}

console.log("\n== A skipped exercise is withheld from the engine ==");
{
  /* Replicates handleLog's ingestLogs mapping exactly (src/App.jsx):
       logs.filter((l) => !l.skipped).map((l) => ({ ...l, touched: true }))
     Work never started is not evidence of fatigue. Logging a skipped exercise
     as "every rep short" — which is what including it would amount to — would
     have the engine pull a recovery week forward because the athlete went home
     early. */
  const seeds = { squat: { weight: 315, reps: 5, rpe: 8 }, bench: { weight: 225, reps: 5, rpe: 8 } };
  const mk = () => freshProgram({ seeds, experience: "intermediate", unit: "lb", goal: "hypertrophy", bodyweight: 200 });
  const rx = prescribe(mk(), { trainingReadiness: 80 });
  const row = (it, over = {}) => ({
    key: it.key, topWeight: it.topLoad, topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe,
    targetReps: it.reps, sets: it.sets, repsShort: 0, touched: true,
    backoffSetCount: it.backoffSetCount, backoffReps: it.reps,
    backoffRpe: it.backoffRpeCap ?? it.rpe, backoffRpeCap: it.backoffRpeCap, ...over,
  });
  const ingestOf = (logs) => ingest(mk(), logs.filter((l) => !l.skipped).map((l) => ({ ...l, touched: true })), { trainingReadiness: 80 });

  const allDone = ingestOf(rx.items.map((it) => row(it)));
  // half the session skipped outright — nothing was attempted on those lifts
  const halfSkipped = ingestOf(rx.items.map((it, i) => row(it, i % 2 === 0 ? { skipped: true } : {})));
  check(`skipping half the session does not raise the fatigue index (${halfSkipped.next.fatigue.missFreq.toFixed(3)} <= ${allDone.next.fatigue.missFreq.toFixed(3)})`,
    halfSkipped.next.fatigue.missFreq <= allDone.next.fatigue.missFreq + 1e-9);
  /* The contrast that gives the assertion meaning: the SAME exercises logged as
     attempted-and-failed must register, or the fatigue signal would be dead. */
  const halfFailed = ingestOf(rx.items.map((it, i) => row(it, i % 2 === 0 ? { repsShort: it.sets * it.reps } : {})));
  check(`the same exercises logged as ATTEMPTED-and-missed do raise it (${halfFailed.next.fatigue.missFreq.toFixed(3)} > 0)`,
    halfFailed.next.fatigue.missFreq > 0);
  // and a skipped lift contributes no strength evidence
  const skippedKey = rx.items[0].key;
  const bumped = rx.items.map((it, i) => row(it, i === 0 ? { skipped: true, topWeight: it.topLoad + 100 } : {}));
  const after = ingestOf(bumped);
  check("a skipped lift's e1RM is untouched even if the row carries numbers",
    after.next.lifts[skippedKey].e1rm === mk().lifts[skippedKey].e1rm);
  check("skipping every exercise leaves the engine with nothing to ingest, without crashing",
    ingestOf(rx.items.map((it) => row(it, { skipped: true }))).next != null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
