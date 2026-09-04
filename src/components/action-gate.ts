/**
 * action-gate.ts — Out-of-band authorization for privileged actions.
 * Agent requests a privileged action → Telegram inline keyboard to master → proceed/deny.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { logInfo, logWarn, logError } from "./logger.js";
import { logAndSwallow } from "./log-and-swallow.js";
import { atomicWriteSync } from "./atomic-write.js";

const TAG = "action-gate";

export interface AuthToken {
  id: string;
  category: string;
  pattern: string;
  expiresAt: number;
  consumed: boolean;
}

export interface AuthRule {
  category: string;
  pattern: string;
  action: "allow" | "deny";
  createdAt: string;
}

export interface AuthRequest {
  id: string;
  category: string;
  detail: string;
  resolve: (granted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  reminderSent: boolean;
}

export type NotifyFn = (text: string, buttons: Array<{ text: string; data: string }>) => Promise<void>;

/** #1771: compile a stored rule pattern (glob: `*` → any run, `?` → one char) to an anchored regex. */
export function globToRegExp(glob: string): RegExp {
  let src = "^";
  for (const ch of glob) {
    if (ch === "*") src += ".*";
    else if (ch === "?") src += ".";
    else if ("\\.+^${}()|[]".includes(ch)) src += `\\${ch}`;
    else src += ch;
  }
  return new RegExp(src + "$");
}

const PRIVILEGE_WRAPPERS = new Set(["sudo", "doas", "pkexec", "runuser", "su"]);
const FAMILY_SUBCOMMAND_EXES = new Set(["git", "npm", "pnpm", "yarn", "docker"]);
const GIT_OPTIONS_WITH_VALUES = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path", "--super-prefix"]);

