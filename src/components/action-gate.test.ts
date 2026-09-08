import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionGate, familyPattern, globToRegExp } from "./action-gate.js";

describe("globToRegExp (#1771)", () => {
  it("matches literally when no wildcards are present", () => {
    const re = globToRegExp("git status");
    expect(re.test("git status")).toBe(true);
    expect(re.test("git status --porcelain")).toBe(false);
    expect(re.test("git statu")).toBe(false);
    expect(re.test("xgit status")).toBe(false);
  });
  it("treats regex metacharacters as literals", () => {
    const re = globToRegExp("node app.js (1)");
    expect(re.test("node app.js (1)")).toBe(true);
    expect(re.test("node appXjs (1)")).toBe(false);
  });
  it("* matches any run, anchored", () => {
    expect(globToRegExp("git status*").test("git status --porcelain")).toBe(true);
    expect(globToRegExp("git status*").test("git status")).toBe(true);
    expect(globToRegExp("git status*").test("git stash")).toBe(false);
    expect(globToRegExp("*").test("anything at all")).toBe(true);
  });
  it("? matches exactly one character", () => {
    expect(globToRegExp("git statu?").test("git status")).toBe(true);
    expect(globToRegExp("git statu?").test("git statu")).toBe(false);
    expect(globToRegExp("git statu?").test("git statusx")).toBe(false);
  });
});

describe("familyPattern (#1771)", () => {
  it.each([
    ["git status", "git status*"],
    ["git status --porcelain", "git status*"],
    ["git -C repo status", "git status*"],
    ["git -C repo status --porcelain", "git status*"],
    ["npm run build", "npm run*"],
    ["npm install", "npm install*"],
    ["docker ps -a", "docker ps*"],
    ["node scripts/backup.js", "node*"],
    ["sqlite3 ~/.abmind/db/mem.db \"SELECT 1\"", "sqlite3*"],
    ["sudo rm -rf ~/.abtars/cache", "sudo rm*"],
    ["sudo git status", "sudo git status*"],
    ["env FOO=1 node x.js", "node*"],
    ["FOO=1 node x.js", "node*"],
    ["git", "git*"],
  ])("maps %s to %s", (cmd, expected) => {
    expect(familyPattern(cmd)).toBe(expected);
  });
  it("always ends with *", () => {
    for (const cmd of ["git status", "node x", "sudo id", "env A=1 env B=2 make all"]) {
      expect(familyPattern(cmd).endsWith("*")).toBe(true);
    }
  });
});

