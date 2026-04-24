import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { HOME } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  return { HOME: mkdtempSync(join(tmpdir(), "ab-user-reg-")) };
});

vi.mock("../paths.js", () => ({ agentBridgeHome: () => HOME }));

import { loadUsers, setUserRegistryOverride } from "./user-registry.js";

describe("user-registry", () => {
  beforeEach(() => {
    setUserRegistryOverride(null);
    mkdirSync(join(HOME, "config"), { recursive: true });
  });

  afterEach(() => {
    setUserRegistryOverride(null);
  });

  it("loads users from users.json", () => {
    writeFileSync(join(HOME, "config", "users.json"), JSON.stringify([
      { userId: "aksika", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 42 } },
      { userId: "guest1", role: "guest", maxClass: 0, tools: [], platforms: { discord: "99" } },
    ]));
    const reg = loadUsers();
    expect(reg.users.length).toBe(2);
    expect(reg.byUserId.get("aksika")?.role).toBe("master");
    expect(reg.byPlatformId.get("telegram:42")?.userId).toBe("aksika");
    expect(reg.byPlatformId.get("discord:99")?.userId).toBe("guest1");
  });

  it("override takes precedence", () => {
    const override = {
      users: [{ userId: "test", role: "master" as const, maxClass: 3, tools: [], platforms: {} }],
      byPlatformId: new Map(),
      byUserId: new Map([["test", { userId: "test", role: "master" as const, maxClass: 3, tools: [], platforms: {} }]]),
    };
    setUserRegistryOverride(override);
    expect(loadUsers().byUserId.get("test")?.userId).toBe("test");
  });

  it("falls back gracefully when no users.json", () => {
    const reg = loadUsers();
    expect(reg.users).toBeDefined();
  });
});
