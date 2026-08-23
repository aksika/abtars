import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveFix,
  disableFix,
  getEffectiveOrcGuardrails,
  getEffectiveShaPolicy,
  loadMergedFixes,
  logAdmissionAllowed,
  policyDiagnostics,
  reload,
  reloadEffectiveShaPolicy,
  validateFixRule,
} from "./sha-policy.js";

const savedHome = process.env["ABTARS_HOME"];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sha-policy-"));
  process.env["ABTARS_HOME"] = home;
  reload();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env["ABTARS_HOME"];
  else process.env["ABTARS_HOME"] = savedHome;
  reload();
});

function writePolicy(name: string, body: unknown): void {
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", name), JSON.stringify(body));
}

describe("validateFixRule", () => {
  it("accepts a well-formed run rule with verifyCommand", () => {
    const rule = validateFixRule({
      pattern: "some distinctive error", action: "run",
      command: ["touch", "/tmp/x"], verifyCommand: ["test", "-f", "/tmp/x"],
      cooldownMin: 30, verified: true,
    });
    expect(rule?.pattern).toBe("some distinctive error");
    expect(rule?.verifyCommand).toEqual(["test", "-f", "/tmp/x"]);
  });

  it("rejects malformed rules from unknown", () => {
    expect(validateFixRule(null)).toBeNull();
    expect(validateFixRule("nope")).toBeNull();
    expect(validateFixRule({ pattern: "", cooldownMin: 1 })).toBeNull();
    expect(validateFixRule({ pattern: "p", cooldownMin: 1, command: ["ok", 42] })).toBeNull();
    expect(validateFixRule({ pattern: "p", cooldownMin: 1, command: [] })).toBeNull();
    expect(validateFixRule({ pattern: "p", cooldownMin: "30" })).toBeNull();
    expect(validateFixRule({ pattern: "p", cooldownMin: 1, action: "explode" })).toBeNull();
    expect(validateFixRule({ pattern: "p", cooldownMin: 1, verifyCommand: ["test", 7] })).toBeNull();
  });
});

describe("loadMergedFixes", () => {
  it("core wins on duplicate patterns; self rules merge", () => {
    writePolicy("sha-policy.json", {
      fixes: [{ pattern: "dup-pattern", action: "run", command: ["core"], cooldownMin: 5 }],
    });
    writePolicy("sha-policy-self.json", {
      fixes: [
        { pattern: "dup-pattern", action: "run", command: ["self"], cooldownMin: 5 },
        { pattern: "a self-generated rule that is long enough", action: "run", command: ["self2"], cooldownMin: 5, createdAt: "2026-01-01" },
      ],
    });
    const fixes = loadMergedFixes();
    expect(fixes).toHaveLength(2);
    const dup = fixes.find((f) => f.pattern === "dup-pattern");
    expect(dup?.command).toEqual(["core"]);
  });

  it("ignores short, disabled, and malformed self rules with bounded warnings", () => {
    writePolicy("sha-policy.json", { fixes: [] });
    writePolicy("sha-policy-self.json", {
      fixes: [
        { pattern: "short", cooldownMin: 5 },
        { pattern: "a disabled rule that is long enough", cooldownMin: 5, enabled: false },
        { pattern: 42, cooldownMin: 5 },
        { pattern: "a valid self rule that is long enough", action: "run", command: ["ok"], cooldownMin: 5 },
      ],
    });
    const fixes = loadMergedFixes();
    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.pattern).toContain("valid self rule");
  });
});

describe("malformed core policy", () => {
  it("disables log admission but keeps scheduled policy loading usable", () => {
    writePolicy("sha-policy.json", { fixes: [] });
    writePolicy("sha-policy-self.json", { fixes: [] });
    expect(logAdmissionAllowed()).toBe(true);
    writeFileSync(join(home, "config", "sha-policy.json"), "{ not json");
    reload();
    expect(logAdmissionAllowed()).toBe(false);
    expect(loadMergedFixes()).toEqual([]);
  });
});