function commandBasename(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

/**
 * #1771: derive the stored family pattern for an "Always allow" grant.
 * Unwraps one privilege wrapper (prefix preserved: `sudo rm …` → `sudo rm*`)
 * and transparent `env` + `VAR=value` prefixes (dropped). git/npm-style
 * executables keep their subcommand (`git status*`, `npm run*`); anything
 * else collapses to the executable (`node*`). Always ends with `*`.
 */
export function familyPattern(cmd: string): string {
  const tokens = cmd.split(/\s+/).filter((t) => t.length > 0);
  let i = 0;
  let prefix = "";
  if (tokens[0] !== undefined && PRIVILEGE_WRAPPERS.has(commandBasename(tokens[0]).toLowerCase())) {
    prefix = `${tokens[0]} `;
    i = 1;
  }
  if (tokens[i] === "env") {
    i++;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  } else {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  }
  const exe = tokens[i];
  if (exe === undefined) {
    const raw = cmd.trim();
    return raw ? `${raw}*` : "*";
  }
  const rest = tokens.slice(i + 1);
  if (FAMILY_SUBCOMMAND_EXES.has(commandBasename(exe).toLowerCase())) {
    const optionsWithValues = commandBasename(exe).toLowerCase() === "git" ? GIT_OPTIONS_WITH_VALUES : undefined;
    for (let k = 0; k < rest.length; k++) {
      const arg = rest[k]!;
      if (arg === "--") {
        const sub = rest[k + 1];
        return sub !== undefined ? `${prefix}${exe} ${sub}*` : `${prefix}${exe}*`;
      }
      if (optionsWithValues?.has(arg)) { k++; continue; }
      if (arg.startsWith("-") && arg.length > 1) continue;
      return `${prefix}${exe} ${arg}*`;
    }
  }
  return `${prefix}${exe}*`;
}

/**
 * #1629/#1663: trusted tool-authorization mode derived by Spin from durable
 * Kanban provenance. `unattended-task` is only ever set by bridge code for an
 * execution whose durable root card has `source === "task"`. A card-backed
 * execution whose provenance cannot be verified is `unverified`; it must not
 * receive unattended grants or non-idempotent scheduled-delivery access. The
 * model can never supply or override the mode.
 */
export type ToolAuthorizationMode = "interactive" | "unattended-task" | "unattended-sleep" | "unverified";

export interface AuthRequestOptions {
  /** Defaults to interactive behavior when omitted or invalid. */
  mode?: ToolAuthorizationMode;
}

export class ActionGate {
  private tokens = new Map<string, AuthToken>();
  private pending = new Map<string, AuthRequest>();
  private rules: AuthRule[] = [];
  private rulesPath: string;
  private auditPath: string;
  private notify: NotifyFn | null = null;

  constructor(authDir: string) {
    this.rulesPath = join(authDir, "rules.json");
    this.auditPath = join(authDir, "audit.jsonl");
    mkdirSync(authDir, { recursive: true });
    this.loadRules();
  }

  setNotify(fn: NotifyFn): void {
    this.notify = fn;
  }

  /** Check if a rule already allows/denies this action (last match wins). */
  checkRules(category: string, pattern: string): "allow" | "deny" | null {
    return this.matchedRule(category, pattern)?.action ?? null;
  }

  /**
   * #1771: last matching rule for (category, pattern), re-reading the file
   * first so concurrent `abtars auth` CLI edits are honored without a
   * restart. A parse failure keeps the last in-memory snapshot (never a
   * silent empty set).
   */
  matchedRule(category: string, pattern: string): AuthRule | null {
    this.reloadRules();
    let matched: AuthRule | null = null;
    for (const rule of this.rules) {
      if (rule.category !== category) continue;
      let re: RegExp;
      try {
        re = globToRegExp(rule.pattern);
      } catch {
        continue;
      }
      if (re.test(pattern)) matched = rule;
    }
    return matched;
  }

  /** #1771: rules for `abtars auth list` (re-reads; returns a copy). */
  listRules(): AuthRule[] {
    this.reloadRules();
    return this.rules.map((r) => ({ ...r }));
  }

  /**
   * #1771: remove rule by 0-based index for `abtars auth rm`.
   * Re-reads before splicing and writes atomically. False on out-of-range.
   */
  removeRule(index: number): boolean {
    this.reloadRules();
    if (!Number.isInteger(index) || index < 0 || index >= this.rules.length) return false;
    this.rules.splice(index, 1);
    this.writeRules();
    logInfo(TAG, `Removed rule at index ${index}`);
    return true;
  }

  /**
   * Request authorization for a privileged action.
   * Returns true if granted, false if denied/timed out.
   *
   * #1629: persistent rules always take precedence. Only when no rule matches
   * may the unattended-task fallback auto-allow — and only for `bash-auth`.
   * The fallback never notifies and never enqueues a pending request.
   */
  async requestAuth(category: string, detail: string, options: AuthRequestOptions = {}): Promise<boolean> {
    // Check persistent rules first — they outrank every fallback
    const matched = this.matchedRule(category, detail);
    if (matched?.action === "allow") {
      this.audit(category, detail, "allowed-by-rule", matched.pattern);
      return true;
    }
    if (matched?.action === "deny") {
      this.audit(category, detail, "denied-by-rule", matched.pattern);
      return false;
    }

    // #1629: unattended scheduled-task execution — no rule, bash only.
    // Audit evidence is preserved; no pending request, no notification.
    if (category === "bash-auth" && options.mode === "unattended-task") {
      this.audit(category, detail, "allowed-unattended-task");
      return true;
    }

    // No rule — ask master via Telegram
    if (!this.notify) {
      logWarn(TAG, `No notify function — auto-denying ${category}: ${detail.slice(0, 80)}`);
      this.audit(category, detail, "denied-no-notify");
      return false;
    }

    const requestId = randomBytes(8).toString("hex");
    const message = this.formatMessage(category, detail);

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        logWarn(TAG, `Auth request timed out: ${category} ${detail.slice(0, 60)}`);
        this.audit(category, detail, "denied-timeout");
        resolve(false);
      }, 120_000);

      // 60s reminder
      const reminderTimer = setTimeout(() => {
        const req = this.pending.get(requestId);
        if (req && !req.reminderSent) {
          req.reminderSent = true;
          this.notify?.("⏳ Still waiting for authorization...", []).catch(err => logAndSwallow(TAG, "send authorization reminder", err));
        }
      }, 60_000);

      this.pending.set(requestId, { id: requestId, category, detail, resolve: (granted) => {
        clearTimeout(timer);
        clearTimeout(reminderTimer);
        this.pending.delete(requestId);
        resolve(granted);
      }, timer, reminderSent: false });

      this.notify!(message, [
        { text: "✓ Allow once", data: `auth:${requestId}:once` },
        { text: "🔓 Always allow", data: `auth:${requestId}:always` },
        { text: "❌ Deny", data: `auth:${requestId}:deny` },
      ]).catch((err) => {
        logError(TAG, `Failed to send auth request: ${err}`);
        clearTimeout(timer);
        clearTimeout(reminderTimer);
        this.pending.delete(requestId);
        this.audit(category, detail, "denied-send-failed");
        resolve(false);
      });
    });
  }

  /** Handle callback from Telegram button press. */
  handleCallback(data: string): boolean {
    const match = data.match(/^auth:([a-f0-9]+):(once|always|deny)$/);
    if (!match) return false;

    const [, requestId, action] = match;
    const req = this.pending.get(requestId!);
    if (!req) return false;

    if (action === "once") {
      this.audit(req.category, req.detail, "allowed-once");
      req.resolve(true);
    } else if (action === "always") {
      // #1771: store the command family, never the raw command text.
      const family = familyPattern(req.detail);
      this.storeRule(req.category, family, "allow");
      this.audit(req.category, req.detail, "allowed-always", family);
      req.resolve(true);
    } else {
      this.audit(req.category, req.detail, "denied");
      req.resolve(false);
    }
    return true;
  }

  /** Generate a one-use token for external CLI callers. */
  generateToken(category: string, pattern: string): string {
    const id = randomBytes(16).toString("hex");
    this.tokens.set(id, {
      id,
      category,
      pattern,
      expiresAt: Date.now() + 120_000,
      consumed: false,
    });
    return id;
  }

  /** Validate and consume a token. */
  validateToken(tokenId: string): boolean {
    const token = this.tokens.get(tokenId);
    if (!token) return false;
    if (token.consumed || Date.now() > token.expiresAt) {
      this.tokens.delete(tokenId);
      return false;
    }
    token.consumed = true;
    this.tokens.delete(tokenId);
    return true;
  }

  private storeRule(category: string, pattern: string, action: "allow" | "deny"): void {
    // #1771: re-read before appending so a concurrent CLI edit is not
    // clobbered (and a just-removed rule is not resurrected).
    this.reloadRules();
    this.rules.push({ category, pattern, action, createdAt: new Date().toISOString() });
    this.writeRules();
    logInfo(TAG, `Stored rule: ${action} ${category}:${pattern}`);
  }

  private writeRules(): void {
    try {
      atomicWriteSync(this.rulesPath, JSON.stringify({ rules: this.rules }, null, 2) + "\n");
    } catch (err) {
      logAndSwallow(TAG, "write rules file", err);
    }
  }

  private reloadRules(): void {
    if (!existsSync(this.rulesPath)) { this.rules = []; return; }
    try {
      const data = JSON.parse(readFileSync(this.rulesPath, "utf-8")) as { rules?: unknown };
      if (Array.isArray(data.rules)) this.rules = data.rules as AuthRule[];
      // Non-array payload: keep the last in-memory snapshot.
    } catch { /* keep the last in-memory snapshot */ }
  }

  private loadRules(): void {
    if (!existsSync(this.rulesPath)) { this.rules = []; return; }
    try {
      const data = JSON.parse(readFileSync(this.rulesPath, "utf-8"));
      this.rules = data.rules ?? [];
    } catch { this.rules = []; }
  }

  private audit(category: string, detail: string, outcome: string, pattern?: string): void {
    const entry: Record<string, string> = { ts: new Date().toISOString(), category, detail: detail.slice(0, 200), outcome };
    if (pattern !== undefined) entry["pattern"] = pattern.slice(0, 200);
    try { appendFileSync(this.auditPath, JSON.stringify(entry) + "\n"); } catch { /* best effort */ }
  }

  private formatMessage(category: string, detail: string): string {
    switch (category) {
      case "secret-recall": return `🔐 Agent wants SECRET memory:\n"${detail.slice(0, 100)}"\n\nAuthorize?`;
      case "bash-auth": return `⚠️ Agent wants to run:\n\`${detail.slice(0, 200)}\`\n\nAuthorize?`;
      default: return `🔒 Agent requests: ${category}\n${detail.slice(0, 150)}\n\nAuthorize?`;
    }
  }
}
