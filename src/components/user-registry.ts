import { getEnv } from "./env-schema.js";
/**
 * User registry — loads users from config/users.json.
 * Falls back to MAIN_CHAT_ID.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../paths.js";
import { logInfo, logWarn } from "./logger.js";

const TAG = "user-registry";

export interface UserEntry {
  userId: string;
  displayName?: string;
  role: "master" | "user" | "guest";
  maxClass: number;
  tools: string[];
  platforms: { telegram?: number; discord?: string };
  allowedChats?: string[];
}

export interface UserRegistry {
  users: UserEntry[];
  byPlatformId: Map<string, UserEntry>;
  byUserId: Map<string, UserEntry>;
}

let _override: UserRegistry | null = null;
let _cached: UserRegistry | null = null;

/** Override registry for testing. Pass null to clear. */
export function setUserRegistryOverride(registry: UserRegistry | null): void { _override = registry; }

/** Load users from config/users.json, fallback to MAIN_CHAT_ID. Cached after first call. */
export function loadUsers(): UserRegistry {
  if (_override) return _override;
  if (_cached) return _cached;
  _cached = loadFromDisk();
  return _cached;
}

/** Force reload from disk (e.g. after /users approve). */
export function reloadUsers(): UserRegistry {
  _cached = null;
  return loadUsers();
}

function loadFromDisk(): UserRegistry {
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
          displayName: u.displayName ?? u.userId,
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

  // Fallback: MAIN_CHAT_ID → single master
  if (registry.users.length === 0) {
    const mainChatId = getEnv().mainChatId;
    if (mainChatId) {
      const entry: UserEntry = {
        userId: "master",
        role: "master",
        maxClass: 3,
        tools: ["all"],
        platforms: { telegram: parseInt(mainChatId, 10) || undefined },
      };
      registry.users.push(entry);
      registry.byUserId.set("master", entry);
      registry.byPlatformId.set(`telegram:${mainChatId}`, entry);
      logInfo(TAG, `Fallback: single master from MAIN_CHAT_ID`);
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

/** Load per-user profile markdown from persona/core/, falling back to default user_profile.md. Returns null if not found. */
export function loadUserProfile(userId: string): string | null {
  try {
    const coreDir = join(process.cwd(), "persona", "core");
    const userProfile = join(coreDir, `user_profile_${userId}.md`);
    const defaultProfile = join(coreDir, "user_profile.md");
    const profilePath = existsSync(userProfile) ? userProfile : defaultProfile;
    if (!existsSync(profilePath)) return null;
    const profile = readFileSync(profilePath, "utf-8").trim();
    return profile || null;
  } catch { return null; }
}
