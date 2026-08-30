import React, { useState, useEffect, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  Dumbbell, TrendingUp, History as HistoryIcon, Activity, Layers,
  Minus, Plus, AlertTriangle, ChevronDown, ChevronRight, Settings, Check,
  Timer, X, Award, Download, LogOut,
} from "lucide-react";
import cloudStorage, { getSession, onAuthChange, signIn, signUp, signOut } from "./storage.js";
import { readDraft, writeDraft, clearDraft, draftMatches } from "./draft.js";
import {
  LIB, BLOCKS, EXPERIENCE_TIERS, landmarksForExperience, freshProgram, migrateProgram, RETIRED_LABELS, LEGACY_BLOCK_TYPES,
  prescribe, ingest, applyTransition, nextSessionTargetAt, targetSessionsPerWeek, deliveredWeekly, maxDeliverable, weeklyFreqScale, effectiveGapDays, capacityShortfalls, capacityPinned, TRAINING_WEEKDAYS, e1rmFrom,
  readinessScore, PLATES, platesForSide, plateText,
} from "./engine.js";

/* All sport-science logic (RPE/e1RM math, volume landmarks, block periodization,
   prescribe/ingest/applyTransition, plate math) lives in src/engine.js as pure,
   deterministic functions — no React, no DOM. The LLM only narrates + breaks
   genuinely borderline transitions (runCoach below, which is I/O, not engine math). */
/* ════════════ COACH (Sonnet): narration + borderline tie-break only ════════════ */
const COACH_OFFLINE_NOTE = "Coach offline — deterministic engine applied.";
async function runCoach({ rx, fatigueIndex, e1rmSlope, rScore, transition, recent }) {
  // POST only structured session state. The prompt template now lives
  // server-side in api/coach.js, so this endpoint can't be used as a
  // general-purpose LLM proxy.
  try {
    const res = await fetch("/api/coach", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        block: rx.block,
        cycle: rx.cycle,
        fatigueIndex,
        slope: e1rmSlope,
        rScore,
        transition,
        recent,
      }),
    });
    const data = await res.json();
    const text = (data.content || []).map((c) => (c.type === "text" ? c.text : "")).join("").replace(/```json|```/g, "").trim();
    return { ok: true, ...JSON.parse(text) };
  } catch {
    return { ok: false, note: COACH_OFFLINE_NOTE, confirmTransition: true, override: null };
  }
}

/* ════════════ STORAGE ════════════ */
const K_PROGRAM = "strength.engine.program.v1";
const K_SESSIONS = "strength.engine.sessions.v1";

/* Errors PROPAGATE here (no swallowing): a null return means "no row exists",
   an exception means "the load failed". The caller MUST distinguish these — a
   failed load must never be mistaken for an empty account (which would render
   Onboarding and let a completion overwrite real, un-loaded data). */
async function loadKey(k) { const r = await cloudStorage.get(k); return r ? JSON.parse(r.value) : null; }
async function saveKey(k, v) { try { await cloudStorage.set(k, JSON.stringify(v)); return true; } catch { return false; } }

/* Loads program + sessions. Rejects if either read fails (propagated from
   loadKey), so the caller can show a retry screen instead of Onboarding.
   Exported for testing. `loadKeyFn` is injectable for that purpose. */
export async function loadProgramState(loadKeyFn = loadKey) {
  const p = await loadKeyFn(K_PROGRAM);
  const s = await loadKeyFn(K_SESSIONS);
  const mp = p ? migrateProgram(p) : null;
  return { program: mp, sessions: s || [], migrated: !!(mp && mp !== p) };
}

/* Single source of truth for which top-level screen renders. Ordering is the
   whole safety property: load-error is checked BEFORE program, so a failed
   fetch can never fall through to Onboarding. Exported for testing. */
export function decideScreen({ session, loadError, ready, program }) {
  if (session === undefined) return "checking-auth";
  if (!session) return "login";
  if (loadError) return "load-error";
  if (!ready) return "loading";
  if (!program) return "onboarding";
  return "app";
}

/* ════════════ UI (functional; secondary to the engine) ════════════ */
function Barbell({ weight, bar = 45 }) {
  const side = platesForSide(weight, bar);
  return (
    <svg viewBox="0 0 320 70" width="100%" height="52" style={{ display: "block" }}>
      <rect x="40" y="32" width="240" height="6" rx="3" fill="#6B7280" />
      <rect x="44" y="28" width="6" height="14" rx="1" fill="#3A3F49" />
      <rect x="270" y="28" width="6" height="14" rx="1" fill="#3A3F49" />
      {side.map((p, i) => <rect key={"r" + i} x={200 + i * 13} y={35 - p.h / 2} width="11" height={p.h} rx="2" fill={p.c} stroke="#0E0F12" strokeWidth="1" />)}
      {side.map((p, i) => <rect key={"l" + i} x={109 - i * 13} y={35 - p.h / 2} width="11" height={p.h} rx="2" fill={p.c} stroke="#0E0F12" strokeWidth="1" />)}
      {side.length === 0 && <text x="160" y="54" textAnchor="middle" fontSize="10" fill="#8A909C" fontFamily="'JetBrains Mono',monospace">bar only</text>}
    </svg>
  );
}
function Stepper({ value, set, min = 0, max = 9999, step = 1, suffix, w }) {
  return (
    <div className="stepper">
      <button onClick={() => set(Math.max(min, +(value - step).toFixed(2)))}><Minus size={13} /></button>
      <span className="mono" style={{ minWidth: w || 56 }}>{value}{suffix || ""}</span>
      <button onClick={() => set(Math.min(max, +(value + step).toFixed(2)))}><Plus size={13} /></button>
    </div>
  );
}

/* Read-only landmarks view, shared by the onboarding preview and Settings.
   When `adjustments` is passed, the most-recent auto-tune delta per pattern is
   surfaced inline (e.g. "18 ▲1") so the automation is visible, not silent.
   `stallNotices` (optional — the onboarding preview has no real program, so
   no stalls to show) is separate from `lastCoach`: that note is overwritten
   every session, which would hide a persistent multi-block stall notice the
   moment the athlete logs anything else. This is observation only — it never
   changes what's prescribed; see adjustLandmarks in src/engine.js. */
