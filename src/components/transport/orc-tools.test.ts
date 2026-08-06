import { describe, it, expect } from "vitest";
import { clampBrowsingLaneDuration, MIN_BROWSING_LANE_MS } from "./orc-tools.js";

describe("clampBrowsingLaneDuration (#1588)", () => {
  it("clamps a browsing lane with artifacts and a 2-minute budget up to the 300s floor", () => {
    expect(clampBrowsingLaneDuration("Browse three web pages and record results", "Lane 3", true, 120_000)).toBe(MIN_BROWSING_LANE_MS);
  });

  it("assigns the floor when a browsing lane declares artifacts but no duration", () => {
    expect(clampBrowsingLaneDuration("Fetch http://example.com and save", undefined, true, undefined)).toBe(MIN_BROWSING_LANE_MS);
  });

  it("leaves a browsing lane with a budget already above the floor untouched", () => {
    expect(clampBrowsingLaneDuration("Browse the web for data", "Web lane", true, 600_000)).toBe(600_000);
  });

  it("does not clamp lanes without artifacts or without browsing shape", () => {
    expect(clampBrowsingLaneDuration("Write a report", "Report lane", true, 120_000)).toBe(120_000);
    expect(clampBrowsingLaneDuration("Browse three pages", "Lane", false, 120_000)).toBe(120_000);
    expect(clampBrowsingLaneDuration("Compute results", "Lane", true, undefined)).toBeUndefined();
  });
});
