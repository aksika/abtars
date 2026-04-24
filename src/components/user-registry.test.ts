import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadUsers, setUserRegistryOverride, type UserEntry, type UserRegistry } from "./user-registry.js";

function buildRegistry(users: UserEntry[]): UserRegistry {
  const byPlatformId = new Map<string, UserEntry>();
  const byUserId = new Map<string, UserEntry>();
  for (const u of users) {
    byUserId.set(u.userId, u);
    if (u.platforms.telegram) byPlatformId.set(`telegram:${u.platforms.telegram}`, u);
    if (u.platforms.discord) byPlatformId.set(`discord:${u.platforms.discord}`, u);
  }
  return { users, byPlatformId, byUserId };
}

describe("user-registry", () => {
  afterEach(() => { setUserRegistryOverride(null); });

  it("override returns provided users", () => {
    const users: UserEntry[] = [
      { userId: "aksika", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 42 } },
      { userId: "guest1", role: "guest", maxClass: 0, tools: [], platforms: { discord: "99" } },
    ];
    setUserRegistryOverride(buildRegistry(users));
    const reg = loadUsers();
    expect(reg.users.length).toBe(2);
    expect(reg.byUserId.get("aksika")?.role).toBe("master");
    expect(reg.byPlatformId.get("telegram:42")?.userId).toBe("aksika");
    expect(reg.byPlatformId.get("discord:99")?.userId).toBe("guest1");
  });

  it("allowedChats field is preserved", () => {
    const users: UserEntry[] = [
      { userId: "test", role: "user", maxClass: 1, tools: [], platforms: { telegram: 1 }, allowedChats: ["ch1", "ch2"] },
    ];
    setUserRegistryOverride(buildRegistry(users));
    expect(loadUsers().byUserId.get("test")?.allowedChats).toEqual(["ch1", "ch2"]);
  });

  it("clearing override restores default behavior", () => {
    setUserRegistryOverride(buildRegistry([{ userId: "x", role: "guest", maxClass: 0, tools: [], platforms: {} }]));
    expect(loadUsers().users.length).toBe(1);
    setUserRegistryOverride(null);
    // After clearing, loadUsers reads from disk (may return any number of users)
    const reg = loadUsers();
    expect(reg.users).toBeDefined();
  });
});
