import type { Page } from "patchright";

/**
 * Strips non-content HTML elements and returns clean plain text.
 * Shared by both the agent tool's extract_text action and the ingestion WebScraper.
 *
 * Uses regex-based approach for raw HTML strings (no DOM available in Node.js).
 * Uses page.evaluate() for live Playwright pages (DOM APIs available in browser).
 */

/** Tags whose entire content (including children) should be removed. */
const STRIPPED_TAGS = ["script", "style", "nav", "footer", "header", "aside"];

/** Build a regex that matches an opening tag through its closing tag (non-greedy, case-insensitive). */
function buildTagStripRegex(tag: string): RegExp {
  return new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
}

/** Regex to match elements with role="navigation" or role="banner". */
const ROLE_STRIP_REGEX =
  /<[a-z][a-z0-9]*\s[^>]*?\brole\s*=\s*["'](navigation|banner)["'][^>]*>[\s\S]*?<\/[a-z][a-z0-9]*>/gi;

/** Regex to match any remaining HTML tag. */
const HTML_TAG_REGEX = /<[^>]+>/g;

/** Common HTML entities to decode. */
const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

const ENTITY_REGEX = /&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g;

/**
 * Parse raw HTML string and return clean text.
 * Removes non-content elements, strips tags, decodes entities, collapses whitespace.
 * Returns empty string on empty/whitespace-only input.
 */
export function extractTextFromHtml(html: string): string {
  if (!html || !html.trim()) return "";

  let text = html;

  // 1. Remove stripped tag elements and their content
  for (const tag of STRIPPED_TAGS) {
    text = text.replace(buildTagStripRegex(tag), "");
  }

  // 2. Remove elements with role="navigation" or role="banner"
  text = text.replace(ROLE_STRIP_REGEX, "");

  // 3. Strip all remaining HTML tags
  text = text.replace(HTML_TAG_REGEX, " ");

  // 4. Decode common HTML entities
  text = text.replace(ENTITY_REGEX, (match) => ENTITY_MAP[match] ?? match);

  // 5. Collapse consecutive whitespace into single spaces/newlines
  //    First normalize newlines, then collapse blank lines, then collapse spaces
  text = text.replace(/\r\n/g, "\n");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ ]+/g, "\n");
  text = text.replace(/[ ]+\n/g, "\n");
  text = text.replace(/\n{2,}/g, "\n");

  return text.trim();
}

/**
 * JavaScript source executed inside the browser context via page.evaluate().
 * Uses DOM APIs (document, HTMLElement, etc.) which are only available at runtime.
 * Accepts a single argument: the CSS selector string or null for full-page extraction.
 */
const BROWSER_EXTRACT_FN = `
(sel) => {
  const TAGS = ["script", "style", "nav", "footer", "header", "aside"];
  const ROLES = ["navigation", "banner"];

  const root = sel ? document.querySelector(sel) : document.body;
  if (!root) return "";

  const clone = root.cloneNode(true);

  for (const tag of TAGS) {
    for (const el of clone.querySelectorAll(tag)) el.remove();
  }
  for (const role of ROLES) {
    for (const el of clone.querySelectorAll('[role="' + role + '"]')) el.remove();
  }

  let text = clone.textContent || "";
  text = text.replace(/\\u00a0/g, " ");
  text = text.replace(/[ \\t]+/g, " ");
  text = text.replace(/\\n[ ]+/g, "\\n");
  text = text.replace(/[ ]+\\n/g, "\\n");
  text = text.replace(/\\n{2,}/g, "\\n");
  return text.trim();
}
`;

/**
 * Extract clean text from a live Playwright Page (runs in browser context).
 * Optionally scoped to a CSS selector. Returns empty string on failure.
 */
export async function extractTextFromPage(
  page: Page,
  selector?: string,
): Promise<string> {
  const text = await page.evaluate<string, string | null>(
    new Function("sel", `return (${BROWSER_EXTRACT_FN})(sel)`) as (sel: string | null) => string,
    selector ?? null,
  );

  return text ?? "";
}
