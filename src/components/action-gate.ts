/**
 * action-gate.ts — Out-of-band authorization for privileged actions.
 * Agent requests a privileged action → Telegram inline keyboard to master → proceed/deny.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { logInfo, logWarn, logError } from "./logger.js";

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

  /** Check if a rule already allows/denies this action. */
  checkRules(category: string, pattern: string): "allow" | "deny" | null {
    for (const rule of this.rules) {
      if (rule.category !== category) continue;
      if (rule.pattern === "*" || rule.pattern === pattern) {
        return rule.action;
      }
    }
    return null;
  }

  /**
   * Request authorization for a privileged action.
   * Returns true if granted, false if denied/timed out.
   */
  async requestAuth(category: string, detail: string): Promise<boolean> {
    // Check persistent rules first
    const rule = this.checkRules(category, detail);
    if (rule === "allow") {
      this.audit(category, detail, "allowed-by-rule");
      return true;
    }
    if (rule === "deny") {
      this.audit(category, detail, "denied-by-rule");
      return false;
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
          this.notify?.("⏳ Still waiting for authorization...", []).catch(() => {});
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
      this.storeRule(req.category, req.detail, "allow");
      this.audit(req.category, req.detail, "allowed-always");
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
    this.rules.push({ category, pattern, action, createdAt: new Date().toISOString() });
    writeFileSync(this.rulesPath, JSON.stringify({ rules: this.rules }, null, 2) + "\n");
    logInfo(TAG, `Stored rule: ${action} ${category}:${pattern}`);
  }

  private loadRules(): void {
    if (!existsSync(this.rulesPath)) { this.rules = []; return; }
    try {
      const data = JSON.parse(readFileSync(this.rulesPath, "utf-8"));
      this.rules = data.rules ?? [];
    } catch { this.rules = []; }
  }

  private audit(category: string, detail: string, outcome: string): void {
    const entry = JSON.stringify({ ts: new Date().toISOString(), category, detail: detail.slice(0, 200), outcome });
    try { appendFileSync(this.auditPath, entry + "\n"); } catch { /* best effort */ }
  }

  private formatMessage(category: string, detail: string): string {
    switch (category) {
      case "secret-recall": return `🔐 Agent wants SECRET memory:\n"${detail.slice(0, 100)}"\n\nAuthorize?`;
      case "bash-auth": return `⚠️ Agent wants to run:\n\`${detail.slice(0, 200)}\`\n\nAuthorize?`;
      default: return `🔒 Agent requests: ${category}\n${detail.slice(0, 150)}\n\nAuthorize?`;
    }
  }
}
