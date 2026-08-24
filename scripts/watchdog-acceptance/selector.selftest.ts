/**
 * Selector self-tests (#1712 Task 1): public M/R ID mapping, lane membership,
 * and runner CLI parsing. Pure — no processes spawned.
 */
import { describe, expect, it } from "vitest";
import {
  FAST_R_PUBLIC_IDS,
  MOCK_PROJECTION_IDS,
  REAL_R_PUBLIC_IDS,
  SLOW_R_PUBLIC_IDS,
  contractKeyOfMock,
  contractKeyOfReal,
  parseRunArgs,
  realPublicId,
  resolveScenarioSelector,
  selectScenarioContractKeys,
  suitePublicIds,
  UsageError,
} from "./contracts.ts";

const ALL_KEYS = [
  ...Array.from({ length: 24 }, (_, i) => `A${i + 1}`),
  ...Array.from({ length: 14 }, (_, i) => `B${i + 1}`),
];

describe("canonical ID mapping", () => {
  it("maps every A/B key to a zero-padded R ID with an equal suffix", () => {
    for (const key of ALL_KEYS) {
      const pub = realPublicId(key);
      expect(pub).toMatch(/^R[AB]\d{2}$/);
      expect(pub!.slice(2)).toBe(String(Number(key.slice(1))).padStart(2, "0"));
      expect(contractKeyOfReal(pub!)).toBe(key);
    }
    expect(REAL_R_PUBLIC_IDS).toHaveLength(38);
  });

  it("round-trips mock ID shapes to their A/B contract keys", () => {
    expect(contractKeyOfMock("MA08")).toBe("A8");
    expect(contractKeyOfMock("MB14")).toBe("B14");
    expect(contractKeyOfMock("RB11")).toBeNull();
    expect(contractKeyOfReal("MA09")).toBeNull();
  });

  it("rejects out-of-range and malformed keys in both directions", () => {
    expect(realPublicId("A25")).toBeNull();
    expect(realPublicId("B15")).toBeNull();
    expect(realPublicId("A0")).toBeNull();
    expect(realPublicId("C3")).toBeNull();
    expect(realPublicId("RA9")).toBeNull();
    expect(contractKeyOfReal("RA00")).toBeNull();
    expect(contractKeyOfReal("RA25")).toBeNull();
    expect(contractKeyOfMock("MB15")).toBeNull();
    expect(contractKeyOfMock("MA0")).toBeNull();
  });
});

describe("portfolio lanes", () => {
  it("FAST holds exactly the 16 specified real cases", () => {
    expect([...FAST_R_PUBLIC_IDS]).toEqual([
      "RA01", "RA02", "RA10", "RA11", "RA13", "RA14", "RA15", "RA16",
      "RA18", "RA19", "RA23", "RB03", "RB04", "RB05", "RB06", "RB08",
    ]);
  });

  it("16 FAST + 22 SLOW = 38 REAL with no overlap and full coverage", () => {
    expect(FAST_R_PUBLIC_IDS).toHaveLength(16);
    expect(SLOW_R_PUBLIC_IDS).toHaveLength(22);
    expect(REAL_R_PUBLIC_IDS).toHaveLength(38);
    for (const id of FAST_R_PUBLIC_IDS) {
      expect(SLOW_R_PUBLIC_IDS).not.toContain(id);
    }
    expect([...FAST_R_PUBLIC_IDS, ...SLOW_R_PUBLIC_IDS].sort()).toEqual([...REAL_R_PUBLIC_IDS].sort());
  });

  it("keeps RA08 explicitly in SLOW so the real suite stays 38 contracts", () => {
    expect(SLOW_R_PUBLIC_IDS).toContain("RA08");
    expect(FAST_R_PUBLIC_IDS).not.toContain("RA08");
  });

  it("registers exactly the 12 approved M projections, each pairing a real case", () => {
    expect(MOCK_PROJECTION_IDS).toHaveLength(12);
    expect(new Set(MOCK_PROJECTION_IDS).size).toBe(12);
    for (const m of MOCK_PROJECTION_IDS) {
      expect(m).toMatch(/^M[AB]\d{2}$/);
      const key = contractKeyOfMock(m)!;
      expect(REAL_R_PUBLIC_IDS).toContain(`R${m.slice(1)}`);
      expect(ALL_KEYS).toContain(key);
    }
    // No implied M placeholder: M ids are never part of any R lane.
    for (const lane of [suitePublicIds("fast"), suitePublicIds("slow"), suitePublicIds("real")]) {
      for (const id of MOCK_PROJECTION_IDS) expect(lane).not.toContain(id);
    }
  });

  it("has no duplicate IDs anywhere in the registry", () => {
    expect(new Set(REAL_R_PUBLIC_IDS).size).toBe(38);
    expect(new Set(SLOW_R_PUBLIC_IDS).size).toBe(22);
    expect(new Set(FAST_R_PUBLIC_IDS).size).toBe(16);
  });
});

