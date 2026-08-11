/**
 * result-writer.ts — #1528 matrix/JUnit writers and bounded failure-artifact
 * copying. Artifacts land in a repository-local ignored directory; only
 * sanitized files are copied from disposable fixture roots.
 */

import { mkdirSync, writeFileSync, copyFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute, basename } from "node:path";
import type { PiAcceptanceMatrixV1, PiLaneResult, PiScenarioResult, ProviderSummary } from "./contracts.js";

const RESULT_ROOT = "test-results/pi-production-e2e";
const ARTIFACT_COPY_BOUND = 4 * 1024 * 1024;

export interface ArtifactWriterOptions {
  repoRoot: string;
  runId: string;
}

export class ResultWriter {
  readonly runId: string;
  private resultDir: string;
  private repoRoot: string;
  private failureArtifacts: string[] = [];

  constructor(opts: ArtifactWriterOptions) {
    this.runId = opts.runId;
    this.repoRoot = opts.repoRoot;
    this.resultDir = validateResultDir(opts.repoRoot, this.runId);
    mkdirSync(this.resultDir, { recursive: true });
  }

  get relativeDirectory(): string {
    return relative(this.repoRoot, this.resultDir);
  }

  writeMatrix(matrix: PiAcceptanceMatrixV1): void {
    const path = join(this.resultDir, "matrix.json");
    writeFileSync(path, JSON.stringify(matrix, null, 2), "utf-8");
  }

  writeJunit(matrix: PiAcceptanceMatrixV1): void {
    const suites = matrix.lanes.map((lane) => this.laneSuite(lane)).join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="pi-production-e2e" tests="${totalTests(matrix)}" failures="${totalFailures(matrix)}" time="${(matrix.durationMs / 1000).toFixed(2)}">
${suites}
</testsuites>
`;
    writeFileSync(join(this.resultDir, "junit.xml"), xml, "utf-8");
  }

  writeProviderSummaries(summaries: ProviderSummary[], laneName?: string): void {
    const name = laneName ? sanitizeName(laneName) : "lane";
    const path = join(this.resultDir, `${name}-provider-summaries.json`);
    writeFileSync(path, JSON.stringify({ lane: name, summaries }, null, 2), "utf-8");
  }

  /** Copy a bounded, sanitized set of failure artifacts from a fixture root. */
  copyFailureArtifacts(lane: string, stage: string, fixtureLogDirs: string[]): void {
    const targetDir = join(this.resultDir, "artifacts", sanitizeName(lane), stage);
    mkdirSync(targetDir, { recursive: true });
    for (const dir of fixtureLogDirs) {
      this.copyBoundedDir(dir, targetDir);
    }
    this.failureArtifacts.push(targetDir);
  }

  private copyBoundedDir(srcDir: string, targetDir: string): void {
    if (!existsSync(srcDir)) return;
    let total = 0;
    for (const entry of readdirSync(srcDir)) {
      const src = join(srcDir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(src);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (total >= ARTIFACT_COPY_BOUND) break;
      // Skip databases and key-shaped files — never copy secrets or bulk data.
      if (/(\.db$|\.pem$|\.key$|secret)/i.test(entry)) continue;
      const target = join(targetDir, `${basename(srcDir)}-${entry}`);
      copyFileSync(src, target);
      total += stat.size;
    }
  }

  private laneSuite(lane: PiLaneResult): string {
    const scenarios = lane.scenarios.map((s) => this.scenarioCase(s)).join("\n");
    const failures = lane.scenarios.filter((s) => s.state === "failed").length;
    const blocked = lane.state === "blocked";
    return `  <testsuite name="${escapeXml(lane.lane)}" tests="${lane.scenarios.length}" failures="${blocked ? 1 : failures}" time="0">
    ${blocked ? `    <testcase name="lane-blocked" time="0"><failure message="${escapeXml(lane.blockedBy ?? "blocked")}">${escapeXml(lane.blockedBy ?? "blocked")}</failure></testcase>` : ""}
${scenarios}
  </testsuite>`;
  }

  private scenarioCase(s: PiScenarioResult): string {
    const name = `${s.name} [${s.lane}]`;
    const time = (s.durationMs / 1000).toFixed(2);
    if (s.state === "passed") {
      return `    <testcase classname="pi-production-e2e.${escapeXml(s.lane)}" name="${escapeXml(name)}" time="${time}"/>`;
    }
    const message = s.failure ? `${s.failure.code}: ${s.failure.message}` : s.state;
    return `    <testcase classname="pi-production-e2e.${escapeXml(s.lane)}" name="${escapeXml(name)}" time="${time}"><failure message="${escapeXml(message)}">${escapeXml(message)}</failure></testcase>`;
  }
}

function validateResultDir(repoRoot: string, runId: string): string {
  const dir = resolve(repoRoot, RESULT_ROOT, runId);
  const rel = relative(resolve(repoRoot), dir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Result directory escapes repository root: ${dir}`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) {
    throw new Error(`runId contains unsafe characters: ${runId}`);
  }
  return dir;
}

function totalTests(matrix: PiAcceptanceMatrixV1): number {
  return matrix.lanes.reduce((acc, l) => acc + (l.state === "blocked" ? 1 : l.scenarios.length), 0);
}

function totalFailures(matrix: PiAcceptanceMatrixV1): number {
  return matrix.lanes.reduce((acc, l) => {
    if (l.state === "blocked") return acc + 1;
    return acc + l.scenarios.filter((s) => s.state === "failed").length;
  }, 0);
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
