import { describe, it, expect } from "vitest";
import { preflightTask, validateReportArtifact } from "./task-preflight.js";
import { getToolDescriptor } from "../transport/tool-registry.js";
import type { ScheduledTask } from "./task-types.js";
import type { ToolExecutionScope } from "./task-package.js";
import { currentTestSandbox } from "../../test-support/runtime-isolation.js";
import { localDate } from "../../utils/date.js";
import { writeFileSync } from "node:fs";
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
