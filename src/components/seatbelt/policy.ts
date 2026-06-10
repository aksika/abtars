/**
 * seatbelt/policy.ts — SeatbeltPolicy type + per-session-type defaults.
 */

export interface SeatbeltPolicy {
  filesystem: {
    allowRead: string[];
    allowWrite: string[];
    denyRead: string[];
    denyWrite: string[];
  };
  network: {
    mode: "none" | "allowlist" | "full";
    allowedDomains?: string[];
  };
  ignoreViolations?: string[];
}

const MODEL_PROVIDER_DOMAINS = [
  "api.openai.com", "openrouter.ai", "api.anthropic.com",
  "api.deepseek.com", "generativelanguage.googleapis.com",
  "integrate.api.nvidia.com",
];

export function getPolicy(sessionType: string, sessionDir: string, home: string): SeatbeltPolicy {
  switch (sessionType) {
    case "W": return {
      filesystem: {
        allowRead: [sessionDir, "/usr", "/bin", "/etc", "/lib", "/opt"],
        allowWrite: [sessionDir, "/tmp"],
        denyRead: [`${home}/config`, `${home}/secret`],
        denyWrite: [],
      },
      network: { mode: "allowlist", allowedDomains: MODEL_PROVIDER_DOMAINS },
      ignoreViolations: ["/home/*/.cache", "/Users/*/Library/Caches"],
    };
    case "B": return {
      filesystem: {
        allowRead: [sessionDir, "/usr", "/bin", "/etc", "/lib", "/opt"],
        allowWrite: [sessionDir, "/tmp"],
        denyRead: [`${home}/config`, `${home}/secret`],
        denyWrite: [],
      },
      network: { mode: "full" },
      ignoreViolations: ["/home/*/.cache", "/Users/*/Library/Caches"],
    };
    default: return { // Main / others — permissive
      filesystem: {
        allowRead: [],  // empty = no restriction
        allowWrite: [`${home}/workspace`, `${home}/logs`, `${home}/sessions`, "/tmp"],
        denyRead: [],
        denyWrite: [`${home}/secret`],
      },
      network: { mode: "full" },
    };
  }
}
