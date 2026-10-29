import { describe, it, expect } from "vitest";
import { SealedSecretHandles } from "./sealed-secret-handles.js";

describe("SealedSecretHandles", () => {
  it("issues unguessable prefixed tokens bound to execution, owner and revision", () => {
    const handles = new SealedSecretHandles();
    const token = handles.issue({ executionId: "exec-1", userId: "u1", memoryId: 7, semanticRevision: 3 });
    expect(token).toMatch(/^secret:[A-Za-z0-9_-]+$/);
    const binding = handles.lookup(token, { executionId: "exec-1", userId: "u1" });
    expect(binding).toEqual({
      executionId: "exec-1",
      userId: "u1",
      memoryId: 7,
      semanticRevision: 3,
      expiresAt: expect.any(Number),
    });
  });

  it("fails closed for forged, wrong-owner and wrong-execution tokens", () => {
    const handles = new SealedSecretHandles();
    const token = handles.issue({ executionId: "exec-1", userId: "u1", memoryId: 7, semanticRevision: 1 });
    expect(handles.lookup("secret:forged", { executionId: "exec-1", userId: "u1" })).toBeNull();
    expect(handles.lookup("not-a-handle", { executionId: "exec-1", userId: "u1" })).toBeNull();
    expect(handles.lookup(token, { executionId: "exec-2", userId: "u1" })).toBeNull();
    expect(handles.lookup(token, { executionId: "exec-1", userId: "u2" })).toBeNull();
  });

  it("expires bindings and drops them on lookup", () => {
    const handles = new SealedSecretHandles();
    const token = handles.issue({ executionId: "e", userId: "u", memoryId: 1, semanticRevision: 1, ttlMs: -1 });
    expect(handles.lookup(token, { executionId: "e", userId: "u" })).toBeNull();
    expect(handles.size).toBe(0);
  });

  it("revokes every binding of an execution and clears on transport close", () => {
    const handles = new SealedSecretHandles();
    handles.issue({ executionId: "e1", userId: "u", memoryId: 1, semanticRevision: 1 });
    handles.issue({ executionId: "e1", userId: "u", memoryId: 2, semanticRevision: 1 });
    handles.issue({ executionId: "e2", userId: "u", memoryId: 3, semanticRevision: 1 });
    expect(handles.revokeExecution("e1")).toBe(2);
    expect(handles.size).toBe(1);
    handles.clear();
    expect(handles.size).toBe(0);
  });
});
