import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock child_process before importing
const spawnMock = vi.fn().mockReturnValue({ unref: vi.fn() });
vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return { ...orig, spawn: (...args: unknown[]) => spawnMock(...args), execSync: orig.execSync };
});

// Mock execSync for crontab
const execSyncMock = vi.fn();
vi.mock("node:child_process", async () => {
  return {
    spawn: (...args: unknown[]) => spawnMock(...args),
    execSync: (...args: unknown[]) => execSyncMock(...args),
  };
});

// Mock os.homedir
let fakeHome: string;
vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: () => fakeHome };
});

// Mock cron-parser
const prevMock = vi.fn();
vi.mock("cron-parser", () => ({
  CronExpressionParser: {
    parse: () => ({ prev: () => ({ getTime: prevMock }) }),
  },
}));

// Mock logger
vi.mock("../components/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const { checkMissedCrons } = await import("../components/cron-checker.js");

describe("checkMissedCrons", () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "cron-missed-"));
    mkdirSync(join(fakeHome, ".agentbridge", "memory"), { recursive: true });
    spawnMock.mockClear().mockReturnValue({ unref: vi.fn() });
    execSyncMock.mockClear();
    prevMock.mockClear();
  });

  it("does nothing when no crontab", () => {
    execSyncMock.mockImplementation(() => { throw new Error("no crontab"); });
    checkMissedCrons(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("ignores entries without agentbridge-managed tag", () => {
    execSyncMock.mockReturnValue("0 8 * * * /usr/bin/some-other-job\n");
    checkMissedCrons(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("executes missed cron when catchUp=true", () => {
    execSyncMock.mockReturnValue('0 8 * * * /usr/bin/agentbridge-browse --task "test" # agentbridge-managed\n');
    prevMock.mockReturnValue(Date.now() - 3600_000); // prev fire 1hr ago
    // No cron_runs.json → lastRun=0 → missed

    checkMissedCrons(true);

    expect(spawnMock).toHaveBeenCalledWith("bash", ["-c", expect.stringContaining("agentbridge-browse")], expect.any(Object));
  });

  it("does NOT execute when catchUp=false (tracking only)", () => {
    execSyncMock.mockReturnValue('0 8 * * * /usr/bin/agentbridge-browse --task "test" # agentbridge-managed\n');
    prevMock.mockReturnValue(Date.now() - 3600_000);

    checkMissedCrons(false);

    expect(spawnMock).not.toHaveBeenCalled();
    // But cron_runs.json should be updated
    const runs = JSON.parse(readFileSync(join(fakeHome, ".agentbridge", "memory", "cron_runs.json"), "utf-8"));
    expect(Object.keys(runs).length).toBe(1);
  });

  it("skips when lastRun is recent", () => {
    const runsPath = join(fakeHome, ".agentbridge", "memory", "cron_runs.json");
    const command = '/usr/bin/agentbridge-browse --task "test"';
    // Compute same hash as the module
    let h = 0;
    for (let i = 0; i < command.length; i++) h = ((h << 5) - h + command.charCodeAt(i)) | 0;
    const key = Math.abs(h).toString(36);
    writeFileSync(runsPath, JSON.stringify({ [key]: { lastRun: Date.now(), command } }));

    execSyncMock.mockReturnValue(`0 8 * * * ${command} # agentbridge-managed\n`);
    prevMock.mockReturnValue(Date.now() - 3600_000); // prev fire 1hr ago, but lastRun is now

    checkMissedCrons(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
