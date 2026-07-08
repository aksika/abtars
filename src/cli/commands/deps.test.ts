import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => tmpDir };
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "deps-test-"));
  mkdirSync(join(tmpDir, ".local", "lib", "node_modules"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("abtars deps", () => {
  it("list shows all optional deps", async () => {
    const { deps } = await import("./deps.js");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await deps(["list"]);
    expect(code).toBe(0);
    const output = write.mock.calls.map(c => c[0]).join("");
    expect(output).toContain("browser");
    expect(output).toContain("pdf");
    expect(output).toContain("youtube");
    expect(output).toContain("image");
    write.mockRestore();
  });

  it("install unknown dep returns error", async () => {
    const { deps } = await import("./deps.js");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await deps(["install", "nonexistent"]);
    expect(code).toBe(1);
    const output = write.mock.calls.map(c => c[0]).join("");
    expect(output).toContain("Unknown dep");
    write.mockRestore();
  });

  it("install of a system binary prints its manual hint, not 'Unknown dep'", async () => {
    const { deps } = await import("./deps.js");
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await deps(["install", "ollama"]);
    // System binaries are not npm-installable — abtars prints the hint and exits 0.
    expect(code).toBe(0);
    const stdout = out.mock.calls.map(c => c[0]).join("");
    const stderr = err.mock.calls.map(c => c[0]).join("");
    expect(stdout).toContain("system binary");
    expect(stdout).toContain("ollama.ai/install.sh");
    expect(stderr).not.toContain("Unknown dep");
    out.mockRestore();
    err.mockRestore();
  });

  it("install with no args defaults to native group", async () => {
    const { deps } = await import("./deps.js");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await deps(["install"]);
    expect(code).toBe(0);
    const output = write.mock.calls.map(c => c[0]).join("");
    expect(output).toContain("native");
    write.mockRestore();
  });

  it("remove cleans up package dir", async () => {
    const { deps } = await import("./deps.js");
    // Fake an installed package
    const pkgDir = join(tmpDir, ".local", "lib", "node_modules", "pdf-parse");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "index.js"), "");
    
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await deps(["remove", "pdf"]);
    expect(code).toBe(0);
    expect(existsSync(pkgDir)).toBe(false);
    write.mockRestore();
  });
});
