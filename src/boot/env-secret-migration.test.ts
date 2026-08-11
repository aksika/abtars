/**
 * env-secret-migration.test.ts — #1354 migration decision matrix.
 * Pure module tests with a fake SecretIO: duplicates, conflicts, unsafe
 * store, write failures, malformed input, WEB_AUTH exception, idempotence,
 * and value-free results.
 */

import { describe, it, expect } from "vitest";
import {
  parseDotenvLines,
  runSecretMigration,
  isSecretEnvName,
} from "./env-secret-migration.js";
import type { SecretIO } from "./env-secret-migration.js";

function fakeStore(initial: Record<string, string> = {}, failCommit = false): SecretIO & { store: Record<string, string> } {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    compare(name: string, value: string): "missing" | "equal" | "different" | "unreadable" {
      if (!(name in store)) return "missing";
      return store[name] === value ? "equal" : "different";
    },
    commit(name: string, value: string): void {
      if (failCommit) throw new Error("disk full");
      store[name] = value;
    },
  };
}

const ENV = "~/.abtars/config/.env";
const SKILLS = "~/.abtars/config/.env.skills";

describe("parseDotenvLines", () => {
  it("parses plain, quoted, and blank assignments; preserves raw lines", () => {
    const lines = parseDotenvLines([
      "# comment",
      "PLAIN=value",
      'DOUBLE="quoted value"',
      "SINGLE='single value'",
      "EMPTY=",
      "MALFORMED no equals",
      "lower=case",
      "",
    ].join("\n"));
    const assignments = lines.filter(l => l.kind === "assignment");
    expect(assignments.map(a => a.key)).toEqual(["PLAIN", "DOUBLE", "SINGLE", "EMPTY"]);
    expect(assignments[1]).toMatchObject({ key: "DOUBLE", value: "quoted value" });
    expect(assignments[2]).toMatchObject({ key: "SINGLE", value: "single value" });
    // raw lines survive for lossless rewrites
    expect(lines.map(l => l.raw)).toContain("# comment");
    expect(lines.map(l => l.raw)).toContain("MALFORMED no equals");
  });
});

describe("isSecretEnvName", () => {
  it("accepts credential-shaped env names", () => {
    for (const n of ["OPENAI_API_KEY", "HA_TOKEN", "DB_SECRET", "MY_PASSWORD", "X_API_ID"]) {
      expect(isSecretEnvName(n), n).toBe(true);
    }
  });
  it("rejects non-credential or malformed names", () => {
    for (const n of ["DEFAULT_PROVIDER", "HA_URL", "lower_key", "A.B_KEY", "BAD-NAME_KEY", "1KEY"]) {
      expect(isSecretEnvName(n), n).toBe(false);
    }
  });
});

describe("runSecretMigration — single value", () => {
  const file = (content: string) => [{ path: ENV, content }];

  it("migrates a missing secret and removes the plaintext line", () => {
    const io = fakeStore();
    const r = runSecretMigration(file("DEFAULT_PROVIDER=openrouter\nOPENAI_API_KEY=sk-abc\nLOG_LEVEL=debug\n"), io);
    expect(r.decisions).toEqual([
      { key: "OPENAI_API_KEY", outcome: "migrated", sources: [".env"] },
    ]);
    expect(io.store["OPENAI_API_KEY"]).toBe("sk-abc");
    expect(r.committedSecrets).toEqual(["OPENAI_API_KEY"]);
    expect(r.files[0].content).toBe("DEFAULT_PROVIDER=openrouter\nLOG_LEVEL=debug\n");
    expect(r.envKeysToUnset).toEqual([]);
    // values never appear in structured results
    expect(JSON.stringify(r)).not.toContain("sk-abc");
  });

  it("removes duplicate assignments with the same value across files", () => {
    const io = fakeStore();
    const r = runSecretMigration([
      { path: ENV, content: "OPENAI_API_KEY=same\n" },
      { path: SKILLS, content: "OPENAI_API_KEY=same\nHA_URL=http://x\n" },
    ], io);
    expect(r.decisions[0]).toMatchObject({ key: "OPENAI_API_KEY", outcome: "migrated", sources: [".env", ".env.skills"] });
    expect(io.store["OPENAI_API_KEY"]).toBe("same");
    expect(r.files).toHaveLength(2);
    expect(r.files[0].content).toBe("");
    expect(r.files[1].content).toBe("HA_URL=http://x\n");
  });

  it("keeps an existing equal secret and removes plaintext", () => {
    const io = fakeStore({ OPENAI_API_KEY: "sk-abc" });
    const r = runSecretMigration(file("OPENAI_API_KEY=sk-abc\n"), io);
    expect(r.decisions[0]).toMatchObject({ key: "OPENAI_API_KEY", outcome: "kept-existing" });
    expect(r.committedSecrets).toEqual([]);
    expect(r.files[0].content).toBe("");
  });

  it("keeps an existing differing secret, warns, removes plaintext", () => {
    const io = fakeStore({ OPENAI_API_KEY: "sk-stored" });
    const r = runSecretMigration(file("OPENAI_API_KEY=sk-plaintext\n"), io);
    expect(r.decisions[0]).toMatchObject({ key: "OPENAI_API_KEY", outcome: "conflict-kept-existing" });
    expect(io.store["OPENAI_API_KEY"]).toBe("sk-stored");
    expect(r.files[0].content).toBe("");
    expect(JSON.stringify(r)).not.toContain("sk-plaintext");
    expect(JSON.stringify(r)).not.toContain("sk-stored");
  });

  it("handles quoted values", () => {
    const io = fakeStore();
    const r = runSecretMigration(file('OPENAI_API_KEY="sk-quoted"\n'), io);
    expect(r.decisions[0].outcome).toBe("migrated");
    expect(io.store["OPENAI_API_KEY"]).toBe("sk-quoted");
  });

  it("skips empty values", () => {
    const io = fakeStore();
    const r = runSecretMigration(file("OPENAI_API_KEY=\n"), io);
    expect(r.decisions).toEqual([]);
    expect(r.files).toEqual([]);
    expect(io.store).toEqual({});
  });
});

