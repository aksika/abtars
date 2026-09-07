/**
 * pi-selection.test.ts — #1780 exact-version selector contract.
 *
 * Guards the narrow exact path: only a strict MAJOR.MINOR.PATCH version maps
 * to an exact npm spec, and a stray --pi-version can never be mislabeled as
 * another source's verdict. Existing latest/pinned/installed behavior is
 * pinned by the same suite.
 */

import { describe, it, expect } from "vitest";
import {
  parsePiSelection,
  resolvePiPackageSpec,
  validateExactPiVersion,
} from "./pi-selection.js";

const PACKAGE = "@earendil-works/pi-coding-agent";
const PINNED_RANGE = "~0.84.2";

describe("validateExactPiVersion (#1780)", () => {
  it("accepts a strict exact version", () => {
    expect(validateExactPiVersion("0.85.1")).toBe("0.85.1");
  });

  it("rejects a missing version before any install", () => {
    expect(() => validateExactPiVersion(undefined)).toThrow(/requires --pi-version/);
    expect(() => validateExactPiVersion("")).toThrow(/requires --pi-version/);
  });

  it.each(["~0.85.1", "^0.85.1", ">=0.85.1", "latest", "0.85", "v0.85.1", "0.85.1-alpha.1", "garbage"])(
    "rejects non-exact value %s",
    (value) => {
      expect(() => validateExactPiVersion(value)).toThrow(/exact MAJOR\.MINOR\.PATCH/);
    },
  );
});

describe("parsePiSelection (#1780)", () => {
  it("parses exact with its requested version", () => {
    expect(parsePiSelection({ pi: "exact", piVersion: "0.85.1" })).toEqual({
      kind: "exact",
      requestedVersion: "0.85.1",
    });
  });

  it("rejects exact without a version", () => {
    expect(() => parsePiSelection({ pi: "exact" })).toThrow(/requires --pi-version/);
    expect(() => parsePiSelection({ pi: "exact", piVersion: "~0.85.1" })).toThrow(/exact MAJOR/);
  });

  it.each(["installed", "latest", "pinned"] as const)("parses %s without a version", (pi) => {
    expect(parsePiSelection({ pi })).toEqual({ kind: pi });
  });

  it("rejects a stray --pi-version on non-exact selections", () => {
    expect(() => parsePiSelection({ pi: "latest", piVersion: "0.85.1" })).toThrow(/only valid with --pi exact/);
    expect(() => parsePiSelection({ pi: "pinned", piVersion: "0.85.1" })).toThrow(/only valid with --pi exact/);
    expect(() => parsePiSelection({ pi: "installed", piVersion: "0.85.1" })).toThrow(/only valid with --pi exact/);
  });

  it("rejects an unknown selection", () => {
    expect(() => parsePiSelection({ pi: "canary" })).toThrow(/--pi must be/);
  });
});

describe("resolvePiPackageSpec (#1780)", () => {
  it("maps exact to the exact npm spec", () => {
    expect(
      resolvePiPackageSpec({ kind: "exact", requestedVersion: "0.85.1" }, { packageName: PACKAGE, pinnedRange: PINNED_RANGE }),
    ).toBe(`${PACKAGE}@0.85.1`);
  });

  it("maps latest and pinned to their range specs", () => {
    expect(resolvePiPackageSpec({ kind: "latest" }, { packageName: PACKAGE, pinnedRange: PINNED_RANGE })).toBe(
      `${PACKAGE}@latest`,
    );
    expect(resolvePiPackageSpec({ kind: "pinned" }, { packageName: PACKAGE, pinnedRange: PINNED_RANGE })).toBe(
      `${PACKAGE}@${PINNED_RANGE}`,
    );
  });

  it("returns null for installed (no disposable install)", () => {
    expect(resolvePiPackageSpec({ kind: "installed" }, { packageName: PACKAGE, pinnedRange: PINNED_RANGE })).toBeNull();
  });
});