describe("approveFix / disableFix", () => {
  it("approve marks verified and persists; disable marks enabled=false", () => {
    writePolicy("sha-policy-self.json", {
      fixes: [{ pattern: "a self rule long enough for approval", action: "run", command: ["x"], cooldownMin: 5, verified: false }],
    });
    expect(approveFix("missing")).toBe(false);
    expect(approveFix("a self rule long enough for approval")).toBe(true);
    const after = loadMergedFixes();
    expect(after.find((f) => f.pattern === "a self rule long enough for approval")?.verified).toBe(true);
    expect(disableFix("a self rule long enough for approval")).toBe(true);
    expect(loadMergedFixes().find((f) => f.pattern === "a self rule long enough for approval")).toBeUndefined();
  });

  it("does not clobber a malformed self-policy file", () => {
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "sha-policy-self.json"), "broken{");
    expect(approveFix("anything")).toBe(false);
    expect(disableFix("anything")).toBe(false);
  });

  it("approve/disable rebuild the effective snapshot before returning", () => {
    writePolicy("sha-policy.json", { schemaVersion: 2, faults: {}, fixes: [], guardrails: {
      orc: {}, logAnomaly: { notifyMain: true, shaAllowed: true, minimumMode: "investigation", cooldownMinutes: 60 },
    } });
    writePolicy("sha-policy-self.json", {
      fixes: [{ pattern: "a self rule long enough for approval", action: "run", command: ["x"], cooldownMin: 5 }],
    });
    expect(getEffectiveShaPolicy().fixes).toHaveLength(1);
    expect(disableFix("a self rule long enough for approval")).toBe(true);
    // No explicit reload needed — the write republished the snapshot.
    expect(getEffectiveShaPolicy().fixes).toHaveLength(0);
  });
});

// ── #1708: effective policy resolution ───────────────────────────────────────

const V2_GUARDRAILS = {
  orc: {
    sameCard: {
      failedOrNoProgress: { max: 3 },
      startsWithoutProgress: { max: 5 },
    },
    bridge: { starts5m: 25, starts1h: 100, newRunRows5m: 50 },
  },
  logAnomaly: { notifyMain: true, shaAllowed: true, minimumMode: "investigation", cooldownMinutes: 60 },
};

describe("#1708 effective guardrails — valid v2", () => {
  it("resolves every leaf from a valid v2 file", () => {
    writePolicy("sha-policy.json", { schemaVersion: 2, faults: {}, fixes: [], guardrails: V2_GUARDRAILS });
    const p = getEffectiveShaPolicy();
    expect(p.logAdmissionAllowed).toBe(true);
    expect(p.orc.sameCard.failedOrNoProgress).toEqual({ max: 3, windowMinutes: 10 });
    expect(p.orc.sameCard.startsWithWithoutProgress).toEqual({ max: 5, windowMinutes: 5 });
    expect(p.orc.bridge).toEqual({ starts5m: 25, starts1h: 100, newRunRows5m: 50 });
    expect(p.logAnomaly).toEqual({ notifyMain: true, shaAllowed: true, minimumMode: "investigation", cooldownMinutes: 60 });
    expect(policyDiagnostics()).toEqual({ coreStatus: "valid-v2", selfStatus: "missing", fallbackFields: [] });
  });

  it("accepts lowered thresholds and clamps raised ones at the shipped ceiling", () => {
    writePolicy("sha-policy.json", { schemaVersion: 2, fixes: [], guardrails: {
      orc: {
        sameCard: { failedOrNoProgress: { max: 1 }, startsWithoutProgress: { max: 99 } },
        bridge: { starts5m: 1, starts1h: 1000, newRunRows5m: 7 },
      },
      logAnomaly: {},
    } });
    const orc = getEffectiveOrcGuardrails();
    expect(orc.sameCard.failedOrNoProgress.max).toBe(1);
    expect(orc.sameCard.startsWithWithoutProgress.max).toBe(5); // clamped to ceiling
    expect(orc.bridge.starts5m).toBe(1);
    expect(orc.bridge.starts1h).toBe(100); // clamped
    expect(orc.bridge.newRunRows5m).toBe(7);
  });

  it("windows stay code-owned even if policy attempts to set them", () => {
    writePolicy("sha-policy.json", { schemaVersion: 2, fixes: [], guardrails: {
      orc: { sameCard: { failedOrNoProgress: { max: 3, windowMinutes: 1 } }, bridge: {} },
      logAnomaly: {},
    } });
    expect(getEffectiveOrcGuardrails().sameCard.failedOrNoProgress.windowMinutes).toBe(10);
  });

  it("cooldown may lengthen to 1440 but never below the one-hour floor", () => {
    writePolicy("sha-policy.json", { schemaVersion: 2, fixes: [], guardrails: {
      orc: {}, logAnomaly: { cooldownMinutes: 1440 },
    } });
    expect(getEffectiveShaPolicy().logAnomaly.cooldownMinutes).toBe(1440);

    writePolicy("sha-policy.json", { schemaVersion: 2, fixes: [], guardrails: {
      orc: {}, logAnomaly: { cooldownMinutes: 30 },
    } });
    reload();
    expect(getEffectiveShaPolicy().logAnomaly.cooldownMinutes).toBe(60);
    expect(policyDiagnostics().fallbackFields).toContain("guardrails.logAnomaly.cooldownMinutes");
  });

  it("minimumMode accepts only investigation/full; runtime off always wins elsewhere", () => {
    writePolicy("sha-policy.json", { schemaVersion: 2, fixes: [], guardrails: {
      orc: {}, logAnomaly: { minimumMode: "full" },
    } });
    expect(getEffectiveShaPolicy().logAnomaly.minimumMode).toBe("full");

    writePolicy("sha-policy.json", { schemaVersion: 2, fixes: [], guardrails: {
      orc: {}, logAnomaly: { minimumMode: "off" },
    } });
    reload();
    expect(getEffectiveShaPolicy().logAnomaly.minimumMode).toBe("investigation");
  });
});

