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

  it("extracts [SUPPORT: refs] and strips the marker", () => {
    const raw = "Kedden! Ha kedd, akkor Belgium.\n[SUPPORT: db:durable:313:u1:aaa, db:durable:1314:u1:bbb]";
    const { text, supportIds } = cleanResponse(raw);
    expect(text).toBe("Kedden! Ha kedd, akkor Belgium.");
    expect(supportIds).toEqual(["db:durable:313:u1:aaa", "db:durable:1314:u1:bbb"]);
  });

  it("deduplicates forged support refs; validation happens downstream", () => {
    const { text, supportIds } = cleanResponse("Answer. [SUPPORT: db:durable:7:u1:aaa, db:durable:7:u1:aaa, db:durable:999:u1:zzz]");
    expect(text).toBe("Answer.");
    expect(supportIds).toEqual(["db:durable:7:u1:aaa", "db:durable:999:u1:zzz"]);
  });

  it("omits supportIds when no marker is present", () => {
    expect(cleanResponse("Plain answer.").supportIds).toBeUndefined();
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
 * #1651: classifyContent is the single normalization of "what did this settled
 * turn produce". Before it existed, spin fabricated "(no output)" for an empty
 * provider response, which made downstream guards unreachable (sleep
 * completion, skill bootstrap, and the whole chat empty/no-reply policy).
 * #1651 v2: the four-way outcome separates chat control signals (reaction)
 * from textual domain content (text). These cases pin the classification each
 * consumer guard now depends on.
 */
describe("classifyContent (#1651)", () => {
  const cases: ReadonlyArray<readonly [string, string, ContentOutcome]> = [
    ["plain text", "Here is the answer.", "text"],
    ["deliberate silence", "[NO_REPLY]", "no_reply"],
    ["silence marker with text — text wins", "[NO_REPLY]\n\nSleep finished — 5 things done.", "text"],
    ["reaction emoji only is a reaction, not text", "[REACT:👋]", "reaction"],
    ["reaction marker with text — text wins", "[REACT:👋] Here is the answer.", "text"],
    ["empty provider response", "", "empty"],
    ["whitespace-only provider response", "   \n\t ", "empty"],
    ["echoed internal context only", "[CONTEXT — do not respond]\nSOUL.md content\n[/CONTEXT]", "empty"],
  ];

  it.each(cases)("%s → %s", (_name, raw, expected) => {
    expect(classifyContent(raw)).toBe(expected);
  });
});


describe("#1928 support metadata validation (owner ref keys)", () => {
  it("strips malformed/empty metadata and rejects non-ref tokens", () => {
    const cleaned = cleanResponse("First. [SUPPORT: db:durable:12:u1:aaa 34, nope, db:durable:56:u1:bbb] Second. [SUPPORT: ]");
    expect(cleaned.supportIds).toEqual(["db:durable:56:u1:bbb"]);
    expect(cleaned.text).toBe("First.  Second.");
    expect(cleaned.text).not.toContain("SUPPORT");
  });

  it("accepts artifact and graph refs and dedupes repeats", () => {
    const cleaned = cleanResponse("[SUPPORT: artifact:u1:summaries/d.md:abc, graph:path:db:x, artifact:u1:summaries/d.md:abc]");
    expect(cleaned.supportIds).toEqual(["artifact:u1:summaries/d.md:abc", "graph:path:db:x"]);
  });

  it("accepts colon-bearing and long principals instead of silently dropping them", () => {
    // Production principals include `peer:<name>`; the marker parser must not
    // be stricter than the identity charset or a valid declaration is lost.
    const peerRef = "db:durable:9:peer:plain:0f1e2d";
    const longOwner = "x".repeat(300);
    const longRef = `db:durable:12:${longOwner}:aa`;
    const cleaned = cleanResponse(`Answer. [SUPPORT: ${peerRef}, ${longRef}]`);
    expect(cleaned.supportIds).toEqual([peerRef, longRef]);
  });

  it("still rejects tokens that cannot be a ref key", () => {
    const cleaned = cleanResponse("[SUPPORT: db:durable:12:u1:aa bb, 313, artifact, db-durable-1]");
    expect(cleaned.supportIds).toBeUndefined();
  });
});