describe("runSecretMigration — conflicts", () => {
  it("rejects conflicting plaintext with no stored secret: files unchanged, env unset", () => {
    const io = fakeStore();
    const content = "OPENAI_API_KEY=value-a\n";
    const r = runSecretMigration([
      { path: ENV, content },
      { path: SKILLS, content: "OPENAI_API_KEY=value-b\n" },
    ], io);
    expect(r.decisions[0]).toMatchObject({ key: "OPENAI_API_KEY", outcome: "rejected-conflict" });
    expect(r.files).toEqual([]);
    expect(r.envKeysToUnset).toEqual(["OPENAI_API_KEY"]);
    expect(io.store).toEqual({});
    expect(JSON.stringify(r)).not.toContain("value-a");
    expect(JSON.stringify(r)).not.toContain("value-b");
  });

  it("existing readable secret wins over conflicting plaintext", () => {
    const io = fakeStore({ OPENAI_API_KEY: "sk-stored" });
    const r = runSecretMigration([
      { path: ENV, content: "OPENAI_API_KEY=value-a\n" },
      { path: SKILLS, content: "OPENAI_API_KEY=value-b\n" },
    ], io);
    expect(r.decisions[0]).toMatchObject({ key: "OPENAI_API_KEY", outcome: "conflict-kept-existing" });
    expect(io.store["OPENAI_API_KEY"]).toBe("sk-stored");
    expect(r.files).toHaveLength(2);
    expect(r.envKeysToUnset).toEqual([]);
  });
});

describe("runSecretMigration — fail closed", () => {
  it("write failure → rejected-unsafe, files unchanged, env unset, value-free error", () => {
    const io = fakeStore({}, true);
    const r = runSecretMigration([{ path: ENV, content: "OPENAI_API_KEY=sk-never-written\n" }], io);
    expect(r.decisions[0]).toMatchObject({ key: "OPENAI_API_KEY", outcome: "rejected-unsafe" });
    expect(r.decisions[0].reason).toContain("disk full");
    expect(r.files).toEqual([]);
    expect(r.envKeysToUnset).toEqual(["OPENAI_API_KEY"]);
    expect(JSON.stringify(r)).not.toContain("sk-never-written");
  });

  it("unreadable existing secret → rejected-unsafe, never clobbered", () => {
    const io: SecretIO = {
      compare: () => "unreadable",
      commit: () => { throw new Error("should not be called"); },
    };
    const r = runSecretMigration([{ path: ENV, content: "OPENAI_API_KEY=sk-x\n" }], io);
    expect(r.decisions[0].outcome).toBe("rejected-unsafe");
    expect(r.files).toEqual([]);
    expect(r.envKeysToUnset).toEqual(["OPENAI_API_KEY"]);
  });
});

describe("runSecretMigration — policy exceptions", () => {
  it("never migrates WEB_AUTH", () => {
    const io = fakeStore();
    const r = runSecretMigration([{ path: ENV, content: "WEB_AUTH=abc\nOPENAI_API_KEY=sk-x\n" }], io);
    expect(r.decisions.map(d => d.key)).toEqual(["OPENAI_API_KEY"]);
    expect(r.files[0].content).toBe("WEB_AUTH=abc\n");
    expect(io.store).not.toHaveProperty("WEB_AUTH");
  });

  it("preserves malformed and non-credential lines exactly", () => {
    const io = fakeStore();
    const content = [
      "SOME_WEIRD_LINE=1",
      "DEFAULT_PROVIDER=openrouter",
      "OPENAI_API_KEY=sk-x",
      "BROKEN no equals",
      "openai_api_key=lowercase",
    ].join("\n");
    const r = runSecretMigration([{ path: ENV, content }], io);
    expect(r.decisions.map(d => d.key)).toEqual(["OPENAI_API_KEY"]);
    expect(r.files[0].content).toBe([
      "SOME_WEIRD_LINE=1",
      "DEFAULT_PROVIDER=openrouter",
      "BROKEN no equals",
      "openai_api_key=lowercase",
    ].join("\n"));
  });

  it("is idempotent: second run finds the secret already stored", () => {
    const io = fakeStore();
    const first = runSecretMigration([{ path: ENV, content: "OPENAI_API_KEY=sk-x\n" }], io);
    expect(first.decisions[0].outcome).toBe("migrated");
    const second = runSecretMigration([{ path: ENV, content: first.files[0].content }], io);
    expect(second.decisions).toEqual([]);
  });
});
