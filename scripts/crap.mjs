// CRAP (Change Risk Anti-Patterns) scorer.
//   CRAP(m) = comp(m)^2 * (1 - cov(m))^3 + comp(m)
// Complexity comes from ESLint's `complexity` rule (cyclomatic, per function).
// Coverage comes from Node's built-in V8 coverage (NODE_V8_COVERAGE), merged
// across the test run and measured per function after clipping nested ranges.
//
// Usage:
//   node scripts/crap.mjs            report (top offenders + per-file summary)
//   node scripts/crap.mjs --gate 30  exit 1 when any function scores above 30
//   node scripts/crap.mjs --all      print every function, not just offenders

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Linter } from "eslint";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC_DIR = join(root, "src");
const args = process.argv.slice(2);
const gateAt = args.includes("--gate") ? Number(args[args.indexOf("--gate") + 1]) : null;
const showAll = args.includes("--all");
const TOP_N = 20;

// --- 1. Run the suite under V8 coverage -------------------------------------
const coverageDir = mkdtempSync(join(tmpdir(), "v8-crap-"));
const run = spawnSync(process.execPath, ["--test"], {
  cwd: root,
  env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
  encoding: "utf8",
});
if (run.status !== 0) {
  process.stderr.write(run.stdout + "\n" + run.stderr);
  console.error("Test suite failed; CRAP scoring aborted.");
  process.exit(run.status ?? 1);
}

// --- 2. Merge coverage JSONs: file -> functions with summed range counts -----
const fileFunctions = new Map(); // url -> [{functionName, ranges:[{start,end,count}]}]
for (const name of readdirSync(coverageDir).filter((n) => n.endsWith(".json"))) {
  const { result } = JSON.parse(readFileSync(join(coverageDir, name), "utf8"));
  for (const entry of result) {
    if (!entry.url.startsWith("file://") || !entry.url.includes("/src/")) continue;
    const list = fileFunctions.get(entry.url) ?? [];
    fileFunctions.set(entry.url, list);
    for (const fn of entry.functions ?? []) {
      const key = fn.ranges[0]?.startOffset;
      const existing = list.find(
        (f) => f.functionName === fn.functionName && f.ranges[0]?.startOffset === key,
      );
      if (!existing) {
        list.push({
          functionName: fn.functionName,
          ranges: fn.ranges.map((r) => ({ ...r })),
        });
      } else {
        for (let i = 0; i < fn.ranges.length && i < existing.ranges.length; i++) {
          existing.ranges[i].count += fn.ranges[i].count;
        }
      }
    }
  }
}
rmSync(coverageDir, { recursive: true, force: true });

// --- 3. ESLint complexity per function ---------------------------------------
const linter = new Linter();
const complexityMessages = (code) =>
  linter.verify(code, {
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: { complexity: ["error", 0] },
  });

// offset of (line, column) in UTF-16 code units, matching V8 coverage offsets
const lineOffsets = (code) => {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === "\n") starts.push(i + 1);
  return starts;
};

// --- 4. Join and score -------------------------------------------------------
const rows = [];
for (const file of readdirSync(SRC_DIR).filter((n) => n.endsWith(".js"))) {
  const filePath = join(SRC_DIR, file);
  const code = readFileSync(filePath, "utf8");
  const starts = lineOffsets(code);
  const url = pathToFileURL(filePath).href;
  const v8Fns = fileFunctions.get(url) ?? [];

  // Per-V8-function covered ratio: clip nested function ranges out of the
  // parent's range set, then measure covered bytes over what remains.
  const coverageOf = (fn) => {
    const nested = v8Fns.filter(
      (other) => other !== fn
        && other.ranges[0].startOffset >= fn.ranges[0].startOffset
        && other.ranges[other.ranges.length - 1].endOffset
          <= fn.ranges[fn.ranges.length - 1].endOffset,
    );
    let total = 0;
    let covered = 0;
    for (const range of fn.ranges) {
      let segments = [[range.startOffset, range.endOffset]];
      for (const inner of nested) {
        for (const ir of inner.ranges) {
          segments = segments.flatMap(([s, e]) => {
            if (ir.endOffset <= s || ir.startOffset >= e) return [[s, e]];
            const out = [];
            if (ir.startOffset > s) out.push([s, ir.startOffset]);
            if (ir.endOffset < e) out.push([ir.endOffset, e]);
            return out;
          });
        }
      }
      const size = segments.reduce((sum, [s, e]) => sum + (e - s), 0);
      total += size;
      if (range.count > 0) covered += size;
    }
    return total === 0 ? 0 : covered / total;
  };

  for (const msg of complexityMessages(code)) {
    const match = /complexity of (\d+)/.exec(msg.message);
    if (!match) continue;
    const comp = Number(match[1]);
    const name = /'([^']+)'/.exec(msg.message)?.[1] ?? "(anonymous)";
    const offset = (starts[msg.line - 1] ?? 0) + msg.column - 1;
    // Innermost V8 function containing this position.
    const owner = v8Fns
      .filter((f) => {
        const s = f.ranges[0].startOffset;
        const e = f.ranges[f.ranges.length - 1].endOffset;
        return s <= offset && offset < e;
      })
      .sort((a, b) =>
        (a.ranges[a.ranges.length - 1].endOffset - a.ranges[0].startOffset)
        - (b.ranges[b.ranges.length - 1].endOffset - b.ranges[0].startOffset),
      )[0];
    const cov = owner ? coverageOf(owner) : 0;
    rows.push({
      file: `src/${file}`,
      line: msg.line,
      name,
      comp,
      cov: Math.round(cov * 100) / 100,
      crap: Math.round((comp * comp * (1 - cov) ** 3 + comp) * 10) / 10,
    });
  }
}

rows.sort((a, b) => b.crap - a.crap);

const list = showAll ? rows : rows.filter((r) => r.crap >= 10);
console.log(`CRAP score report — ${rows.length} functions across src/\n`);
console.log(
  `${"CRAP".padStart(6)}  ${"comp".padStart(4)}  ${"cov".padStart(5)}  location`,
);
for (const r of list.slice(0, showAll ? Infinity : TOP_N)) {
  console.log(
    `${String(r.crap).padStart(6)}  ${String(r.comp).padStart(4)}  ${String(r.cov).padStart(5)}  ${r.file}:${r.line} ${r.name}`,
  );
}
if (!showAll && list.length > TOP_N) {
  console.log(`… and ${list.length - TOP_N} more with CRAP >= 10 (use --all)`);
}

if (gateAt != null) {
  const over = rows.filter((r) => r.crap > gateAt);
  if (over.length) {
    console.error(`\n${over.length} function(s) exceed CRAP gate ${gateAt}.`);
    process.exit(1);
  }
  console.log(`\nAll functions under CRAP gate ${gateAt}.`);
}
