/**
 * transport-config/validator.ts — schema whitelist, structural validation,
 * and canonical serialization for transport.json.
 * Pure: never mutates input, never writes to disk.
 */

import type {
  AssignmentIssue,
  ExecutionRoute,
  ModelCatalog,
  ModelProviderValidation,
  ProviderConfig,
  RouteAssignments,
  TransportConfig,
  TransportConfigIssue,
  TransportValidationResult,
} from "./types.js";
import { loadModels } from "./loader.js";

// ── #1354: Provider schema whitelist ────────────────────────────────────────
//
// Provider configuration is schema-whitelisted. Raw secret fields (apiKey,
// api_key, token, secret, password, ...) are REJECTED — they must be
// referenced by environment-variable name via `apiKeyEnv`. Unknown
// non-secret fields are rejected too: the schema is the contract.

export const PROVIDER_ALLOWED_FIELDS = new Set([
  "transport",
  "cli",
  "endpoint",
  "apiKeyEnv",
  "apiFormat",
  "thinking",
  "defaults",
]);

const TRANSPORT_ALLOWED_FIELDS = new Set([
  "schemaVersion",
  "activeRoute",
  "routes",
  "providers",
  "transportDefaults",
  "maxTurns",
  "maxToolRounds",
  "maxFallbackToolRounds",
  "hailMary",
  "healthPolicy",
]);

const PROVIDER_SECRET_FIELDS = new Set([
  "apikey", "api_key", "token", "secret", "password", "passwd",
  "auth", "authorization", "credential", "credentials",
  "apikeyvalue", "apisecret", "accesskey", "accesskeyid", "secretaccesskey",
  "clientsecret", "client_secret", "refreshtoken", "refresh_token",
]);

/**
 * True when a provider field name carries a raw credential value.
 * Only reached for fields outside the allowlist, so a substring match on
 * credential vocabulary is safe — including camelCase (clientSecret).
 */
export function isSecretLikeField(field: string): boolean {
  if (PROVIDER_SECRET_FIELDS.has(field.toLowerCase())) return true;
  return /key|token|secret|password|passwd|auth|credential/i.test(field);
}

/**
 * Catch raw credential-bearing keys in nested sections that are not provider
 * entries (for example a malicious `routes.pi-ai.agents.main.apiKey`).
 * Tuning fields such as `authFill`/`authSticky` do not end in `auth` and are
 * therefore not mistaken for credentials.
 */
function isNestedRawSecretField(field: string): boolean {
  return /(?:key|token|secret|password|passwd|authorization|credential|credentials|access[_-]?key(?:id)?|client[_-]?secret|refresh[_-]?token|auth)$/i.test(field);
}

function collectNestedRawSecretFields(value: unknown, path: string, issues: TransportConfigIssue[], seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (seen.has(object)) return;
  seen.add(object);
  for (const [field, child] of Object.entries(object)) {
    const childPath = path ? `${path}.${field}` : field;
    if (field !== "apiKeyEnv" && isNestedRawSecretField(field) && !issues.some(i => i.code === "plaintext_secret_field" && i.path === childPath)) {
      issues.push({
        code: "plaintext_secret_field",
        path: childPath,
        message: `Raw credential field "${field}" is not allowed in transport configuration — reference a secret via apiKeyEnv`,
      });
    }
    collectNestedRawSecretFields(child, childPath, issues, seen);
  }
}

/** #1354: valid environment-variable name for apiKeyEnv references. */
export function isValidApiKeyEnv(name: unknown): name is string {
  return typeof name === "string" && /^[A-Z_][A-Z0-9_]*$/.test(name);
}

/**
 * #1354: normalize a provider entry through the schema allowlist.
 * Invalid fields are rejected; the candidate must already have passed the
 * validator before serialization is allowed.
 */
