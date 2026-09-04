import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_HOME = mkdtempSync(join(tmpdir(), "abtars-auth-cli-"));

vi.mock("../../paths.js", () => ({
  abtarsHome: () => TEST_HOME,
}));

const { auth } = await import("./auth.js");

function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return { output, restore: () => spy.mockRestore() };
}

function seedRules(): void {
  mkdirSync(join(TEST_HOME, "auth"), { recursive: true });
  writeFileSync(join(TEST_HOME, "auth", "rules.json"), JSON.stringify({
    rules: [
      { category: "bash-auth", pattern: "git status*", action: "allow", createdAt: "2026-09-04T00:00:00.000Z" },
      { category: "bash-auth", pattern: "rm -rf /tmp/*", action: "deny", createdAt: "2026-09-04T00:00:01.000Z" },
    ],
  }));
}

describe("abtars auth CLI (#1771)", () => {
  beforeEach(() => {
    rmSync(join(TEST_HOME, "auth"), { recursive: true, force: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(join(TEST_HOME, "auth"), { recursive: true, force: true });
  });

  it("lists nothing with exit 0 when no rules file exists", async () => {
    const cap = captureStdout();
    try {
      expect(await auth(["list"])).toBe(0);
      expect(cap.output.join("")).toBe("");
    } finally {
      cap.restore();
    }
  });

  it("lists index, category, pattern, action, createdAt per rule", async () => {
    seedRules();
    const cap = captureStdout();
    try {
      expect(await auth(["list"])).toBe(0);
      const text = cap.output.join("");
      expect(text).toContain("0\tbash-auth\tgit status*\tallow\t2026-09-04T00:00:00.000Z");
      expect(text).toContain("1\tbash-auth\trm -rf /tmp/*\tdeny\t2026-09-04T00:00:01.000Z");
    } finally {
      cap.restore();
    }
  });

  it("rm removes the indexed rule and persists the file", async () => {
    seedRules();
    const cap = captureStdout();
    try {
      expect(await auth(["rm", "0"])).toBe(0);
      expect(cap.output.join("")).toContain("removed rule 0");
    } finally {
      cap.restore();
    }
    const remaining = JSON.parse(readFileSync(join(TEST_HOME, "auth", "rules.json"), "utf-8")) as {
      rules: Array<{ pattern: string }>;
    };
    expect(remaining.rules.map((r) => r.pattern)).toEqual(["rm -rf /tmp/*"]);
  });

  it("rm with an out-of-range or non-numeric index errors", async () => {
    seedRules();
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    const cap = captureStdout();
    try {
      expect(await auth(["rm", "7"])).toBe(1);
      expect(await auth(["rm", "nope"])).toBe(1);
      expect(await auth([])).toBe(1);
      expect(await auth(["bogus"])).toBe(1);
    } finally {
      cap.restore();
      errSpy.mockRestore();
    }
    // Untouched by failed removals
    const intact = JSON.parse(readFileSync(join(TEST_HOME, "auth", "rules.json"), "utf-8")) as {
      rules: unknown[];
    };
    expect(intact.rules.length).toBe(2);
  });
});
