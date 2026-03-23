/**
 * Auto-detect the ingestion source type from a user-provided argument.
 *
 * - YouTube URLs → "youtube"
 * - Non-YouTube HTTP/HTTPS URLs → "webpage"
 * - .pdf files → "pdf"
 * - .md files → "markdown"
 * - Everything else → "text"
 */

const YOUTUBE_HOSTNAMES = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);

export type IngestSourceType = "youtube" | "pdf" | "text" | "markdown" | "webpage";

export function detectIngestSourceType(arg: string): IngestSourceType {
  if (arg.startsWith("http://") || arg.startsWith("https://")) {
    try {
      const hostname = new URL(arg).hostname.toLowerCase();
      if (YOUTUBE_HOSTNAMES.has(hostname)) {
        return "youtube";
      }
    } catch {
      // Malformed URL — treat as webpage anyway since it starts with http(s)
    }
    return "webpage";
  }

  if (arg.endsWith(".pdf")) return "pdf";
  if (arg.endsWith(".md")) return "markdown";
  return "text";
}