export function normalizeProviderEntry(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of Object.keys(raw)) {
    if (!PROVIDER_ALLOWED_FIELDS.has(field)) {
      throw new Error(`Cannot serialize provider entry with unsupported field "${field}"`);
    }
    out[field] = raw[field];
  }
  return out;
}

/**
 * #1354: THE validated serialization path for transport.json persistence.
 * Every production writer of transport.json must go through this (or the
 * write/restore/reset boundaries that use it). Serializes only allowlisted
 * provider fields — credentials can never reach primary, temp, or backup
 * files through this path.
 */
export function serializeTransportConfig(config: TransportConfig): string {
  const validation = validateTransportConfig(config);
  if (!validation.ok) {
    throw new Error(`Cannot serialize invalid transport config (${validation.issues.map(i => i.code).join(", ")})`);
  }
  const copy = JSON.parse(JSON.stringify(validation.config)) as TransportConfig;
  for (const [name, entry] of Object.entries(copy.providers)) {
    (copy.providers as Record<string, unknown>)[name] = normalizeProviderEntry(entry as Record<string, unknown>);
  }
  return JSON.stringify(copy, null, 2);
}

// ── Route-local accessors (#1467) ─────────────────────────────────────────────

export function routeAssignments(
  config: TransportConfig,
  route: ExecutionRoute = config.activeRoute,
): RouteAssignments | null {
  return config.routes[route] ?? null;
}

export function requireRouteAssignments(
  config: TransportConfig,
  route: ExecutionRoute = config.activeRoute,
): RouteAssignments {
  const ra = routeAssignments(config, route);
  if (!ra) throw new Error(`Route "${route}" has no assignments block in transport config`);
  return ra;
}

/**
 * Pure validator — never mutates input, never writes to disk.
 * Returns structured issues for every invariant violation.
 */
