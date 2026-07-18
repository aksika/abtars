import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectPiRuntimeSurfaces } from "./pi-inspector.js";
import type { PiInstallation } from "./pi-installation.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmpDir(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-inspector-"));
  roots.push(root);
  return root;
}

function makeInstallation(aiRoot: string, tuiRoot: string, agentCoreRoot: string): PiInstallation {
  return {
    executable: "/usr/bin/pi",
    packageRoot: "/usr/lib/pi-coding-agent",
    version: "0.80.7",
    source: "path",
    moduleRoots: { ai: aiRoot, tui: tuiRoot, agentCore: agentCoreRoot },
  };
}

function makeAiPackage(root: string, exports: unknown): void {
  mkdirSync(join(root, "dist", "api"), { recursive: true });
  mkdirSync(join(root, "dist", "providers"), { recursive: true });
  writeFileSync(join(root, "dist", "index.js"), "export const createProvider = () => {};\nexport const isRetryableAssistantError = () => false;\n");
  writeFileSync(join(root, "dist", "api", "openai-completions.js"), "export const stream = async function*(){};\nexport const streamSimple = async function*(){};\n");
  writeFileSync(join(root, "dist", "providers", "all.js"), "export const builtinModels = () => ({});\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", exports }));
}

function makeTuiPackage(root: string, exports: unknown): void {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.js"), "export class ProcessTerminal {}\nexport class TUI {}\nexport class Container {}\nexport class Editor {}\nexport class Text {}\nexport class Markdown {}\nexport function matchesKey() {}\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", exports }));
}

function makeAgentCorePackage(root: string, exports: unknown): void {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.js"), "export const x = 1;\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-agent-core", exports }));
}

describe("inspectPiRuntimeSurfaces", () => {
  it("all surfaces loadable for a valid ESM-only installation", () => {
    const dir = tmpDir();
    const ai = join(dir, "pi-ai");
    const tui = join(dir, "pi-tui");
    const core = join(dir, "pi-agent-core");
    makeAiPackage(ai, { ".": { import: "./dist/index.js" }, "./api/*": { import: "./dist/api/*.js" }, "./providers/*": { import: "./dist/providers/*.js" } });
    makeTuiPackage(tui, { ".": { import: "./dist/index.js" } });
    makeAgentCorePackage(core, { ".": { import: "./dist/index.js" } });
    const installation = makeInstallation(ai, tui, core);

    const result = inspectPiRuntimeSurfaces(installation);

    expect(result.ai.status).toBe("loadable");
    expect(result["ai-api"].status).toBe("loadable");
    expect(result["ai-providers"].status).toBe("loadable");
    expect(result.tui.status).toBe("loadable");
    expect(result["agent-core"].status).toBe("loadable");
  });

  it("reports unloadable when exports field is missing", () => {
    const dir = tmpDir();
    const ai = join(dir, "pi-ai");
    const tui = join(dir, "pi-tui");
    const core = join(dir, "pi-agent-core");
    makeAiPackage(ai, { ".": { import: "./dist/index.js" } });
    makeTuiPackage(tui, { ".": { import: "./dist/index.js" } });
    // agent-core has no exports field
    mkdirSync(join(core, "dist"), { recursive: true });
    writeFileSync(join(core, "package.json"), JSON.stringify({ name: "@earendil-works/pi-agent-core" }));
    const installation = makeInstallation(ai, tui, core);

    const result = inspectPiRuntimeSurfaces(installation);

    expect(result["agent-core"].status).toBe("unloadable");
    expect(typeof (result["agent-core"] as { status: "unloadable"; reason: string }).reason).toBe("string");
    expect(result.ai.status).toBe("loadable");
    expect(result.tui.status).toBe("loadable");
  });

  it("reports unloadable when subpath export is missing", () => {
    const dir = tmpDir();
    const ai = join(dir, "pi-ai");
    const tui = join(dir, "pi-tui");
    const core = join(dir, "pi-agent-core");
    // Only root export, no ./api/* wildcard
    makeAiPackage(ai, { ".": { import: "./dist/index.js" } });
    makeTuiPackage(tui, { ".": { import: "./dist/index.js" } });
    makeAgentCorePackage(core, { ".": { import: "./dist/index.js" } });
    const installation = makeInstallation(ai, tui, core);

    const result = inspectPiRuntimeSurfaces(installation);

    expect(result["ai-api"].status).toBe("unloadable");
    expect(result["ai-providers"].status).toBe("unloadable");
    expect(result.ai.status).toBe("loadable");
  });

  it("reports unloadable when package.json is malformed JSON", () => {
    const dir = tmpDir();
    const ai = join(dir, "pi-ai");
    const tui = join(dir, "pi-tui");
    const core = join(dir, "pi-agent-core");
    mkdirSync(ai, { recursive: true });
    writeFileSync(join(ai, "package.json"), "not json");
    makeTuiPackage(tui, { ".": { import: "./dist/index.js" } });
    makeAgentCorePackage(core, { ".": { import: "./dist/index.js" } });
    const installation = makeInstallation(ai, tui, core);

    const result = inspectPiRuntimeSurfaces(installation);

    expect(result.ai.status).toBe("unloadable");
    expect(result["ai-api"].status).toBe("unloadable");
    expect(result["ai-providers"].status).toBe("unloadable");
  });

  it("reports unloadable when export target file is missing", () => {
    const dir = tmpDir();
    const ai = join(dir, "pi-ai");
    const tui = join(dir, "pi-tui");
    const core = join(dir, "pi-agent-core");
    mkdirSync(join(ai, "dist"), { recursive: true });
    writeFileSync(join(ai, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai",
      exports: { ".": { import: "./dist/missing.js" } },
    }));
    makeTuiPackage(tui, { ".": { import: "./dist/index.js" } });
    makeAgentCorePackage(core, { ".": { import: "./dist/index.js" } });
    const installation = makeInstallation(ai, tui, core);

    const result = inspectPiRuntimeSurfaces(installation);

    expect(result.ai.status).toBe("unloadable");
    const unloadable = result.ai as { status: "unloadable"; reason: string };
    expect(unloadable.reason).toMatch(/missing\.js/);
  });

  it("reports unloadable when export target escapes via symlink", () => {
    const dir = tmpDir();
    const externalDir = tmpDir();
    writeFileSync(join(externalDir, "malicious.js"), "export const x = 1;\n");
    const ai = join(dir, "pi-ai");
    const tui = join(dir, "pi-tui");
    const core = join(dir, "pi-agent-core");
    mkdirSync(join(ai, "dist"), { recursive: true });
    symlinkSync(join(externalDir, "malicious.js"), join(ai, "dist", "evil.js"));
    writeFileSync(join(ai, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai",
      exports: { ".": { import: "./dist/evil.js" } },
    }));
    makeTuiPackage(tui, { ".": { import: "./dist/index.js" } });
    makeAgentCorePackage(core, { ".": { import: "./dist/index.js" } });
    const installation = makeInstallation(ai, tui, core);

    const result = inspectPiRuntimeSurfaces(installation);

    expect(result.ai.status).toBe("unloadable");
    expect((result.ai as { status: "unloadable"; reason: string }).reason).toMatch(/escapes package root/);
  });
});
