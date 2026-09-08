/**
 * peer-sessions.test.ts — #1786 conversation ownership.
 *
 * Store key binds caller + peer. Unknown/expired IDs fail; only omission
 * allocates. Expiry is lazy. One in-flight turn per conversation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getOrCreateSession,
  addTurn,
  tryBeginTurn,
  endTurn,
  isEnded,
  destroySession,
} from "./peer-sessions.js";

describe("peer-sessions ownership (#1786)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allocates on omission and binds caller + peer", () => {
    const r = getOrCreateSession(undefined, "molty", "user-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.peerName).toBe("molty");
    expect(r.session.callerId).toBe("user-1");
  });

  it("resolves the same conversation for the same caller + peer", () => {
    const a = getOrCreateSession(undefined, "molty", "user-1");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = getOrCreateSession(a.session.id, "molty", "user-1");
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.session.id).toBe(a.session.id);
  });

  it("rejects reuse across peers", () => {
    const a = getOrCreateSession(undefined, "molty", "user-1");
    if (!a.ok) return;
    const b = getOrCreateSession(a.session.id, "kp", "user-1");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe("session_mismatch");
  });

  it("rejects reuse across callers", () => {
    const a = getOrCreateSession(undefined, "molty", "user-1");
    if (!a.ok) return;
    const b = getOrCreateSession(a.session.id, "molty", "user-2");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe("session_mismatch");
  });

  it("expires unknown and idle-timed-out IDs", () => {
    expect(getOrCreateSession("nope", "molty", "user-1")).toMatchObject({ ok: false, code: "session_expired" });
    const a = getOrCreateSession(undefined, "molty", "user-1");
    if (!a.ok) return;
    vi.setSystemTime(1_000_000 + 5 * 60 * 1000 + 1);
    expect(getOrCreateSession(a.session.id, "molty", "user-1")).toMatchObject({ ok: false, code: "session_expired" });
  });

  it("serializes turns with an in-flight guard", () => {
    const a = getOrCreateSession(undefined, "molty", "user-1");
    if (!a.ok) return;
    expect(tryBeginTurn(a.session)).toBe(true);
    expect(tryBeginTurn(a.session)).toBe(false);
    endTurn(a.session);
    expect(tryBeginTurn(a.session)).toBe(true);
    endTurn(a.session);
  });

  it("preserves ten-exchange cap and end markers", () => {
    const a = getOrCreateSession(undefined, "molty", "user-1");
    if (!a.ok) return;
    for (let i = 0; i < 20; i++) addTurn(a.session, i % 2 === 0 ? "user" : "assistant", `m${i}`);
    expect(isEnded(a.session, "plain")).toEqual({ ended: true, reason: "max-turns" });
    destroySession(a.session.id);
    const b = getOrCreateSession(undefined, "molty", "user-1");
    if (!b.ok) return;
    addTurn(b.session, "user", "hi");
    expect(isEnded(b.session, "see you [END]")).toEqual({ ended: true, reason: "peer-signal" });
  });
});
