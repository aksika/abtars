import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_COMPATIBILITY } from "./pi-compatibility.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

describe("PI_COMPATIBILITY constant", () => {
  it("family is 0.80", () => {
    expect(PI_COMPATIBILITY.family).toBe("0.80");
  });

  it("all three packages have the same version", () => {
    const v = PI_COMPATIBILITY.packages.ai.version;
    expect(PI_COMPATIBILITY.packages.tui.version).toBe(v);
    expect(PI_COMPATIBILITY.packages.codingAgent.version).toBe(v);
  });

  it("version is an exact patch (no ranges)", () => {
    const v = PI_COMPATIBILITY.packages.ai.version;
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("package names are correct", () => {
    expect(PI_COMPATIBILITY.packages.ai.name).toBe("@earendil-works/pi-ai");
    expect(PI_COMPATIBILITY.packages.tui.name).toBe("@earendil-works/pi-tui");
    expect(PI_COMPATIBILITY.packages.codingAgent.name).toBe("@earendil-works/pi-coding-agent");
  });
});

describe("devDependencies vs PI_COMPATIBILITY (#1427)", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("all three Pi packages are devDependencies", () => {
    expect(pkg.dependencies?.[PI_COMPATIBILITY.packages.ai.name]).toBeUndefined();
    expect(pkg.devDependencies?.[PI_COMPATIBILITY.packages.ai.name]).toBeDefined();
    expect(pkg.devDependencies?.[PI_COMPATIBILITY.packages.tui.name]).toBeDefined();
    expect(pkg.devDependencies?.[PI_COMPATIBILITY.packages.codingAgent.name]).toBeDefined();
  });

  it("devDep specs match PI_COMPATIBILITY exact versions", () => {
    for (const key of ["ai", "tui", "codingAgent"] as const) {
      const p = PI_COMPATIBILITY.packages[key];
      expect(pkg.devDependencies?.[p.name]).toBe(p.version);
    }
  });
});

describe("lockfile resolutions match PI_COMPATIBILITY (#1427)", () => {
  const lock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf-8")) as {
    packages?: Record<string, { version?: string }>;
  };
  const pkg = lock.packages ?? {};

  it("pi-ai resolves to exact version", () => {
    expect(pkg["node_modules/@earendil-works/pi-ai"]?.version).toBe(
      PI_COMPATIBILITY.packages.ai.version,
    );
  });

  it("pi-tui resolves to exact version", () => {
    expect(pkg["node_modules/@earendil-works/pi-tui"]?.version).toBe(
      PI_COMPATIBILITY.packages.tui.version,
    );
  });

  it("pi-coding-agent resolves to exact version", () => {
    expect(pkg["node_modules/@earendil-works/pi-coding-agent"]?.version).toBe(
      PI_COMPATIBILITY.packages.codingAgent.version,
    );
  });
});