function LandmarkTable({ landmarks, adjustments, stallNotices }) {
  const fmtDelta = (d) => (d > 0 ? `▲${d}` : `▼${Math.abs(d)}`);
  return (
    <div className="lmtable">
      <div className="lmtable-head mono"><span>MUSCLE</span><span>MEV</span><span>MAV</span><span>MRV</span></div>
      {Object.entries(landmarks).map(([p, lm]) => {
        const adj = adjustments?.[p];
        const stall = stallNotices?.[p];
        return (
          <div key={p} className="lmrow">
            <div className="lmrow-main">
              <span className="lmrow-name">{lm.label}</span>
              <span className="mono">{lm.mev}{adj?.dMev ? <em className={"lmdelta" + (adj.dMev < 0 ? " dn" : "")}>{fmtDelta(adj.dMev)}</em> : null}</span>
              <span className="mono">{lm.mav}</span>
              <span className="mono">{lm.mrv}{adj?.dMrv ? <em className={"lmdelta" + (adj.dMrv < 0 ? " dn" : "")}>{fmtDelta(adj.dMrv)}</em> : null}</span>
            </div>
            {adj?.signal && <div className="lmsig mono">↳ last auto-tune: {adj.signal}</div>}
            {stall && (
              <div className="lmstall mono">
                <AlertTriangle size={11} /> {lm.label}: no growth for {stall.cyclesStalled} blocks despite volume at MAV — consider a manual exercise swap.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Onboarding({ onDone }) {
  const [step, setStep] = useState(0);
  const [experience, setExperience] = useState("intermediate");
  const [bodyweight, setBodyweight] = useState(180);
  /* Four seeded lifts, one per movement family, chosen so every other exercise
     in LIB can be ratio-seeded off one of them (see ACC_E1RM_REF): a squat
     pattern, a hinge, an upper press, and an upper pull. Deadlift is no longer
     asked for — it isn't in the rotation — and T-Bar Row is asked for instead,
     so pulling loads stop being estimated from a pressing lift. */
  const [seeds, setSeeds] = useState({
    squat: { weight: 225, reps: 5, rpe: 8 }, rdl: { weight: 185, reps: 8, rpe: 8 },
    bench: { weight: 155, reps: 5, rpe: 8 }, tbarrow: { weight: 135, reps: 8, rpe: 8 },
  });
  const setSeed = (k, f, v) => setSeeds((s) => ({ ...s, [k]: { ...s[k], [f]: v } }));

  if (step === 0) return (
    <div className="screen">
      <div className="eyebrow">SETUP · 1 OF 2</div>
      <h1 className="display">Calibrate the lifts.</h1>
      <p className="lede">Bodyweight drives system-load math for bodyweight lifts (Pull-Up / Lat Pulldown) — added weight or assistance is tracked relative to it. Enter a recent honest top set for each of these four — weight, reps, and RPE (10 = no reps left, 8 = two left). Every other exercise in the program starts from a ratio off the closest one of these, then re-anchors to your own numbers after its first real session.</p>
      <div className="panel">
        <label className="fieldrow sm"><span>Bodyweight</span><Stepper value={bodyweight} set={setBodyweight} min={80} max={400} step={1} suffix=" lb" /></label>
      </div>
      {["squat", "rdl", "bench", "tbarrow"].map((k) => (
        <div key={k} className="panel">
          <div className="exer-name" style={{ fontSize: 19, padding: "10px 0 4px" }}>{LIB[k].label}</div>
          <label className="fieldrow sm"><span>Weight</span><Stepper value={seeds[k].weight} set={(v) => setSeed(k, "weight", v)} step={5} suffix=" lb" /></label>
          <label className="fieldrow sm"><span>Reps</span><Stepper value={seeds[k].reps} set={(v) => setSeed(k, "reps", v)} min={1} max={12} /></label>
          <label className="fieldrow sm"><span>RPE</span><Stepper value={seeds[k].rpe} set={(v) => setSeed(k, "rpe", v)} min={6} max={10} step={0.5} /></label>
          <div className="est mono">≈ e1RM {Math.round(e1rmFrom(seeds[k].weight, seeds[k].reps, seeds[k].rpe))} lb</div>
        </div>
      ))}
      <button className="cta" onClick={() => setStep(1)}>Next — training experience</button>
    </div>
  );

  const preview = landmarksForExperience(experience);
  return (
    <div className="screen">
      <div className="eyebrow">SETUP · 2 OF 2</div>
      <h1 className="display sm">Training experience.</h1>
      <p className="lede">This seeds your starting weekly-volume landmarks — MEV (minimum effective), MAV (most growth), MRV (most you can recover from) hard sets per muscle. Each block ramps from MEV up to MAV and then deloads; MRV is the recovery ceiling that bounds how far MAV can climb. From here the engine auto-tunes all three every block from your growth trend and fatigue; you won't set these by hand.</p>
      {Object.entries(EXPERIENCE_TIERS).map(([key, t]) => (
        <button key={key} type="button" className={"optcard" + (experience === key ? " on" : "")} onClick={() => setExperience(key)}>
          <div className="optcard-top">
            <span className="optcard-name">{t.label}</span>
            {experience === key && <Check size={16} />}
          </div>
          <span className="optcard-sub mono">{t.blurb}</span>
        </button>
      ))}
      <div className="eyebrow mt">SEEDED LANDMARKS</div>
      <LandmarkTable landmarks={preview} />
      <button className="cta" onClick={() => onDone(freshProgram({ seeds, experience, unit: "lb", goal: "hypertrophy", bodyweight }))}>Start program</button>
    </div>
  );
}

/* Rest between straight sets, by exercise tier. Longer rest is one of the few
   session variables with a clear hypertrophy effect: short rest truncates the
   next set's reps, so matched-set programs on 1-minute rest deliver less total
   volume and less growth than the same program on 2-3 minutes (Schoenfeld et
   al. 2016). Multi-joint work needs the most because it is the most limited by
   systemic recovery between sets; single-joint work recovers fastest. Replaces
   the old flat "3:00 for a main, 1:30 for everything else". */
const REST_LABEL = { compound: "2:30", unilateral: "2:00", isolation: "1:30" };

function ExerciseCard({ it, log, update, barWeight }) {
  /* Compounds open by default — they are the session's headline work and the
     exercises most likely to need a warmup ramp expanded. Isolation work stays
     collapsed. (This used to key off isMain, which no longer exists.) */
  const [open, setOpen] = useState(it.repTier === "compound");
  const [warmupOpen, setWarmupOpen] = useState(false);
  /* Six loggable fields (weight/reps/RPE/missed/backoff reps/backoff RPE)
     each feed a distinct engine calculation — none are removable without
     losing real data the engine uses. `log` already defaults to exactly
     what was prescribed, so a session logged as-written needs zero edits;
     showing all six as open steppers regardless punishes the common case.
     `editing` gates that: closed shows a compact summary of the CURRENT
     log values (tap to reveal the full stepper set), same progressive-
     disclosure principle the card itself already uses for accessories. */
  const [editing, setEditing] = useState(false);
  /* assistanceNeeded now carries the magnitude as a NEGATIVE topLoad (see the
     bodyweight branch in prescribe) — show it rather than leaving the athlete
     to guess which band to grab. bodyweightUnknown means the engine couldn't
     do bodyweight math at all and fell back to unloaded reps; say so, since
     the fix is for the athlete to set their bodyweight in Settings. */
  const bwScheme = it.bodyweightUnknown ? "bodyweight only — set your bodyweight in Settings"
    : it.assistanceNeeded ? `assisted — about ${Math.abs(it.topLoad)} lb help`
    : it.repOnly ? "bodyweight only"
    : `BW${it.topLoad >= 0 ? "+" : ""}${it.topLoad} lb`;
  const loadScheme = it.bodyweight ? bwScheme
    : it.barbell ? `${it.topLoad} lb — ${plateText(it.topLoad, barWeight)}`
    : (it.unilateral || it.perDumbbell) ? `${it.topLoad} lb/dumbbell`
    : `${it.topLoad} lb`;
  /* Every exercise is straight sets since the hypertrophy rebuild — `sets` is
     the full working-set count at one load, so there is no top-set/backoff
     split left to describe here.
     AUDIT 2.6: double-progression sets hold a fixed load and climb reps —
     the load is never derived from the shown RPE the way a normal accessory's
     is, so leading with "RPE X ·" implies a precision that isn't there. Lead
     with the load (what's actually prescribed) and show RPE as a target
     effort to aim for, not a computed value. */
  const scheme = it.dpMode
    ? `${it.sets} × ${it.reps} @ ${loadScheme} (aim RPE ${it.rpe})`
    : `${it.sets} × ${it.reps} @ RPE ${it.rpe} · ${loadScheme}`;
  // Same load-display logic as loadScheme above, applied to the LOGGED weight
  // instead of the prescribed one — mode (bodyweight/assisted/repOnly) still
  // comes from `it` since editing a number doesn't change which mode it's in.
  const logLoadScheme = it.bodyweightUnknown ? "bodyweight only"
    : it.bodyweight ? (log.topWeight < 0 ? `assisted — about ${Math.abs(log.topWeight)} lb help` : log.topWeight === 0 ? "bodyweight only" : `BW${log.topWeight >= 0 ? "+" : ""}${log.topWeight} lb`)
    : it.barbell ? `${log.topWeight} lb`
    : (it.unilateral || it.perDumbbell) ? `${log.topWeight} lb/dumbbell`
    : `${log.topWeight} lb`;
  const logSummary = (it.dpMode
    ? `${it.sets} × ${log.topReps} @ ${logLoadScheme} (RPE ${log.topRpe})`
    : `${it.sets} × ${log.topReps} @ RPE ${log.topRpe} · ${logLoadScheme}`)
    + (log.repsShort > 0 ? ` · ${log.repsShort} reps short` : "");
  return (
    <div className="exer">
      <div className="exer-head" onClick={() => setOpen(!open)}>
        <div>
          <div className="exer-name">
            {it.label}
            {/* Status reads from the COLLAPSED card, so a glance down the list
                answers "where am I?" without opening anything. */}
            {log.done && <span className="pill pill-done mono">LOGGED</span>}
            {log.skipped && <span className="pill pill-skip mono">SKIPPED</span>}
          </div>
          <div className="exer-scheme mono">{scheme}</div>
        </div>
        {open ? <ChevronDown size={17} color="#8A909C" /> : <ChevronRight size={17} color="#8A909C" />}
      </div>
      {it.barbell && (
        <div className="bar-wrap">
          <Barbell weight={log.topWeight} bar={barWeight} />
          {log.topWeight !== it.topLoad && <div className="plates mono">now {log.topWeight} lb — {plateText(log.topWeight, barWeight)}</div>}
        </div>
      )}
      {open && (
        <div className="exer-body">
          {it.warmup && (
            <div className="warmup">
              <button type="button" className="warmup-head mono" onClick={() => setWarmupOpen(!warmupOpen)}>
                <span className="warmup-label">
                  WARM-UP · {it.warmup.type === "full" ? "4-step ramp" : it.warmup.type === "short" ? "2-step ramp"
                    : it.warmup.type === "minimal" ? "1-step ramp" : "feeler set"}
                </span>
                {warmupOpen ? <ChevronDown size={14} color="#E8C547" /> : <ChevronRight size={14} color="#E8C547" />}
              </button>
              {warmupOpen && (
                <div className="warmup-body">
                  {it.warmup.note && <div className="warmup-row mono">{it.warmup.note}</div>}
                  {it.warmup.sets.map((s, i) => (
                    <div key={i} className="warmup-row mono">
                      {s.weight} lb{it.barbell ? ` — ${plateText(s.weight, barWeight)}` : ""} × {s.reps}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {!editing ? (
            <button type="button" className="logsummary mono" onClick={() => setEditing(true)}>
              <span>{logSummary}</span>
              <span className="logsummary-edit">EDIT</span>
            </button>
          ) : (
            <>
              <label className="fieldrow sm"><span>{it.bodyweight ? "Added / assist weight" : (it.unilateral || it.perDumbbell) ? "Weight per dumbbell" : "Working weight"}</span><Stepper value={log.topWeight} set={(v) => update({ topWeight: v })} min={it.bodyweight ? -200 : 0} step={5} suffix=" lb" /></label>
              {/* Reps and RPE are a MATCHED PAIR describing ONE set — the
                  engine feeds them to e1rmFrom(weight, reps, rpe) together, so
                  they must come from the same set or the estimate describes a
                  set that never happened. This said "Reps (per set)" while its
                  neighbour said "RPE (hardest set)": logging 12 reps from set
                  one alongside the RPE 9 of a final set of 8 had the engine
                  back-solve a max from 12 reps @ RPE 9, overstating strength
                  for anyone whose reps decline across straight sets. Both now
                  name the same set. */}
              <label className="fieldrow sm"><span>Reps (hardest set)</span><Stepper value={log.topReps} set={(v) => update({ topReps: v })} min={1} max={20} /></label>
              <label className="fieldrow sm"><span>RPE (hardest set)</span><Stepper value={log.topRpe} set={(v) => update({ topRpe: v })} min={5} max={10} step={0.5} /></label>
              {/* Total reps left on the table across ALL sets, which is where
                  the other sets are accounted for now that reps/RPE describe
                  only the hardest one. Replaces a "sets missed" count the
                  engine read as a boolean — see the missFrac comment in
                  ingest(). Capped at the session's full prescription. */}
              <label className="fieldrow sm"><span>Reps short (all sets)</span><Stepper value={log.repsShort ?? 0} set={(v) => update({ repsShort: v })} min={0} max={it.sets * it.reps} /></label>
              {/* Backoff fields render only if something is ever prescribed a
                  distinct backoff set. Nothing is today (straight sets
                  everywhere — see prescribe), so this branch is currently
                  unreachable; it is kept rather than deleted because the log
                  shape still carries the fields and an older saved session can
                  still have non-zero values in them. */}
              {it.backoffSetCount > 0 && (
                <>
                  <label className="fieldrow sm"><span>Backoff sets — reps (avg)</span><Stepper value={log.backoffReps} set={(v) => update({ backoffReps: v })} min={1} max={20} /></label>
                  <label className="fieldrow sm"><span>Backoff sets — RPE (avg)</span><Stepper value={log.backoffRpe} set={(v) => update({ backoffRpe: v })} min={5} max={10} step={0.5} /></label>
                </>
              )}
              {it.bodyweight && <div className="est mono">negative = assistance used</div>}
              {Math.abs(log.topRpe - it.rpe) >= 1 && (
                <div className="warn mono">{log.topRpe > it.rpe ? "harder than target — engine notes fatigue" : "easier than target — e1RM will rise"}</div>
              )}
            </>
          )}
          {/* The rest TIMER button is gone (unused in practice), but the rest
              GUIDANCE stays — the interval is one of the few session variables
              with a clear hypertrophy effect, so losing the number along with
              the button would have quietly removed real coaching. */}
          <div className="cardactions">
            <button
              type="button"
              className={"logbtn mono" + (log.done ? " is-done" : "")}
              aria-pressed={!!log.done}
              onClick={() => update({ done: !log.done, skipped: false })}
            >
              {log.done ? <><Check size={13} /> LOGGED</> : "LOG EXERCISE"}
            </button>
            <button
              type="button"
              className={"skipbtn mono" + (log.skipped ? " is-skipped" : "")}
              aria-pressed={!!log.skipped}
              onClick={() => update({ skipped: !log.skipped, done: false })}
            >
              {log.skipped ? "SKIPPED" : "DIDN'T DO"}
            </button>
            <span className="restcue mono">rest {REST_LABEL[it.repTier] || "1:30"}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Gauge({ value, label, color }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div className="gauge">
      <div className="gauge-label mono">{label}</div>
      <div className="gauge-bar"><div className="gauge-fill" style={{ width: `${pct * 100}%`, background: color }} /></div>
    </div>
  );
}


function Today({ program, sessions, onLog }) {
  const [readiness, setReadiness] = useState({ trainingReadiness: 65 });
  const rx = useMemo(() => prescribe(program, readiness), [program, readiness]);
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);



  /* Seed the session's logs — from a saved draft if one exists for THIS
     session, otherwise from the prescription.
     The draft is keyed on sessionCount so a stale draft can never bleed into a
     different session: finish session 12, and a leftover draft for 12 is
     ignored when 13 opens. Exercise keys are checked too, because the rotation
     can change under a draft (a swapped exercise, a migrated program) and
     restoring a log against the wrong exercise would attribute the athlete's
     numbers to a lift they never did. */
  useEffect(() => {
    const fresh = () => rx.items.map((it) => ({ key: it.key, topWeight: it.topLoad, topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe, targetReps: it.reps, repsShort: 0, sets: it.sets, backoffSetCount: it.backoffSetCount, backoffReps: it.reps, backoffRpe: it.rpe, backoffRpeCap: it.backoffRpeCap, done: false, skipped: false }));
    const d = readDraft();
    if (draftMatches(d, program.sessionCount, rx.items.map((it) => it.key))) {
      setLogs(d.logs);
      if (d.readiness && Number.isFinite(d.readiness.trainingReadiness)) setReadiness(d.readiness);
      setRestored(true);
    } else {
      setLogs(fresh());
      setRestored(false);
    }
    // eslint-disable-next-line
  }, [program.sessionCount]);

  /* Persist on EVERY change. No debounce: the payload is a few hundred bytes
     and the failure this guards against (the OS suspending the tab without
     warning) gives no opportunity to flush a pending timer. */
  useEffect(() => {
    if (!logs.length) return;
    writeDraft({ sessionCount: program.sessionCount, logs, readiness, savedAt: Date.now() });
  }, [logs, readiness, program.sessionCount]);

  useEffect(() => {
    /* Re-seeds the numbers on an untouched card when readiness changes the
       prescription. `done`/`skipped` are carried across rather than reset:
       they record what the athlete DID, which a change in today's readiness
       has no business undoing — marking an exercise skipped and then nudging
       the readiness slider must not silently un-skip it. */
    setLogs((L) => L.map((l, i) => (l && l._touched ? l : rx.items[i] ? { key: rx.items[i].key, topWeight: rx.items[i].topLoad, topReps: rx.items[i].reps, topRpe: rx.items[i].rpe, targetRpe: rx.items[i].rpe, targetReps: rx.items[i].reps, repsShort: 0, sets: rx.items[i].sets, backoffSetCount: rx.items[i].backoffSetCount, backoffReps: rx.items[i].reps, backoffRpe: rx.items[i].rpe, backoffRpeCap: rx.items[i].backoffRpeCap, done: l?.done ?? false, skipped: l?.skipped ?? false } : l)));
    // eslint-disable-next-line
  }, [rx.band]);

  const upd = (i, patch) => setLogs((L) => L.map((l, j) => (j === i ? { ...l, ...patch, _touched: true } : l)));
  const bandColor = rx.band === "green" ? "#3FA85F" : rx.band === "amber" ? "#E8C547" : "#D7443E";

  return (
    <div className="screen">
      <div className="eyebrow">SESSION {program.sessionCount + 1} · {rx.dayName.toUpperCase()}</div>
      <div className="blockrow">
        <span className="phase mono" style={{ borderColor: bandColor }}>{rx.block} · cycle {rx.cycle + 1}</span>
        {/* blockEffortRpe, not rpeTop. rpeTop went with the main lifts at the
                hypertrophy rebuild and prescribe() has not returned it since, so
                this line rendered "top RPE" followed by nothing — the one place
                the block's current effort target is shown, blank ever since. */}
        <span className="mono dim">top RPE {rx.blockEffortRpe}</span>
      </div>

      {/* Say so when work was recovered, rather than silently repopulating the
          fields — an athlete who watched the app die mid-session needs to know
          the numbers on screen are theirs and not a fresh prescription. */}
      {restored && (
        <div className="restored mono"><Check size={12} /> RESTORED YOUR IN-PROGRESS SESSION</div>
      )}

      {program.lastCoach && (
        <div className={"coach " + (program.lastCoach === COACH_OFFLINE_NOTE ? "coach-off " : "") + (program.block.type === "deload" ? "coach-alert" : "")}>
          <div className="coach-top mono">{program.block.type === "deload" ? <AlertTriangle size={12} /> : <Check size={12} />} COACH</div>
          <p>{program.lastCoach}</p>
        </div>
      )}

      {program.lastPRs?.length > 0 && (
        <div className="prnote mono"><Award size={13} /> NEW e1RM {program.lastPRs.length > 1 ? "PRs" : "PR"} — {program.lastPRs.map((k) => LIB[k]?.label || RETIRED_LABELS[k] || k).join(", ")}</div>
      )}

      {/* Names the DATE to train next and the cadence that date is steering
          toward, so the two can be sanity-checked against each other. The old
          banner said "Rest until <date>" from a flat 1/2/3-day minimum, which
          read as a recommendation and pointed at 7 sessions/week at normal
          fatigue. Still advisory — nothing here blocks logging early. */}
      {program.nextSessionAt && (
        <div className="restnote mono">
          <Timer size={13} />
          <span>
            Next session {new Date(program.nextSessionAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            {/* "on pace for N/week" described a cadence that drifted through the
                week and only averaged out. The schedule is fixed weekdays now,
                so the honest phrasing names the schedule rather than a rate the
                athlete has to trust is being hit. */}
            {program.nextSessionPerWeek >= 3.5
              ? ` — your usual ${program.nextSessionPerWeek.toFixed(0)}-day week`
              : " — stretched to let fatigue clear"}
            . Advisory only, log anytime.
            {/* The advisory and the volume math were never cross-checked, so at
                elevated fatigue the app could recommend 2.5 sessions/week while
                the Status screen simultaneously warned that 2.5/week strands
                every muscle's MAV. Both are correct in isolation — recovery
                first, then dose — but the athlete should be told the stretch has
                a cost rather than left to reconcile two screens. */}
            {program.nextSessionPerWeek < TRAINING_WEEKDAYS.length && (
              <span className="dim"> Below your usual cadence, so this week's volume targets won't all be met.</span>
            )}
          </span>
        </div>
      )}

      {rx.items.map((it, i) => logs[i] && <ExerciseCard key={it.key + i} it={it} log={logs[i]} update={(p) => upd(i, p)} barWeight={program.barWeight || 45} />)}

      <div className="eyebrow mt">READINESS — Garmin Training Readiness Score</div>
      <div className="panel">
        <label className="fieldrow sm"><span>Training Readiness Score</span><Stepper value={readiness.trainingReadiness} set={(v) => setReadiness({ ...readiness, trainingReadiness: v })} step={5} max={100} /></label>
      </div>
      <div className="readout mono" style={{ color: bandColor }}>
        readiness {rx.band.toUpperCase()} → {rx.band === "green" ? "session as prescribed" : rx.band === "amber" ? "load + volume trimmed slightly" : "auto mini-deload today"}
      </div>

      <button className="cta" disabled={busy} onClick={async () => { setBusy(true); await onLog(logs, readiness, rx); setBusy(false); }}>
        {busy ? "Coach reviewing…" : "Log session"}
      </button>

    </div>
  );
}

/* Muscles whose MAV the rotation cannot deliver at the athlete's actual
   training cadence.

   WHY THIS IS WORTH A PANEL. MAV is the endpoint every accumulation block
   ramps toward. A MAV the schedule can never reach doesn't announce itself:
   the volume bar simply stops climbing a little short, block after block,
   looking like a normal plateau. The athlete's only lever is cadence, and
   nothing in the app previously connected the two — so the failure mode was
   training for months against a target the program structurally could not hand
   out, and reading it as a recovery problem.

   It renders nothing when there is nothing to say, which is the common case at
   4x/week on the intermediate landmarks. */
function CapacityWarning({ shortfalls, gapDays }) {
  const rows = Object.entries(shortfalls);
  if (!rows.length) return null;
  /* Sorted worst-first: with 7+ groups short (advanced landmarks on a slow
     cadence) an unsorted list buries the one that matters. */
  rows.sort((a, b) => b[1].shortfall - a[1].shortfall);
  /* One cadence that clears everything cadence CAN clear, so the athlete gets
     a single number to act on instead of a per-muscle table of them. */
  const fixable = rows.filter(([, v]) => v.fixableByCadence);
  const needed = fixable.length ? Math.max(...fixable.map(([, v]) => v.sessionsPerWeekNeeded)) : null;
  const stuck = rows.filter(([, v]) => !v.fixableByCadence);
  const perWeek = gapDays ? 7 / gapDays : null;
  return (
    <div className="panel capwarn">
      <div className="capwarn-head">
        <AlertTriangle size={13} />
        <span className="mono">SCHEDULE CAN'T DELIVER {rows.length === 1 ? "1 TARGET" : `${rows.length} TARGETS`}</span>
      </div>
      <p className="capwarn-lede">
        {perWeek ? `At your current ${perWeek.toFixed(1)} sessions/week, these` : "These"} muscles have a MAV the rotation
        cannot prescribe. Each block ramps toward a number it never reaches — that reads as a plateau, but it's the schedule, not your recovery.
      </p>
      {rows.map(([p, v]) => (
        <div key={p} className="capwarn-row mono">
          <span>{v.label}</span>
          <span className="dim">
            {v.capacityWeekly.toFixed(1)} of {v.mav} sets
            <span className="capwarn-gap"> −{v.shortfall.toFixed(1)}</span>
          </span>
        </div>
      ))}
      {needed != null && (
        <p className="capwarn-fix">
          Training <strong>{needed.toFixed(1)}×/week</strong> (about every {(7 / needed).toFixed(1)} days) delivers{" "}
          {stuck.length ? fixable.map(([, v]) => v.label).join(", ") : "all of these"} in full.
        </p>
      )}
      {stuck.length > 0 && (
        <p className="capwarn-fix">
          {stuck.map(([, v]) => v.label).join(", ")} {stuck.length === 1 ? "is" : "are"} short of ramped
          exercise slots, not training days — no cadence delivers {stuck.length === 1 ? "it" : "them"}. That needs a rotation change.
        </p>
      )}
    </div>
  );
}

/* Muscles whose MAV has reached the schedule's ceiling and can no longer be
   raised by the auto-tune.

   WHY THIS IS ITS OWN PANEL rather than a row in CapacityWarning: they are
   opposite problems with opposite fixes. A SHORTFALL means the target is out of
   reach and the athlete is under-training it — add days. PINNED means the
   target has been fully met and has stopped moving — the athlete is doing
   everything the rotation can give them, and the limit is now the rotation
   itself. Colouring the two the same would tell someone doing everything right
   that something is wrong.

   It renders nothing until a group actually arrives at its ceiling, which for a
   growing athlete takes months. */
function CapacityPinned({ pinned }) {
  const rows = Object.entries(pinned);
  if (!rows.length) return null;
  rows.sort((a, b) => b[1].mav - a[1].mav);
  const needed = Math.max(...rows.map(([, v]) => v.sessionsPerWeekForHeadroom));
  return (
    <div className="panel cappin">
      <div className="cappin-head mono">
        <Check size={13} />
        <span>{rows.length === 1 ? "1 MUSCLE" : `${rows.length} MUSCLES`} AT THE SCHEDULE'S CEILING</span>
      </div>
      <p className="cappin-lede">
        These are getting everything the rotation can deliver — target met, nothing missing.
        But their targets have stopped climbing between blocks, because the next step up is more
        than the schedule holds.
      </p>
      {rows.map(([p, v]) => (
        <div key={p} className="cappin-row mono">
          <span>{v.label}</span>
          <span className="dim">{v.mav} sets · at capacity</span>
        </div>
      ))}
      <p className="cappin-fix">
        To give them room again: <strong>{needed.toFixed(1)}×/week</strong>, or another exercise slot
        on a day that isn't already full for that muscle.
      </p>
    </div>
  );
}

function Status({ program }) {
  const cyc = program.block.cycle;
  /* Same frequency correction prescribe() applies to the ramped-accessory
     set count (see weeklyTarget in engine.js): deliveredWeekly is called
     WITH freqScale so it reflects what's really being prescribed at this
     athlete's actual training frequency, then divided by freqScale again to
     land back on a true-weekly RATE — comparable to the weekly-unit MEV/
     MAV/MRV landmarks this row is judged against. Without both steps this
     display would silently drift from what prescribe() actually hands the
     athlete the moment avgSessionGapDays departs from ~4x/week. */
  /* effectiveGapDays, NOT avgSessionGapDays. Every consumer inside the engine
     moved to the rate estimator; this call site did not, so the Status screen
     computed weekly volume at a different cadence than the one the athlete was
     actually prescribed at — and it oscillated on exactly the weekday cycle the
     rate estimator exists to eliminate. Measured on a settled Mon-Fri athlete:
     this read 0.838 / 1.229 / 1.075 / 0.967 / 0.891 across the week while the
     engine used 1.0 throughout, swinging the volume bar's ceiling marker
     between 21 and 31 sets and on Tuesday rendering it BELOW the delivered
     volume — the one thing that marker exists to make impossible. */
  const freqScale = weeklyFreqScale(effectiveGapDays(program));
  const shortfalls = capacityShortfalls(program, program.block.type);
  const pinned = capacityPinned(program, program.block.type);
  const rows = Object.entries(program.landmarks).map(([p, lm]) => {
    // true-weekly full-muscle sets actually prescribed (mains + fixedSets + ramped); rounded since freqScale != 1 makes this a rate, not a literal per-rotation count
    const wk = Math.round(deliveredWeekly(p, program.block.type, cyc, program.landmarks, freqScale) / freqScale);
    /* maxDeliverable is per-ROTATION; mrv is per-CALENDAR-WEEK. Comparing them
       directly (as this did) is only correct at exactly 4x/week — the same
       units mismatch AUDIT 3.3 fixed inside adjustLandmarks' raise gates. At a
       slower cadence it UNDER-reported the ceiling marker and at a faster one
       it over-reported it, so the one indicator meant to warn about capacity
       was itself wrong wherever capacity actually mattered. */
    const deliverable = Math.round(maxDeliverable(p, program.block.type) / freqScale);
    const capped = deliverable < lm.mrv;      // group structurally can't reach its own MRV at this cadence
    const pctMrv = Math.min(1, wk / lm.mrv);
    const color = wk < lm.mev ? "#9AA0AC" : wk < lm.mav ? "#3FA85F" : wk < lm.mrv ? "#E8C547" : "#D7443E";
    return { p, label: lm.label, wk, lm, pctMrv, color, deliverable, capped };
  });
  return (
    <div className="screen">
      <div className="eyebrow">MESOCYCLE</div>
      <h1 className="display sm">{BLOCKS[program.block.type]?.label || LEGACY_BLOCK_TYPES[program.block.type] || program.block.type}</h1>
      <p className="lede" style={{ marginBottom: 14 }}>Microcycle {cyc + 1} · emphasis: {BLOCKS[program.block.type]?.emphasis || "volume"}. Block length is decided live from your e1RM trend, RPE creep, and readiness — not a fixed calendar.</p>
      <div className="panel" style={{ padding: 14 }}>
        <Gauge value={program.fatigue.index} label={`FATIGUE INDEX  ${program.fatigue.index.toFixed(2)}`} color={program.fatigue.index >= 0.7 ? "#D7443E" : program.fatigue.index >= 0.55 ? "#E8C547" : "#3FA85F"} />
        <Gauge value={0.5 + program.fatigue.slope * 50} label={`e1RM TREND  ${(program.fatigue.slope * 100).toFixed(2)}%/session`} color="#2F6FB0" />
      </div>
      <CapacityWarning shortfalls={shortfalls} gapDays={effectiveGapDays(program)} />
      <CapacityPinned pinned={pinned} />
      <div className="eyebrow mt">WEEKLY VOLUME vs LANDMARKS</div>
      {rows.map((r) => (
        <div key={r.p} className="volrow">
          <div className="volrow-top"><span className="mono">{r.label}</span><span className="mono" style={{ color: r.color }}>{r.wk} sets</span></div>
          <div className="vol-track">
            <div className="vol-fill" style={{ width: `${r.pctMrv * 100}%`, background: r.color }} />
            <div className="vol-tick" style={{ left: `${(r.lm.mev / r.lm.mrv) * 100}%` }} />
            <div className="vol-tick" style={{ left: `${(r.lm.mav / r.lm.mrv) * 100}%` }} />
            {r.capped && <div className="vol-cap" style={{ left: `${(r.deliverable / r.lm.mrv) * 100}%` }} title={`max ${r.deliverable} sets deliverable`} />}
          </div>
          <div className="vol-legend mono dim">MEV {r.lm.mev} · MAV {r.lm.mav} · MRV {r.lm.mrv}{r.capped ? <span className="vol-capnote"> · ceiling {r.deliverable} (max deliverable &lt; MRV)</span> : null}</div>
        </div>
      ))}
    </div>
  );
}

function Trends({ program }) {
  /* The four onboarding-seeded lifts, one per movement family — the same four
     the athlete calibrated at setup, so the trend lines are the ones they have
     a reference point for. (Deadlift is no longer in the program; T-Bar Row
     replaces it here as the pulling trend.) */
  const lifts = [["squat", "Squat", "#D7443E"], ["bench", "Bench", "#2F6FB0"], ["rdl", "RDL", "#3FA85F"], ["tbarrow", "T-Bar Row", "#E8C547"]];
  const any = lifts.some(([k]) => (program.lifts[k].hist || []).length > 1);
  if (!any) return <div className="screen"><div className="empty">Estimated-1RM curves appear here once you've logged a few sessions.</div></div>;
  return (
    <div className="screen">
      <div className="eyebrow">ESTIMATED 1RM</div>
      <h1 className="display sm">Strength trend</h1>
      <p className="lede" style={{ marginBottom: 12 }}>Smoothed e1RM (bold) vs each session's raw reading (faint). The smoothed line drives load prescription and stall detection.</p>
      {lifts.map(([k, label, color]) => {
        const d = (program.lifts[k].hist || []).map((p, i) => ({ n: i + 1, e: p.e, raw: p.raw }));
        return (
          <div key={k} className="panel chart">
            <div className="chart-title mono" style={{ color }}>{label.toUpperCase()} · {Math.round(program.lifts[k].e1rm)} lb</div>
            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={d} margin={{ top: 6, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid stroke="#2E333D" vertical={false} />
                <XAxis dataKey="n" stroke="#5A6070" fontSize={10} />
                <YAxis stroke="#5A6070" fontSize={10} domain={["auto", "auto"]} />
                <Tooltip contentStyle={{ background: "#1C1F26", border: "1px solid #2E333D", borderRadius: 8, color: "#E6E8EC", fontSize: 12 }} />
                <Line type="monotone" dataKey="raw" stroke={color} strokeOpacity={0.25} strokeWidth={1} dot={false} />
                <Line type="monotone" dataKey="e" stroke={color} strokeWidth={2.5} dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        );
      })}
    </div>
  );
}

function History({ sessions }) {
  if (!sessions.length) return <div className="screen"><div className="empty">Logged sessions land here.</div></div>;
  return (
    <div className="screen">
      <div className="eyebrow">LOG</div>
      <h1 className="display sm">History</h1>
      {[...sessions].reverse().map((s, i) => (
        <div key={i} className="hist">
          <div className="hist-top"><span className="mono">{s.block} · {s.dayName}</span><span className="mono dim">{new Date(s.date).toLocaleDateString()}</span></div>
          <div className="hist-lifts mono">{s.logs.map((l) => `${(LIB[l.key]?.label || RETIRED_LABELS[l.key] || l.key).split(" ")[0]} ${l.topWeight}×${l.topReps}@${l.topRpe}` + (l.backoffSetCount > 0 ? ` (+${l.backoffSetCount} backoff×${l.backoffReps}@${l.backoffRpe})` : "")).join("  ·  ")}</div>
          {s.prs?.length > 0 && <div className="hist-pr mono">★ e1RM PR — {s.prs.map((k) => LIB[k]?.label || RETIRED_LABELS[k] || k).join(", ")}</div>}
          {s.transition && <div className="hist-trans mono">→ {BLOCKS[s.transition]?.label || LEGACY_BLOCK_TYPES[s.transition] || s.transition}</div>}
          {s.coach && s.coach !== COACH_OFFLINE_NOTE && <div className="hist-coach">{s.coach}</div>}
        </div>
      ))}
    </div>
  );
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  const submit = async () => {
    if (!email || !password) { setErr("Enter your email and password."); return; }
    setBusy(true); setErr(""); setNote("");
    try {
      if (mode === "signup") {
        const { needsConfirmation } = await signUp(email, password);
        if (needsConfirmation) { setNote("Account created — confirm via the email link, then sign in."); setMode("signin"); }
        // if no confirmation required, onAuthChange in App flips to the app automatically
      } else {
        await signIn(email, password);
      }
    } catch (e) { setErr(e?.message || "Authentication failed."); }
    finally { setBusy(false); }
  };

  return (
    <div className="screen">
      <div className="eyebrow">IRON LOG</div>
      <h1 className="display sm">{mode === "signup" ? "Create your account." : "Sign in."}</h1>
      <p className="lede">Your data is private to your account — a login is required to read or write it.</p>
      <div className="panel" style={{ padding: 14 }}>
        <label className="fieldrow sm" style={{ display: "block" }}><span style={{ display: "block", marginBottom: 6 }}>Email</span>
          <input className="textinput mono" type="email" value={email} autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label>
        <label className="fieldrow sm" style={{ display: "block", borderBottom: "none" }}><span style={{ display: "block", marginBottom: 6 }}>Password</span>
          <input className="textinput mono" type="password" value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="••••••••"
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }} /></label>
      </div>
      {err && <div className="warn mono" style={{ paddingTop: 4 }}>{err}</div>}
      {note && <div className="est mono" style={{ padding: "4px 0 0", color: "#3FA85F" }}>{note}</div>}
      <button className="cta" disabled={busy} onClick={submit}>{busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}</button>
      <div className="est mono" style={{ textAlign: "center" }}>
        {mode === "signup"
          ? <>Already have an account? <a style={{ color: "var(--text)", cursor: "pointer" }} onClick={() => { setMode("signin"); setErr(""); }}>Sign in</a></>
          : <>Need an account? <a style={{ color: "var(--text)", cursor: "pointer" }} onClick={() => { setMode("signup"); setErr(""); }}>Create one</a></>}
      </div>
    </div>
  );
}

function LoadErrorScreen({ onRetry, busy }) {
  return (
    <div className="screen">
      <div className="eyebrow">IRON LOG</div>
      <h1 className="display sm">Couldn't load your data.</h1>
      <p className="lede">The request to your database failed — this is a connection or server problem, not missing data. Your saved program and history are safe; we just couldn't reach them. Nothing has been created or overwritten.</p>
      <button className="cta" disabled={busy} onClick={onRetry}>{busy ? "Retrying…" : "Retry"}</button>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = checking, null = logged out, obj = signed in
  const [program, setProgram] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [tab, setTab] = useState("today");
  const [showSettings, setShowSettings] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetPhrase, setResetPhrase] = useState("");

  // ---- auth: track the session; the app is gated behind it ----
  useEffect(() => {
    let active = true;
    getSession().then((s) => { if (active) setSession(s); }).catch(() => { if (active) setSession(null); });
    const unsub = onAuthChange((s) => setSession(s));
    return () => { active = false; unsub(); };
  }, []);

  const loadData = async () => {
    setLoadError(false); setReady(false); setRetrying(true);
    try {
      const { program: mp, sessions: s, migrated } = await loadProgramState();
      if (mp) setProgram(mp);
      setSessions(s);
      if (migrated && mp) saveKey(K_PROGRAM, mp); // best-effort migration persist
      setReady(true);
    } catch {
      // A failed fetch must NOT look like an empty account — surface a retry
      // screen and never fall through to Onboarding / start().
      setLoadError(true); setReady(true);
    } finally { setRetrying(false); }
  };

  // load data only once signed in (and reset local state on sign-out)
  useEffect(() => {
    if (session) { loadData(); }
    else { setProgram(null); setSessions([]); setReady(false); setLoadError(false); setShowSettings(false); }
    // eslint-disable-next-line
  }, [session]);

  // checked persistence — surfaces a save failure instead of silently proceeding
  const persist = async (prog, sess) => {
    const okP = await saveKey(K_PROGRAM, prog);
    const okS = await saveKey(K_SESSIONS, sess);
    const ok = okP && okS;
    setSaveError(!ok);
    return ok;
  };

  const start = async (p) => {
    if (loadError) return; // never complete onboarding while data failed to load
    setProgram(p); await persist(p, sessions);
  };

  const handleLog = async (logs, readiness, rx) => {
    /* Every log reaching handleLog was submitted by the athlete through the
       Today screen — there is no auto-log/skip-and-fill path here, so
       submission itself is sufficient evidence the session happened,
       regardless of whether any field was edited from the prescribed
       default. `touched` is always true for real submissions; ingest()'s
       `g.touched === false` gate exists for a future bulk-import/migration
       path that might construct logs without real user submission, not for
       this one. (`_touched` is a separate, UI-local concern — see the `upd`
       function below — tracking which fields the athlete edited so the
       readiness-resync effect doesn't clobber their edits; it is NOT a
       signal about whether the session itself is real data.) */
    /* A SKIPPED exercise is withheld from the engine entirely rather than
       logged as a failure. The distinction matters in both directions: it must
       not feed the e1RM estimate (no set happened, so there is nothing to
       measure), and it must not feed the fatigue index either — work you never
       started is not evidence that you are breaking down, which is exactly
       what logging it as "all reps short" would have claimed. It is still
       written to the session record below, so the history shows what was
       actually trained. */
    const ingestLogs = logs.filter((l) => !l.skipped).map((l) => ({ ...l, touched: true }));
    const { next, transition, fatigueIndex, e1rmSlope, rScore, prs, rpeMiss, backoffDrift, missFreq } = ingest(program, ingestLogs, readiness);
    const recent = [
      { block: rx.block, fatigue: +fatigueIndex.toFixed(2),
        lifts: logs.filter((l) => !l.skipped && LIB[l.key]?.repTier === "compound").map((l) => ({ lift: l.key, w: l.topWeight, reps: l.topReps, rpe: l.topRpe, target: l.targetRpe, repsShort: l.repsShort, ofReps: (l.sets ?? 1) * (l.targetReps ?? l.topReps) })),
        trainingReadiness: readiness.trainingReadiness },
      ...sessions.slice(-4).reverse().map((s) => ({ block: s.block, lifts: s.logs.filter((l) => LIB[l.key]?.repTier === "compound").map((l) => ({ lift: l.key, w: l.topWeight, reps: l.topReps, rpe: l.topRpe })) })),
    ];

    const coach = await runCoach({ rx, fatigueIndex, e1rmSlope, rScore, transition, recent });

    let finalProgram = next, appliedTransition = null;
    if (transition) {
      let t = transition;
      if (t.borderline && coach.ok && coach.confirmTransition === false) t = null;
      else if (t.borderline && coach.ok && coach.override && coach.override !== "null" && BLOCKS[coach.override]) t = { ...transition, to: coach.override };
      if (t) { finalProgram = applyTransition(next, t); appliedTransition = t.to; }
    }
    finalProgram.lastCoach = coach.note;
    finalProgram.lastPRs = prs.length ? prs : null;
    /* Fractional days, added to the timestamp — see nextSessionGapDays. The
       1.75 must NOT be rounded here: keeping it is what makes the advised date
       alternate Mon/Wed/Fri/Sun and land on 4 sessions per 7 days. */
    finalProgram.nextSessionAt = nextSessionTargetAt(program.nextSessionAt, Date.now(), fatigueIndex);
    finalProgram.nextSessionPerWeek = targetSessionsPerWeek(fatigueIndex);
    delete finalProgram.lastRestUntil;   // superseded; drop so the old banner can't linger

    const record = {
      date: Date.now(), block: rx.block, dayName: rx.dayName,
      logs: logs.map((l) => ({ key: l.key, topWeight: l.topWeight, topReps: l.topReps, topRpe: l.topRpe, repsShort: l.repsShort, targetReps: l.targetReps, sets: l.sets,
        backoffSetCount: l.backoffSetCount || 0, backoffReps: l.backoffReps, backoffRpe: l.backoffRpe, touched: true, skipped: !!l.skipped })),
      readiness, coach: coach.note, transition: appliedTransition, prs: prs.length ? prs : null,
      /* Readiness instrumentation for readiness_analysis.mjs: the band/score
         and adjustment that were ACTUALLY applied to this session's
         prescription (rx — captured at prescribe-time, not re-derived later,
         so a future change to READINESS_RPE_ADJ/READINESS_SET_MULT can never
         retroactively rewrite what an old session's numbers say happened),
         alongside the real outcome ingest() already computed (reused, not
         recomputed) so the two can eventually be compared per band. */
      readinessOutcome: {
        band: rx.band, score: +readinessScore(readiness).toFixed(3),
        rpeAdj: rx.rpeAdj, setMult: rx.setMult,
        rpeMiss: rpeMiss == null ? null : +rpeMiss.toFixed(3),
        backoffDrift: backoffDrift == null ? null : +backoffDrift.toFixed(3),
        missFreq: +missFreq.toFixed(3),
      },
    };
    const newSessions = [...sessions, record];
    setProgram(finalProgram); setSessions(newSessions);
    // Check the write: if it fails, surface a save error rather than silently
    // proceeding as though the session was safely logged.
    await persist(finalProgram, newSessions);
    /* Drop the in-progress draft only AFTER the session has been persisted.
       Clearing it earlier would open a window where a failed cloud write has
       already destroyed the local copy — the athlete's whole session lost to
       an error that the retry screen is there to recover from. */
    clearDraft();
    setTab("today");
  };

  const retrySave = async () => { await persist(program, sessions); };

  const reset = async () => {
    if (resetPhrase !== "DELETE") return;
    const ok = await persist(null, []);
    if (!ok) return; // don't clear local state if the delete didn't persist
    setProgram(null); setSessions([]); setTab("today"); setConfirmingReset(false); setShowSettings(false); setResetPhrase("");
  };

  const setProgramField = async (field, v) => {
    const next = { ...program, [field]: v };
    setProgram(next);
    await persist(next, sessions);
  };

  const exportData = () => {
    const payload = { exportedAt: new Date().toISOString(), version: 1, program, sessions };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `iron-log-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const screen = decideScreen({ session, loadError, ready, program });

  return (
    <div className="root">
      <style>{CSS}</style>
      {screen === "checking-auth" || screen === "loading"
        ? <div className="screen"><div className="empty">Loading…</div></div>
        : screen === "login" ? <Login />
        : screen === "load-error" ? <LoadErrorScreen onRetry={loadData} busy={retrying} />
        : screen === "onboarding" ? <Onboarding onDone={start} />
        : <>
          <div className="topbar">
            <div className="brand mono"><Dumbbell size={15} /> IRON&nbsp;LOG</div>
            <button className="ghost" onClick={() => setShowSettings(true)}><Settings size={15} /></button>
          </div>
          {saveError && (
            <div className="savewarn mono">
              <AlertTriangle size={14} />
              <span className="sw-text">Couldn't save — your last change may not persist. Check your connection.</span>
              <button onClick={retrySave}>Retry</button>
              <button onClick={() => setSaveError(false)}><X size={13} /></button>
            </div>
          )}
          {showSettings && (
            <div className="screen">
              <div className="eyebrow">SETTINGS</div>
              <div className="panel">
                <label className="fieldrow sm"><span>Bodyweight</span><Stepper value={program.bodyweight || 180} set={(v) => setProgramField("bodyweight", v)} min={80} max={400} step={1} suffix=" lb" /></label>
                <label className="fieldrow sm"><span>Bar weight</span><Stepper value={program.barWeight || 45} set={(v) => setProgramField("barWeight", v)} min={15} max={100} step={5} suffix=" lb" /></label>
              </div>
              <div className="est mono" style={{ padding: "0 0 14px" }}>Bodyweight drives Pull-Up / Chin-Up system-load math. Bar weight drives the plate-loading breakdown.</div>
              <div className="eyebrow">VOLUME LANDMARKS · {(EXPERIENCE_TIERS[program.experience] || EXPERIENCE_TIERS.intermediate).label.toUpperCase()} SEED</div>
              <p className="est mono" style={{ padding: "0 0 8px" }}>Weekly hard sets per pattern. Auto-tuned each block from your strength trend + fatigue — ▲/▼ marks the most recent change.</p>
              <LandmarkTable landmarks={program.landmarks} adjustments={program.landmarkAdjustments} stallNotices={program.stallNotices} />
              <div style={{ height: 16 }} />
              <div className="eyebrow">BACKUP & ACCOUNT</div>
              <p className="est mono" style={{ padding: "0 0 8px" }}>Supabase's free tier has no automated backups — export a copy periodically as your safety net.</p>
              <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                <button className="cta" style={{ margin: 0, background: "var(--surface2)", color: "var(--text)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }} onClick={exportData}><Download size={15} /> Export my data</button>
                <button className="cta" style={{ margin: 0, background: "var(--surface2)", color: "var(--text)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }} onClick={() => signOut()}><LogOut size={15} /> Sign out</button>
              </div>
              {!confirmingReset ? (
                <div style={{ display: "flex", gap: 10 }}>
                  <button className="cta" style={{ margin: 0, background: "#D7443E", color: "#2A0907" }} onClick={() => setConfirmingReset(true)}>Reset everything</button>
                  <button className="cta" style={{ margin: 0, background: "var(--surface2)", color: "var(--text)" }} onClick={() => setShowSettings(false)}>Done</button>
                </div>
              ) : (
                <div className="panel" style={{ padding: 16 }}>
                  <p style={{ margin: "4px 0 10px", fontSize: 13.5, lineHeight: 1.5, color: "var(--text)" }}>
                    This will permanently delete your program and all session history. There is no backup — this cannot be undone.
                  </p>
                  <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--dim)" }}>Type <b style={{ color: "var(--text)" }}>DELETE</b> to confirm.</p>
                  <input
                    className="textinput mono"
                    value={resetPhrase}
                    onChange={(e) => setResetPhrase(e.target.value)}
                    placeholder="DELETE"
                    autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  />
                  <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                    <button className="cta" disabled={resetPhrase !== "DELETE"} style={{ margin: 0, background: "#D7443E", color: "#2A0907" }} onClick={reset}>Confirm reset</button>
                    <button className="cta" style={{ margin: 0, background: "var(--surface2)", color: "var(--text)" }} onClick={() => { setConfirmingReset(false); setResetPhrase(""); }}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {tab === "today" && <Today program={program} sessions={sessions} onLog={handleLog} />}
          {tab === "status" && <Status program={program} />}
          {tab === "trends" && <Trends program={program} />}
          {tab === "history" && <History sessions={sessions} />}
          <nav className="tabs">
            {[["today", "Today", Activity], ["status", "Block", Layers], ["trends", "Trends", TrendingUp], ["history", "Log", HistoryIcon]].map(([t, l, Icon]) => (
              <button key={t} className={tab === t ? "tab-on" : ""} onClick={() => setTab(t)}><Icon size={17} /><span>{l}</span></button>
            ))}
          </nav>
        </>}
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
.root{--bg:#121419;--surface:#1A1D24;--surface2:#22262F;--line:#2E333D;--text:#E6E8EC;--dim:#8A909C;--accent:#3FA85F;
  max-width:460px;margin:0 auto;min-height:100vh;background:var(--bg);color:var(--text);
  font-family:'Inter',system-ui,sans-serif;position:relative;padding-bottom:80px;}
.root *{box-sizing:border-box;}
.mono{font-family:'JetBrains Mono',monospace;}
.dim{color:var(--dim);}
.topbar{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line);
  position:sticky;top:0;background:rgba(18,20,25,.92);backdrop-filter:blur(8px);z-index:5;}
.brand{display:flex;align-items:center;gap:7px;font-weight:500;letter-spacing:.14em;font-size:13px;}
.ghost{background:none;border:none;color:var(--dim);cursor:pointer;width:44px;height:44px;display:flex;align-items:center;justify-content:center;margin:-10px 0;}
.screen{padding:18px 18px 8px;}
.eyebrow{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.16em;color:var(--dim);margin-bottom:8px;}
.eyebrow.mt{margin-top:24px;}
.display{font-family:'Saira Condensed',sans-serif;font-weight:700;letter-spacing:-.01em;line-height:.95;font-size:42px;margin:0 0 12px;}
.display.sm{font-size:32px;}
.lede{color:var(--dim);font-size:13.5px;line-height:1.5;margin:0 0 18px;}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:4px 14px;margin-bottom:8px;}
.fieldrow{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--line);font-size:14px;}
.panel .fieldrow:last-child{border-bottom:none;}
.fieldrow.sm{padding:6px 0;font-size:13px;}
.logsummary{display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%;padding:12px 0;
  background:none;border:none;border-bottom:1px solid var(--line);font-size:13px;color:var(--text);cursor:pointer;
  text-align:left;font-family:inherit;}
.logsummary-edit{color:#E8C547;font-size:10.5px;letter-spacing:.1em;flex-shrink:0;}
.est{font-size:11.5px;color:var(--dim);padding:2px 0 10px;}
.textinput{width:100%;padding:12px 13px;border-radius:10px;border:1px solid var(--line);background:var(--surface2);color:var(--text);font-size:14.5px;height:44px;}
.textinput:focus{outline:none;border-color:#D7443E;}
.textinput::placeholder{color:var(--dim);opacity:.5;}
.stepper{display:flex;align-items:center;gap:6px;}
.stepper button{width:44px;height:44px;border-radius:10px;border:1px solid var(--line);background:var(--surface2);color:var(--text);display:flex;align-items:center;justify-content:center;cursor:pointer;}
.stepper button:active{background:var(--line);}
.stepper .mono{text-align:center;font-size:14.5px;font-weight:500;}
.cta{width:100%;margin:20px 0 6px;padding:15px;border:none;border-radius:12px;background:#3FA85F;color:#06210F;
  font-family:'Saira Condensed',sans-serif;font-weight:700;font-size:19px;letter-spacing:.03em;cursor:pointer;text-transform:uppercase;}
.cta:disabled{opacity:.6;cursor:wait;}
.blockrow{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;}
.phase{font-size:11.5px;padding:5px 10px;border:1px solid;border-radius:20px;letter-spacing:.06em;}
.exer{background:var(--surface);border:1px solid var(--line);border-radius:13px;margin-bottom:9px;overflow:hidden;}
.exer-head{display:flex;justify-content:space-between;align-items:center;padding:13px 15px;cursor:pointer;}
.exer-name{font-family:'Saira Condensed',sans-serif;font-weight:600;font-size:20px;line-height:1;display:flex;align-items:center;gap:8px;}
.tag{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;color:#06210F;background:#3FA85F;padding:2px 5px;border-radius:4px;}
.exer-scheme{font-size:11px;color:var(--dim);margin-top:5px;}
.bar-wrap{padding:0 10px 6px;}
.exer-body{padding:2px 15px 12px;border-top:1px solid var(--line);}
.warmup{background:var(--surface2);border:1px solid var(--line);border-radius:10px;margin:10px 0;overflow:hidden;}
.warmup-head{display:flex;width:100%;justify-content:space-between;align-items:center;padding:9px 12px;background:none;border:none;color:#E8C547;cursor:pointer;font-family:inherit;}
.warmup-label{font-size:10.5px;letter-spacing:.09em;}
.warmup-body{padding:2px 12px 9px;border-top:1px solid var(--line);}
.warmup-row{font-size:11.5px;color:var(--dim);padding:4px 0;}
.warn{color:#E8C547;font-size:11px;padding-top:8px;}
.coach{background:var(--surface);border:1px solid var(--line);border-left:3px solid #3FA85F;border-radius:11px;padding:11px 13px;margin-bottom:16px;}
.coach-alert{border-left-color:#D7443E;}
.coach-top{display:flex;align-items:center;gap:6px;font-size:10.5px;letter-spacing:.12em;color:var(--dim);margin-bottom:6px;}
.coach p{margin:0;font-size:13px;line-height:1.45;}
.coach-off{border-left-color:var(--line);}
.coach-off .coach-top{opacity:.65;}
.coach-off p{color:var(--dim);font-size:11.5px;font-family:'JetBrains Mono',monospace;}
.prnote{display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--line);border-left:3px solid #E8C547;border-radius:11px;padding:11px 13px;margin-bottom:16px;font-size:11.5px;letter-spacing:.05em;color:#E8C547;}
.restnote{display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--line);border-left:3px solid #E8C547;border-radius:11px;padding:11px 13px;margin-bottom:16px;font-size:11.5px;letter-spacing:.03em;color:var(--dim);}
.restnote svg{color:#E8C547;flex-shrink:0;}
.savewarn{display:flex;align-items:center;gap:8px;margin:14px 18px 0;padding:9px 12px;background:#2A0E0C;border:1px solid #D7443E;border-radius:10px;color:#F0B7B3;font-size:11.5px;}
.savewarn svg{color:#D7443E;flex-shrink:0;}
.sw-text{flex:1;}
.savewarn button{background:var(--surface2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:4px 8px;font-size:11px;cursor:pointer;display:flex;align-items:center;}
.plates{font-size:10.5px;color:var(--dim);letter-spacing:.04em;padding:2px 4px 6px;}
/* per-exercise commit / skip, in the slot the rest timer used to occupy */
.cardactions{display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap;}
.logbtn{flex:1 1 auto;min-width:132px;height:44px;border:1px solid var(--accent);border-radius:10px;background:transparent;color:var(--accent);font-size:11.5px;letter-spacing:.1em;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;}
.logbtn:active{background:var(--line);}
.logbtn.is-done{background:var(--accent);border-color:var(--accent);color:#0E1116;}
.skipbtn{flex:0 0 auto;height:44px;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--dim);font-size:11.5px;letter-spacing:.1em;cursor:pointer;}
.skipbtn:active{background:var(--line);}
.skipbtn.is-skipped{border-color:#D7443E;color:#D7443E;}
/* NB: distinct from .restnote, which is the 'Rest until <date>' advisory
   banner further down — same name meant this inherited its gold left border. */
.restcue{flex:1 0 100%;text-align:center;color:var(--dim);font-size:10.5px;letter-spacing:.08em;opacity:.75;}
.pill{margin-left:8px;padding:2px 6px;border-radius:4px;font-size:9px;letter-spacing:.1em;vertical-align:middle;}
.pill-done{background:rgba(63,168,95,.16);color:#3FA85F;}
.pill-skip{background:rgba(215,68,62,.14);color:#D7443E;}
.restored{display:flex;align-items:center;gap:7px;margin:0 0 12px;padding:9px 11px;border:1px solid var(--line);border-left:2px solid var(--accent);border-radius:8px;background:var(--surface2);color:var(--dim);font-size:11px;letter-spacing:.04em;}
.readout{font-size:11.5px;text-align:center;padding:6px 0 0;}
.gauge{margin:10px 0;}
.gauge-label{font-size:10.5px;letter-spacing:.08em;color:var(--dim);margin-bottom:5px;}
.gauge-bar{height:7px;background:var(--surface2);border-radius:4px;overflow:hidden;}
.gauge-fill{height:100%;border-radius:4px;transition:width .3s;}
.optcard{display:block;width:100%;text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:13px 15px;margin-bottom:9px;cursor:pointer;color:var(--text);font-family:inherit;}
.optcard.on{border-color:#E8C547;box-shadow:inset 0 0 0 1px #E8C547;}
.optcard-top{display:flex;justify-content:space-between;align-items:center;color:#E8C547;}
.optcard-name{font-family:'Saira Condensed',sans-serif;font-weight:600;font-size:21px;line-height:1;color:var(--text);}
.optcard.on .optcard-name{color:#E8C547;}
.optcard-sub{display:block;font-size:11px;color:var(--dim);margin-top:5px;letter-spacing:.02em;}
.lmtable{background:var(--surface);border:1px solid var(--line);border-radius:13px;overflow:hidden;margin-bottom:8px;}
.lmtable-head{display:grid;grid-template-columns:1fr 52px 52px 52px;padding:10px 14px;font-size:10px;letter-spacing:.12em;color:var(--dim);border-bottom:1px solid var(--line);}
.lmtable-head span:not(:first-child){text-align:right;}
.lmrow{padding:9px 14px;border-bottom:1px solid var(--line);}
.lmtable .lmrow:last-child{border-bottom:none;}
.lmrow-main{display:grid;grid-template-columns:1fr 52px 52px 52px;align-items:center;font-size:13.5px;}
.lmrow-main span:not(:first-child){text-align:right;}
.lmrow-name{font-size:12.5px;}
.lmdelta{font-style:normal;font-size:9.5px;margin-left:3px;color:#3FA85F;letter-spacing:.02em;}
.lmdelta.dn{color:#D7443E;}
.lmsig{font-size:10px;color:var(--dim);margin-top:5px;letter-spacing:.02em;}
.lmstall{display:flex;align-items:flex-start;gap:6px;font-size:10.5px;color:#E8C547;margin-top:6px;letter-spacing:.02em;line-height:1.4;}
.lmstall svg{flex-shrink:0;margin-top:1px;}
.volrow{margin-bottom:13px;}
.volrow-top{display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px;}
.vol-track{position:relative;height:8px;background:var(--surface2);border-radius:4px;}
.vol-fill{height:100%;border-radius:4px;}
.vol-tick{position:absolute;top:-2px;width:2px;height:12px;background:var(--dim);opacity:.6;}
.vol-cap{position:absolute;top:-3px;width:2px;height:14px;background:#D7443E;opacity:.9;}
.vol-legend{font-size:10px;margin-top:5px;}
.vol-capnote{color:#D7443E;opacity:.9;}
/* Schedule-capacity warning. Amber rather than the red used for MRV overreach:
   this is "you are leaving growth on the table", not "you are digging a hole",
   and colouring the two the same would flatten a distinction the athlete has to
   act on differently. */
.capwarn{padding:12px 14px;margin-top:14px;border-color:rgba(232,197,71,.45);background:rgba(232,197,71,.06);}
.capwarn-head{display:flex;align-items:center;gap:6px;color:#E8C547;font-size:11px;letter-spacing:.1em;margin-bottom:7px;}
.capwarn-lede{font-size:11.5px;line-height:1.5;color:var(--dim);margin:0 0 9px;}
.capwarn-row{display:flex;justify-content:space-between;font-size:11.5px;padding:3px 0;border-top:1px solid rgba(232,197,71,.15);}
.capwarn-gap{color:#E8C547;margin-left:7px;}
.capwarn-fix{font-size:11.5px;line-height:1.5;margin:9px 0 0;padding-top:9px;border-top:1px solid rgba(232,197,71,.15);}
.cappin{padding:12px 14px;margin-top:14px;border-color:rgba(63,168,95,.4);background:rgba(63,168,95,.05);}
.cappin-head{display:flex;align-items:center;gap:6px;color:#3FA85F;font-size:11px;letter-spacing:.1em;margin-bottom:7px;}
.cappin-lede{font-size:11.5px;line-height:1.5;color:var(--dim);margin:0 0 9px;}
.cappin-row{display:flex;justify-content:space-between;font-size:11.5px;padding:3px 0;border-top:1px solid rgba(63,168,95,.15);}
.cappin-fix{font-size:11.5px;line-height:1.5;margin:9px 0 0;padding-top:9px;border-top:1px solid rgba(63,168,95,.15);}
.chart{padding:14px;}
.chart-title{font-size:11px;letter-spacing:.1em;margin-bottom:8px;}
.hist{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:9px;}
.hist-top{display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:7px;}
.hist-lifts{font-size:11.5px;line-height:1.5;}
.hist-trans{font-size:11px;color:#E8C547;margin-top:7px;}
.hist-pr{font-size:11px;color:#E8C547;margin-top:7px;letter-spacing:.04em;}
.hist-coach{font-size:11.5px;color:var(--dim);margin-top:7px;line-height:1.4;font-style:italic;}
.empty{color:var(--dim);font-size:14px;line-height:1.6;padding:40px 6px;text-align:center;}
.tabs{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:460px;display:flex;
  background:rgba(18,20,25,.95);backdrop-filter:blur(10px);border-top:1px solid var(--line);z-index:5;}
.tabs button{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 0 13px;background:none;border:none;color:var(--dim);cursor:pointer;font-family:inherit;font-size:10.5px;}
.tab-on{color:var(--text)!important;}
@media (prefers-reduced-motion:reduce){*{transition:none!important;}}
`;
