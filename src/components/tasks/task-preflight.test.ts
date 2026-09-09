import { describe, it, expect } from "vitest";
import { preflightTask, validateReportArtifact, captureReportArtifact, REPORT_CAPTURE_MAX_BYTES } from "./task-preflight.js";
import { getToolDescriptor } from "../transport/tool-registry.js";
import type { ScheduledTask } from "./task-types.js";
import type { ToolExecutionScope } from "./task-package.js";
import { currentTestSandbox } from "../../test-support/runtime-isolation.js";
import { localDate } from "../../utils/date.js";
import { writeFileSync, mkdirSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";

function makeReportEntry(id: string, tools: string[]): ScheduledTask & { kind: "agent" } {
  return {
    id,
    kind: "agent",
    prompt: "run the report",
    agent: "task",
    interaction: { mode: "oneshot" },
    delivery: "report",
    chatId: "1",
    schedule: "* * * * *",
    enabled: true,
    priority: "medium",
    orchestration: { maxAgents: 1 },
    report: {
      artifact: `Daily-Briefing-{today}.md`,
      requiredSections: ["# Daily Briefing"],
      minBytes: 100,
      requires: { files: [], executables: [], tools },
    },
  };
}

function makeScope(id: string): ToolExecutionScope {
  const workspace = join(currentTestSandbox().abtarsHome, "workspace", id);
  return { cwd: workspace, env: { WORKSPACE: workspace, PATH: "/usr/bin:/bin" } };
}

describe("report contract {today} substitution (#1592)", () => {
  /* Regression: finance-daily/daily-ai/weekly-ai declare requiredSections like
   * "# Daily Briefing — {today}". resolvePath substituted {today} for the
   * artifact path but not for the headings, so validateReportArtifact compared
   * the report against a literal "{today}" and rejected correct reports with
   * required_heading_missing (Molty runs 2026-08-02, 2026-08-05). */
  it("accepts a report whose dated heading matches, and still rejects a missing heading", () => {
    const entry = makeReportEntry("today-sub", ["execute_bash"]);
    entry.report!.requiredSections = ["# Daily Briefing — {today}", "## Stats"];

    const preflight = preflightTask(entry, makeScope("today-sub"), { getToolDescriptor });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok || !preflight.report) return;

    const contract = preflight.report;
    expect(contract.requiredSections[0]).toBe(`# Daily Briefing — ${localDate()}`);
    expect(contract.artifactPath).toContain(localDate());

    const body = `# Daily Briefing — ${localDate()}\n\n## Stats\n${"filler line\n".repeat(20)}`;
    writeFileSync(contract.artifactPath, body, "utf-8");

    const accepted = validateReportArtifact(contract.artifactPath, preflight.artifactBaseline, contract, Date.now(), entry.id);
    expect(accepted.ok).toBe(true);

    writeFileSync(contract.artifactPath, `# Daily Briefing — ${localDate()}\n${"filler line\n".repeat(20)}`, "utf-8");
    const rejected = validateReportArtifact(contract.artifactPath, preflight.artifactBaseline, contract, Date.now(), entry.id);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("required_heading_missing");
  });
});

describe("preflightTask tool verification (#1535)", () => {
  it("passes when the required tool is registered in the real registry", () => {
    const result = preflightTask(makeReportEntry("t1", ["execute_bash"]), makeScope("t1"), { getToolDescriptor });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report?.tools.map(t => t.name)).toContain("execute_bash");
    }
  });

  it("fails with required_tool_unregistered when the tool is not registered", () => {
    const result = preflightTask(makeReportEntry("t2", ["web_browse"]), makeScope("t2"), { getToolDescriptor });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("required_tool_unregistered");
      expect(result.safeDetail).toContain("web_browse");
    }
  });

  it("fails with the registry-unavailable contract when no registry is provided", () => {
    const result = preflightTask(makeReportEntry("t3", ["execute_bash"]), makeScope("t3"), undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("required_tool_unregistered");
      expect(result.safeDetail).toContain("tool registry unavailable");
    }
  });
});

