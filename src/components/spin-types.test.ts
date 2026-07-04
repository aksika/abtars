/**
 * spin-types.test.ts — #1022 A/C compaction gate helpers.
 */
import { describe, it, expect } from "vitest";

import { sessionTypeOf, isCompactable } from "./spin-types.js";

describe("sessionTypeOf", () => {
  it("extracts the type segment from a session id", () => {
    expect(sessionTypeOf("1720000000_A_01")).toBe("A");
    expect(sessionTypeOf("1720000000_C_07")).toBe("C");
    expect(sessionTypeOf("1720000000_D_02")).toBe("D");
  });

  it("defaults to A on a malformed id", () => {
    expect(sessionTypeOf("nosegments")).toBe("A");
  });
});

describe("isCompactable (#1022 A/C gate)", () => {
  it("allows A and C session types", () => {
    expect(isCompactable("1720000000_A_01")).toBe(true);
    expect(isCompactable("1720000000_C_01")).toBe(true);
  });

  it("blocks every other session type", () => {
    for (const t of ["B", "D", "O", "S", "T", "P", "W", "H"]) {
      expect(isCompactable(`1720000000_${t}_01`)).toBe(false);
    }
  });
});
