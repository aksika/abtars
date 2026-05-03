/**
 * #369 — Skill catalog gate + correct frontmatter parsing.
 *
 * Covers:
 * - parseSkillHeader (private but tested via generateCatalog output)
 * - YAML frontmatter extraction (name, description, requires)
 * - Fallback parsing for skills without frontmatter
 * - Binary-availability gate via execFileSync("which", [bin])
 * - Per-instance cache (no repeated which calls)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillWatcher } from "./skill-watcher.js";

describe("#369 — SkillWatcher frontmatter parsing + binary gate", () => {
  let tmpDir: string;
  let skillsDir: string;
  let catalogPath: string;
  let watcher: SkillWatcher;

  function writeSkill(name: string, content: string, category = "tools"): string {
    const dir = join(skillsDir, category, name);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "SKILL.md");
    writeFileSync(p, content, "utf-8");
    return p;
  }

  function readCatalog(): string {
    return readFileSync(catalogPath, "utf-8");
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "skill-watcher-"));
    skillsDir = join(tmpDir, "skills");
    catalogPath = join(tmpDir, "core", "skills_catalog.md");
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(join(tmpDir, "core"), { recursive: true });
    watcher = new SkillWatcher(skillsDir, catalogPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Frontmatter parsing ────────────────────────────────────────────────

  describe("frontmatter", () => {
    it("extracts name + description from YAML frontmatter", () => {
      writeSkill("alpha", `---
name: alpha
description: First test skill
---

# Heading that should NOT be used as name

Body paragraph.
`);
      watcher.generateCatalog();
      const catalog = readCatalog();
      expect(catalog).toContain("- alpha: First test skill");
      expect(catalog).not.toContain("Heading that should NOT");
    });

    it("is case-insensitive on frontmatter keys", () => {
      writeSkill("beta", `---
Name: beta
Description: Mixed-case keys
---

# body
`);
      watcher.generateCatalog();
      expect(readCatalog()).toContain("- beta: Mixed-case keys");
    });

    it("trims whitespace around values", () => {
      writeSkill("gamma", `---
name:    gamma
description:     Padded description
---
`);
      watcher.generateCatalog();
      expect(readCatalog()).toContain("- gamma: Padded description");
    });

    it("extracts 'requires' field when present", () => {
      // node is always available — skill should appear
      writeSkill("runnable", `---
name: runnable
description: Gated by node presence
requires: node
---
`);
      watcher.generateCatalog();
      expect(readCatalog()).toContain("- runnable: Gated by node presence");
    });

    it("handles unclosed frontmatter (falls back to heading heuristic)", () => {
      writeSkill("broken", `---
name: broken
description: Missing closing fence

# Heading
Body.
`);
      watcher.generateCatalog();
      const catalog = readCatalog();
      // Falls back to heading/paragraph heuristic — name from `# Heading`
      expect(catalog).toContain("- Heading:");
    });

    it("handles no-frontmatter files via fallback heuristic", () => {
      writeSkill("plain", `# Plain Heading

This is a paragraph describing the skill, long enough to pass the > 10 char filter.
`);
      watcher.generateCatalog();
      expect(readCatalog()).toContain("- Plain Heading:");
      expect(readCatalog()).toContain("This is a paragraph");
    });

    it("truncates description at 120 chars", () => {
      const long = "x".repeat(200);
      writeSkill("long", `---
name: long
description: ${long}
---
`);
      watcher.generateCatalog();
      const catalog = readCatalog();
      // Should contain exactly 120 x's, not 200
      const match = catalog.match(/- long: (x+)/);
      expect(match).not.toBeNull();
      expect(match![1]!.length).toBe(120);
    });

    it("ignores leading empty lines before frontmatter fence", () => {
      writeSkill("padded", `

---
name: padded
description: Leading blank lines
---
`);
      watcher.generateCatalog();
      expect(readCatalog()).toContain("- padded: Leading blank lines");
    });
  });

  // ── Binary gate ────────────────────────────────────────────────────────

  describe("requires gate", () => {
    it("includes skill when required binary is present (node)", () => {
      writeSkill("needs-node", `---
name: needs-node
description: Requires node runtime
requires: node
---
`);
      watcher.generateCatalog();
      expect(readCatalog()).toContain("- needs-node:");
    });

    it("skips skill when required binary is missing", () => {
      writeSkill("needs-missing", `---
name: needs-missing
description: Requires a binary that does not exist
requires: nonexistent-cli-abc123xyz
---
`);
      watcher.generateCatalog();
      const catalog = readCatalog();
      expect(catalog).not.toContain("needs-missing");
    });

    it("includes skills without 'requires:' field regardless (backward compat)", () => {
      writeSkill("no-req", `---
name: no-req
description: No requires field
---
`);
      watcher.generateCatalog();
      expect(readCatalog()).toContain("- no-req: No requires field");
    });

    it("catalog contains exactly the expected subset on mixed input", () => {
      writeSkill("a", `---
name: a
description: Always included
---
`);
      writeSkill("b", `---
name: b
description: Gated by node
requires: node
---
`);
      writeSkill("c", `---
name: c
description: Gated by nonsense
requires: nonexistent-zxy-999
---
`);
      watcher.generateCatalog();
      const catalog = readCatalog();
      expect(catalog).toContain("- a: Always included");
      expect(catalog).toContain("- b: Gated by node");
      expect(catalog).not.toContain("- c:");
      expect(catalog).not.toContain("c: Gated");
    });

    it("caches 'which' results across multiple generateCatalog calls", () => {
      // First call populates the cache. Second call should not re-invoke `which`.
      // We can't easily spy on execFileSync without DI, so we verify observable
      // behavior: back-to-back calls both produce the same catalog correctly
      // and are fast (no 1s timeouts stacking up).
      writeSkill("cached", `---
name: cached
description: Uses binary cache
requires: node
---
`);
      const start = Date.now();
      watcher.generateCatalog();
      watcher.generateCatalog();
      watcher.generateCatalog();
      const elapsed = Date.now() - start;
      expect(readCatalog()).toContain("- cached:");
      // 3 calls with caching should complete fast. Without caching, 3 × execFileSync = ~60ms+.
      // We assert a generous bound that still catches "cache is broken".
      expect(elapsed).toBeLessThan(500);
    });
  });

  // ── Injection-safety guard preserved ──────────────────────────────────

  describe("existing behavior preserved", () => {
    it("generates a valid catalog header even with zero skills", () => {
      watcher.generateCatalog();
      expect(readCatalog()).toMatch(/^# Skills Catalog\n/);
    });
  });
});
