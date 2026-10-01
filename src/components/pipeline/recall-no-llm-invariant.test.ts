/**
 * recall-no-llm-invariant.test.ts — #1894 grep invariant.
 *
 * Ambient auto-recall (query preparation in this directory plus the bridge
 * recall block in prompt-builder.ts) is translation-free and LLM-free: a
 * skipped, searched, or check-failed turn must never reach a model call. This
 * test enforces that — it greps the pipeline directory and fails if an LLM
 * entry point is introduced into ambient query preparation, including
 * indirectly through a helper (a direct-call scan of prompt-builder.ts alone
 * would miss that).
 *
 * Allowed: System One post-MMR rerank lives in abmind and never participates
 * in the skip verdict; embedding stages run inside full recall as before.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PIPELINE_DIR = join(process.cwd(), "src", "components", "pipeline");

/** Walk .ts files, excluding tests and type declarations. */
function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

function strippedCode(file: string): string {
  return readFileSync(file, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("ambient recall is translation-free and LLM-free (#1894)", () => {
  it("no model-call entry point in ambient query preparation", () => {
    const violations: string[] = [];
    for (const file of walkTsFiles(PIPELINE_DIR)) {
      const rel = relative(process.cwd(), file);
      const code = strippedCode(file);
      const hits: string[] = [];
      if (/\bdispatchBackground\s*\(/.test(code)) hits.push("dispatchBackground()");
      if (/\btranslateRecallTerms\b/.test(code)) hits.push("translateRecallTerms");
      if (/\bneedsTranslation\b/.test(code)) hits.push("needsTranslation");
      if (/\bspin\s*\(\s*\{/.test(code)) hits.push("spin()");
      if (/\.sendPrompt\s*\(/.test(code)) hits.push(".sendPrompt()");
      if (/(?:runtime|subagent|runtimeRef|agentRuntime)\.complete\s*\(/.test(code)) hits.push("caller-turn .complete()");
      if (hits.length > 0) violations.push(`${rel}: LLM entry reachable from ambient recall: ${hits.join(", ")}`);
    }
    expect(violations).toEqual([]);
  });
});
