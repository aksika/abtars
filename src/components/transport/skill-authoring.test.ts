import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { skillCreateTool } from "./skill-authoring.js";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SKILLS_DIR = join(process.env.ABTARS_HOME ?? join(homedir(), ".abtars"), "skills");
const TEST_CATEGORY = "tools";
const TEST_NAME = "test-skill-vitest-tmp";
const TEST_PATH = join(SKILLS_DIR, TEST_CATEGORY, TEST_NAME);

function cleanup(): void {
  if (existsSync(TEST_PATH)) rmSync(TEST_PATH, { recursive: true });
}

describe("skill_create (#381)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("rejects invalid name", async () => {
    const r = JSON.parse(await skillCreateTool.execute({ name: "BAD NAME!", category: "tools", description: "test", content: "x".repeat(100) }));
    expect(r.error).toContain("Invalid name");
  });

  it("rejects invalid category", async () => {
    const r = JSON.parse(await skillCreateTool.execute({ name: TEST_NAME, category: "personal", description: "test", content: "x".repeat(100) }));
    expect(r.error).toContain("Invalid category");
  });

  it("rejects short description", async () => {
    const r = JSON.parse(await skillCreateTool.execute({ name: TEST_NAME, category: "tools", description: "", content: "x".repeat(100) }));
    expect(r.error).toContain("Description must be");
  });

  it("rejects content too short", async () => {
    const r = JSON.parse(await skillCreateTool.execute({ name: TEST_NAME, category: "tools", description: "test desc", content: "short" }));
    expect(r.error).toContain("too short");
  });

  it("rejects content too large", async () => {
    const r = JSON.parse(await skillCreateTool.execute({ name: TEST_NAME, category: "tools", description: "test desc", content: "x".repeat(51_000) }));
    expect(r.error).toContain("too large");
  });

  it("creates skill successfully", async () => {
    const content = "# Test Skill\n\n" + "This is a test skill with enough content to pass validation.\n".repeat(3);
    const r = JSON.parse(await skillCreateTool.execute({ name: TEST_NAME, category: TEST_CATEGORY, description: "A test skill", content }));
    expect(r.ok).toBe(true);
    expect(existsSync(join(TEST_PATH, "SKILL.md"))).toBe(true);
    const written = readFileSync(join(TEST_PATH, "SKILL.md"), "utf-8");
    expect(written).toContain("name: " + TEST_NAME);
    expect(written).toContain("description: A test skill");
    expect(written).toContain("# Test Skill");
  });

  it("rejects duplicate", async () => {
    const content = "# Test\n\n" + "Enough content here for the minimum.\n".repeat(4);
    await skillCreateTool.execute({ name: TEST_NAME, category: TEST_CATEGORY, description: "first", content });
    const r = JSON.parse(await skillCreateTool.execute({ name: TEST_NAME, category: TEST_CATEGORY, description: "second", content }));
    expect(r.error).toContain("already exists");
  });
});
