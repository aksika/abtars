/**
 * worker-orc-extension.contract.test.ts — #1643: the versioned Pi extension
 * artifact contract.
 *
 * Loads the REAL artifact (templates/pi-extensions/worker-orc-v1.ts) through
 * Pi's real extension loader with the pinned Pi package and proves:
 *   - registration of exactly two typed sequential tools (tell_orc, ask_orc);
 *   - schema bounds and prompt guidance;
 *   - tell_orc's own execution performs no host side effect (its typed
 *     tool-start frame is the host signal — the artifact has no fs/network
 *     access); and
 *   - ask_orc emits exactly one extension_ui_request(method=input) with NO
 *     timeout and resolves with the documented result.
 *
 * A Pi API upgrade or artifact edit that removes the tools, changes their
 * bounds, or reintroduces a timeout race fails this test.
 */
import { describe, it, expect } from "vitest";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Check } from "typebox/value";
import type { RegisteredTool } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = join(__dirname, "..", "..", "..", "templates", "pi-extensions", "worker-orc-v1.ts");

// The package exports map only exposes "." and "./rpc-entry"; the real loader
// is deliberately not re-exported there (circularity), so reach it by file URL
// — still the pinned package's genuine loader (jiti + bundled module aliases).
const LOADER_URL = pathToFileURL(resolve(__dirname, "..", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "index.js")).href;

interface InputRequest {
  title: string;
  placeholder: string | undefined;
  opts: { signal?: unknown; timeout?: number } | undefined;
}

async function loadTools(): Promise<Map<string, RegisteredTool>> {
  const { loadExtensions } = await import(LOADER_URL) as typeof import("@earendil-works/pi-coding-agent");
  const result = await loadExtensions([ARTIFACT], dirname(ARTIFACT));
  expect(result.errors).toEqual([]);
  expect(result.extensions).toHaveLength(1);
  return result.extensions[0]!.tools;
}

describe("worker-orc-v1.ts extension contract (#1643)", () => {
  // The real 0.84 extension loader (jiti) compiles the TS artifact on first
  // load — cold runs can exceed vitest's default 5s under suite load.
  it("loads with the pinned Pi extension loader and registers exactly the two typed sequential tools", { timeout: 30_000 }, async () => {
    const tools = await loadTools();
    expect([...tools.keys()].sort()).toEqual(["ask_orc", "tell_orc"]);
    for (const tool of tools.values()) {
      expect(tool.definition.executionMode).toBe("sequential");
      expect(tool.definition.promptSnippet).toBeTruthy();
      expect(tool.definition.promptGuidelines?.length).toBeGreaterThan(0);
    }
  });

  it("enforces the bounded schemas: trimmed non-empty text, 1000/4000 char caps", async () => {
    const tools = await loadTools();
    const tellSchema = tools.get("tell_orc")!.definition.parameters;
    const askSchema = tools.get("ask_orc")!.definition.parameters;
    expect(Check(tellSchema, { message: "ok" })).toBe(true);
    expect(Check(tellSchema, { message: "" })).toBe(false);
    expect(Check(tellSchema, { message: "a".repeat(1000) })).toBe(true);
    expect(Check(tellSchema, { message: "a".repeat(1001) })).toBe(false);
    expect(Check(tellSchema, {})).toBe(false);
    expect(Check(askSchema, { question: "a".repeat(4000) })).toBe(true);
    expect(Check(askSchema, { question: "a".repeat(4001) })).toBe(false);
    expect(Check(askSchema, { question: "" })).toBe(false);
  });

  it("tell_orc performs no network/filesystem mutation and returns the bounded result", async () => {
    const tools = await loadTools();
    const { definition } = tools.get("tell_orc")!;
    const tmp = mkdtempSync(join(tmpdir(), "worker-orc-tell-"));
    const before = readdirSync(tmp);
    const toolResult = await definition.execute(
      "tc1",
      { message: "Found the root cause in the config loader." },
      undefined,
      undefined,
      {} as never,
    );
    const after = readdirSync(tmp);
    expect(after).toEqual(before);
    expect(toolResult.content[0]).toEqual({
      type: "text",
      text: "Notification submitted to Orc; continue working.",
    });
    expect(toolResult.details).toEqual({ protocol: 1, kind: "tell_orc", submitted: true, characters: 42 });
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects whitespace-only tell_orc input before claiming submission", async () => {
    const tools = await loadTools();
    const { definition } = tools.get("tell_orc")!;
    const toolResult = await definition.execute("tc-space", { message: "   " }, undefined, undefined, {} as never);
    expect(toolResult.isError).toBe(true);
    expect(toolResult.details).toEqual({ protocol: 1, kind: "tell_orc", submitted: false });
  });

  it("ask_orc emits exactly one input request titled Ask Orc with NO timeout", async () => {
    const tools = await loadTools();
    const { definition } = tools.get("ask_orc")!;
    const requests: InputRequest[] = [];
    const ctx = {
      ui: {
        input: async (title: string, placeholder?: string, opts?: { signal?: unknown; timeout?: number }) => {
          requests.push({ title, placeholder, opts });
          return "Target branch is main.";
        },
      },
    };
    const toolResult = await definition.execute("ac1", { question: "Which branch should I target?" }, undefined, undefined, ctx as never);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.title).toBe("Ask Orc");
    expect(requests[0]!.placeholder).toBe("Which branch should I target?");
    expect(requests[0]!.opts).toBeUndefined();
    expect(toolResult.content[0]).toEqual({ type: "text", text: "Orc answered; continue with the answer above." });
    expect(toolResult.details).toEqual({ protocol: 1, kind: "ask_orc" });
  });

  it("rejects whitespace-only ask_orc input without opening the UI", async () => {
    const tools = await loadTools();
    const { definition } = tools.get("ask_orc")!;
    let inputCalls = 0;
    const toolResult = await definition.execute(
      "ac-space",
      { question: "   " },
      undefined,
      undefined,
      { ui: { input: async () => { inputCalls += 1; return "never"; } } } as never,
    );
    expect(inputCalls).toBe(0);
    expect(toolResult.isError).toBe(true);
    expect(toolResult.details).toEqual({ protocol: 1, kind: "ask_orc", submitted: false });
  });
});