describe("ActionGate glob rules + families (#1771)", () => {
  let tmpDir: string;
  let gate: ActionGate;
  let notifyCalls: Array<{ text: string; buttons: Array<{ text: string; data: string }> }>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "actiongate-1771-"));
    gate = new ActionGate(tmpDir);
    notifyCalls = [];
    gate.setNotify(async (text, buttons) => { notifyCalls.push({ text, buttons }); });
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  function auditLines(): string[] {
    return readFileSync(join(tmpDir, "audit.jsonl"), "utf-8").trim().split("\n").filter(Boolean);
  }

  it("legacy literal rules still match exactly", async () => {
    writeFileSync(join(tmpDir, "rules.json"), JSON.stringify({
      rules: [{ category: "bash-auth", pattern: "echo allowed-here", action: "allow", createdAt: new Date().toISOString() }],
    }));
    expect(await gate.requestAuth("bash-auth", "echo allowed-here", { mode: "unattended-task" })).toBe(true);
    // Same prefix is NOT a match for a wildcard-less rule
    const second = gate.requestAuth("bash-auth", "echo allowed-here please", { mode: "interactive" });
    await new Promise((r) => setTimeout(r, 10));
    expect(notifyCalls.length).toBe(1);
    gate.handleCallback(notifyCalls[0]!.buttons[2]!.data);
    expect(await second).toBe(false);
  });

  it("last matching rule wins in both directions", async () => {
    writeFileSync(join(tmpDir, "rules.json"), JSON.stringify({
      rules: [
        { category: "bash-auth", pattern: "git *", action: "allow", createdAt: "2026-09-04T00:00:00.000Z" },
        { category: "bash-auth", pattern: "git push*", action: "deny", createdAt: "2026-09-04T00:00:01.000Z" },
      ],
    }));
    expect(await gate.requestAuth("bash-auth", "git status", { mode: "unattended-task" })).toBe(true);
    expect(await gate.requestAuth("bash-auth", "git push --force", { mode: "unattended-task" })).toBe(false);
    expect(auditLines().at(-1)).toContain('"outcome":"denied-by-rule"');
    expect(auditLines().at(-1)).toContain('"pattern":"git push*"');
  });

  it("Always allow stores the family — variants auto-grant with pattern audit", async () => {
    const first = gate.requestAuth("bash-auth", "git status --porcelain");
    await new Promise((r) => setTimeout(r, 10));
    gate.handleCallback(notifyCalls[0]!.buttons[1]!.data); // "🔓 Always allow"
    expect(await first).toBe(true);

    const stored = JSON.parse(readFileSync(join(tmpDir, "rules.json"), "utf-8")) as {
      rules: Array<{ pattern: string }>;
    };
    expect(stored.rules.map((r) => r.pattern)).toEqual(["git status*"]);

    notifyCalls = [];
    expect(await gate.requestAuth("bash-auth", "git status")).toBe(true);
    expect(notifyCalls.length).toBe(0);
    expect(auditLines().at(-1)).toContain('"outcome":"allowed-by-rule"');
    expect(auditLines().at(-1)).toContain('"pattern":"git status*"');
    expect(auditLines()).toContainEqual(expect.stringContaining('"outcome":"allowed-always"'));
  });

  it("sudo grants keep the wrapper prefix, never bare sudo*", async () => {
    const first = gate.requestAuth("bash-auth", "sudo rm -rf ~/.abtars/cache");
    await new Promise((r) => setTimeout(r, 10));
    gate.handleCallback(notifyCalls[0]!.buttons[1]!.data);
    expect(await first).toBe(true);
    const stored = JSON.parse(readFileSync(join(tmpDir, "rules.json"), "utf-8")) as {
      rules: Array<{ pattern: string }>;
    };
    expect(stored.rules.map((r) => r.pattern)).toEqual(["sudo rm*"]);
    // A different sudo executable still prompts (never bare `sudo*`)
    notifyCalls = [];
    const second = gate.requestAuth("bash-auth", "sudo id");
    await new Promise((r) => setTimeout(r, 10));
    expect(notifyCalls.length).toBe(1);
    gate.handleCallback(notifyCalls[0]!.buttons[2]!.data);
    expect(await second).toBe(false);
  });

  it("external CLI edits are honored without restart; store does not resurrect removals", async () => {
    writeFileSync(join(tmpDir, "rules.json"), JSON.stringify({
      rules: [{ category: "bash-auth", pattern: "echo one*", action: "allow", createdAt: new Date().toISOString() }],
    }));
    expect(await gate.requestAuth("bash-auth", "echo one two", { mode: "unattended-task" })).toBe(true);
    // External removal (as `abtars auth rm` would do)
    writeFileSync(join(tmpDir, "rules.json"), JSON.stringify({ rules: [] }));
    expect(gate.listRules()).toEqual([]);
    // Bridge "Always allow" afterwards appends without resurrecting
    const pending = gate.requestAuth("bash-auth", "npm run build");
    await new Promise((r) => setTimeout(r, 10));
    gate.handleCallback(notifyCalls[0]!.buttons[1]!.data);
    expect(await pending).toBe(true);
    const stored = JSON.parse(readFileSync(join(tmpDir, "rules.json"), "utf-8")) as {
      rules: Array<{ pattern: string }>;
    };
    expect(stored.rules.map((r) => r.pattern)).toEqual(["npm run*"]);
  });

  it("listRules/removeRule round-trip with out-of-range guard", () => {
    writeFileSync(join(tmpDir, "rules.json"), JSON.stringify({
      rules: [
        { category: "bash-auth", pattern: "a*", action: "allow", createdAt: "t0" },
        { category: "bash-auth", pattern: "b*", action: "deny", createdAt: "t1" },
      ],
    }));
    expect(gate.listRules().map((r) => r.pattern)).toEqual(["a*", "b*"]);
    expect(gate.removeRule(5)).toBe(false);
    expect(gate.removeRule(0)).toBe(true);
    expect(gate.listRules().map((r) => r.pattern)).toEqual(["b*"]);
  });
});

