import { describe, it, expect } from "vitest";
import { SecurityGate } from "./security-gate.js";
import type { UserRegistry, UserEntry } from "./user-registry.js";

function makeRegistry(users: Array<{ userId: string; role: "master" | "user" | "guest"; telegram?: number; allowedChats?: string[] }>): UserRegistry {
  const registry: UserRegistry = { users: [], byPlatformId: new Map(), byUserId: new Map() };
  for (const u of users) {
    const entry: UserEntry = { userId: u.userId, role: u.role, maxClass: u.role === "master" ? 3 : 0, tools: [], platforms: { telegram: u.telegram }, allowedChats: u.allowedChats };
    registry.users.push(entry);
    registry.byUserId.set(u.userId, entry);
    if (u.telegram) registry.byPlatformId.set(`telegram:${u.telegram}`, entry);
  }
  return registry;
}

describe("SecurityGate", () => {
  it("throws when constructed with empty registry", () => {
    expect(() => new SecurityGate({ users: [], byPlatformId: new Map(), byUserId: new Map() })).toThrow("at least one");
  });

  it("authorizes a registered user", () => {
    const gate = new SecurityGate(makeRegistry([{ userId: "aksika", role: "master", telegram: 42 }]));
    const result = gate.authorize("42", "telegram");
    expect(result.authorized).toBe(true);
    expect(result.user?.userId).toBe("aksika");
  });

  it("rejects an unknown user", () => {
    const gate = new SecurityGate(makeRegistry([{ userId: "aksika", role: "master", telegram: 42 }]));
    expect(gate.authorize("999", "telegram").authorized).toBe(false);
  });

  it("authorizeById works for legacy callers", () => {
    const gate = new SecurityGate(makeRegistry([{ userId: "aksika", role: "master", telegram: 42 }]));
    expect(gate.authorizeById("42")).toBe(true);
    expect(gate.authorizeById("999")).toBe(false);
  });

  it("allows all chats when allowedChats is empty", () => {
    const gate = new SecurityGate(makeRegistry([{ userId: "aksika", role: "master", telegram: 42 }]));
    expect(gate.authorize("42", "telegram", "any-chat").authorized).toBe(true);
  });

  it("restricts to allowedChats when set", () => {
    const gate = new SecurityGate(makeRegistry([{ userId: "aksika", role: "master", telegram: 42, allowedChats: ["ch1", "ch2"] }]));
    expect(gate.authorize("42", "telegram", "ch1").authorized).toBe(true);
    expect(gate.authorize("42", "telegram", "ch3").authorized).toBe(false);
  });

  it("authorizeById checks allowedChats", () => {
    const gate = new SecurityGate(makeRegistry([{ userId: "aksika", role: "master", telegram: 42, allowedChats: ["ch1"] }]));
    expect(gate.authorizeById("42", "ch1")).toBe(true);
    expect(gate.authorizeById("42", "ch9")).toBe(false);
  });
});
