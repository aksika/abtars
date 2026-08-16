#!/usr/bin/env node
/**
 * check-silent-catches.mjs — syntax-aware guard for undocumented empty catch
 * blocks and empty Promise rejection callbacks in production TypeScript.
 *
 * A silent handler is allowed only when its body contains a line/block comment
 * (semantic adequacy is judged by review, not by this scanner). Everything else
 * is a violation reported with a repository-relative path and one-based line.
 *
 * Usage:
 *   node scripts/check-silent-catches.mjs            # scan <repo>/src
 *   node scripts/check-silent-catches.mjs <path>     # absolute or repo-relative root
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

function isSourceFile(name) {
  return name.endsWith(".ts");
}

function isIgnoredDir(name) {
  return name === "node_modules" || name === "dist" || name === "bundle" || name.startsWith(".");
}

function isExcludedFile(relPath) {
  if (relPath.startsWith("src/tests/")) return true;
  if (relPath.startsWith("src/test-support/")) return true;
  if (relPath.endsWith(".test.ts") || relPath.endsWith(".spec.ts")) return true;
  return false;
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

/** True when the token stream between `node.pos` and `node.end` contains a comment. */
function hasCommentTrivia(node, sourceFile) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /*skipTrivia*/ false,
    ts.LanguageVariant.Standard,
    sourceFile.text,
    /*onError*/ undefined,
    node.pos,
    node.end - node.pos,
  );
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      return true;
    }
    token = scanner.scan();
  }
  return false;
}

function isUndocumentedEmptyCatch(node, sourceFile) {
  return node.block.statements.length === 0 && !hasCommentTrivia(node.block, sourceFile);
}

/** Recognizes a property-access call named `catch`; never an unrelated identifier. */
function isCatchPropertyCall(expression) {
  return ts.isPropertyAccessExpression(expression) && expression.name.text === "catch";
}

function isUndocumentedEmptyPromiseCatch(node, sourceFile) {
  if (!isCatchPropertyCall(node.expression)) return false;
  const handler = node.arguments[0];
  if (!handler) return false;
  if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return false;
  if (!ts.isBlock(handler.body)) return false;
  return handler.body.statements.length === 0 && !hasCommentTrivia(handler.body, sourceFile);
}

function checkFile(sourceFile, filePath) {
  const found = [];
  function visit(node) {
    if (ts.isCatchClause(node) && isUndocumentedEmptyCatch(node, sourceFile)) {
      found.push({
        file: filePath,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        label: "undocumented empty catch block",
      });
    }
    if (ts.isCallExpression(node) && isUndocumentedEmptyPromiseCatch(node, sourceFile)) {
      found.push({
        file: filePath,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        label: "undocumented empty Promise catch callback",
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

let failed = false;
const violations = [];

for (const file of walk(scanDir)) {
  const relPath = relative(ROOT_DIR, file);
  if (isExcludedFile(relPath)) continue;
  const sourceText = readFileSync(file, "utf-8");
  const sourceFile = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  for (const violation of checkFile(sourceFile, file)) {
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
    `VIOLATION: ${relative(ROOT_DIR, violation.file)}:${violation.line}: ${violation.label}\n`,
  );
}

if (failed) {
  process.stderr.write("\ncheck-silent-catches: FAIL — undocumented silent failure handlers found.\n");
  process.exit(1);
} else {
  process.stdout.write("check-silent-catches: OK — no undocumented silent failure handlers.\n");
}