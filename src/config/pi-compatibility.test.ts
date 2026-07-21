import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_COMPATIBILITY } from "./pi-compatibility.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

describe("PI_COMPATIBILITY constant", () => {
  it("has the coding-agent package name", () => {
    expect(PI_COMPATIBILITY.packageName).toBe("@earendil-works/pi-coding-agent");
  });

  it("has a minimum version in exact patch format", () => {
    expect(PI_COMPATIBILITY.minimumPiVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("has nested package names", () => {
    expect(PI_COMPATIBILITY.nestedPackages.ai).toBe("@earendil-works/pi-ai");
    expect(PI_COMPATIBILITY.nestedPackages.tui).toBe("@earendil-works/pi-tui");
    expect(PI_COMPATIBILITY.nestedPackages.agentCore).toBe("@earendil-works/pi-agent-core");
  });
});

describe("devDependencies vs PI_COMPATIBILITY (#1438)", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("pi-coding-agent is a devDependency", () => {
    expect(pkg.dependencies?.[PI_COMPATIBILITY.packageName]).toBeUndefined();
    expect(pkg.devDependencies?.[PI_COMPATIBILITY.packageName]).toBeDefined();
  });

  it("pi-ai is a devDependency (not runtime)", () => {
    expect(pkg.dependencies?.[PI_COMPATIBILITY.nestedPackages.ai]).toBeUndefined();
    expect(pkg.devDependencies?.[PI_COMPATIBILITY.nestedPackages.ai]).toBeDefined();
  });

  it("pi-tui is a devDependency (not runtime)", () => {
    expect(pkg.dependencies?.[PI_COMPATIBILITY.nestedPackages.tui]).toBeUndefined();
    expect(pkg.devDependencies?.[PI_COMPATIBILITY.nestedPackages.tui]).toBeDefined();
  });

  it("pi-agent-core is a devDependency (#1445)", () => {
    expect(pkg.dependencies?.[PI_COMPATIBILITY.nestedPackages.agentCore]).toBeUndefined();
    expect(pkg.devDependencies?.[PI_COMPATIBILITY.nestedPackages.agentCore]).toBeDefined();
  });
});

describe("lockfile resolutions match PI_COMPATIBILITY (#1438)", () => {
  const lock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf-8")) as {
    packages?: Record<string, { version?: string }>;
  };
  const pkg = lock.packages ?? {};

  it("pi-coding-agent resolves in lockfile", () => {
    expect(pkg["node_modules/@earendil-works/pi-coding-agent"]?.version).toBeDefined();
  });

  it("pi-ai resolves in lockfile", () => {
    expect(pkg["node_modules/@earendil-works/pi-ai"]?.version).toBeDefined();
  });

  it("pi-tui resolves in lockfile", () => {
    expect(pkg["node_modules/@earendil-works/pi-tui"]?.version).toBeDefined();
  });

  it("pi-agent-core resolves in lockfile (#1445)", () => {
    expect(pkg["node_modules/@earendil-works/pi-agent-core"]?.version).toBeDefined();
  });
});
