#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = join(__dirname, "..");

const EXEMPT_FILES = new Set([
  "src/utils/abmind-lazy.ts",
]);

let failed = false;
let violations = [];

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

const PATTERNS = [
  // Deleted runtime components — must never be imported or constructed
  { re: /DirectApiTransport/, label: "DirectApiTransport (deleted)" },
  { re: /ConversationSession/, label: "ConversationSession (deleted)" },
  // Legacy "direct-api" route — must not appear in production source
  { re: /"direct-api"/, label: '"direct-api" route (deleted)' },
  // Emergency L0 — must not appear in production source
  { re: /createL0Attempt|emergencyCandidate|defaultCreateL0Attempt/, label: "emergency L0 (deleted)" },
  // Runtime imports from abmind internals
  { re: /import\(["']abmind\//, label: "dynamic import from abmind/" },
];

// #1508: the abtars-owned signed WSS client must never import the abmind
// package at runtime — protocol constants are represented locally and
// protected by cross-repository conformance acceptance.
const RUNTIME_ABMIND_IMPORT_RE = /^import\s+[^t]/;

for (const file of walk(scanDir)) {
  if (isExemptFile(file)) continue;
  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isErasedImport(line)) continue;

    for (const { re, label } of PATTERNS) {
      if (re.test(line)) {
        violations.push(`${relative(scanDir, file)}:${i + 1}: ${label}`);
        failed = true;
      }
    }

    const rel = relative(ROOT_DIR, file);
    if (rel === "src/components/abmind-signed-wss-client.ts" && RUNTIME_ABMIND_IMPORT_RE.test(line) && /from ["']abmind/.test(line)) {
      violations.push(`${rel}:${i + 1}: runtime import from abmind (forbidden — remote client is self-contained)`);
      failed = true;
    }
  }
}

for (const v of violations) {
  process.stderr.write(`VIOLATION: ${v}\n`);
}

if (failed) {
  process.stderr.write("\ncheck-imports: FAIL — architecture violations found.\n");
  process.exit(1);
} else {
  process.stdout.write("check-imports: OK — no architecture violations.\n");
}
