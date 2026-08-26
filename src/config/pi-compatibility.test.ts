import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_COMPATIBILITY, classifyPiPin, formatPiPinWarning, formatPiPinnedInstallCommand } from "./pi-compatibility.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

describe("PI_COMPATIBILITY constant", () => {
  it("has the coding-agent package name", () => {
    expect(PI_COMPATIBILITY.packageName).toBe("@earendil-works/pi-coding-agent");
  });

  it("has a pinned version in exact patch format", () => {
    expect(PI_COMPATIBILITY.pinnedVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("has a pinned range matching the pinned version", () => {
    expect(PI_COMPATIBILITY.pinnedRange).toBe(`~${PI_COMPATIBILITY.pinnedVersion}`);
  });

  it("has nested package names", () => {
    expect(PI_COMPATIBILITY.nestedPackages.ai).toBe("@earendil-works/pi-ai");
    expect(PI_COMPATIBILITY.nestedPackages.tui).toBe("@earendil-works/pi-tui");
    expect(PI_COMPATIBILITY.nestedPackages.agentCore).toBe("@earendil-works/pi-agent-core");
  });
});

describe("devDependencies vs PI_COMPATIBILITY (#1438, #1572)", () => {
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

  // #1572: the four @earendil-works/* devDeps must agree with the runtime pin.
  // The drift this guards against (types at 0.80.7, runtime >=0.83.0) broke
  // typecheck-vs-execute consistency.
  it("all four @earendil-works/* devDeps equal the pinned range (#1572)", () => {
    const expected = `~${PI_COMPATIBILITY.pinnedVersion}`;
    for (const name of [
      PI_COMPATIBILITY.packageName,
      PI_COMPATIBILITY.nestedPackages.ai,
      PI_COMPATIBILITY.nestedPackages.tui,
      PI_COMPATIBILITY.nestedPackages.agentCore,
    ]) {
      expect(pkg.devDependencies?.[name]).toBe(expected);
    }
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

describe("classifyPiPin (#1572)", () => {
  it.each([
    ["0.84.2", "at-pin"],
    ["0.84.9", "at-pin"],
    ["0.84.2-alpha.1", "at-pin"],
    ["0.85.0", "above-pin"],
    ["0.90.0", "above-pin"],
    ["1.0.0", "above-pin"],
    ["garbage", "above-pin"],
  ] as const)("classifies %s as %s", (version, expected) => {
    expect(classifyPiPin(version)).toBe(expected);
  });
});

describe("formatPiPinWarning (#1572)", () => {
  it("returns null for at-pin versions", () => {
    expect(formatPiPinWarning("0.84.2")).toBeNull();
    expect(formatPiPinWarning("0.84.9")).toBeNull();
  });

  it("returns the warning with the exact downgrade command for above-pin", () => {
    const warning = formatPiPinWarning("0.85.1");
    expect(warning).not.toBeNull();
    expect(warning).toContain("0.85.1");
    expect(warning).toContain(`npm i -g '${PI_COMPATIBILITY.packageName}@${PI_COMPATIBILITY.pinnedRange}'`);
  });

  it("returns a warning for unparseable versions (unknown shape is not tested)", () => {
    expect(formatPiPinWarning("9.9")).not.toBeNull();
  });
});

describe("formatPiPinnedInstallCommand (#1573)", () => {
  it("returns the exact pinned install command", () => {
    expect(formatPiPinnedInstallCommand()).toBe(
      `npm i -g '${PI_COMPATIBILITY.packageName}@${PI_COMPATIBILITY.pinnedRange}'`,
    );
  });

  it("is the single command reused by the pin warning", () => {
    const warning = formatPiPinWarning("0.85.1");
    expect(warning).toContain(formatPiPinnedInstallCommand());
    expect(warning!.split(formatPiPinnedInstallCommand())).toHaveLength(2);
  });
});
