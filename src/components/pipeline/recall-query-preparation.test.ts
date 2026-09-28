/**
 * #1867 — bridge query preparation: discrete terms, non-English gate, and
 * bounded translation with extraction/joined fallbacks.
 */
import { describe, it, expect, vi } from "vitest";
import {
  prepareRecallQuery,
  needsTranslation,
  translateRecallTerms,
  mergeQueryTerms,
  MAX_QUERY_TERMS,
} from "./recall-query-preparation.js";

const TOKENS = (text: string): string[] =>
  text.split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length > 2).map((t) => t.toLowerCase());

describe("prepareRecallQuery", () => {
  it("emits discrete terms from extraction plus priming", () => {
    const prepared = prepareRecallQuery("what do you know about Patchright", ["docker"], { extractTokens: TOKENS });
    expect(prepared.query).toBe("what do you know about Patchright docker");
    expect(prepared.original).toBe("what do you know about Patchright");
    expect(prepared.terms).toContain("patchright");
    expect(prepared.terms).toContain("docker");
    expect(prepared.terms!.length).toBeLessThanOrEqual(MAX_QUERY_TERMS);
  });

  it("omits terms when extraction finds nothing (joined fallback)", () => {
    const prepared = prepareRecallQuery("a be to it", [], { extractTokens: () => [] });
    expect(prepared.query).toBe("a be to it");
    expect(prepared.terms).toBeUndefined();
    expect(prepared.original).toBe("a be to it");
  });

  it("dedupes terms across extraction and priming", () => {
    const prepared = prepareRecallQuery("docker deploy", ["docker"], { extractTokens: TOKENS });
    expect(prepared.terms?.filter((t) => t === "docker")).toHaveLength(1);
  });

  it("an extraction throw falls back to priming-only terms, never no query", () => {
    const prepared = prepareRecallQuery("some text", ["priming"], {
      extractTokens: () => { throw new Error("tokenizer down"); },
    });
    expect(prepared.query).toBe("some text priming");
    expect(prepared.terms).toEqual(["priming"]);
  });
});

describe("mergeQueryTerms", () => {
  it("caps at MAX_QUERY_TERMS in first-seen order", () => {
    const many = Array.from({ length: 30 }, (_, i) => `term${i}`);
    expect(mergeQueryTerms([many])).toHaveLength(MAX_QUERY_TERMS);
    expect(mergeQueryTerms([many])[0]).toBe("term0");
  });

  it("trims and drops empties", () => {
    expect(mergeQueryTerms([["  a  ", "", "b"]])).toEqual(["a", "b"]);
  });
});

describe("needsTranslation", () => {
  it("English turns never need translation", () => {
    const text = "what do you know about Patchright deployment";
    expect(needsTranslation(text, TOKENS(text))).toBe(false);
  });

  it("Hungarian turns with no ASCII coverage need translation", () => {
    expect(needsTranslation("mit mondott a svéd váltókezelő?", [])).toBe(true);
  });

  it("Hungarian turns dominated by source language need translation", () => {
    // One proper noun surfaced, most letter content still Hungarian.
    expect(needsTranslation("ki volt Morgenson a viccben?", ["Morgenson"])).toBe(true);
  });

  it("short texts never trigger translation", () => {
    expect(needsTranslation("ok", [])).toBe(false);
  });
});

describe("translateRecallTerms", () => {
  it("parses line-per-term output into terms", async () => {
    const caller = { dispatchBackground: vi.fn().mockResolvedValue("architect\nparadox\ntester") };
    const terms = await translateRecallTerms(caller, "ki volt az építész?");
    expect(terms).toEqual(["architect", "paradox", "tester"]);
    expect(caller.dispatchBackground).toHaveBeenCalledOnce();
  });

  it("a translation failure throws so the caller falls back", async () => {
    const caller = { dispatchBackground: vi.fn().mockRejectedValue(new Error("timeout")) };
    await expect(translateRecallTerms(caller, "ki volt az építész?")).rejects.toThrow("timeout");
  });

  it("empty input yields no terms without calling", async () => {
    const caller = { dispatchBackground: vi.fn() };
    expect(await translateRecallTerms(caller, "   ")).toEqual([]);
    expect(caller.dispatchBackground).not.toHaveBeenCalled();
  });

  it("unparseable output yields no terms (caller falls back)", async () => {
    const caller = { dispatchBackground: vi.fn().mockResolvedValue("a be -- ...") };
    expect(await translateRecallTerms(caller, "valami")).toEqual([]);
  });
});
