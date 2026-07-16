#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = join(__dirname, "..");

const EXEMPT_FILES = new Set([
  "src/utils/abmind-lazy.ts",
]);

function isSourceFile(name) {
  return name.endsWith(".ts");
}

function isIgnoredDir(name) {
  return name === "node_modules" || name.startsWith(".");
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isIgnoredDir(entry.name)) continue;
      yield* walk(full);
    } else if (isSourceFile(entry.name)) {
      yield full;
    }
  }
}

function isErasedImport(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("import type ") ||
    trimmed.startsWith('import type "') ||
    trimmed.startsWith("import type '")
  );
}

function isExemptFile(filePath) {
  const rel = relative(ROOT_DIR, filePath);
  return EXEMPT_FILES.has(rel);
}

const scanDir = process.argv[2] ? join(ROOT_DIR, process.argv[2]) : join(ROOT_DIR, "src");

const staticRe = /(?:^|\s)(?:from\s+)["']abmind\/([^"']+)["']/;
const dynamicImportRe = /import\(["']abmind\/([^"']+)["']\)/;

let failed = false;
let violations = [];

for (const file of walk(scanDir)) {
  if (isExemptFile(file)) continue;
  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isErasedImport(line)) continue;

    const staticMatch = staticRe.exec(line);
    if (staticMatch) {
      violations.push(`${relative(scanDir, file)}:${i + 1}: static import from abmind/${staticMatch[1]}`);
      failed = true;
    }

    const dynamicMatch = dynamicImportRe.exec(line);
    if (dynamicMatch) {
      violations.push(`${relative(scanDir, file)}:${i + 1}: dynamic import from abmind/${dynamicMatch[1]}`);
      failed = true;
    }
  }
}

for (const v of violations) {
  process.stderr.write(`VIOLATION: ${v}\n`);
}

if (failed) {
  process.stderr.write("\ncheck-imports: FAIL — runtime imports from abmind/* are prohibited.\n");
  process.exit(1);
} else {
  process.stdout.write("check-imports: OK — no runtime imports from abmind/*.\n");
}
