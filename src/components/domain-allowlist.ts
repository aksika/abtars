/**
 * Validates URLs against a configurable allowlist of domain patterns.
 * Prevents the agent from navigating to arbitrary domains.
 *
 * Pattern matching:
 *   - `*.example.com` → matches any subdomain of example.com
 *   - `example.com`   → exact match only
 *   - Empty list       → open mode (all domains allowed)
 */
export class DomainAllowlist {
  private readonly _patterns: string[];

  constructor(patterns: string[]) {
    this._patterns = patterns
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p.length > 0);
  }

  /** Check if a URL's hostname matches the allowlist. Returns true if allowed. */
  isAllowed(url: string): boolean {
    if (this._patterns.length === 0) return true;

    let hostname: string;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }

    return this._patterns.some((pattern) => {
      if (pattern.startsWith("*.")) {
        const suffix = pattern.slice(2); // e.g. "example.com"
        return hostname === suffix || hostname.endsWith(`.${suffix}`);
      }
      return hostname === pattern;
    });
  }

  /** Get the list of configured patterns (for error messages). */
  get patterns(): string[] {
    return [...this._patterns];
  }

  /** True if no patterns configured (open mode). */
  get isOpenMode(): boolean {
    return this._patterns.length === 0;
  }

  /** Create a DomainAllowlist from the BROWSER_ALLOWED_DOMAINS env var. */
  static fromEnv(): DomainAllowlist {
    const raw = process.env["BROWSER_ALLOWED_DOMAINS"] ?? "";
    const patterns = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    return new DomainAllowlist(patterns);
  }
}
