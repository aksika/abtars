/**
 * Null-object memory backend — used when abmind is not installed.
 * All methods are no-ops that return empty/safe defaults.
 * Uses a Proxy to handle any method not explicitly listed.
 */

const handler: ProxyHandler<object> = {
  get(_target, prop) {
    if (prop === "available") return false;
    if (prop === "then") return undefined; // not a thenable
    return (..._args: unknown[]) => {
      // Return type-appropriate defaults
      if (typeof prop === "string" && prop.startsWith("get")) return null;
      return undefined;
    };
  },
};

const explicitMethods = {
  available: false,
  recall: async () => ({ results: [], source: "none" as const }),
  recordMessage: () => {},
  instantStore: async () => ({ stored: false, memoriesCount: 0, error: "memory not available" }),
  editMemory: async () => ({ edited: false, error: "memory not available" }),
  forget: async () => ({ deleted: 0 }),
  rebuildFtsIndexes: () => ({ rebuilt: [] }),
  initialize: async () => {},
  close: () => {},
  shutdown: async () => {},
  getDb: () => null,
  get editor() { return new Proxy({}, handler); },
  get contextEngine() { return null; },
};

export const nullMemory = new Proxy(explicitMethods, handler) as any;
