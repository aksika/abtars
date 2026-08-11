import { describe, it, expect } from "vitest";
import { isLoopbackAddress } from "./net.js";

describe("isLoopbackAddress", () => {
  it("returns true for 127.0.0.1", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  });

  it("returns true for ::1", () => {
    expect(isLoopbackAddress("::1")).toBe(true);
  });

  it("returns true for ::ffff:127.0.0.1", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("returns true for undefined", () => {
    expect(isLoopbackAddress(undefined)).toBe(true);
  });

  it("returns false for external IP", () => {
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
  });

  it("returns false for public IP", () => {
    expect(isLoopbackAddress("203.0.113.1")).toBe(false);
  });
});
