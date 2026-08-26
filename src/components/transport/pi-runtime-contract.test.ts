/**
 * pi-runtime-contract.test.ts — #1573 probe contract evidence.
 *
 * The probe's only external boundaries are `resolveInstallation` and
 * `loadModule`; tests inject fake boundaries returning module-shaped objects
 * and never exercise the real Pi installation. Each missing capability maps
 * to the typed bounded error with the pinned install command, API families
 * are deduplicated, no inspected function is invoked, and a repaired fixture
 * can retry after a prior failure.
 */

import { describe, it, expect, vi } from "vitest";
import { validatePiRuntimeContract, PiRuntimeContractError } from "./pi-runtime-contract.js";
import type { PiInstallation, PiModuleSpecifier, PiInstallationState } from "../pi-installation.js";
import type { PiRuntimeContractDependencies } from "./pi-runtime-contract.js";

const PINNED_INSTALL_COMMAND = "npm i -g '@earendil-works/pi-coding-agent@~0.84.2'";

function makeInstallation(version = "0.84.0"): PiInstallation {
  return {
    executable: "/opt/pi/bin/pi",
    packageRoot: "/opt/pi",
    version,
    source: "path",
    pinStatus: "above-pin",
    moduleRoots: { ai: "/opt/pi/node_modules/@earendil-works/pi-ai", tui: "/opt/pi/node_modules/@earendil-works/pi-tui", agentCore: "/opt/pi/node_modules/@earendil-works/pi-agent-core" },
  };
}

function makeAgentCoreModule(): Record<string, unknown> {
  return {
    Agent: class FakeAgent {
      subscribe(): void {}
      prompt(): void {}
      steer(): void {}
      followUp(): void {}
      clearAllQueues(): void {}
      abort(): void {}
      waitForIdle(): void {}
    },
  };
}

function makeAiModule(): Record<string, unknown> {
  return { createProvider: vi.fn() };
}

function makeApiModule(): Record<string, unknown> {
  return { stream: vi.fn(), streamSimple: vi.fn() };
}

interface FakeBoundary {
  state: PiInstallationState;
  modules: Map<string, unknown>;
  loadModule: ReturnType<typeof vi.fn>;
  resolveInstallation: ReturnType<typeof vi.fn>;
  calls: string[];
}

function makeDependencies(options?: {
  state?: PiInstallationState;
  modules?: Record<string, unknown>;
}): FakeBoundary & { deps: PiRuntimeContractDependencies } {
  const modules = new Map(Object.entries(options?.modules ?? {}));
  const calls: string[] = [];
  const loadModule = vi.fn(async (_installation: PiInstallation, specifier: PiModuleSpecifier) => {
    const key = specifier.subpath ? `${specifier.package}/${specifier.subpath}` : specifier.package;
    calls.push(key);
    const mod = modules.get(key);
    if (mod === undefined) throw new Error(`module not present: ${key}`);
    return mod;
  });
  const resolveInstallation = vi.fn(() => options?.state ?? { state: "compatible", installation: makeInstallation() });
  return {
    state: options?.state ?? { state: "compatible", installation: makeInstallation() },
    modules,
    loadModule,
    resolveInstallation,
    calls,
    deps: { loadModule, resolveInstallation },
  };
}

function contractDeps(boundary: FakeBoundary): PiRuntimeContractDependencies {
  return boundary.deps;
}

