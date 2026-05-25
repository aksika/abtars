import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { skillCreateTool } from "./skill-authoring.js";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SKILLS_DIR = join(process.env.ABTARS_HOME ?? join(homedir(), ".abtars"), "skills");
const TEST_NAME = "test-skill-vitest-tmp";
const TEST_PATH = join(SKILLS_DIR, "self", TEST_NAME);

function cleanup(): void {
  if (existsSync(TEST_PATH)) rmSync(TEST_PATH, { recursive: true });
}

describe("skill_create (#381, #614)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("rejects invalid name", async () => {
    const r = JSON.parse(await skillCreateTool.execute({ name: "BAD NAME!", description: "test", content: "x".repeat(100) }));
    expect(r.error).toContain("Invalid name");
  });

  it("rejects short description", async () => {
    const r = JSON.parse(await skillCreateTool.execute({ name: TEST_NAME, description: "", content: "x".repeat(100) }));
    expect(r.error).toContain("Description must be");
  });

  it("rejects content too short", async () => {
    const r = JSON.parse(await skillCreateTool.execute({ name: TEST_NAME, description: "test desc", content: "short" }));
    expect(r.error).toContain("too short");
  });

  it("rejects content too large", async () => {
    const r = JSON.parse(await skillCreateTool.execute({ name: TEST_NAME, description: "test desc", content: "x".repeat(51_000) }));
    expect(r.error).toContain("too large");
  });

  it("creates skill in self/ directory", async () => {
    const content = "# Test Skill\n\n" + "This is a test skill with enough content to pass validation.\n".repeat(3);
    const r = JSON.parse(await skillCreateTool.execute({ name: TEST_NAME, description: "A test skill", content }));
    expect(r.ok).toBe(true);
    expect(r.path).toContain("self/" + TEST_NAME);
    expect(existsSync(join(TEST_PATH, "SKILL.md"))).toBe(true);
    const written = readFileSync(join(TEST_PATH, "SKILL.md"), "utf-8");
    expect(written).toContain("name: " + TEST_NAME);
    expect(written).toContain("description: A test skill");
    expect(written).toContain("# Test Skill");
  });

  it("stores tags in frontmatter", async () => {
    const content = "# Tagged Skill\n\n" + "Content with enough bytes to pass.\n".repeat(4);
    const r = JSON.parse(await skillCreateTool.execute({ name: TEST_NAME, description: "Tagged", content, tags: ["browser", "debugging"] }));
    expect(r.ok).toBe(true);
    const written = readFileSync(join(TEST_PATH, "SKILL.md"), "utf-8");
    expect(written).toContain("tags: [browser, debugging]");
  });

  it("rejects duplicate", async () => {
    const content = "# Test\n\n" + "Enough content here for the minimum.\n".repeat(4);
    await skillCreateTool.execute({ name: TEST_NAME, description: "first", content });
    const r = JSON.parse(await skillCreateTool.execute({ name: TEST_NAME, description: "second", content }));
    expect(r.error).toContain("already exists");
  });
});
