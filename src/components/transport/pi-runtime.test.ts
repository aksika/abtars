/**
 * pi-runtime.test.ts — Pi-managed runtime bridge (#1757).
 *
 * The Pi installation loader is bypassed via setPiRuntimeForTest: tests prove
 * the readiness/dispatch/error contract against a fake runtime, never real
 * credentials. Live Pi behavior is covered by the production runtime report
 * (surface check) plus a real-auth verification during implementation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  checkPiManagedAuth,
  checkPiManagedSelection,
  isPiAuthAbsenceMessage,
  isPiManagedModelKnown,
  PiManagedAuthError,
  resetPiRuntimeForTest,
  setPiRuntimeForTest,
  streamPiManaged,
} from "./pi-runtime.js";

function fakeRuntime(overrides?: {
  checkAuth?: (providerId: string) => Promise<{ type: string } | undefined>;
  getModel?: (providerId: string, modelId: string) => { id: string; reasoning: boolean } | undefined;
  streamSimple?: (...args: unknown[]) => unknown;
}): ModelRuntime {
  return {
    checkAuth: overrides?.checkAuth ?? (async () => ({ type: "api_key" })),
    getModel: overrides?.getModel ?? (() => ({ id: "m", reasoning: true })),
    streamSimple: overrides?.streamSimple ?? (() => ({ ok: true })),
  } as unknown as ModelRuntime;
}

beforeEach(() => {
  resetPiRuntimeForTest();
});

describe("isPiAuthAbsenceMessage (#1757)", () => {
  it("matches credential-absence phrasings", () => {
    for (const msg of [
      "No API key for provider: openrouter",
      "Provider is not configured",
      "Model needs-login",
      "OAuth login expired",
      "Invalid API key",
      "authentication failed",
    ]) {
      expect(isPiAuthAbsenceMessage(msg), msg).toBe(true);
    }
  });

  it("does not match ordinary provider errors", () => {
    for (const msg of [
      "429 rate_limited: slow down",
      "context_overflow: too many tokens",
      "Request was aborted",
      "Stream ended without finish_reason",
    ]) {
      expect(isPiAuthAbsenceMessage(msg), msg).toBe(false);
    }
  });
});

describe("checkPiManagedAuth (#1757)", () => {
  it("reports unconfigured for providers with no Pi mapping", async () => {
    const r = await checkPiManagedAuth("definitely-not-a-pi-provider");
    expect(r.ok).toBe(false);
    expect(r.state).toBe("unconfigured");
  });

  it("reports usable when Pi checkAuth resolves", async () => {
    setPiRuntimeForTest(fakeRuntime());
    const r = await checkPiManagedAuth("openrouter");
    expect(r).toMatchObject({ ok: true, state: "usable" });
    expect(r.detail).toContain("openrouter");
    expect(r.detail).not.toContain("sk-");
  });

  it("reports needs-login when Pi has no credential", async () => {
    setPiRuntimeForTest(fakeRuntime({ checkAuth: async () => undefined }));
    const r = await checkPiManagedAuth("openrouter");
    expect(r).toMatchObject({ ok: false, state: "needs-login" });
    expect(r.detail).toContain("pi auth check --provider openrouter");
  });

  it("reports needs-login when the credential check rejects", async () => {
    setPiRuntimeForTest(fakeRuntime({
      checkAuth: async () => { throw new Error("store locked"); },
    }));
    const r = await checkPiManagedAuth("openrouter");
    expect(r).toMatchObject({ ok: false, state: "needs-login" });
  });

  it("passes Pi's diagnostic text through in detail strings", async () => {
    setPiRuntimeForTest(fakeRuntime({
      checkAuth: async () => { throw new Error("leaked sk-or-SENTINEL should surface"); },
    }));
    const r = await checkPiManagedAuth("openrouter");
    expect(r.detail).toContain("sk-or-SENTINEL should surface");
  });
});

describe("checkPiManagedSelection (#1757)", () => {
  it("passes non-Pi-managed providers through without a runtime", async () => {
    const r = await checkPiManagedSelection("openrouter", {});
    expect(r).toEqual({ ok: true });
  });

  it("gates Pi-managed providers on live Pi auth", async () => {
    setPiRuntimeForTest(fakeRuntime({ checkAuth: async () => undefined }));
    const r = await checkPiManagedSelection("openrouter", { authSource: "pi" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("pi auth check");
  });
});

describe("streamPiManaged (#1757)", () => {
  it("rejects unknown provider mappings without touching a runtime", async () => {
    await expect(streamPiManaged("definitely-not-a-pi-provider", "m", { messages: [] })).rejects.toThrow(/no Pi provider mapping/);
  });

  it("maps missing login to an auth-kind (401) error", async () => {
    setPiRuntimeForTest(fakeRuntime({ checkAuth: async () => undefined }));
    const err = await streamPiManaged("openrouter", "m", { messages: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PiManagedAuthError);
    expect((err as PiManagedAuthError).status).toBe(401);
  });

  it("maps credential-check rejection to an auth-kind (401) error", async () => {
    setPiRuntimeForTest(fakeRuntime({
      checkAuth: async () => { throw new Error("store failure"); },
    }));
    const err = await streamPiManaged("openrouter", "m", { messages: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PiManagedAuthError);
    expect((err as PiManagedAuthError).status).toBe(401);
  });

  it("leaves unknown models as plain transient errors (fallback proceeds)", async () => {
    setPiRuntimeForTest(fakeRuntime({ getModel: () => undefined }));
    const err = await streamPiManaged("openrouter", "nope", { messages: [] }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PiManagedAuthError);
    expect(err).toBeInstanceOf(Error);
  });

  it("dispatches through the runtime with no abtars key", async () => {
    const seen: unknown[] = [];
    const stream = { fake: "stream" };
    setPiRuntimeForTest(fakeRuntime({
      streamSimple: (...args: unknown[]) => { seen.push(args); return stream; },
    }));
    const out = await streamPiManaged("openrouter", "m", { messages: [] }, { signal: undefined as unknown as AbortSignal });
    expect(out).toBe(stream);
    const [, , options] = seen[0] as [unknown, unknown, Record<string, unknown>];
    expect(options).not.toHaveProperty("apiKey");
  });

  it("overlays the session reasoning flag without touching Pi's endpoint semantics", async () => {
    const seen: unknown[] = [];
    setPiRuntimeForTest(fakeRuntime({
      getModel: () => ({ id: "m", provider: "openrouter", baseUrl: "https://pi.example/v1", reasoning: true }),
      streamSimple: (...args: unknown[]) => { seen.push(args); return { fake: "stream" }; },
    }));
    await streamPiManaged("openrouter", "m", { messages: [] }, undefined, false);
    const [model] = seen[0] as Array<Record<string, unknown>>;
    if (model === undefined) throw new Error("expected dispatched model arg");
    expect(model["reasoning"]).toBe(false);
    expect(model["baseUrl"]).toBe("https://pi.example/v1");
  });

  it("adds opencode session attribution from the shared session id only", async () => {
    const seen: unknown[] = [];
    setPiRuntimeForTest(fakeRuntime({
      getModel: () => ({ id: "m", provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", reasoning: true }),
      streamSimple: (...args: unknown[]) => { seen.push(args); return { fake: "stream" }; },
    }));
    await streamPiManaged(
      "opencode-go",
      "m",
      { messages: [] },
      { sessionId: "cache-session-1" } as never,
    );
    const [, , options] = seen[0] as Array<Record<string, unknown>>;
    if (options === undefined) throw new Error("expected dispatched options arg");
    const merged = await (options["transformHeaders"] as (h: Record<string, string>) => Promise<Record<string, string>>)({});
    expect(merged["x-opencode-session"]).toBe("cache-session-1");
    expect(merged).not.toHaveProperty("apiKey");
  });

  it("skips session attribution for non-opencode providers", async () => {
    const seen: unknown[] = [];
    setPiRuntimeForTest(fakeRuntime({
      streamSimple: (...args: unknown[]) => { seen.push(args); return { fake: "stream" }; },
    }));
    await streamPiManaged(
      "openrouter",
      "m",
      { messages: [] },
      { sessionId: "cache-session-1" } as never,
    );
    const [, , options] = seen[0] as Array<Record<string, unknown>>;
    expect(options).not.toHaveProperty("transformHeaders");
  });
});

describe("isPiManagedModelKnown (#1757)", () => {
  it("reflects the runtime catalog without dispatching", async () => {
    setPiRuntimeForTest(fakeRuntime({ getModel: ( _p, m) => (m === "known" ? { id: "known", reasoning: true } : undefined) }));
    expect(await isPiManagedModelKnown("openrouter", "known")).toBe(true);
    expect(await isPiManagedModelKnown("openrouter", "missing")).toBe(false);
    expect(await isPiManagedModelKnown("definitely-not-a-pi-provider", "known")).toBe(false);
  });

  it("returns false when the runtime is unavailable", async () => {
    expect(await isPiManagedModelKnown("openrouter", "known")).toBe(false);
  });
});

describe("PiManagedAuthError", () => {
  it("carries status 401 for the shared classifier", () => {
    const err = new PiManagedAuthError("nope");
    expect(err.status).toBe(401);
    expect(err.name).toBe("PiManagedAuthError");
  });
});

/*
 * TEST DEFICIENCY (2026-09-23):
 * Missing: real subscription/OAuth smoke through the Pi-managed path
 * (Anthropic, Copilot, or Codex per specs/1757 acceptance).
 * Reason deferred: no operator OAuth credential is available in this
 * environment (only an opencode-go API key); live dispatch is proven
 * against opencode-go with real Pi auth instead.
 * Future verification: configure a Pi OAuth login, set a Pi-managed
 * provider entry, and run one tiny turn; see specs/1757/tasks.md item 6.
 */
