/**
 * User registry — loads users from config/users.json.
 * Falls back to ALLOWED_USER_IDS (all treated as master, maxClass=3, all tools).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../paths.js";
import { logInfo, logWarn } from "./logger.js";

const TAG = "user-registry";

export interface UserEntry {
  userId: string;
  role: "master" | "user" | "guest";
  maxClass: number;
  tools: string[];
  platforms: { telegram?: number; discord?: string };
}

export interface UserRegistry {
  users: UserEntry[];
  byPlatformId: Map<string, UserEntry>;
  byUserId: Map<string, UserEntry>;
}

/** Load users from config/users.json, fallback to ALLOWED_USER_IDS. */
export function loadUsers(): UserRegistry {
  const configPath = join(agentBridgeHome(), "config", "users.json");
  const registry: UserRegistry = { users: [], byPlatformId: new Map(), byUserId: new Map() };

  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      const entries = Array.isArray(raw.users) ? raw.users as UserEntry[] : [];
      for (const u of entries) {
        if (!u.userId || !u.role) continue;
        const entry: UserEntry = {
          userId: u.userId,
          role: u.role,
          maxClass: typeof u.maxClass === "number" ? u.maxClass : (u.role === "master" ? 3 : 0),
          tools: Array.isArray(u.tools) ? u.tools : (u.role === "master" ? ["all"] : []),
          platforms: u.platforms ?? {},
        };
        registry.users.push(entry);
        registry.byUserId.set(entry.userId, entry);
        if (entry.platforms.telegram) registry.byPlatformId.set(`telegram:${entry.platforms.telegram}`, entry);
        if (entry.platforms.discord) registry.byPlatformId.set(`discord:${entry.platforms.discord}`, entry);
      }
      logInfo(TAG, `Loaded ${registry.users.length} users from users.json`);
    } catch (err) {
      logWarn(TAG, `Failed to parse users.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback: ALLOWED_USER_IDS → all master
  if (registry.users.length === 0) {
    const raw = process.env["ALLOWED_USER_IDS"] ?? "";
    for (const id of raw.split(",").map(s => s.trim()).filter(Boolean)) {
      const entry: UserEntry = {
        userId: id,
        role: "master",
        maxClass: 3,
        tools: ["all"],
        platforms: { telegram: parseInt(id, 10) || undefined },
      };
      registry.users.push(entry);
      registry.byUserId.set(entry.userId, entry);
      registry.byPlatformId.set(`telegram:${id}`, entry);
    }
    if (registry.users.length > 0) {
      logInfo(TAG, `Fallback: ${registry.users.length} users from ALLOWED_USER_IDS (all master)`);
    }
  }

  return registry;
}

/** Build [USERS] block for soul bundle injection. */
export function buildUsersBlock(registry: UserRegistry): string {
  const CLASS_NAMES = ["UNCLASSIFIED", "RESTRICTED", "CONFIDENTIAL", "SECRET"];
  const lines = registry.users
    .filter(u => u.role !== "guest")
    .map(u => `- ${u.userId} (${u.role}, ${CLASS_NAMES[u.maxClass] ?? `class ${u.maxClass}`} clearance)`);
  return `[USERS]\n${lines.join("\n")}`;
}
