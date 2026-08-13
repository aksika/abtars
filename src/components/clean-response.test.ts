import { describe, it, expect } from "vitest";
import { classifyContent, cleanResponse } from "./clean-response.js";
import type { ContentOutcome } from "./clean-response.js";

describe("cleanResponse", () => {
  it("strips [CONTEXT] block", () => {
    const raw = "Here is the answer.\n[CONTEXT — do not respond]\nSOUL.md content\n[/CONTEXT]\nMore text.";
    const { text } = cleanResponse(raw);
    expect(text).not.toContain("[CONTEXT");
    expect(text).not.toContain("SOUL.md");
    expect(text).toContain("Here is the answer.");
    expect(text).toContain("More text.");
  });

  it("strips [MEMORY CONTEXT] block", () => {
    const raw = "Answer.\n[MEMORY CONTEXT — auto-recalled, do not repeat verbatim]\n[F|topic] fact\n[/MEMORY CONTEXT]";
    const { text } = cleanResponse(raw);
    expect(text).not.toContain("MEMORY CONTEXT");
    expect(text).toBe("Answer.");
  });

  it("extracts [TOPICS: kw1, kw2]", () => {
    const raw = "Here is my answer.\n[TOPICS: clerk, auth, pricing]";
    const { text, topics } = cleanResponse(raw);
    expect(text).toBe("Here is my answer.");
    expect(topics).toEqual(["clerk", "auth", "pricing"]);
  });

  it("extracts [REACT:emoji] as separate field", () => {
    const raw = "Hello!\n[REACT:👋]";
    const { text, reactionEmoji } = cleanResponse(raw);
    expect(text).toBe("Hello!");
    expect(reactionEmoji).toBe("👋");
  });

  it("detects [NO_REPLY]", () => {
    const { text, noReply } = cleanResponse("[NO_REPLY]");
    expect(text).toBe("");
    expect(noReply).toBe(true);
  });

  it("strips [Current time:] and [Flashback]", () => {
    const raw = "[Current time: 2026-04-24 14:00 (Thursday)]\n[Flashback] some memory\nActual response.";
    const { text } = cleanResponse(raw);
    expect(text).toBe("Actual response.");
  });
});

/*
 * #1651: classifyContent is the single normalization of "did this turn produce
 * anything". Before it existed, spin fabricated "(no output)" for an empty
 * provider response, which made three downstream guards unreachable (sleep
 * completion, skill bootstrap, and the whole chat empty/no-reply policy). These
 * cases pin the classification each of those guards now depends on.
 */
describe("classifyContent (#1651)", () => {
  const cases: ReadonlyArray<readonly [string, string, ContentOutcome]> = [
    ["plain text", "Here is the answer.", "content"],
    ["deliberate silence", "[NO_REPLY]", "no_reply"],
    ["silence marker with text — text wins", "[NO_REPLY]\n\nSleep finished — 5 things done.", "content"],
    ["reaction emoji only IS the reply", "[REACT:👋]", "content"],
    ["empty provider response", "", "empty"],
    ["whitespace-only provider response", "   \n\t ", "empty"],
    ["echoed internal context only", "[CONTEXT — do not respond]\nSOUL.md content\n[/CONTEXT]", "empty"],
  ];

  it.each(cases)("%s → %s", (_name, raw, expected) => {
    expect(classifyContent(raw)).toBe(expected);
  });
});
