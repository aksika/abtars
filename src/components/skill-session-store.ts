/**
 * skill-session-store.ts — Durable skill-session binding store (#1432).
 *
 * Persists routing/lifecycle metadata only: skill name, exact conversation
 * address, selected agent, context path, and inactivity deadlines. Never
 * prompts, transcripts, credentials, model output, or general memories.
 *
 * The durable record intentionally excludes the Spin session ID — Spin IDs
 * and transports are process-local. Restart loads unexpired bindings as
 * "suspended"; the first matching inbound message allocates a fresh K.
 *
 * Writes are temp-file + atomic rename; a single malformed record fails
 * closed individually and never destroys unrelated bindings.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentName } from "./subagent-runtime.js";
import { abtarsHome } from "../paths.js";
import { atomicWriteSync } from "./atomic-write.js";
import { logWarn } from "./logger.js";

const TAG = "skill-session-store";

export interface ConversationAddress {
  userId: string;
  platform: string;
  chatId: string;
  threadId?: string;
}

export interface SkillBindingRecordV1 {
  version: 1;
  skillName: string;
  userId: string;
  platform: string;
  chatId: string;
  threadId?: string;
  agent: AgentName;
  contextPath?: string;
  startedAt: number;
  lastActiveAt: number;
  expiresAt: number;
}

export interface SkillSessionStateV1 {
  version: 1;
  bindings: SkillBindingRecordV1[];
}

/**
 * Canonical scope key from an exact conversation address. Built via
 * JSON.stringify of all four fields — never concatenated user input.
 */
export function scopeKeyOf(address: ConversationAddress): string {
  return JSON.stringify([address.userId, address.platform, address.chatId, address.threadId ?? null]);
}

const STORE_FILE = (): string => join(abtarsHome(), "state", "skill-sessions.json");

function isRecord(value: unknown): value is SkillBindingRecordV1 {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return r["version"] === 1
    && typeof r["skillName"] === "string" && r["skillName"].length > 0
    && typeof r["userId"] === "string" && r["userId"].length > 0
    && typeof r["platform"] === "string" && r["platform"].length > 0
    && typeof r["chatId"] === "string" && r["chatId"].length > 0
    && (r["threadId"] === undefined || typeof r["threadId"] === "string")
    && typeof r["agent"] === "string" && r["agent"].length > 0
    && (r["contextPath"] === undefined || typeof r["contextPath"] === "string")
    && typeof r["startedAt"] === "number"
    && typeof r["lastActiveAt"] === "number"
    && typeof r["expiresAt"] === "number";
}

export interface SkillSessionStoreOptions {
  file?: string;
  now?: () => number;
}

export class SkillSessionStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly bindings = new Map<string, SkillBindingRecordV1>();

  constructor(opts?: SkillSessionStoreOptions) {
    this.file = opts?.file ?? STORE_FILE();
    this.now = opts?.now ?? Date.now;
  }

  /** Path of the store file (test visibility). */
  get path(): string { return this.file; }

  /** Load durable state: malformed records fail closed, expired ones are dropped. */
  load(): void {
    this.bindings.clear();
    if (!existsSync(this.file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf-8"));
    } catch (err) {
      logWarn(TAG, `Cannot parse ${this.file} — starting empty: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const state = raw as Partial<SkillSessionStateV1>;
    if (typeof state !== "object" || state === null || !Array.isArray(state.bindings)) {
      logWarn(TAG, `Malformed skill-session state in ${this.file} — starting empty`);
      return;
    }
    const now = this.now();
    for (const item of state.bindings) {
      if (!isRecord(item)) {
        logWarn(TAG, `Malformed skill binding record skipped (isolated)`);
        continue;
      }
      if (item.expiresAt <= now) continue; // expired — dropped on load
      const key = scopeKeyOf({ userId: item.userId, platform: item.platform, chatId: item.chatId, threadId: item.threadId });
      this.bindings.set(key, item);
    }
  }

  /** Exact-address lookup. */
  get(key: string): SkillBindingRecordV1 | undefined {
    return this.bindings.get(key);
  }

  /** All live bindings (for expiry scanning / list). */
  list(): SkillBindingRecordV1[] {
    return [...this.bindings.values()];
  }

  /** Persist a binding (create or refresh). */
  upsert(record: SkillBindingRecordV1): void {
    const key = scopeKeyOf({ userId: record.userId, platform: record.platform, chatId: record.chatId, threadId: record.threadId });
    this.bindings.set(key, record);
    this.save();
  }

  /** Remove one binding by scope key. Returns true when a record was removed. */
  remove(key: string): boolean {
    const existed = this.bindings.delete(key);
    if (existed) this.save();
    return existed;
  }

  /** Atomic durable write (temp file + fsync + rename). */
  save(): void {
    const state: SkillSessionStateV1 = {
      version: 1,
      bindings: [...this.bindings.values()],
    };
    mkdirSync(dirname(this.file), { recursive: true });
    try {
      atomicWriteSync(this.file, JSON.stringify(state, null, 2));
    } catch (err) {
      logWarn(TAG, `Durable skill-session write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
