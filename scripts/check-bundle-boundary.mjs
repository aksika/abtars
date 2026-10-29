#!/usr/bin/env node
/**
 * check-bundle-boundary.mjs — artifact guard: no @earendil-works implementation
 * module may ship inside the published bundle.
 *
 * esbuild emits a sourcemap for every chunk, and any module inlined into the
 * bundle appears in a map's `sources` array. Production source must only ever
 * type-import @earendil-works packages (their implementations resolve at
 * runtime from the installed pi CLI), so a source path containing
 * `@earendil-works/` in any emitted map is a boundary violation. #1746: pi-ai
 * code previously shipped inlined because a static value import survived into
 * the build.
 *
 * Fails loudly when bundle/ is absent or contains no maps — an invocation
 * with nothing to inspect is an error, never a silent pass.
 *
 * Usage:
 *   node scripts/check-bundle-boundary.mjs
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const BUNDLE_DIR = join(ROOT_DIR, "bundle");

const FORBIDDEN = "@earendil-works/";

if (!existsSync(BUNDLE_DIR)) {
  process.stderr.write(
    "check-bundle-boundary: FAIL — bundle/ does not exist. Run `npm run bundle` first.\n",
  );
  process.exit(1);
}

const violations = [];
let mapCount = 0;

function checkMap(mapPath) {
  let map;
  try {
    map = JSON.parse(readFileSync(mapPath, "utf-8"));
  } catch (cause) {
    violations.push(
      `${relative(ROOT_DIR, mapPath)}: unparsable sourcemap (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    return;
  }
  const sources = Array.isArray(map.sources) ? map.sources : [];
  for (const source of sources) {
    if (typeof source === "string" && source.includes(FORBIDDEN)) {
      const chunk = mapPath.replace(/\.map$/, "");
      violations.push(
        `${relative(ROOT_DIR, mapPath)}: source ${source} (imported into ${relative(ROOT_DIR, chunk)})`,
      );
    }
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name.endsWith(".map")) {
      mapCount++;
      checkMap(full);
    }
  }
}

walk(BUNDLE_DIR);

if (mapCount === 0) {
  process.stderr.write(
    "check-bundle-boundary: FAIL — no sourcemaps found under bundle/. A build without maps cannot be inspected.\n",
  );
  process.exit(1);
}

for (const violation of violations) {
  process.stderr.write(`VIOLATION: ${violation}\n`);
}

if (violations.length > 0) {
  process.stderr.write("\ncheck-bundle-boundary: FAIL — @earendil-works implementation code found in the bundle.\n");
  process.exit(1);
} else {
  process.stdout.write("check-bundle-boundary: OK — no @earendil-works sources in any bundle sourcemap.\n");
}