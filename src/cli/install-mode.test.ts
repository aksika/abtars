import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readInstallMode, writeInstallMode, resolveInstallMode } from "./install-mode.js";

describe("install-mode", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ab-mode-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("readInstallMode returns null when file missing", () => {
    expect(readInstallMode(dir)).toBeNull();
  });

  it("writeInstallMode + readInstallMode round-trips", () => {
    writeInstallMode(dir, "simple");
    expect(readInstallMode(dir)).toBe("simple");
    writeInstallMode(dir, "supervised");
    expect(readInstallMode(dir)).toBe("supervised");
  });

  it("readInstallMode returns null for invalid content", () => {
    writeFileSync(join(dir, "install-mode"), "garbage\n");
    expect(readInstallMode(dir)).toBeNull();
  });

  it("resolveInstallMode writes inferred mode when file missing", () => {
    const mode = resolveInstallMode(dir);
    expect(mode === "simple" || mode === "supervised").toBe(true);
    expect(readInstallMode(dir)).toBe(mode);
  });

  it("resolveInstallMode returns existing mode without overwriting", () => {
    writeInstallMode(dir, "simple");
    expect(resolveInstallMode(dir)).toBe("simple");
  });
});
