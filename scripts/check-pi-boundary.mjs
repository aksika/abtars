#!/usr/bin/env node
/**
 * check-pi-boundary.mjs — AST-aware guard: production source may only ever
 * type-import @earendil-works packages. Their implementations resolve at
 * runtime from the installed pi CLI through loadPiModule(); a static value
 * import lets esbuild inline the devDependency copy into the published bundle
 * ahead of the installation the catalog resolves through (#1746).
 *
 * A line-based regex cannot classify multi-line `import type { ... }` blocks
 * whose closing `} from "@earendil-works/pi-ai";` line does not start with
 * `import type`. This walker reads the TypeScript AST instead.
 *
 * Rules:
 *  - skip `src/tests/`, `src/test-support/`, `*.test.ts`, `*.spec.ts`;
 *  - flag any @earendil-works ImportDeclaration that survives to runtime:
 *    a default or namespace binding, a side-effect import, or a named
 *    binding without an inline `type` modifier inside a value import
 *    (an import whose bindings are all inline-type is fully erased and
 *    stays clean);
 *  - never flag string literals that merely contain a package name;
 *  - no exemptions: the baseline is zero violations.
 *
 * Usage:
 *   node scripts/check-pi-boundary.mjs
 *   node scripts/check-pi-boundary.mjs <dir>
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = join(__dirname, "..");

const scanArg = process.argv[2];
const scanDir = scanArg
  ? isAbsolute(scanArg) ? resolve(scanArg) : join(ROOT_DIR, scanArg)
  : join(ROOT_DIR, "src");

const EAREANDIL_PREFIX = "@earendil-works/";

function isIgnoredDir(name) {
  return name === "node_modules" || name === "dist" || name === "bundle" || name.startsWith(".");
}

function isExcludedFile(relPath) {
  if (relPath.startsWith("src/tests/")) return true;
  if (relPath.startsWith("src/test-support/")) return true;
  if (relPath.endsWith(".test.ts") || relPath.endsWith(".spec.ts")) return true;
  return false;
}

function isEarendilImport(node) {
  const spec = node.moduleSpecifier;
  return spec !== undefined && ts.isStringLiteral(spec) && spec.text.startsWith(EAREANDIL_PREFIX);
}

/**
 * True when the declaration is not fully erased at compile time — a runtime
 * binding from an @earendil-works package enters the import graph.
 */
function hasRuntimeBinding(node) {
  const clause = node.importClause;
  if (!clause) return true; // side-effect import
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true; // default import
  const bindings = clause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings)) return true; // import * as X
  return bindings.elements.some((el) => !el.isTypeOnly);
}

/** Check one source text; exported for the boundary test's fixture exercise. */
export function checkPiBoundarySource(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  const found = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) && isEarendilImport(node) && hasRuntimeBinding(node)) {
      const spec = node.moduleSpecifier;
      found.push({
        file: fileName,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        specifier: spec !== undefined && ts.isStringLiteral(spec) ? spec.text : "unknown",
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

let failed = false;
const violations = [];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isIgnoredDir(entry.name)) continue;
      yield* walk(full);
    } else if (entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

// Only run the scan when executed as a script; the checker is also imported
// by pi-boundary.test.ts for fixture exercises and must not exit the test
// process as a side effect.
function main() {
  for (const file of walk(scanDir)) {
    const relPath = relative(ROOT_DIR, file);
    if (isExcludedFile(relPath)) continue;
    const sourceText = readFileSync(file, "utf-8");
    for (const violation of checkPiBoundarySource(sourceText, file)) {
      violations.push(violation);
      failed = true;
    }
  }

  violations.sort((a, b) => {
    const ra = relative(ROOT_DIR, a.file);
    const rb = relative(ROOT_DIR, b.file);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a.line - b.line;
  });

  for (const violation of violations) {
    process.stderr.write(
      `VIOLATION: ${relative(ROOT_DIR, violation.file)}:${violation.line}: non-type import of ${violation.specifier}\n`,
    );
  }

  if (failed) {
    process.stderr.write("\ncheck-pi-boundary: FAIL — @earendil-works runtime imports found in production source.\n");
    process.exit(1);
  } else {
    process.stdout.write("check-pi-boundary: OK — no @earendil-works runtime imports in production source.\n");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}