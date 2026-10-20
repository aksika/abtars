/**
 * pi-runtime.test.ts — Pi-managed runtime bridge (#1757).
 *
 * The Pi installation loader is bypassed via setPiRuntimeForTest: tests prove
 * the readiness/dispatch/error contract against a fake runtime, never real
 * credentials. Live Pi behavior is covered by the production runtime report
 * (surface check) plus a real-auth verification during implementation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  checkPiManagedAuth,
  checkPiManagedSelection,
  isPiManagedModelKnown,
  piRuntimeModelsForProvider,
  refreshPiRuntime,
  resetPiRuntimeForTest,
  setPiRuntimeForTest,
} from "./pi-runtime.js";

function fakeRuntime(overrides?: {
  checkAuth?: (providerId: string) => Promise<{ type: string } | undefined>;
  getModel?: (providerId: string, modelId: string) => { id: string; reasoning: boolean } | undefined;
  getModels?: (providerId?: string) => Array<{ id: string; cost: { input: number; output: number }; contextWindow: number }>;
  streamSimple?: (...args: unknown[]) => unknown;
  refresh?: (...args: unknown[]) => Promise<unknown>;
}): ModelRuntime {
  return {
    checkAuth: overrides?.checkAuth ?? (async () => ({ type: "api_key" })),
    getModel: overrides?.getModel ?? (() => ({ id: "m", reasoning: true })),
    getModels: overrides?.getModels ?? (() => []),
    streamSimple: overrides?.streamSimple ?? (() => ({ ok: true })),
    refresh: overrides?.refresh ?? (async () => ({ aborted: false, errors: new Map<string, Error>() })),
  } as unknown as ModelRuntime;
}

beforeEach(() => {
  resetPiRuntimeForTest();
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

describe("refreshPiRuntime (#1875)", () => {
  it("rebuilds the snapshot local-only and reports ok", async () => {
    const refresh = vi.fn(async (..._args: unknown[]) => ({ aborted: false, errors: new Map<string, Error>() }));
    setPiRuntimeForTest(fakeRuntime({ refresh }));
    await expect(refreshPiRuntime()).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    const opts = refresh.mock.calls[0]![0] as { allowNetwork?: boolean };
    expect(opts.allowNetwork).toBe(false);
  });

  it("returns false without throwing when the rebuild rejects", async () => {
    setPiRuntimeForTest(fakeRuntime({
      refresh: async () => { throw new Error("store locked"); },
    }));
    await expect(refreshPiRuntime()).resolves.toBe(false);
  });

  it("returns false when no runtime is available", async () => {
    setPiRuntimeForTest(null);
    await expect(refreshPiRuntime()).resolves.toBe(false);
  });

  it("shares one rebuild across concurrent callers", async () => {
    let rebuilds = 0;
    const refresh = async (..._args: unknown[]): Promise<unknown> => {
      rebuilds++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { aborted: false, errors: new Map<string, Error>() };
    };
    setPiRuntimeForTest(fakeRuntime({ refresh }));
    const [a, b] = await Promise.all([refreshPiRuntime(), refreshPiRuntime()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(rebuilds).toBe(1);
  });
});

describe("piRuntimeModelsForProvider (#1875 menu source)", () => {
  it("maps the runtime's composed models to the picker shape", async () => {
    setPiRuntimeForTest(fakeRuntime({
      getModels: () => [
        { id: "deepseek-v4.1-flash", cost: { input: 0.14, output: 0.28 }, contextWindow: 200000 },
      ],
    }));
    const out = await piRuntimeModelsForProvider("opencode-go");
    expect(out).toEqual([
      { id: "deepseek-v4.1-flash", cost: { input: 0.14, output: 0.28 }, contextWindow: 200000 },
    ]);
  });

  it("returns null for providers with no Pi mapping", async () => {
    setPiRuntimeForTest(fakeRuntime());
    await expect(piRuntimeModelsForProvider("ollama")).resolves.toBeNull();
  });

  it("returns null when no runtime is available", async () => {
    setPiRuntimeForTest(null);
    await expect(piRuntimeModelsForProvider("opencode-go")).resolves.toBeNull();
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
