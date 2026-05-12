import { describe, it, expect } from "vitest";

describe("mcp-tool (integration)", () => {
  it("has correct tool definition shape", async () => {
    const { mcpTool } = await import("./mcp-tool.js");
    expect(mcpTool.name).toBe("mcp");
    expect(mcpTool.parameters.required).toContain("server");
    expect(mcpTool.parameters.required).toContain("tool");
  });

  it("returns error when mcporter not available", async () => {
    // This test works because mcporter daemon may not be running in test env
    const { mcpTool } = await import("./mcp-tool.js");
    const result = await mcpTool.execute({ server: "nonexistent", tool: "fake_tool" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeDefined();
  });
});
