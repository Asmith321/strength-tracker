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
import {
  LIB, BLOCKS, EXPERIENCE_TIERS, landmarksForExperience, freshProgram, migrateProgram,
  prescribe, ingest, applyTransition, restDaysForFatigue, deliveredWeekly, maxDeliverable, e1rmFrom,
  PLATES, platesForSide, plateText,
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
   surfaced inline (e.g. "18 ▲1") so the automation is visible, not silent. */
function LandmarkTable({ landmarks, adjustments }) {
  const fmtDelta = (d) => (d > 0 ? `▲${d}` : `▼${Math.abs(d)}`);
  return (
    <div className="lmtable">
      <div className="lmtable-head mono"><span>MUSCLE</span><span>MEV</span><span>MAV</span><span>MRV</span></div>
      {Object.entries(landmarks).map(([p, lm]) => {
        const adj = adjustments?.[p];
        return (
          <div key={p} className="lmrow">
            <div className="lmrow-main">
              <span className="lmrow-name">{lm.label}</span>
              <span className="mono">{lm.mev}{adj?.dMev ? <em className={"lmdelta" + (adj.dMev < 0 ? " dn" : "")}>{fmtDelta(adj.dMev)}</em> : null}</span>
              <span className="mono">{lm.mav}</span>
              <span className="mono">{lm.mrv}{adj?.dMrv ? <em className={"lmdelta" + (adj.dMrv < 0 ? " dn" : "")}>{fmtDelta(adj.dMrv)}</em> : null}</span>
            </div>
            {adj?.signal && <div className="lmsig mono">↳ last auto-tune: {adj.signal}</div>}
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
  const [seeds, setSeeds] = useState({
    squat: { weight: 225, reps: 5, rpe: 8 }, bench: { weight: 155, reps: 5, rpe: 8 }, deadlift: { weight: 275, reps: 5, rpe: 8 },
  });
  const setSeed = (k, f, v) => setSeeds((s) => ({ ...s, [k]: { ...s[k], [f]: v } }));

  if (step === 0) return (
    <div className="screen">
      <div className="eyebrow">SETUP · 1 OF 2</div>
      <h1 className="display">Calibrate the lifts.</h1>
      <p className="lede">Bodyweight drives system-load math for bodyweight lifts (Pull-Up / Chin-Up) — added weight or assistance is tracked relative to it. Enter a recent honest top set for each main lift — weight, reps, and RPE (10 = no reps left, 8 = two left). The engine converts this to an estimated 1RM and prescribes every future load from it, re-reading your e1RM after each session.</p>
      <div className="panel">
        <label className="fieldrow sm"><span>Bodyweight</span><Stepper value={bodyweight} set={setBodyweight} min={80} max={400} step={1} suffix=" lb" /></label>
      </div>
      {["squat", "bench", "deadlift"].map((k) => (
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
      <p className="lede">This seeds your starting weekly-volume landmarks — MEV (minimum effective), MAV (most growth), MRV (most you can recover from) hard sets per pattern. From here the engine auto-tunes them each block from your strength trend and fatigue; you won't set these by hand.</p>
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
      <button className="cta" onClick={() => onDone(freshProgram({ seeds, experience, unit: "lb", goal: "hybrid", bodyweight }))}>Start program</button>
    </div>
  );
}

function ExerciseCard({ it, log, update, barWeight, onRest }) {
  const [open, setOpen] = useState(it.isMain);
  const [warmupOpen, setWarmupOpen] = useState(false);
  const bwScheme = it.assistanceNeeded ? "assistance needed" : it.repOnly ? "bodyweight only"
    : `BW${it.topLoad >= 0 ? "+" : ""}${it.topLoad} lb`;
  const loadScheme = it.bodyweight ? bwScheme
    : it.barbell ? `${it.topLoad} lb — ${plateText(it.topLoad, barWeight)}`
    : `${it.topLoad} lb`;
  const setWord = (n) => (n === 1 ? "set" : "sets");
  /* Unambiguous total-set breakdown for mains: `sets` is the FULL working-set
     count, never top-sets-plus-extra-backoff — see prescribe(). Only the
     first set is at topLoad; the rest (if any) are at the lower backoffLoad. */
  const scheme = it.isMain
    ? (it.backoffSetCount > 0
        ? `${it.topSetCount} ${setWord(it.topSetCount)} @ ${it.topLoad} lb, then ${it.backoffSetCount} ${setWord(it.backoffSetCount)} @ ${it.backoffLoad} lb (${it.reps} reps · RPE ${it.rpe})`
        : `${it.sets} ${setWord(it.sets)} of ${it.reps} @ ${it.topLoad} lb (RPE ${it.rpe})`)
    : `${it.sets} × ${it.reps} @ RPE ${it.rpe} · ${loadScheme}`;
  return (
    <div className="exer">
      <div className="exer-head" onClick={() => setOpen(!open)}>
        <div>
          <div className="exer-name">{it.label}{it.isMain && <span className="tag">MAIN</span>}</div>
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
          <label className="fieldrow sm"><span>{it.bodyweight ? "Added / assist weight" : "Top-set weight"}</span><Stepper value={log.topWeight} set={(v) => update({ topWeight: v })} min={it.bodyweight ? -200 : 0} step={5} suffix=" lb" /></label>
          <label className="fieldrow sm"><span>Top-set reps</span><Stepper value={log.topReps} set={(v) => update({ topReps: v })} min={1} max={15} /></label>
          <label className="fieldrow sm"><span>Top-set RPE</span><Stepper value={log.topRpe} set={(v) => update({ topRpe: v })} min={5} max={10} step={0.5} /></label>
          <label className="fieldrow sm"><span>Sets missed (reps short)</span><Stepper value={log.missedSets} set={(v) => update({ missedSets: v })} min={0} max={it.sets} /></label>
          {it.isMain && it.backoffSetCount > 0 && (
            <>
              <label className="fieldrow sm"><span>Backoff sets — reps (avg)</span><Stepper value={log.backoffReps} set={(v) => update({ backoffReps: v })} min={1} max={20} /></label>
              <label className="fieldrow sm"><span>Backoff sets — RPE (avg)</span><Stepper value={log.backoffRpe} set={(v) => update({ backoffRpe: v })} min={5} max={10} step={0.5} /></label>
            </>
          )}
          {it.bodyweight && <div className="est mono">negative = assistance used</div>}
          {Math.abs(log.topRpe - it.rpe) >= 1 && (
            <div className="warn mono">{log.topRpe > it.rpe ? "harder than target — engine notes fatigue" : "easier than target — e1RM will rise"}</div>
          )}
          <button className="restbtn mono" onClick={() => onRest(it)}><Timer size={13} /> REST {it.isMain ? "3:00" : "1:30"}</button>
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

const fmtSecs = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function Today({ program, sessions, onLog }) {
  const [readiness, setReadiness] = useState({ trainingReadiness: 65 });
  const rx = useMemo(() => prescribe(program, readiness), [program, readiness]);
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [rest, setRest] = useState(null); // { label, left }

  useEffect(() => {
    if (!rest || rest.left <= 0) return;
    const id = setInterval(() => setRest((r) => (r ? { ...r, left: Math.max(0, r.left - 1) } : r)), 1000);
    return () => clearInterval(id);
  }, [rest !== null && rest.left > 0]);

  const startRest = (it) => setRest({ label: it.label, left: it.isMain ? 180 : 90 });
  const nudgeRest = (d) => setRest((r) => (r ? { ...r, left: Math.max(0, r.left + d) } : r));

  useEffect(() => {
    setLogs(rx.items.map((it) => ({ key: it.key, topWeight: it.topLoad, topReps: it.reps, topRpe: it.rpe, targetRpe: it.rpe, missedSets: 0, sets: it.sets, backoffSetCount: it.backoffSetCount, backoffReps: it.reps, backoffRpe: it.rpe, backoffRpeCap: it.backoffRpeCap })));
    // eslint-disable-next-line
  }, [program.sessionCount]);

  useEffect(() => {
    setLogs((L) => L.map((l, i) => (l && l._touched ? l : rx.items[i] ? { key: rx.items[i].key, topWeight: rx.items[i].topLoad, topReps: rx.items[i].reps, topRpe: rx.items[i].rpe, targetRpe: rx.items[i].rpe, missedSets: 0, sets: rx.items[i].sets, backoffSetCount: rx.items[i].backoffSetCount, backoffReps: rx.items[i].reps, backoffRpe: rx.items[i].rpe, backoffRpeCap: rx.items[i].backoffRpeCap } : l)));
    // eslint-disable-next-line
  }, [rx.band]);

  const upd = (i, patch) => setLogs((L) => L.map((l, j) => (j === i ? { ...l, ...patch, _touched: true } : l)));
  const bandColor = rx.band === "green" ? "#3FA85F" : rx.band === "amber" ? "#E8C547" : "#D7443E";

  return (
    <div className="screen">
      <div className="eyebrow">SESSION {program.sessionCount + 1} · {rx.dayName.toUpperCase()}</div>
      <div className="blockrow">
        <span className="phase mono" style={{ borderColor: bandColor }}>{rx.block} · cycle {rx.cycle + 1}</span>
        <span className="mono dim">top RPE {rx.rpeTop}</span>
      </div>

      {program.lastCoach && (
        <div className={"coach " + (program.lastCoach === COACH_OFFLINE_NOTE ? "coach-off " : "") + (program.block.type === "deload" ? "coach-alert" : "")}>
          <div className="coach-top mono">{program.block.type === "deload" ? <AlertTriangle size={12} /> : <Check size={12} />} COACH</div>
          <p>{program.lastCoach}</p>
        </div>
      )}

      {program.lastPRs?.length > 0 && (
        <div className="prnote mono"><Award size={13} /> NEW e1RM {program.lastPRs.length > 1 ? "PRs" : "PR"} — {program.lastPRs.map((k) => LIB[k]?.label || k).join(", ")}</div>
      )}

      {program.lastRestUntil && (
        <div className="restnote mono">
          <Timer size={13} /> Rest until {new Date(program.lastRestUntil).toLocaleDateString("en-US", { month: "long", day: "numeric" })} — advisory only, log anytime
        </div>
      )}

      {rx.items.map((it, i) => logs[i] && <ExerciseCard key={it.key + i} it={it} log={logs[i]} update={(p) => upd(i, p)} barWeight={program.barWeight || 45} onRest={startRest} />)}

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

      {rest && (
        <div className={"resttimer mono" + (rest.left === 0 ? " done" : "")}>
          <Timer size={14} color={rest.left === 0 ? "#3FA85F" : "#8A909C"} />
          <span className="rt-label">{rest.left === 0 ? "REST DONE" : rest.label}</span>
          <span className="rt-time">{fmtSecs(rest.left)}</span>
          <button onClick={() => nudgeRest(-15)}>−15</button>
          <button onClick={() => nudgeRest(15)}>+15</button>
          <button onClick={() => setRest(null)}><X size={14} /></button>
        </div>
      )}
    </div>
  );
}

function Status({ program }) {
  const cyc = program.block.cycle;
  const rows = Object.entries(program.landmarks).map(([p, lm]) => {
    const wk = deliveredWeekly(p, program.block.type, cyc, program.landmarks); // full-muscle sets actually prescribed (mains + fixedSets + ramped)
    const deliverable = maxDeliverable(p, program.block.type);
    const capped = deliverable < lm.mrv;      // group structurally can't reach its own MRV at current exercise counts
    const pctMrv = Math.min(1, wk / lm.mrv);
    const color = wk < lm.mev ? "#9AA0AC" : wk < lm.mav ? "#3FA85F" : wk < lm.mrv ? "#E8C547" : "#D7443E";
    return { p, label: lm.label, wk, lm, pctMrv, color, deliverable, capped };
  });
  return (
    <div className="screen">
      <div className="eyebrow">MESOCYCLE</div>
      <h1 className="display sm">{BLOCKS[program.block.type].label}</h1>
      <p className="lede" style={{ marginBottom: 14 }}>Microcycle {cyc + 1} · emphasis: {BLOCKS[program.block.type].emphasis}. Block length is decided live from your e1RM trend, RPE creep, and readiness — not a fixed calendar.</p>
      <div className="panel" style={{ padding: 14 }}>
        <Gauge value={program.fatigue.index} label={`FATIGUE INDEX  ${program.fatigue.index.toFixed(2)}`} color={program.fatigue.index >= 0.7 ? "#D7443E" : program.fatigue.index >= 0.55 ? "#E8C547" : "#3FA85F"} />
        <Gauge value={0.5 + program.fatigue.slope * 50} label={`e1RM TREND  ${(program.fatigue.slope * 100).toFixed(2)}%/session`} color="#2F6FB0" />
      </div>
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
  const lifts = [["squat", "Squat", "#D7443E"], ["bench", "Bench", "#2F6FB0"], ["deadlift", "Deadlift", "#3FA85F"]];
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
          <div className="hist-lifts mono">{s.logs.map((l) => `${(LIB[l.key]?.label || l.key).split(" ")[0]} ${l.topWeight}×${l.topReps}@${l.topRpe}` + (l.backoffSetCount > 0 ? ` (+${l.backoffSetCount} backoff×${l.backoffReps}@${l.backoffRpe})` : "")).join("  ·  ")}</div>
          {s.prs?.length > 0 && <div className="hist-pr mono">★ e1RM PR — {s.prs.map((k) => LIB[k]?.label || k).join(", ")}</div>}
          {s.transition && <div className="hist-trans mono">→ {BLOCKS[s.transition]?.label || s.transition}</div>}
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
    /* Normalize the UI's internal _touched marker into an explicit `touched`
       boolean for the engine: untouched entries are the prescription echoed
       back, and ingest() excludes them from e1RM/trend/PR math (they still
       count for adherence + fatigue bookkeeping). */
    const ingestLogs = logs.map((l) => ({ ...l, touched: !!l._touched }));
    const { next, transition, fatigueIndex, e1rmSlope, rScore, prs } = ingest(program, ingestLogs, readiness);
    const recent = [
      { block: rx.block, fatigue: +fatigueIndex.toFixed(2),
        lifts: logs.filter((l) => LIB[l.key]?.role === "main").map((l) => ({ lift: l.key, w: l.topWeight, reps: l.topReps, rpe: l.topRpe, target: l.targetRpe, missed: l.missedSets })),
        trainingReadiness: readiness.trainingReadiness },
      ...sessions.slice(-4).reverse().map((s) => ({ block: s.block, lifts: s.logs.filter((l) => LIB[l.key]?.role === "main").map((l) => ({ lift: l.key, w: l.topWeight, reps: l.topReps, rpe: l.topRpe })) })),
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
    const restDays = restDaysForFatigue(fatigueIndex);
    finalProgram.lastRestUntil = Date.now() + restDays * 86400000;

    const record = {
      date: Date.now(), block: rx.block, dayName: rx.dayName,
      logs: logs.map((l) => ({ key: l.key, topWeight: l.topWeight, topReps: l.topReps, topRpe: l.topRpe, missedSets: l.missedSets,
        backoffSetCount: l.backoffSetCount || 0, backoffReps: l.backoffReps, backoffRpe: l.backoffRpe, touched: !!l._touched })),
      readiness, coach: coach.note, transition: appliedTransition, prs: prs.length ? prs : null,
    };
    const newSessions = [...sessions, record];
    setProgram(finalProgram); setSessions(newSessions);
    // Check the write: if it fails, surface a save error rather than silently
    // proceeding as though the session was safely logged.
    await persist(finalProgram, newSessions);
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
              <LandmarkTable landmarks={program.landmarks} adjustments={program.landmarkAdjustments} />
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
.root{--bg:#121419;--surface:#1A1D24;--surface2:#22262F;--line:#2E333D;--text:#E6E8EC;--dim:#8A909C;
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
.restbtn{width:100%;height:44px;margin-top:12px;border:1px solid var(--line);border-radius:10px;background:var(--surface2);color:var(--dim);font-size:11.5px;letter-spacing:.1em;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;}
.restbtn:active{background:var(--line);}
.resttimer{position:fixed;bottom:72px;left:50%;transform:translateX(-50%);width:calc(100% - 28px);max-width:432px;display:flex;align-items:center;gap:8px;background:var(--surface2);border:1px solid var(--line);border-radius:12px;padding:6px 10px;z-index:6;font-size:12px;box-shadow:0 8px 22px rgba(0,0,0,.45);}
.rt-label{flex:1;color:var(--dim);font-size:10.5px;letter-spacing:.08em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-transform:uppercase;}
.rt-time{font-size:17px;font-weight:500;min-width:48px;text-align:center;}
.resttimer.done .rt-time{color:#3FA85F;}
.resttimer button{min-width:44px;height:44px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--text);cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:11px;display:flex;align-items:center;justify-content:center;}
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
.volrow{margin-bottom:13px;}
.volrow-top{display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px;}
.vol-track{position:relative;height:8px;background:var(--surface2);border-radius:4px;}
.vol-fill{height:100%;border-radius:4px;}
.vol-tick{position:absolute;top:-2px;width:2px;height:12px;background:var(--dim);opacity:.6;}
.vol-cap{position:absolute;top:-3px;width:2px;height:14px;background:#D7443E;opacity:.9;}
.vol-legend{font-size:10px;margin-top:5px;}
.vol-capnote{color:#D7443E;opacity:.9;}
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
