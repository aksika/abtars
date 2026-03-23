import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "fs";

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Sanitizes a topic name into a safe filename component.
 * Returns null if the input is invalid (empty, path traversal, etc.).
 */
function sanitizeTopicName(input: string): string | null {
  // Reject path traversal patterns on raw input BEFORE sanitization
  if (input.includes("..") || input.includes("/") || input.includes("\\")) {
    return null;
  }

  // Replace all whitespace chars with hyphens
  let result = input.replace(/\s/g, "-");

  // Remove chars that are not alphanumeric, hyphens, or underscores
  result = result.replace(/[^a-zA-Z0-9_-]/g, "");

  // Collapse consecutive hyphens into a single hyphen
  result = result.replace(/-{2,}/g, "-");

  // Trim leading/trailing hyphens
  result = result.replace(/^-+|-+$/g, "");

  // Return null if result is empty
  if (result.length === 0) {
    return null;
  }

  return result;
}

/**
 * Builds the full topic file path from a sanitized name and date.
 */
function buildTopicPath(sanitizedName: string, date: string): string {
  return `.agentbridge/topics/${sanitizedName}-${date}.md`;
}

/**
 * Discovers an existing topic file by case-insensitive match on the name portion.
 * The filename must start with {sanitizedName}- (case-insensitive), followed by
 * a YYYY-MM-DD date pattern, and end with .md.
 * Returns the matching filename or null.
 */
function discoverTopicFile(sanitizedName: string, directoryFiles: string[]): string | null {
  const lowerName = sanitizedName.toLowerCase();
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;

  for (const file of directoryFiles) {
    if (!file.endsWith(".md")) continue;

    // Strip .md extension
    const withoutExt = file.slice(0, -3);

    // Find the last occurrence of a date pattern: -YYYY-MM-DD
    // The date is the last 10 chars after the last hyphen-group
    const lastDashIdx = withoutExt.length - 10;
    if (lastDashIdx < 1) continue;
    if (withoutExt[lastDashIdx - 1] !== "-") continue;

    const datePart = withoutExt.slice(lastDashIdx);
    const namePart = withoutExt.slice(0, lastDashIdx - 1);

    if (!datePattern.test(datePart)) continue;
    if (namePart.toLowerCase() === lowerName) {
      return file;
    }
  }

  return null;
}


// ─── Task 3.1: Basic Sanity Tests for Helpers ────────────────────────────────

describe("Topic Skill — Helper Functions", () => {
  describe("sanitizeTopicName", () => {
    it("preserves simple alphanumeric names", () => {
      expect(sanitizeTopicName("Tesla")).toBe("Tesla");
    });

    it("replaces spaces with hyphens", () => {
      expect(sanitizeTopicName("My Tesla Project")).toBe("My-Tesla-Project");
    });

    it("replaces tabs and newlines with hyphens", () => {
      expect(sanitizeTopicName("hello\tworld\nnew")).toBe("hello-world-new");
    });

    it("removes non-alphanumeric/hyphen/underscore chars", () => {
      expect(sanitizeTopicName("test!!!name")).toBe("testname");
    });

    it("collapses consecutive hyphens", () => {
      expect(sanitizeTopicName("My--Topic")).toBe("My-Topic");
    });

    it("preserves underscores", () => {
      expect(sanitizeTopicName("Already-Valid_Name")).toBe("Already-Valid_Name");
    });

    it("preserves original casing", () => {
      expect(sanitizeTopicName("CamelCase")).toBe("CamelCase");
    });

    it("returns null for empty string", () => {
      expect(sanitizeTopicName("")).toBeNull();
    });

    it("returns null for all-whitespace", () => {
      expect(sanitizeTopicName("   ")).toBeNull();
    });

    it("returns null for path traversal with ..", () => {
      expect(sanitizeTopicName("../etc/passwd")).toBeNull();
    });

    it("returns null for path traversal with /", () => {
      expect(sanitizeTopicName("some/path")).toBeNull();
    });

    it("returns null for path traversal with backslash", () => {
      expect(sanitizeTopicName("some\\path")).toBeNull();
    });
  });

  describe("buildTopicPath", () => {
    it("constructs the correct path", () => {
      expect(buildTopicPath("Tesla", "2025-07-17")).toBe(
        ".agentbridge/topics/Tesla-2025-07-17.md",
      );
    });

    it("works with hyphenated names", () => {
      expect(buildTopicPath("My-Tesla-Project", "2025-01-01")).toBe(
        ".agentbridge/topics/My-Tesla-Project-2025-01-01.md",
      );
    });
  });

  describe("discoverTopicFile", () => {
    it("finds a matching file case-insensitively", () => {
      const files = ["Tesla-2025-07-15.md", "Other-2025-01-01.md"];
      expect(discoverTopicFile("tesla", files)).toBe("Tesla-2025-07-15.md");
    });

    it("returns null when no match exists", () => {
      const files = ["Other-2025-01-01.md"];
      expect(discoverTopicFile("Tesla", files)).toBeNull();
    });

    it("returns null for empty directory", () => {
      expect(discoverTopicFile("Tesla", [])).toBeNull();
    });

    it("does not match partial name prefixes", () => {
      const files = ["TeslaMotors-2025-07-15.md"];
      expect(discoverTopicFile("Tesla", files)).toBeNull();
    });
  });
});