describe("captureReportArtifact bounded consistent capture (#1791)", () => {
  const contract = { minBytes: 10, requiredSections: ["# Title"], baseline: { existed: false } };

  function capScope(id: string): string {
    const workspace = join(currentTestSandbox().abtarsHome, "workspace", id);
    return workspace;
  }

  it("captures a valid report with content, digest, and size over the same bytes", () => {
    const dir = capScope("cap-valid");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "R.md");
    const body = "# Title\n\nbody body body\n";
    writeFileSync(p, body, "utf-8");
    const got = captureReportArtifact(p, contract, Date.now());
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.content).toBe(body);
    expect(got.sizeBytes).toBe(Buffer.byteLength(body, "utf-8"));
    expect(got.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps absent and stale files to invalid observations with mechanical codes", () => {
    const missing = captureReportArtifact(join(capScope("cap-miss"), "No.md"), contract, Date.now());
    expect(missing).toMatchObject({ ok: false, kind: "invalid", code: "artifact_not_found" });

    const dir = capScope("cap-stale");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "R.md");
    writeFileSync(p, "# Title\n\nbody body body\n", "utf-8");
    const stale = captureReportArtifact(p, contract, Date.now() + 3_600_000);
    expect(stale).toMatchObject({ ok: false, kind: "invalid", code: "artifact_stale_mtime" });
  });

  it("rejects oversized reports without content at the exact boundary", () => {
    const dir = capScope("cap-size");
    mkdirSync(dir, { recursive: true });
    const okPath = join(dir, "Ok.md");
    const head = "# Title\n";
    writeFileSync(okPath, head + "x".repeat(REPORT_CAPTURE_MAX_BYTES - head.length), "utf-8");
    const ok = captureReportArtifact(okPath, { minBytes: 1, requiredSections: ["# Title"], baseline: { existed: false } }, Date.now());
    expect(ok.ok).toBe(true);

    const bigPath = join(dir, "Big.md");
    writeFileSync(bigPath, head + "x".repeat(REPORT_CAPTURE_MAX_BYTES - head.length + 1), "utf-8");
    const big = captureReportArtifact(bigPath, { minBytes: 1, requiredSections: ["# Title"], baseline: { existed: false } }, Date.now());
    expect(big).toMatchObject({ ok: false, kind: "unavailable", code: "report_too_large" });
    if (!big.ok) expect("content" in big).toBe(false);
  });

  it("rejects symlinks consistently with the mechanical validator", () => {
    const dir = capScope("cap-link");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "R.md");
    writeFileSync(target, "# Title\n\nbody body body\n", "utf-8");
    const link = join(dir, "L.md");
    symlinkSync(target, link);
    const got = captureReportArtifact(link, contract, Date.now());
    expect(got).toMatchObject({ ok: false, kind: "invalid", code: "artifact_not_regular_file" });
  });

  it("rejects non-UTF8 bytes without content", () => {
    const dir = capScope("cap-enc");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "R.md");
    writeFileSync(p, Buffer.from([0x23, 0x20, 0x54, 0xff, 0xfe, 0x0a]));
    const got = captureReportArtifact(p, { minBytes: 1, requiredSections: [], baseline: { existed: false } }, Date.now());
    expect(got).toMatchObject({ ok: false, kind: "unavailable", code: "report_encoding_invalid" });
  });

  it("maps unreadable files to report_read_failed, never to absence", () => {
    // Root bypasses permission bits, so this can only prove the mapping away from root.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dir = capScope("cap-perm");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "R.md");
    writeFileSync(p, "# Title\n\nbody body body\n", "utf-8");
    chmodSync(p, 0o000);
    try {
      const got = captureReportArtifact(p, contract, Date.now());
      expect(got).toMatchObject({ ok: false, kind: "unavailable", code: "report_read_failed" });
    } finally {
      chmodSync(p, 0o600);
    }
  });
});
