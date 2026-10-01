/**
 * #1867 — bridge query preparation: discrete terms with extraction/joined
 * fallbacks. #1894 — ambient auto-recall is translation-free and LLM-free:
 * extraction plus priming composition only.
 */
import { describe, it, expect } from "vitest";
import {
  prepareRecallQuery,
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