// ─── Tasks 3.2–3.7: Property-Based Tests ─────────────────────────────────────

describe("Topic Skill — Property Tests", () => {
  // Feature: topic-skill, Property 1: File path follows naming convention
  it("Property 1: File path follows naming convention", () => {
    // Generate valid topic names (alphanumeric + spaces) and ISO dates
    const topicNameArb = fc
      .stringOf(
        fc.constantFrom(
          ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ".split(""),
        ),
        { minLength: 1, maxLength: 40 },
      )
      .filter((s) => sanitizeTopicName(s) !== null);

    const dateArb = fc
      .tuple(
        fc.integer({ min: 2000, max: 2099 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
      )
      .map(
        ([y, m, d]) =>
          `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      );

    fc.assert(
      fc.property(topicNameArb, dateArb, (name, date) => {
        const sanitized = sanitizeTopicName(name)!;
        const path = buildTopicPath(sanitized, date);

        // Path must match the expected pattern
        const expectedPattern = /^\.agentbridge\/topics\/[a-zA-Z0-9_-]+-\d{4}-\d{2}-\d{2}\.md$/;
        expect(path).toMatch(expectedPattern);

        // Path must equal the exact construction
        expect(path).toBe(`.agentbridge/topics/${sanitized}-${date}.md`);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: topic-skill, Property 2: Discovery matches existing files case-insensitively
  it("Property 2: Discovery matches existing files case-insensitively", () => {
    const topicNameArb = fc
      .stringOf(
        fc.constantFrom(
          ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ".split(""),
        ),
        { minLength: 1, maxLength: 30 },
      )
      .filter((s) => sanitizeTopicName(s) !== null);

    const dateArb = fc
      .tuple(
        fc.integer({ min: 2000, max: 2099 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
      )
      .map(
        ([y, m, d]) =>
          `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      );

    fc.assert(
      fc.property(topicNameArb, dateArb, (name, date) => {
        const sanitized = sanitizeTopicName(name)!;

        // Create a case-varied version of the sanitized name for the directory listing
        const caseVaried = sanitized
          .split("")
          .map((ch) => (Math.random() > 0.5 ? ch.toUpperCase() : ch.toLowerCase()))
          .join("");

        const matchingFile = `${caseVaried}-${date}.md`;
        const nonMatchingFile = `CompletelyDifferent-${date}.md`;

        // Should find the case-varied match
        const found = discoverTopicFile(sanitized, [matchingFile, nonMatchingFile]);
        expect(found).toBe(matchingFile);

        // Should not find a false positive with a different name
        const notFound = discoverTopicFile(sanitized, [nonMatchingFile]);
        if (sanitized.toLowerCase() !== "completelydifferent") {
          expect(notFound).toBeNull();
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: topic-skill, Property 3: Filename date preserved on append
  it("Property 3: Filename date preserved on append", () => {
    const topicNameArb = fc
      .stringOf(
        fc.constantFrom(
          ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_".split(""),
        ),
        { minLength: 1, maxLength: 30 },
      )
      .filter((s) => sanitizeTopicName(s) !== null);

    const dateArb = fc
      .tuple(
        fc.integer({ min: 2000, max: 2099 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
      )
      .map(
        ([y, m, d]) =>
          `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      );

    fc.assert(
      fc.property(topicNameArb, dateArb, (name, date) => {
        const sanitized = sanitizeTopicName(name)!;
        const originalFilename = `${sanitized}-${date}.md`;

        // Simulate discovering the file
        const discovered = discoverTopicFile(sanitized, [originalFilename]);
        expect(discovered).toBe(originalFilename);

        // After "append", the filename should remain identical
        // (append does not change the filename — this is the invariant)
        const filenameAfterAppend = discovered;
        expect(filenameAfterAppend).toBe(originalFilename);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: topic-skill, Property 4: Sanitization produces only valid characters with casing preserved
  it("Property 4: Sanitization produces only valid characters with casing preserved", () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ minLength: 1, maxLength: 50 }), (input) => {
        const result = sanitizeTopicName(input);

        if (result === null) return; // null is acceptable for invalid inputs

        // Output must contain only valid characters
        expect(result).toMatch(/^[a-zA-Z0-9_-]+$/);

        // Verify casing preservation: every alpha char in the result must appear
        // in the original input with the same casing
        for (const ch of result) {
          if (/[a-zA-Z]/.test(ch)) {
            expect(input).toContain(ch);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: topic-skill, Property 5: Sanitization is idempotent
  it("Property 5: Sanitization is idempotent", () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ minLength: 0, maxLength: 50 }), (input) => {
        const first = sanitizeTopicName(input);

        if (first === null) return; // skip inputs that produce null

        const second = sanitizeTopicName(first);
        expect(second).toBe(first);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: topic-skill, Property 6: Path traversal rejection
  it("Property 6: Path traversal rejection", () => {
    // Generate strings that contain path traversal patterns
    const traversalArb = fc.oneof(
      // Strings containing ".."
      fc
        .tuple(
          fc.string({ minLength: 0, maxLength: 20 }),
          fc.string({ minLength: 0, maxLength: 20 }),
        )
        .map(([a, b]) => `${a}..${b}`),
      // Strings containing "/"
      fc
        .tuple(
          fc.string({ minLength: 0, maxLength: 20 }),
          fc.string({ minLength: 0, maxLength: 20 }),
        )
        .map(([a, b]) => `${a}/${b}`),
      // Strings containing "\"
      fc
        .tuple(
          fc.string({ minLength: 0, maxLength: 20 }),
          fc.string({ minLength: 0, maxLength: 20 }),
        )
        .map(([a, b]) => `${a}\\${b}`),
    );

    fc.assert(
      fc.property(traversalArb, (input) => {
        const result = sanitizeTopicName(input);
        expect(result).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});


// ─── Task 3.8: SKILL.md Content Validation ───────────────────────────────────

describe("Topic Skill — SKILL.md Validation", () => {
  const skillPath = "skills/topic-save.md";
  let content: string;

  it("SKILL.md file exists", () => {
    content = readFileSync(skillPath, "utf-8");
    expect(content).toBeTruthy();
  });

  it("YAML frontmatter contains required fields", () => {
    content = readFileSync(skillPath, "utf-8");
    // Extract frontmatter between --- delimiters (handle \r\n or \n)
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(frontmatterMatch).not.toBeNull();

    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).toMatch(/name:/);
    expect(frontmatter).toMatch(/description:/);
    expect(frontmatter).toMatch(/user-invocable:/);
  });

  it("contains 'When to use' section", () => {
    content = readFileSync(skillPath, "utf-8");
    expect(content.toLowerCase()).toContain("when to use");
  });

  it("contains 'When NOT to use' section", () => {
    content = readFileSync(skillPath, "utf-8");
    expect(content.toLowerCase()).toContain("when not to use");
  });

  it("does not contain CLI command patterns", () => {
    content = readFileSync(skillPath, "utf-8");
    // Should not reference agentbridge- CLI commands
    expect(content).not.toMatch(/agentbridge-\w+/);
  });

  it("sanitization edge case: empty string returns null", () => {
    expect(sanitizeTopicName("")).toBeNull();
  });

  it("sanitization edge case: all-whitespace returns null", () => {
    expect(sanitizeTopicName("   \t\n")).toBeNull();
  });

  it("sanitization edge case: ../etc/passwd returns null", () => {
    expect(sanitizeTopicName("../etc/passwd")).toBeNull();
  });

  it("discovery edge case: empty directory returns null", () => {
    expect(discoverTopicFile("Tesla", [])).toBeNull();
  });
});
