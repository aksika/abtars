import { describe, it, expect } from "vitest";
import { toResponsesRequest, fromResponsesResponse } from "./responses-adapter.js";

describe("responses-adapter", () => {
  it("extracts system message to instructions field", () => {
    const msgs = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hi" },
    ];
    const req = toResponsesRequest("codex-mini-latest", msgs, undefined, 4096);
    expect(req.instructions).toBe("You are helpful");
    expect(req.input).toBe("Hi");
  });

  it("concatenates multiple user messages into input", () => {
    const msgs = [
      { role: "user", content: "First" },
      { role: "assistant", content: "Reply" },
      { role: "user", content: "Second" },
    ];
    const req = toResponsesRequest("codex-mini-latest", msgs, undefined, 4096);
    expect(req.input).toContain("First");
    expect(req.input).toContain("Second");
  });

  it("omits instructions when no system message", () => {
    const msgs = [{ role: "user", content: "Hi" }];
    const req = toResponsesRequest("codex-mini-latest", msgs, undefined, 4096);
    expect(req.instructions).toBeUndefined();
  });

  it("passes tools when provided", () => {
    const tools = [{ type: "function", function: { name: "bash", description: "run", parameters: {} } }];
    const req = toResponsesRequest("codex-mini-latest", [{ role: "user", content: "hi" }], tools, 4096);
    expect(req.tools).toHaveLength(1);
  });

  it("fromResponsesResponse extracts text from output", () => {
    const resp = { id: "r1", output: [{ type: "message", content: [{ type: "text", text: "Hello!" }] }] };
    expect(fromResponsesResponse(resp)).toBe("Hello!");
  });

  it("fromResponsesResponse returns empty on no text", () => {
    const resp = { id: "r1", output: [{ type: "function_call", name: "bash", arguments: "{}" }] };
    expect(fromResponsesResponse(resp)).toBe("");
  });
});
