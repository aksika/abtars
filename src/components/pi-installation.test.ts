import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveNestedPackageRoot } from "./pi-installation.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-installation-"));
  roots.push(root);
  return root;
}

describe("resolveNestedPackageRoot", () => {
  it("accepts an ESM-only package nested in the Pi installation", () => {
    const piRoot = fixture();
    const aiRoot = join(piRoot, "node_modules", "@earendil-works", "pi-ai");
    mkdirSync(join(aiRoot, "dist"), { recursive: true });
    writeFileSync(join(aiRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai",
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
    }));
    writeFileSync(join(aiRoot, "dist", "index.js"), "export {};\n");

    expect(resolveNestedPackageRoot(piRoot, "@earendil-works/pi-ai")).toBe(aiRoot);
  });

  it("rejects a nested package symlink that escapes the Pi installation", () => {
    const piRoot = fixture();
    const externalRoot = fixture();
    const scopeRoot = join(piRoot, "node_modules", "@earendil-works");
    mkdirSync(scopeRoot, { recursive: true });
    writeFileSync(join(externalRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai" }));
    symlinkSync(externalRoot, join(scopeRoot, "pi-ai"));

    expect(resolveNestedPackageRoot(piRoot, "@earendil-works/pi-ai")).toBeNull();
  });
});
