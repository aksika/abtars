/**
 * cloakbrowser — primary alias for the abtars-browser CLI (#955).
 *
 * Delegates to the same parser/policy/IPC code as abtars-browser.
 * Published as the canonical name; abtars-browser retained as compat alias.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Detect and refuse executable-name collision with a separately installed cloakbrowser.
const HOME_BIN = join(homedir(), ".local", "bin", "cloakbrowser");
if (existsSync(HOME_BIN)) {
  const realPath = join(homedir(), ".abtars", "bin", "cloakbrowser");
  if (!existsSync(realPath)) {
    console.error("cloakbrowser: another executable exists at " + HOME_BIN + " (not managed by abtars). Use abtars-browser instead.");
    process.exit(2);
  }
}

const { main } = await import("./abtars-browser.js");
void main().then((code) => process.exit(code ?? 0));