describe("--only selector resolution", () => {
  it("accepts canonical and legacy spellings and resolves to the same case", () => {
    for (const arg of ["RA03", "ra03", "A3", "a3"]) {
      expect(resolveScenarioSelector(arg)).toEqual({ publicId: "RA03", contractKey: "A3" });
    }
    for (const arg of ["RB11", "rb11", "B11"]) {
      expect(resolveScenarioSelector(arg)).toEqual({ publicId: "RB11", contractKey: "B11" });
    }
  });

  it("rejects unknown or malformed selectors", () => {
    expect(resolveScenarioSelector("Z9")).toBeNull();
    expect(resolveScenarioSelector("MA09")).toBeNull();
    expect(resolveScenarioSelector("A25")).toBeNull();
    expect(resolveScenarioSelector("RA0")).toBeNull();
    expect(resolveScenarioSelector("")).toBeNull();
  });
});

describe("suite selection preserves serial order", () => {
  it("selects exactly the lane members in canonical order", () => {
    for (const suite of ["fast", "slow", "real"] as const) {
      const keys = selectScenarioContractKeys(suite, null, ALL_KEYS);
      const expected = suitePublicIds(suite).map((id) => contractKeyOfReal(id));
      expect(keys).toEqual(expected);
    }
    expect(selectScenarioContractKeys("real", null, ALL_KEYS)).toHaveLength(38);
  });

  it("narrows to one scenario when --only is given, whatever spelling arrived", () => {
    expect(selectScenarioContractKeys("real", "B11", ALL_KEYS)).toEqual(["B11"]);
    expect(selectScenarioContractKeys("fast", "A8", ALL_KEYS)).toEqual(["A8"]); // focused RA08 is allowed even though RA08 is SLOW
  });
});

describe("run CLI parsing", () => {
  it("defaults to the manifest-gated REAL behavior", () => {
    expect(parseRunArgs([])).toEqual({ only: null, baseline: false, requireAllGreen: false, list: false, suite: "real" });
  });

  it("parses --suite fast|slow|real alongside existing flags", () => {
    expect(parseRunArgs(["--suite", "fast"]).suite).toBe("fast");
    expect(parseRunArgs(["--suite", "slow"]).suite).toBe("slow");
    const full = parseRunArgs(["--suite", "real", "--baseline", "--require-all-green", "--only", "RA06"]);
    expect(full).toEqual({ only: "RA06", baseline: true, requireAllGreen: true, list: false, suite: "real" });
  });

  it("rejects unknown flags, bad suites, and empty --only values", () => {
    expect(() => parseRunArgs(["--frobnicate"])).toThrow(UsageError);
    expect(() => parseRunArgs(["--suite", "mega"])).toThrow(/unknown --suite/);
    expect(() => parseRunArgs(["--suite"])).toThrow(/--suite requires/);
    expect(() => parseRunArgs(["--only"])).toThrow(/--only requires/);
  });
});