describe("trusted-root seed defaults (REQUIREMENT: prompt-free allowed dirs)", () => {
  let tmpDir: string;
  let gate: ActionGate;
  let notifyCalls: Array<{ text: string; buttons: Array<{ text: string; data: string }> }>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "actiongate-seed-"));
    gate = new ActionGate(tmpDir);
    notifyCalls = [];
    gate.setNotify(async (text, buttons) => { notifyCalls.push({ text, buttons }); });
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("builds cat/ls/find allows in tilde + absolute form per root", async () => {
    const { buildDefaultSeedRules } = await import("./action-gate.js");
    const r1 = join(homedir(), ".abtars-seedtest");
    const seeds = buildDefaultSeedRules([r1, "/opt/outside-home"]);
    const patterns = seeds.map((r) => r.pattern);
    expect(patterns).toContain(`cat ${r1}*`);
    expect(patterns).toContain("cat ~/.abtars-seedtest*");
    expect(patterns).toContain("ls ~/.abtars-seedtest*");
    expect(patterns).toContain("find ~/.abtars-seedtest*");
    expect(patterns).toContain("find /opt/outside-home*");
    // Outside-home roots get absolute form only (no fake tilde)
    expect(patterns.some((p) => p.includes("~/opt"))).toBe(false);
    expect(seeds.every((r) => r.category === "bash-auth" && r.action === "allow")).toBe(true);
    // No interpreter seeds — an interactive python/node prompt stays correct
    expect(patterns.some((p) => /^(python|node|bash|sh) /.test(p))).toBe(false);
  });

  it("ensureSeededDefaults is idempotent and allows an in-root find -exec chain silently", async () => {
    const added = gate.ensureSeededDefaults();
    expect(added.length).toBeGreaterThan(0);
    expect(gate.ensureSeededDefaults()).toEqual([]);
    const { abtarsHome } = await import("../paths.js");
    const home = abtarsHome();
    const chain =
      `cat ${home}/config/peers.json 2>/dev/null || ` +
      `find ${home} -maxdepth 3 -name "peers.json" -exec cat {} \\;`;
    expect(await gate.requestAuth("bash-auth", chain, { mode: "interactive" })).toBe(true);
    expect(notifyCalls.length).toBe(0);
  });

  it("user deny keeps precedence over seeds in both orders", async () => {
    const { buildDefaultSeedRules } = await import("./action-gate.js");
    const seedPattern = buildDefaultSeedRules()[0]!.pattern;
    const probe = `${seedPattern.slice(0, -1)}/secret/x`;
    // Order 1: seed first, user deny appended later wins
    gate.ensureSeededDefaults();
    const afterSeed = JSON.parse(readFileSync(join(tmpDir, "rules.json"), "utf-8")) as {
      rules: Array<Record<string, string>>;
    };
    writeFileSync(join(tmpDir, "rules.json"), JSON.stringify({
      rules: [...afterSeed.rules, { category: "bash-auth", pattern: seedPattern, action: "deny", createdAt: "t-deny" }],
    }));
    expect(await gate.requestAuth("bash-auth", probe, { mode: "interactive" })).toBe(false);
    expect(notifyCalls.length).toBe(0);
    // Order 2: user deny first — identical-pattern seed is skipped, deny stands
    writeFileSync(join(tmpDir, "rules.json"), JSON.stringify({
      rules: [{ category: "bash-auth", pattern: seedPattern, action: "deny", createdAt: "t-deny" }],
    }));
    expect(gate.ensureSeededDefaults()).not.toContain(seedPattern);
    expect(await gate.requestAuth("bash-auth", probe, { mode: "interactive" })).toBe(false);
    expect(notifyCalls.length).toBe(0);
  });
});
