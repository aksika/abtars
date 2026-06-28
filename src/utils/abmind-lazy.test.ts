import { describe, expect, it } from "vitest";
import { ABMIND_MIN, isSupportedVersion, parseSemver } from "./abmind-lazy.js";

describe("#1243 abmind version floor", () => {
  it("ABMIND_MIN is 0.3.0 (the contract-introducing version)", () => {
    expect(ABMIND_MIN).toEqual([0, 3, 0]);
  });

  it("parseSemver reads leading major.minor.patch, ignores pre-release/build", () => {
    expect(parseSemver("0.3.0")).toEqual([0, 3, 0]);
    expect(parseSemver("0.3.0-alpha.0")).toEqual([0, 3, 0]);
    expect(parseSemver("1.2.3-rc.1+build.5")).toEqual([1, 2, 3]);
    expect(parseSemver("not-a-version")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });

  it("isSupportedVersion accepts the floor and above", () => {
    expect(isSupportedVersion("0.3.0")).toBe(true);
    expect(isSupportedVersion("0.3.0-alpha.0")).toBe(true);
    expect(isSupportedVersion("0.3.1")).toBe(true);
    expect(isSupportedVersion("0.10.0")).toBe(true);
    expect(isSupportedVersion("1.0.0")).toBe(true);
  });

  it("isSupportedVersion rejects below-floor, ancient, and unparseable abmind", () => {
    expect(isSupportedVersion("0.2.5-alpha.0")).toBe(false); // pre-contract
    expect(isSupportedVersion("0.2.4")).toBe(false);
    expect(isSupportedVersion("garbage")).toBe(false);
    expect(isSupportedVersion("")).toBe(false);
  });
});
