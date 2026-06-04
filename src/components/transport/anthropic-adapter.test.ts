import { describe, it, expect } from "vitest";
import { toAnthropicRequest, buildAnthropicHeaders, fromAnthropicResponse } from "./anthropic-adapter.js";

describe("anthropic-adapter", () => {
  it("extracts system message to top-level field", () => {
    const msgs = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hi" },
    ];
    const req = toAnthropicRequest("claude-sonnet-4", msgs, 4096);
    expect(req.system).toBe("You are helpful");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
  });

  it("converts role:tool to role:user with tool_result blocks", () => {
    const msgs = [
      { role: "user", content: "run ls" },
      { role: "assistant", content: "calling tool" },
      { role: "tool", content: "file1.ts\nfile2.ts", tool_call_id: "toolu_abc" },
    ];
    const req = toAnthropicRequest("claude-sonnet-4", msgs, 4096);
    const toolMsg = req.messages.find(m => Array.isArray(m.content));
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.role).toBe("user");
    const block = (toolMsg!.content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("toolu_abc");
    expect(block.content).toBe("file1.ts\nfile2.ts");
  });

  it("merges consecutive tool results into one user message", () => {
    const msgs = [
      { role: "tool", content: "result1", tool_call_id: "t1" },
      { role: "tool", content: "result2", tool_call_id: "t2" },
    ];
    const req = toAnthropicRequest("claude-sonnet-4", msgs, 4096);
    expect(req.messages).toHaveLength(1);
    expect((req.messages[0].content as unknown[]).length).toBe(2);
  });

  it("converts tool schemas to input_schema format", () => {
    const tools = [{ type: "function" as const, function: { name: "bash", description: "Run command", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
    const req = toAnthropicRequest("claude-sonnet-4", [{ role: "user", content: "hi" }], 4096, tools);
    expect(req.tools).toHaveLength(1);
    expect((req.tools![0] as Record<string, unknown>).name).toBe("bash");
    expect((req.tools![0] as Record<string, unknown>).input_schema).toBeDefined();
  });

  it("buildAnthropicHeaders uses x-api-key", () => {
    const h = buildAnthropicHeaders("sk-test");
    expect(h["x-api-key"]).toBe("sk-test");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["Authorization"]).toBeUndefined();
  });

  it("fromAnthropicResponse extracts text", () => {
    const resp = { content: [{ type: "text", text: "Hello!" }] };
    expect(fromAnthropicResponse(resp)).toBe("Hello!");
  });

  it("fromAnthropicResponse returns empty on no text", () => {
    const resp = { content: [{ type: "tool_use", id: "x", name: "bash" }] };
    expect(fromAnthropicResponse(resp as any)).toBe("");
  });
});