describe("validatePiRuntimeContract (#1573)", () => {
  it("resolves when the complete contract holds and loads each unique API family once", async () => {
    const boundary = makeDependencies({
      modules: {
        "@earendil-works/pi-agent-core": makeAgentCoreModule(),
        "@earendil-works/pi-ai": makeAiModule(),
        "@earendil-works/pi-ai/api/openai-completions": makeApiModule(),
        "@earendil-works/pi-ai/api/openai-responses": makeApiModule(),
        "@earendil-works/pi-ai/api/anthropic-messages": makeApiModule(),
      },
    });
    const candidates = [
      { apiFormat: "chat" as const },
      { apiFormat: undefined },
      { apiFormat: "chat" as const },
      { apiFormat: "responses" as const },
      { apiFormat: "anthropic" as const },
    ];
    await expect(validatePiRuntimeContract(candidates, contractDeps(boundary))).resolves.toBeUndefined();
    expect(boundary.resolveInstallation).toHaveBeenCalledTimes(1);
    expect(boundary.calls).toEqual([
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-ai/api/openai-completions",
      "@earendil-works/pi-ai/api/openai-responses",
      "@earendil-works/pi-ai/api/anthropic-messages",
    ]);
  });

  it("rejects an absent installation with the pinned remediation command", async () => {
    const boundary = makeDependencies({ state: { state: "absent" } });
    const error = await validatePiRuntimeContract([], contractDeps(boundary)).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PiRuntimeContractError);
    const contractError = error as PiRuntimeContractError;
    expect(contractError.component).toBe("installation");
    expect(contractError.capability).toBe("absent");
    expect(contractError.remediationCommand).toBe(PINNED_INSTALL_COMMAND);
    expect(contractError.message).toContain("Pi runtime contract incompatible");
    expect(contractError.message).toContain(PINNED_INSTALL_COMMAND);
    expect(contractError.message).not.toContain("Error:");
  });

  it("rejects an agent-core import failure with cause retained", async () => {
    const boundary = makeDependencies({
      modules: { "@earendil-works/pi-agent-core": undefined },
    });
    const loaderError = new Error("Cannot find module '@earendil-works/pi-agent-core'");
    boundary.loadModule.mockRejectedValueOnce(loaderError);
    const error = await validatePiRuntimeContract([], contractDeps(boundary)).catch((err: unknown) => err);
    const contractError = error as PiRuntimeContractError;
    expect(contractError.component).toBe("pi-agent-core");
    expect(contractError.capability).toBe("module-load");
    expect(contractError.cause).toBe(loaderError);
    expect(contractError.message).not.toContain("Cannot find module");
  });

  it("rejects missing Agent methods with the exact method capability", async () => {
    const boundary = makeDependencies({
      modules: {
        "@earendil-works/pi-agent-core": { Agent: class FakeAgent { subscribe(): void {} prompt(): void {} steer(): void {} followUp(): void {} clearAllQueues(): void {} abort(): void {} } },
      },
    });
    const error = await validatePiRuntimeContract([], contractDeps(boundary)).catch((err: unknown) => err);
    const contractError = error as PiRuntimeContractError;
    expect(contractError.component).toBe("pi-agent-core");
    expect(contractError.capability).toBe("waitForIdle");
    expect(contractError.message).toContain("missing waitForIdle");
  });

  it("rejects a pi-ai module without callable createProvider", async () => {
    const boundary = makeDependencies({
      modules: {
        "@earendil-works/pi-agent-core": makeAgentCoreModule(),
        "@earendil-works/pi-ai": { createProvider: "not-a-function" },
      },
    });
    const error = await validatePiRuntimeContract([], contractDeps(boundary)).catch((err: unknown) => err);
    const contractError = error as PiRuntimeContractError;
    expect(contractError.component).toBe("pi-ai");
    expect(contractError.capability).toBe("createProvider");
    expect(contractError.message).toContain("missing createProvider");
    expect(contractError.message).toContain("0.84.0");
    expect(contractError.message).toContain(PINNED_INSTALL_COMMAND);
  });

  it("rejects each api family missing stream or streamSimple with its family component", async () => {
    const boundary = makeDependencies({
      modules: {
        "@earendil-works/pi-agent-core": makeAgentCoreModule(),
        "@earendil-works/pi-ai": makeAiModule(),
        "@earendil-works/pi-ai/api/openai-completions": { stream: vi.fn() },
      },
    });
    const error = await validatePiRuntimeContract([{ apiFormat: "chat" }], contractDeps(boundary)).catch((err: unknown) => err);
    const contractError = error as PiRuntimeContractError;
    expect(contractError.component).toBe("openai-completions");
    expect(contractError.capability).toBe("streamSimple");
    expect(contractError.message).toContain("missing streamSimple");
  });

  it("rejects a missing api subpath as module-load without leaking the loader message", async () => {
    const boundary = makeDependencies({
      modules: {
        "@earendil-works/pi-agent-core": makeAgentCoreModule(),
        "@earendil-works/pi-ai": makeAiModule(),
      },
    });
    const error = await validatePiRuntimeContract([{ apiFormat: "responses" }], contractDeps(boundary)).catch((err: unknown) => err);
    const contractError = error as PiRuntimeContractError;
    expect(contractError.component).toBe("openai-responses");
    expect(contractError.capability).toBe("module-load");
    expect(contractError.message).toContain("load failed");
    expect(contractError.message).not.toContain("module not present");
  });

  it("invokes none of the inspected functions or constructors", async () => {
    const createProvider = vi.fn();
    const stream = vi.fn();
    const streamSimple = vi.fn();
    const subscribe = vi.fn();
    const boundary = makeDependencies({
      modules: {
        "@earendil-works/pi-agent-core": {
          Agent: class FakeAgent { subscribe(): void { subscribe(); } prompt(): void {} steer(): void {} followUp(): void {} clearAllQueues(): void {} abort(): void {} waitForIdle(): void {} },
        },
        "@earendil-works/pi-ai": { createProvider },
        "@earendil-works/pi-ai/api/openai-completions": { stream, streamSimple },
        "@earendil-works/pi-ai/api/anthropic-messages": { stream, streamSimple },
      },
    });
    await validatePiRuntimeContract(
      [{ apiFormat: "chat" }, { apiFormat: "anthropic" }, { apiFormat: undefined }],
      contractDeps(boundary),
    );
    expect(createProvider).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(streamSimple).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("retries successfully after a prior injected failure once the fixture is repaired", async () => {
    const aiModule = makeAiModule();
    const boundary = makeDependencies({
      modules: {
        "@earendil-works/pi-agent-core": makeAgentCoreModule(),
        "@earendil-works/pi-ai": aiModule,
        "@earendil-works/pi-ai/api/openai-completions": { stream: vi.fn() },
      },
    });
    const first = await validatePiRuntimeContract([{ apiFormat: "chat" }], contractDeps(boundary)).catch((err: unknown) => err);
    expect(first).toBeInstanceOf(PiRuntimeContractError);
    expect((first as PiRuntimeContractError).capability).toBe("streamSimple");

    boundary.modules.set("@earendil-works/pi-ai/api/openai-completions", makeApiModule());
    await expect(validatePiRuntimeContract([{ apiFormat: "chat" }], contractDeps(boundary))).resolves.toBeUndefined();
  });
});
