/**
 * abtars-browser — standalone CLI for agent-initiated browser control.
 *
 * Gives the LLM agent direct control over a headless Chromium browser.
 * Follows the same pattern as abmind recall and abmind store.
 *
 * Usage:
 *   abtars-browser --action navigate --url "https://example.com" --session-id default
 *   abtars-browser --action fill --selector "#email" --value "user@example.com" --session-id auth
 *   abtars-browser --action click --selector "text=Sign In" --session-id auth
 *   abtars-browser --action extract_text --session-id auth
 *   abtars-browser --action screenshot --full-page --session-id auth
 *   abtars-browser --action get_page_info --session-id auth
 *   abtars-browser --action close_session --session-id auth
 *
 * Output (success):
 *   { "success": true, "title": "Example", "url": "https://example.com", "status": 200 }
 *
 * Output (error):
 *   { "success": false, "error": "navigate action requires --url" }
 */

import * as net from "node:net";
import * as fs from "node:fs";
import type { BrowserAction, BrowserActionType, BrowserToolResult } from "../types/browser.js";
import { BrowserManager } from "../capabilities/browser/browser-manager.js";
import { BrowserTool } from "../capabilities/browser/browser-tool.js";
import { DomainAllowlist } from "../capabilities/browser/domain-allowlist.js";
import { getDefaultSocketPath } from "../capabilities/browser/browser-ipc-server.js";

/** The 7 valid browser action types. */
const VALID_ACTIONS: ReadonlySet<string> = new Set<BrowserActionType>([
  "navigate",
  "click",
  "fill",
  "extract_text",
  "screenshot",
  "get_page_info",
  "close_session",
  "set_cookie",
]);

export type RawBrowserArgs = {
  action?: string;
  url?: string;
  selector?: string;
  value?: string;
  sessionId: string;
  fullPage: boolean;
  cookieFile?: string;
  engine?: string;
};

/**
 * Parse raw CLI argv into a RawBrowserArgs object.
 * Exported for unit testing.
 */
export function parseArgs(argv: string[]): RawBrowserArgs {
  const args = argv.slice(2);
  const parsed: RawBrowserArgs = { sessionId: "default", fullPage: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--action":     parsed.action = args[++i] ?? ""; break;
      case "--url":        parsed.url = args[++i] ?? ""; break;
      case "--selector":   parsed.selector = args[++i] ?? ""; break;
      case "--value":      parsed.value = args[++i] ?? ""; break;
      case "--session-id": parsed.sessionId = args[++i] ?? "default"; break;
      case "--full-page":  parsed.fullPage = true; break;
      case "--cookie-file": parsed.cookieFile = args[++i] ?? ""; break;
      case "--engine":     parsed.engine = args[++i] ?? ""; break;
    }
  }

  return parsed;
}

/**
 * Validate raw CLI arguments and return either a parsed BrowserAction or an error string.
 * Exported for unit testing.
 */
export function validateArgs(
  raw: RawBrowserArgs,
): { ok: true; action: BrowserAction; raw: RawBrowserArgs } | { ok: false; error: string } {
  // Validate action is one of the 7 valid types
  if (!raw.action) {
    return { ok: false, error: "--action is required" };
  }
  if (!VALID_ACTIONS.has(raw.action)) {
    return {
      ok: false,
      error: `Invalid action "${raw.action}". Valid actions: ${[...VALID_ACTIONS].join(", ")}`,
    };
  }

  const actionType = raw.action as BrowserActionType;

  // Validate required params per action
  switch (actionType) {
    case "navigate":
      if (!raw.url) return { ok: false, error: "navigate action requires --url" };
      break;
    case "click":
      if (!raw.selector) return { ok: false, error: "click action requires --selector" };
      break;
    case "fill":
      if (!raw.selector) return { ok: false, error: "fill action requires --selector" };
      if (raw.value === undefined) return { ok: false, error: "fill action requires --value" };
      break;
    case "set_cookie":
      if (!raw.cookieFile) return { ok: false, error: "set_cookie action requires --cookie-file" };
      break;
    // extract_text, screenshot, get_page_info, close_session have no extra required params
  }

  return {
    ok: true,
    raw,
    action: {
      action: actionType,
      sessionId: raw.sessionId,
      url: raw.url,
      selector: raw.selector,
      value: raw.value,
      fullPage: raw.fullPage,
      cookieFile: raw.cookieFile,
    },
  };
}

// --- CLI entry point (only runs when executed directly) ---

/**
 * Try executing the action via the main process IPC socket.
 * Returns null if socket unavailable (caller should fall back to ephemeral).
 */
export function executeViaIpc(
  action: BrowserAction,
  socketPath?: string,
): Promise<BrowserToolResult | null> {
  const sock = socketPath ?? getDefaultSocketPath();

  if (!fs.existsSync(sock)) return Promise.resolve(null);

  return new Promise<BrowserToolResult | null>((resolve) => {
    const conn = net.createConnection(sock, () => {
      conn.end(JSON.stringify(action) + "\n");
    });

    let data = "";
    conn.on("data", (chunk) => { data += chunk.toString(); });

    conn.on("end", () => {
      try {
        resolve(JSON.parse(data.trim()) as BrowserToolResult);
      } catch {
        resolve(null);
      }
    });

    conn.on("error", () => resolve(null));

    // Don't hang forever if main process is stuck.
    conn.setTimeout(60_000, () => {
      conn.destroy();
      resolve(null);
    });
  });
}

async function main() {
  const raw = parseArgs(process.argv);
  const validation = validateArgs(raw);

  if (!validation.ok) {
    console.log(JSON.stringify({ success: false, error: validation.error }));
    process.exit(1);
  }

  // Try IPC to main process first (sessions persist across calls).
  const ipcResult = await executeViaIpc(validation.action);
  if (ipcResult !== null) {
    console.log(JSON.stringify(ipcResult));
    return;
  }

  // Fallback: ephemeral browser (no session persistence).
  if (validation.raw.engine) process.env["BROWSER_ENGINE"] = validation.raw.engine;
  else if (!process.env["BROWSER_ENGINE"]) process.env["BROWSER_ENGINE"] = "cloakbrowser";
  const browserManager = new BrowserManager();
  const allowlist = DomainAllowlist.fromEnv();
  const tool = new BrowserTool(browserManager, allowlist);

  try {
    const result = await tool.execute(validation.action);
    console.log(JSON.stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ success: false, error: message }));
  } finally {
    await browserManager.shutdown();
  }
}

// Only run when executed as a script, not when imported for testing
const isDirectRun =
  process.argv[1]?.endsWith("abtars-browser.ts") ||
  process.argv[1]?.endsWith("abtars-browser.js");
if (isDirectRun) {
  main();
}
