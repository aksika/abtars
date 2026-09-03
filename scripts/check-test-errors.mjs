#!/usr/bin/env node
/**
 * Baseline-pinned guard for test-file type errors (#1742).
 *
 * Runs `tsc -p tsconfig.test.json --noEmit`, groups errors by file, and
 * compares against `check-test-errors.baseline.json` (frozen per-file counts).
 * Existing debt may shrink, but adding an error in a file requires fixing the
 * test rather than raising the baseline. Parallel to check-async-promises.mjs
 * so agents already know the workflow: `--write-baseline` ratchets the pin
 * down (and warns if it would increase any file).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const BASELINE_PATH = resolve(SCRIPT_DIR, "check-test-errors.baseline.json");
const WRITE_BASELINE = process.argv.slice(2).includes("--write-baseline");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--write-baseline");

if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument(s): ${unknownArguments.join(", ")}`);
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    if (WRITE_BASELINE) return { files: {} };
    throw new Error(`Baseline is missing: ${relative(REPO_ROOT, BASELINE_PATH)}`);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch (error) {
    throw new Error(`Baseline is unreadable: ${relative(REPO_ROOT, BASELINE_PATH)}`, { cause: error });
  }

  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    throw new Error("Baseline must be a JSON object");
  }
  if (!baseline.files || typeof baseline.files !== "object" || Array.isArray(baseline.files)) {
    throw new Error("Baseline must contain a files object");
  }

  for (const [filePath, count] of Object.entries(baseline.files)) {
    if (!filePath || !Number.isInteger(count) || count < 0) {
      throw new Error(`Baseline entry is invalid: ${filePath}`);
    }
  }

  return baseline;
}

function relativeFilePath(filePath) {
  return relative(REPO_ROOT, filePath).split("\\").join("/");
}

/** Run the test typecheck and group errors by file. Returns { counts, lines }. */
function collectErrors() {
  const result = spawnSync("npx", ["tsc", "-p", "tsconfig.test.json", "--noEmit"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const lines = (stdout + stderr).split("\n").filter((line) => line.includes("error TS"));
  const counts = {};
  const sampleByFile = {};
  for (const line of lines) {
    const match = /^([^(]+)\((\d+),(\d+)\): error TS(\d+)/.exec(line);
    if (!match) continue;
    const filePath = relativeFilePath(match[1].trim());
    counts[filePath] = (counts[filePath] ?? 0) + 1;
    if (!sampleByFile[filePath]) sampleByFile[filePath] = line.trim();
  }
  return { counts, sampleByFile, total: lines.length };
}

function writeBaseline(counts) {
  const files = Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
  const baseline = {
    _comment:
      "Existing test-file typecheck debt, frozen by #1742. May shrink, never grow. A baseline increase is a review red flag; fix the test, do not raise the baseline.",
    _recorded: new Date().toISOString().slice(0, 10),
    files,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  return Object.values(files).reduce((total, count) => total + count, 0);
}

function main() {
  const baseline = readBaseline();
  const { counts, sampleByFile, total } = collectErrors();
  const failures = [];

  for (const [filePath, currentCount] of Object.entries(counts)) {
    const baselineCount = baseline.files[filePath] ?? 0;
    if (currentCount > baselineCount) {
      failures.push(
        `${filePath}: ${currentCount} error(s) exceed baseline ${baselineCount} (${sampleByFile[filePath]}); fix the test instead of raising the baseline`,
      );
    }
  }

  if (WRITE_BASELINE) {
    const increasedFiles = Object.entries(counts).filter(
      ([filePath, count]) => count > (baseline.files[filePath] ?? 0),
    );
    if (increasedFiles.length > 0) {
      console.error(
        `WARNING: --write-baseline would increase ${increasedFiles.length} baseline file(s); review and fix the new errors before committing the baseline.`,
      );
    }
    const pinnedTotal = writeBaseline(counts);
    console.log(`check-test-errors: baseline written (${pinnedTotal} error(s)).`);
    return;
  }

  for (const [filePath, baselineCount] of Object.entries(baseline.files)) {
    const currentCount = counts[filePath] ?? 0;
    if (currentCount < baselineCount) {
      console.log(
        `NOTICE: ${filePath} is below its baseline (${currentCount}/${baselineCount}); run node scripts/check-test-errors.mjs --write-baseline to ratchet it down.`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("check-test-errors: FAILED — test typecheck increased in the following files:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(`check-test-errors: OK — baseline pinned at ${total} error(s).`);
}

try {
  main();
} catch (error) {
  console.error(`check-test-errors: FAILED — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}