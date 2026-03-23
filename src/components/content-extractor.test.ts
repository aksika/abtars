import { describe, it, expect } from "vitest";
import { extractTextFromHtml } from "./content-extractor.js";

describe("extractTextFromHtml", () => {
  // ── Empty / whitespace input ────────────────────────────────────────────

  describe("empty input", () => {
    it("returns empty string for empty input", () => {
      expect(extractTextFromHtml("")).toBe("");
    });

    it("returns empty string for whitespace-only input", () => {
      expect(extractTextFromHtml("   \n\t  ")).toBe("");
    });
  });

  // ── Tag stripping ──────────────────────────────────────────────────────

  describe("strips non-content elements", () => {
    it("removes script elements and their content", () => {
      const html = "<p>Hello</p><script>alert('xss')</script><p>World</p>";
      expect(extractTextFromHtml(html)).toBe("Hello World");
    });

    it("removes style elements and their content", () => {
      const html = "<style>.foo { color: red; }</style><p>Content</p>";
      expect(extractTextFromHtml(html)).toBe("Content");
    });

    it("removes nav elements", () => {
      const html = "<nav><a href='/'>Home</a></nav><main>Main content</main>";
      expect(extractTextFromHtml(html)).toBe("Main content");
    });

    it("removes footer elements", () => {
      const html = "<p>Body</p><footer>Copyright 2024</footer>";
      expect(extractTextFromHtml(html)).toBe("Body");
    });

    it("removes header elements", () => {
      const html = "<header>Site Header</header><p>Content</p>";
      expect(extractTextFromHtml(html)).toBe("Content");
    });

    it("removes aside elements", () => {
      const html = "<p>Main</p><aside>Sidebar</aside>";
      expect(extractTextFromHtml(html)).toBe("Main");
    });
  });

  // ── Role-based stripping ───────────────────────────────────────────────

  describe("strips elements by role attribute", () => {
    it("removes elements with role=navigation", () => {
      const html = '<div role="navigation"><a>Nav link</a></div><p>Content</p>';
      expect(extractTextFromHtml(html)).toBe("Content");
    });

    it("removes elements with role=banner", () => {
      const html = '<div role="banner">Banner text</div><p>Content</p>';
      expect(extractTextFromHtml(html)).toBe("Content");
    });
  });

  // ── HTML tag stripping ─────────────────────────────────────────────────

  describe("strips all HTML tags", () => {
    it("removes simple tags", () => {
      const html = "<p>Hello <strong>world</strong></p>";
      expect(extractTextFromHtml(html)).toBe("Hello world");
    });

    it("removes self-closing tags", () => {
      const html = "Line one<br/>Line two";
      expect(extractTextFromHtml(html)).toBe("Line one Line two");
    });

    it("removes tags with attributes", () => {
      const html = '<a href="https://example.com" class="link">Click here</a>';
      expect(extractTextFromHtml(html)).toBe("Click here");
    });
  });

  // ── Entity decoding ────────────────────────────────────────────────────

  describe("decodes HTML entities", () => {
    it("decodes &amp;", () => {
      expect(extractTextFromHtml("Tom &amp; Jerry")).toBe("Tom & Jerry");
    });

    it("decodes &lt; and &gt;", () => {
      expect(extractTextFromHtml("a &lt; b &gt; c")).toBe("a < b > c");
    });

    it("decodes &quot;", () => {
      expect(extractTextFromHtml("He said &quot;hello&quot;")).toBe('He said "hello"');
    });

    it("decodes &#39;", () => {
      expect(extractTextFromHtml("it&#39;s fine")).toBe("it's fine");
    });

    it("decodes &nbsp;", () => {
      expect(extractTextFromHtml("word&nbsp;word")).toBe("word word");
    });
  });

  // ── Whitespace collapsing ──────────────────────────────────────────────

  describe("collapses whitespace", () => {
    it("collapses multiple spaces into one", () => {
      expect(extractTextFromHtml("hello     world")).toBe("hello world");
    });

    it("collapses multiple newlines into one", () => {
      expect(extractTextFromHtml("line1\n\n\n\nline2")).toBe("line1\nline2");
    });

    it("trims leading and trailing whitespace", () => {
      expect(extractTextFromHtml("  \n  hello  \n  ")).toBe("hello");
    });

    it("collapses tabs", () => {
      expect(extractTextFromHtml("col1\t\t\tcol2")).toBe("col1 col2");
    });
  });

  // ── Combined scenarios ─────────────────────────────────────────────────

  describe("combined extraction", () => {
    it("handles a realistic HTML page", () => {
      const html = `
        <html>
          <head><title>Test</title></head>
          <body>
            <header><h1>Site Name</h1></header>
            <nav><a href="/">Home</a><a href="/about">About</a></nav>
            <main>
              <p>This is the &amp; main content.</p>
              <p>It has <strong>bold</strong> text.</p>
            </main>
            <aside>Related links</aside>
            <footer>Copyright &copy; 2024</footer>
            <script>console.log("tracking")</script>
            <style>body { margin: 0; }</style>
          </body>
        </html>
      `;
      const result = extractTextFromHtml(html);
      expect(result).toContain("This is the & main content.");
      expect(result).toContain("bold");
      expect(result).not.toContain("Site Name");
      expect(result).not.toContain("Home");
      expect(result).not.toContain("Related links");
      expect(result).not.toContain("tracking");
      expect(result).not.toContain("margin");
    });

    it("returns no HTML tags in output", () => {
      const html = "<div><p>Text with <b>tags</b> and <a href='#'>links</a></p></div>";
      const result = extractTextFromHtml(html);
      expect(result).not.toMatch(/<[^>]+>/);
    });
  });
});
