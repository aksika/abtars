import { describe, it, expect } from "vitest";
import { NATIVE_TARGET_CONTRACT, NATIVE_TARGET_NAMES, nativeTargetVersion } from "./native-dep-targets.js";

describe("abtars native target contract (#1436)", () => {
  it("contract hash matches the expected cross-product value", () => {
    expect(NATIVE_TARGET_CONTRACT.contractHash).toBe("native-v1-node22-better-sqlite3-12.11.1-sqlite-vec-0.1.9");
  });

  it("better-sqlite3 target is exact", () => {
    expect(nativeTargetVersion("better-sqlite3")).toBe("12.11.1");
  });

  it("sqlite-vec target is exact", () => {
    expect(nativeTargetVersion("sqlite-vec")).toBe("0.1.9");
  });

  it("node major is 22", () => {
    expect(NATIVE_TARGET_CONTRACT.nodeMajor).toBe(22);
  });

  it("all targets are semver (not latest)", () => {
    for (const pkg of NATIVE_TARGET_NAMES) {
      expect(NATIVE_TARGET_CONTRACT.packages[pkg].version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("lists both native packages", () => {
    expect(NATIVE_TARGET_NAMES).toContain("better-sqlite3");
    expect(NATIVE_TARGET_NAMES).toContain("sqlite-vec");
  });

  it("abtars OPTIONAL_DEPS targets match contract", async () => {
    const { OPTIONAL_DEPS } = await import("../../utils/lazy-require.js");
    const native = OPTIONAL_DEPS["native"];
    expect(native.targets).toBeDefined();
    for (const pkg of NATIVE_TARGET_NAMES) {
      expect(native.targets[pkg]).toBe(nativeTargetVersion(pkg));
    }
  });
});