export function validateTransportConfig(input: unknown): TransportValidationResult {
  const issues: TransportConfigIssue[] = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      issues: [{ code: "missing_field", path: "", message: "Transport config must be an object" }],
    };
  }
  const tc = input as Record<string, unknown>;

  for (const field of Object.keys(tc)) {
    if (TRANSPORT_ALLOWED_FIELDS.has(field)) continue;
    issues.push({
      code: isNestedRawSecretField(field) ? "plaintext_secret_field" : "invalid_config_field",
      path: field,
      message: isNestedRawSecretField(field)
        ? `Raw credential field "${field}" is not allowed in transport configuration — reference a secret via apiKeyEnv`
        : `Unknown transport config field "${field}" — configuration is schema-whitelisted`,
    });
  }

  // schemaVersion required, must be 3
  if (tc.schemaVersion == null) {
    issues.push({ code: "missing_field", path: "schemaVersion", message: "schemaVersion is required" });
  } else if (tc.schemaVersion !== 3) {
    issues.push({ code: "unsupported_schema", path: "schemaVersion", message: `Unsupported schema version ${tc.schemaVersion} — only version 3 is supported` });
  }

  // activeRoute required, must be a valid ExecutionRoute
  if (tc.activeRoute == null) {
    issues.push({ code: "missing_field", path: "activeRoute", message: "activeRoute is required" });
  } else if (tc.activeRoute !== "pi-ai" && tc.activeRoute !== "acp") {
    issues.push({ code: "invalid_route", path: "activeRoute", message: `Invalid activeRoute "${String(tc.activeRoute)}" — must be "pi-ai" or "acp"` });
  }

  // routes required
  if (tc.routes == null || typeof tc.routes !== "object" || Array.isArray(tc.routes)) {
    issues.push({ code: "missing_field", path: "routes", message: "routes is required" });
  }

  // providers required
  if (tc.providers == null || typeof tc.providers !== "object" || Array.isArray(tc.providers)) {
    issues.push({ code: "missing_field", path: "providers", message: "providers is required" });
  }

  if (issues.length > 0) return { ok: false, issues };

  const config = input as TransportConfig;
  const providers = config.providers;
  const activeRoute = config.activeRoute;

  // Provider validation below catches its own fields; this second pass covers
  // route assignments and other nested objects before any serializer can see
  // them. It records paths only and never includes candidate values.
  collectNestedRawSecretFields(tc, "", issues);

  // #1354: schema-whitelist provider entries — raw secret fields are rejected,
  // unknown fields are rejected, and apiKeyEnv must be a valid env-var name.
  for (const [provName, entry] of Object.entries(providers)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({ code: "missing_field", path: `providers.${provName}`, message: `Provider "${provName}" must be an object` });
      continue;
    }
    const entryRecord = entry as Record<string, unknown>;
    for (const field of Object.keys(entryRecord)) {
      if (PROVIDER_ALLOWED_FIELDS.has(field)) continue;
      if (isSecretLikeField(field)) {
        const path = `providers.${provName}.${field}`;
        if (!issues.some(i => i.code === "plaintext_secret_field" && i.path === path)) {
          issues.push({
            code: "plaintext_secret_field",
            path,
            message: `Provider "${provName}" contains raw credential field "${field}" — remove it and reference a secret via apiKeyEnv`,
          });
        }
      } else {
        issues.push({
          code: "invalid_provider_field",
          path: `providers.${provName}.${field}`,
          message: `Provider "${provName}" has unknown field "${field}" — provider configuration is schema-whitelisted`,
        });
      }
    }
    if (entryRecord.apiKeyEnv !== undefined && entryRecord.apiKeyEnv !== null) {
      if (!isValidApiKeyEnv(entryRecord.apiKeyEnv)) {
        issues.push({
          code: "invalid_provider_field",
          path: `providers.${provName}.apiKeyEnv`,
          message: `Provider "${provName}" apiKeyEnv must be a valid environment-variable name ([A-Z_][A-Z0-9_]*)`,
        });
      }
    }
  }

  // Reject unknown route keys in routes object
  for (const routeKey of Object.keys(config.routes)) {
    if (routeKey !== "pi-ai" && routeKey !== "acp") {
      issues.push({ code: "invalid_route", path: `routes.${routeKey}`, message: `Unknown route "${routeKey}" — only "pi-ai" and "acp" are supported` });
    }
  }

  // Require the active route block to exist
  if (!config.routes[activeRoute]) {
    issues.push({ code: "missing_field", path: `routes.${activeRoute}`, message: `Active route "${activeRoute}" has no assignments block` });
  }

  if (issues.length > 0) return { ok: false, issues };

  // Validate each present route block independently
  const validateRouteBlock = (routeKey: string, ra: RouteAssignments) => {
    const prefix = `routes.${routeKey}`;

    if (ra.agents == null || typeof ra.agents !== "object" || Array.isArray(ra.agents)) {
      issues.push({ code: "missing_field", path: `${prefix}.agents`, message: `Route "${routeKey}" has no agents block` });
      return;
    }

    for (const [role, assignment] of Object.entries(ra.agents)) {
      if (!assignment || typeof assignment !== "object") {
        issues.push({ code: "missing_field", path: `${prefix}.agents.${role}`, message: `Agent "${role}" in route "${routeKey}" has invalid assignment` });
        continue;
      }
      const assignmentRecord = assignment as Record<string, unknown>;
      const model = assignmentRecord.model;
      const providerName = assignmentRecord.provider;
      if (typeof model !== "string" || !model.trim()) {
        issues.push({ code: "missing_field", path: `${prefix}.agents.${role}.model`, message: `Agent "${role}" in route "${routeKey}" has no model` });
      }
      if (typeof providerName !== "string") {
        issues.push({ code: "missing_field", path: `${prefix}.agents.${role}.provider`, message: `Agent "${role}" in route "${routeKey}" has no provider` });
        continue;
      }
      const p = providers[providerName];
      if (!p) {
        issues.push({ code: "missing_provider", path: `${prefix}.agents.${role}`, message: `Agent "${role}" in route "${routeKey}" references unknown provider "${providerName}"` });
        continue;
      }
      if (!providerSupportsRoute(p, routeKey as ExecutionRoute)) {
        issues.push({ code: "provider_route_incompatible", path: `${prefix}.agents.${role}`, message: `Agent "${role}" in route "${routeKey}" provider "${providerName}" does not support route "${routeKey}"` });
      }
    }

    if (ra.fallbacks != null && !Array.isArray(ra.fallbacks)) {
      issues.push({ code: "missing_field", path: `${prefix}.fallbacks`, message: `fallbacks in route "${routeKey}" must be an array` });
      return;
    }

    for (let i = 0; i < (ra.fallbacks ?? []).length; i++) {
      const fb = ra.fallbacks![i];
      if (!fb || typeof fb !== "object") {
        issues.push({ code: "missing_field", path: `${prefix}.fallbacks[${i}]`, message: `Fallback[${i}] in route "${routeKey}" is invalid` });
        continue;
      }
      if (typeof fb.model !== "string" || !fb.model.trim()) {
        issues.push({ code: "missing_field", path: `${prefix}.fallbacks[${i}].model`, message: `Fallback[${i}] in route "${routeKey}" has no model` });
      }
      if (typeof fb.provider !== "string") {
        issues.push({ code: "missing_field", path: `${prefix}.fallbacks[${i}].provider`, message: `Fallback[${i}] in route "${routeKey}" has no provider` });
        continue;
      }
      const p = providers[fb.provider];
      if (!p) {
        issues.push({ code: "missing_provider", path: `${prefix}.fallbacks[${i}]`, message: `Fallback[${i}] in route "${routeKey}" references unknown provider "${fb.provider}"` });
      } else if (!providerSupportsRoute(p, routeKey as ExecutionRoute)) {
        issues.push({ code: "provider_route_incompatible", path: `${prefix}.fallbacks[${i}]`, message: `Fallback[${i}] in route "${routeKey}" provider "${fb.provider}" does not support route "${routeKey}"` });
      }
    }
  };

  for (const [routeKey, ra] of Object.entries(config.routes)) {
    if (ra) validateRouteBlock(routeKey, ra);
  }

  if (issues.length > 0) return { ok: false, issues };

  // ACP same-provider rule — scoped to routes.acp only
  const acpRa = config.routes["acp"];
  if (acpRa) {
    const entries = Object.values(acpRa.agents);
    if (entries.length > 0) {
      const first = entries[0]!.provider;
      for (let i = 1; i < entries.length; i++) {
        if (entries[i]!.provider !== first) {
          issues.push({ code: "acp_provider_mismatch", path: `routes.acp.agents.${Object.keys(acpRa.agents)[i]}`, message: `ACP requires all agents use the same provider ("${first}")` });
        }
      }
    }
  }

  // Validate hailMary when present
  if (tc.hailMary != null) {
    const hm = tc.hailMary as Record<string, unknown>;
    if (hm.route !== "acp") {
      issues.push({ code: "invalid_route", path: "hailMary.route", message: `hailMary route must be "acp", got "${String(hm.route)}"` });
    }
    if (typeof hm.provider !== "string") {
      issues.push({ code: "missing_field", path: "hailMary.provider", message: "hailMary provider is required" });
    } else {
      const p = providers[hm.provider as string];
      if (!p) {
        issues.push({ code: "missing_provider", path: "hailMary.provider", message: `hailMary references unknown provider "${hm.provider}"` });
      } else if (!providerSupportsRoute(p, "acp")) {
        issues.push({ code: "provider_route_incompatible", path: "hailMary.route", message: `hailMary provider "${hm.provider}" does not support ACP route` });
      }
    }
    if (typeof hm.model !== "string" || !(hm.model as string).trim()) {
      issues.push({ code: "missing_field", path: "hailMary.model", message: "hailMary model is required" });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  // Model/provider compatibility (warns only — non-fatal when catalog entry missing)
  const models = loadModels();
  for (const [routeKey, ra] of Object.entries(config.routes)) {
    if (!ra) continue;
    const prefix = `routes.${routeKey}`;
    for (const [role, assignment] of Object.entries(ra.agents)) {
      const entry = models[assignment.model];
      if (entry && !entry.transports.includes(assignment.provider)) {
        issues.push({ code: "model_provider_incompatible", path: `${prefix}.agents.${role}`, message: `Model "${assignment.model}" not available on provider "${assignment.provider}" in route "${routeKey}" — only supported on: ${entry.transports.join(", ")}` });
      }
    }
    for (let i = 0; i < (ra.fallbacks ?? []).length; i++) {
      const fb = ra.fallbacks![i]!;
      const entry = models[fb.model];
      if (entry && !entry.transports.includes(fb.provider)) {
        issues.push({ code: "model_provider_incompatible", path: `${prefix}.fallbacks[${i}]`, message: `Model "${fb.model}" not available on provider "${fb.provider}" in route "${routeKey}" — only supported on: ${entry.transports.join(", ")}` });
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  return { ok: true, config };
}

// ── Route classification (#1418) ─────────────────────────────────────────────

export function providerSupportsRoute(provider: ProviderConfig, route: ExecutionRoute): boolean {
  if (route === "pi-ai") return provider.transport === "api";
  if (route === "acp") return provider.transport === "acp";
  return false;
}

export function acpSameProviderConstraint(config: TransportConfig): boolean {
  // ACP requires all agents to use the same provider (single child process)
  const acpRa = config.routes["acp"];
  if (!acpRa) return true;
  const first = Object.values(acpRa.agents)[0];
  if (!first) return true;
  return Object.values(acpRa.agents).every(a => a.provider === first.provider);
}

// ── Model/provider compatibility (#1415) ─────────────────────────────────────

/** Validate a single model/provider pair against the catalog.
 *  Returns ok when the model is absent from the catalog (unknown/custom model).
 *  When the entry exists, returns ok only when entry.transports includes the provider. */
export function validateModelProviderPair(
  model: string,
  provider: string,
  models?: ModelCatalog,
): ModelProviderValidation {
  const mc = models ?? loadModels();
  const entry = mc[model];
  if (!entry) return { ok: true };
  if (entry.transports.includes(provider)) return { ok: true };
  return {
    ok: false,
    model,
    provider,
    allowed: [...entry.transports],
    reason: `Model "${model}" is not available on provider "${provider}" — only supported on: ${entry.transports.join(", ")}`,
  };
}

/** Validate every agent primary, fallback, and hail Mary in a transport config.
 *  Reports all issues in deterministic location order. */
export function validateTransportAssignments(
  config: TransportConfig,
  models?: ModelCatalog,
  explicitRoute?: ExecutionRoute,
): AssignmentIssue[] {
  const issues: AssignmentIssue[] = [];
  const mc = models ?? loadModels();

  // Validate active route block (or the explicit route if given) + hailMary
  const route = explicitRoute ?? config.activeRoute;
  const ra = routeAssignments(config, route);
  if (ra) {
    for (const [role, assignment] of Object.entries(ra.agents)) {
      const result = validateModelProviderPair(assignment.model, assignment.provider, mc);
      if (!result.ok) {
        issues.push({ location: `${route}.agents.${role}.model`, model: assignment.model, provider: assignment.provider, reason: result.reason });
      }
    }
    for (let i = 0; i < (ra.fallbacks ?? []).length; i++) {
      const fb = ra.fallbacks![i]!;
      const fbResult = validateModelProviderPair(fb.model, fb.provider, mc);
      if (!fbResult.ok) {
        issues.push({ location: `${route}.fallbacks[${i}]`, model: fb.model, provider: fb.provider, reason: fbResult.reason });
      }
    }
  }

  return issues;
}