describe("#1708 effective guardrails — fallback matrix", () => {
  it("unversioned existing file keeps its fixes and receives default guardrails", () => {
    writePolicy("sha-policy.json", { faults: {}, fixes: [{ pattern: "legacy fix pattern here", action: "suppress", cooldownMin: 0 }] });
    const p = getEffectiveShaPolicy();
    expect(policyDiagnostics().coreStatus).toBe("valid-legacy");
    expect(p.fixes).toHaveLength(1);
    expect(p.orc.sameCard.failedOrNoProgress.max).toBe(3);
    expect(p.logAdmissionAllowed).toBe(true);
  });

  it("explicit unsupported schema version disables line-level and anomaly admission with shipped defaults", () => {
    writePolicy("sha-policy.json", { schemaVersion: 3, faults: {}, fixes: [{ pattern: "should not load", action: "suppress", cooldownMin: 0 }] });
    const d = policyDiagnostics();
    expect(d.coreStatus).toBe("unsupported-schema");
    expect(loadMergedFixes()).toEqual([]);
    expect(logAdmissionAllowed()).toBe(false);
    expect(getEffectiveShaPolicy().orc.sameCard.failedOrNoProgress.max).toBe(3);
    expect(getEffectiveShaPolicy().logAnomaly.shaAllowed).toBe(true); // defaults are inert without admission
  });

  it("missing core file fails closed with bounded diagnostics", () => {
    const p = getEffectiveShaPolicy();
    expect(policyDiagnostics().coreStatus).toBe("missing");
    expect(p.logAdmissionAllowed).toBe(false);
    expect(p.fixes).toEqual([]);
    expect(p.orc.sameCard.failedOrNoProgress.max).toBe(3);
  });

  it("syntactically invalid JSON fails closed and emits one bounded diagnostic per load", () => {
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "sha-policy.json"), "{ not json");
    reload();
    expect(policyDiagnostics().coreStatus).toBe("invalid-json");
    expect(logAdmissionAllowed()).toBe(false);
  });

  it("a non-object JSON document is invalid input, not a valid empty policy", () => {
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "sha-policy.json"), "[1,2,3]");
    reload();
    expect(policyDiagnostics().coreStatus).toBe("invalid-json");
    expect(logAdmissionAllowed()).toBe(false);
  });

  it("one malformed leaf falls back only that leaf; other leaves stay usable", () => {
    writePolicy("sha-policy.json", { schemaVersion: 2, fixes: [], guardrails: {
      orc: {
        sameCard: { failedOrNoProgress: { max: 0 }, startsWithoutProgress: { max: 2 } },
        bridge: { starts5m: 10, starts1h: 100, newRunRows5m: "fifty" },
      },
      logAnomaly: { notifyMain: "yes", shaAllowed: false, minimumMode: "full", cooldownMinutes: 90 },
    } });
    const p = getEffectiveShaPolicy();
    expect(p.orc.sameCard.failedOrNoProgress.max).toBe(3);
    expect(p.orc.sameCard.startsWithWithoutProgress.max).toBe(2);
    expect(p.orc.bridge.starts5m).toBe(10);
    expect(p.orc.bridge.newRunRows5m).toBe(50);
    expect(p.logAnomaly.notifyMain).toBe(true);
    expect(p.logAnomaly.shaAllowed).toBe(false);
    expect(p.logAnomaly.minimumMode).toBe("full");
    expect(p.logAnomaly.cooldownMinutes).toBe(90);
    const fields = policyDiagnostics().fallbackFields;
    expect(fields).toContain("guardrails.orc.sameCard.failedOrNoProgress.max");
    expect(fields).toContain("guardrails.orc.bridge.newRunRows5m");
    expect(fields).toContain("guardrails.logAnomaly.notifyMain");
    expect(fields).toHaveLength(3);
  });

  it("rejects non-integer, negative, and non-finite counts", () => {
    writePolicy("sha-policy.json", { schemaVersion: 2, fixes: [], guardrails: {
      orc: {
        sameCard: { failedOrNoProgress: { max: -1 }, startsWithoutProgress: { max: 2.5 } },
        bridge: { starts5m: Number.NaN, starts1h: Number.POSITIVE_INFINITY, newRunRows5m: 0 },
      },
      logAnomaly: {},
    } });
    const orc = getEffectiveOrcGuardrails();
    expect(orc.sameCard.failedOrNoProgress.max).toBe(3);
    expect(orc.sameCard.startsWithWithoutProgress.max).toBe(5);
    expect(orc.bridge.starts5m).toBe(25);
    expect(orc.bridge.starts1h).toBe(100);
    expect(orc.bridge.newRunRows5m).toBe(50);
  });
});

