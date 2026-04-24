import { describe, it, expect } from "vitest";
import { cleanResponse } from "./clean-response.js";

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

  it("detects [NO-REPLY]", () => {
    const { text, noReply } = cleanResponse("[NO-REPLY]");
    expect(text).toBe("");
    expect(noReply).toBe(true);
  });

  it("strips [Current time:] and [Flashback]", () => {
    const raw = "[Current time: 2026-04-24 14:00 (Thursday)]\n[Flashback] some memory\nActual response.";
    const { text } = cleanResponse(raw);
    expect(text).toBe("Actual response.");
  });
});
