/* Per-day warmup + prescription report, plus the exercise→volumeGroup mapping
   table. Used to prove the classification-system consolidation changes NO
   actual prescription: run before and after the refactor and diff the output.
   Bundles the real engine out of src/App.jsx (same approach as stress_test.mjs). */
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(ROOT, "warmup_report_engine.mjs");
const SRC = join(ROOT, "src", "App.jsx");
const shim = join(ROOT, "src", ".App_report_shim.jsx");
const body = readFileSync(SRC, "utf8").replace(/^import cloudStorage.*from "\.\/storage\.js";\s*$/m, "")
  + `\nexport { freshProgram, prescribe, applyTransition, ingest, LIB, ROTATION, BLOCKS, PATTERNS };\n`;
writeFileSync(shim, body);
try {
  execFileSync(join(ROOT, "node_modules", ".bin", "esbuild"),
    [shim, "--bundle", "--format=esm", "--loader:.jsx=jsx",
      "--external:react", "--external:react-dom", "--external:recharts", "--external:lucide-react",
      `--outfile=${BUNDLE}`], { stdio: "pipe" });
} finally { rmSync(shim, { force: true }); }

const { freshProgram, prescribe, LIB, ROTATION, PATTERNS } = await import("./warmup_report_engine.mjs?t=" + Date.now());

const seeds = { squat: { weight: 315, reps: 5, rpe: 8 }, bench: { weight: 225, reps: 5, rpe: 8 }, deadlift: { weight: 405, reps: 5, rpe: 8 } };

// Fixed program; iterate every rotation day and a few block types so every
// warmup branch (full/short/minimal, feeler, primed reductions) is exercised.
function report(blockType) {
  const lines = [];
  for (let day = 0; day < ROTATION.length; day++) {
    const p = freshProgram({ seeds, experience: "intermediate", unit: "lb", goal: "strength", bodyweight: 200 });
    p.cycleIndex = day;
    p.block = { type: blockType, cycle: 1, sessionsInBlock: day, nextAfter: null };
    const rx = prescribe(p, { trainingReadiness: 75 });
    lines.push(`  DAY ${day} "${ROTATION[day].name}":`);
    for (const it of rx.items) {
      const w = it.warmup ? `${it.warmup.type}(${(it.warmup.sets || []).map((s) => `${s.weight}x${s.reps}`).join(",")})` : "—";
      lines.push(`    ${it.key.padEnd(15)} sets=${it.sets} reps=${it.reps} rpe=${it.rpe} top=${it.topLoad} bo=${it.backoffLoad} warmup=${w}`);
    }
  }
  return lines.join("\n");
}

console.log("==== EXERCISE → VOLUME GROUP ====");
const groups = new Set();
for (const [k, L] of Object.entries(LIB)) {
  const vg = L.volumeGroup || L.pattern;
  groups.add(vg);
  console.log(`  ${k.padEnd(16)} -> ${vg}`);
}
console.log(`  TOTAL DISTINCT VOLUME GROUPS: ${groups.size}  [${[...groups].sort().join(", ")}]`);
console.log(`  LANDMARK GROUPS (PATTERNS): ${Object.keys(PATTERNS).length}  [${Object.keys(PATTERNS).sort().join(", ")}]`);

for (const bt of ["accumulation", "intensification", "deload", "realization"]) {
  console.log(`\n==== PRESCRIPTION REPORT · block=${bt} ====`);
  console.log(report(bt));
}
rmSync(BUNDLE, { force: true });