describe("#1708 self-policy isolation", () => {
  it("self-generated guardrails cannot change limits, gates, or mode floors", () => {
    writePolicy("sha-policy.json", { schemaVersion: 2, fixes: [], guardrails: V2_GUARDRAILS });
    writePolicy("sha-policy-self.json", {
      schemaVersion: 2,
      guardrails: {
        orc: { sameCard: { failedOrNoProgress: { max: 999 } }, bridge: { starts1h: 100000 } },
        logAnomaly: { shaAllowed: false, minimumMode: "full" },
      },
      fixes: [{ pattern: "a valid self rule that is long enough", action: "run", command: ["ok"], cooldownMin: 5 }],
    });
    const p = getEffectiveShaPolicy();
    expect(p.orc.sameCard.failedOrNoProgress.max).toBe(3);
    expect(p.orc.bridge.starts1h).toBe(100);
    expect(p.logAnomaly.shaAllowed).toBe(true);
    expect(p.logAnomaly.minimumMode).toBe("investigation");
    expect(p.fixes.map((f) => f.pattern)).toContain("a valid self rule that is long enough");
    expect(policyDiagnostics().selfStatus).toBe("valid");
  });

  it("an invalid self file leaves core guardrails intact", () => {
    writePolicy("sha-policy.json", { schemaVersion: 2, fixes: [], guardrails: V2_GUARDRAILS });
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "sha-policy-self.json"), "broken{");
    const p = getEffectiveShaPolicy();
    expect(policyDiagnostics().selfStatus).toBe("invalid-json");
    expect(p.orc.sameCard.failedOrNoProgress.max).toBe(3);
    expect(p.logAdmissionAllowed).toBe(true);
  });
});

describe("#1708 reload behavior", () => {
  it("reloadEffectiveShaPolicy publishes an edited snapshot atomically", () => {
    writePolicy("sha-policy.json", { schemaVersion: 2, fixes: [], guardrails: V2_GUARDRAILS });
    expect(getEffectiveOrcGuardrails().bridge.starts5m).toBe(25);

    writePolicy("sha-policy.json", { schemaVersion: 2, fixes: [], guardrails: {
      ...V2_GUARDRAILS,
      orc: { ...V2_GUARDRAILS.orc, bridge: { starts5m: 4, starts1h: 100, newRunRows5m: 50 } },
    } });
    const published = reloadEffectiveShaPolicy();
    expect(published.snapshot.orc.bridge.starts5m).toBe(4);
    expect(getEffectiveOrcGuardrails().bridge.starts5m).toBe(4);
    expect(published.diagnostics.coreStatus).toBe("valid-v2");
  });

  it("a malformed reload publishes safe defaults instead of retaining the prior snapshot", () => {
    writePolicy("sha-policy.json", { schemaVersion: 2, fixes: [], guardrails: V2_GUARDRAILS });
    expect(getEffectiveOrcGuardrails().sameCard.failedOrNoProgress.max).toBe(3);
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "sha-policy.json"), "nope{");
    const published = reloadEffectiveShaPolicy();
    expect(published.diagnostics.coreStatus).toBe("invalid-json");
    expect(published.snapshot.logAdmissionAllowed).toBe(false);
    expect(getEffectiveShaPolicy().logAdmissionAllowed).toBe(false);
    expect(getEffectiveShaPolicy().orc.sameCard.failedOrNoProgress.max).toBe(3);
  });

  it("ordinary fresh-process reads (cache miss) read edited files like a restart", () => {
    writePolicy("sha-policy.json", { schemaVersion: 2, fixes: [], guardrails: V2_GUARDRAILS });
    expect(getEffectiveOrcGuardrails().bridge.starts5m).toBe(25);
    writePolicy("sha-policy.json", { schemaVersion: 2, fixes: [], guardrails: {
      ...V2_GUARDRAILS,
      orc: { ...V2_GUARDRAILS.orc, bridge: { starts5m: 9, starts1h: 100, newRunRows5m: 50 } },
    } });
    reload(); // simulates restart: cold cache
    expect(getEffectiveOrcGuardrails().bridge.starts5m).toBe(9);
  });
});