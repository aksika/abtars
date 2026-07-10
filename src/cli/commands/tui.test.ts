/**
 * tui.test.ts — `abtars tui` client tests (#1315).
 *
 * parseAttachMode is pure and tested directly. The full rendering path
 * (lazyRequire + pi-tui + raw mode) is integration-tested manually on a
 * foreground bridge — see specs/1315/tasks.md Task 8.
 */

import { describe, it, expect } from "vitest";
import { parseAttachMode } from "./tui.js";

describe("parseAttachMode", () => {
  it("default is resume (no args)", () => {
    expect(parseAttachMode([])).toEqual({ kind: "resume" });
  });

  it("--session N parses to session mode", () => {
    expect(parseAttachMode(["--session", "2"])).toEqual({ kind: "session", index: 2 });
  });

  it("--session=N (equals form) parses to session mode", () => {
    expect(parseAttachMode(["--session=2"])).toEqual({ kind: "session", index: 2 });
  });

  it("--new defaults to type A", () => {
    expect(parseAttachMode(["--new"])).toEqual({ kind: "new", sessionType: "A" });
  });

  it("--new C parses to new mode with type C", () => {
    expect(parseAttachMode(["--new", "C"])).toEqual({ kind: "new", sessionType: "C" });
  });

  it("--new=b (lowercase) normalizes to B", () => {
    expect(parseAttachMode(["--new=b"])).toEqual({ kind: "new", sessionType: "B" });
  });

  it("--orc parses to orc mode", () => {
    expect(parseAttachMode(["--orc"])).toEqual({ kind: "orc" });
  });

  it("--session and --new are mutually exclusive", () => {
    expect(() => parseAttachMode(["--session", "1", "--new"])).toThrow(/mutually exclusive/);
  });

  it("--session and --orc are mutually exclusive", () => {
    expect(() => parseAttachMode(["--session", "1", "--orc"])).toThrow(/mutually exclusive/);
  });

  it("--new and --orc are mutually exclusive", () => {
    expect(() => parseAttachMode(["--new", "C", "--orc"])).toThrow(/mutually exclusive/);
  });

  it("--session without a value throws", () => {
    expect(() => parseAttachMode(["--session"])).toThrow(/requires a numeric/);
  });

  it("--session with a non-numeric value throws", () => {
    expect(() => parseAttachMode(["--session", "abc"])).toThrow(/non-negative integer/);
    expect(() => parseAttachMode(["--session=-1"])).toThrow(/non-negative integer/);
  });

  it("--new with an invalid type throws", () => {
    expect(() => parseAttachMode(["--new", "O"])).toThrow(/A, B, or C/);
    expect(() => parseAttachMode(["--new=t"])).toThrow(/A, B, or C/);
  });
});
