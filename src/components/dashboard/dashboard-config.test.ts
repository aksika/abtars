import { describe, it, expect } from "vitest";
import {
  loadDashboardConfig,
  validateDashboardConfig,
  formatUptime,
} from "./dashboard-config.js";

// ── loadDashboardConfig ─────────────────────────────────────────────────────

describe("loadDashboardConfig", () => {
  it("returns defaults when env is empty", () => {
    const config = loadDashboardConfig({});
    expect(config.webPort).toBe(3000);
    expect(config.webHost).toBe("127.0.0.1");
    expect(config.webAuthToken).toBe("");
    expect(config.webPushIntervalMs).toBe(5000);
  });

  it("parses valid numeric env vars", () => {
    const config = loadDashboardConfig({
      WEB_PORT: "8080",
      WEB_HOST: "127.0.0.1",
      WEB_AUTH: "secret-token",
      WEB_PUSH_INTERVAL_MS: "10000",
    });
    expect(config.webPort).toBe(8080);
    expect(config.webHost).toBe("127.0.0.1");
    expect(config.webAuthToken).toBe("secret-token");
    expect(config.webPushIntervalMs).toBe(10000);
  });

  it("falls back to defaults for invalid numeric values", () => {
    const config = loadDashboardConfig({
      WEB_PORT: "not-a-number",
      WEB_PUSH_INTERVAL_MS: "abc",
    });
    expect(config.webPort).toBe(3000);
    expect(config.webPushIntervalMs).toBe(5000);
  });

  it("falls back to defaults for negative numeric values", () => {
    const config = loadDashboardConfig({
      WEB_PORT: "-1",
      WEB_PUSH_INTERVAL_MS: "-500",
    });
    expect(config.webPort).toBe(3000);
    expect(config.webPushIntervalMs).toBe(5000);
  });

  it("falls back to defaults for empty string values", () => {
    const config = loadDashboardConfig({
      WEB_PORT: "",
      WEB_HOST: "",
      WEB_PUSH_INTERVAL_MS: "  ",
    });
    expect(config.webPort).toBe(3000);
    expect(config.webHost).toBe("127.0.0.1");
    expect(config.webPushIntervalMs).toBe(5000);
  });

  it("falls back to defaults for Infinity and NaN", () => {
    const config = loadDashboardConfig({
      WEB_PORT: "Infinity",
      WEB_PUSH_INTERVAL_MS: "NaN",
    });
    expect(config.webPort).toBe(3000);
    expect(config.webPushIntervalMs).toBe(5000);
  });

  it("floors fractional port values", () => {
    const config = loadDashboardConfig({ WEB_PORT: "3000.7" });
    expect(config.webPort).toBe(3000);
  });
});

// ── validateDashboardConfig ─────────────────────────────────────────────────

describe("validateDashboardConfig", () => {
  it("throws when webEnabled is true and token is empty", () => {
    const config = loadDashboardConfig({});
    expect(() => validateDashboardConfig(config, true)).toThrow(
      "WEB_AUTH is required",
    );
  });

  it("does not throw when webEnabled is true and token is set", () => {
    const config = loadDashboardConfig({ WEB_AUTH: "my-token" });
    expect(() => validateDashboardConfig(config, true)).not.toThrow();
  });

  it("does not throw when webEnabled is false regardless of token", () => {
    const config = loadDashboardConfig({});
    expect(() => validateDashboardConfig(config, false)).not.toThrow();
  });
});

// ── formatUptime ────────────────────────────────────────────────────────────

describe("formatUptime", () => {
  it("formats zero milliseconds as 0s", () => {
    expect(formatUptime(0)).toBe("0s");
  });

  it("formats seconds only", () => {
    expect(formatUptime(45_000)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatUptime(130_000)).toBe("2m 10s");
  });

  it("formats hours, minutes, and seconds", () => {
    expect(formatUptime(7_530_000)).toBe("2h 5m 30s");
  });

  it("omits zero minutes when only hours and seconds", () => {
    expect(formatUptime(3_605_000)).toBe("1h 5s");
  });

  it("formats exact hours without minutes or seconds", () => {
    expect(formatUptime(7_200_000)).toBe("2h");
  });

  it("formats exact minutes without seconds", () => {
    expect(formatUptime(300_000)).toBe("5m");
  });

  it("truncates sub-second precision", () => {
    expect(formatUptime(1_999)).toBe("1s");
  });
});

// Feature: kiro-professor-webui, Property 10: Dashboard config parsing with defaults
import fc from "fast-check";

describe("loadDashboardConfig — Property 10: Dashboard config parsing with defaults", () => {
  it("WEB_PORT parses to number (default 3000), WEB_HOST to string (default '127.0.0.1'), WEB_PUSH_INTERVAL_MS to number (default 5000), with invalid numerics falling back to defaults", () => {
    /**
     * Validates: Requirements 13.1, 13.3, 13.4
     *
     * For any set of env var values (including missing/empty), the dashboard
     * config should parse WEB_PORT to a number (default 3000), WEB_HOST to a
     * string (default "127.0.0.1"), and WEB_PUSH_INTERVAL_MS to a number
     * (default 5000). Invalid numeric values fall back to defaults.
     */
    const optionalString = fc.oneof(
      fc.constant(undefined),
      fc.string(),
    );

    const envArb = fc.record({
      WEB_PORT: optionalString,
      WEB_HOST: optionalString,
      WEB_PUSH_INTERVAL_MS: optionalString,
      WEB_AUTH: optionalString,
    });

    fc.assert(
      fc.property(envArb, (env) => {
        const config = loadDashboardConfig(env);

        // webPort is always a finite non-negative integer, default 3000
        expect(typeof config.webPort).toBe("number");
        expect(Number.isFinite(config.webPort)).toBe(true);
        expect(config.webPort).toBeGreaterThanOrEqual(0);
        expect(config.webPort).toBe(Math.floor(config.webPort));

        if (env.WEB_PORT !== undefined && env.WEB_PORT.trim() !== "") {
          const parsed = Number(env.WEB_PORT);
          if (Number.isFinite(parsed) && parsed >= 0) {
            expect(config.webPort).toBe(Math.floor(parsed));
          } else {
            expect(config.webPort).toBe(3000);
          }
        } else {
          expect(config.webPort).toBe(3000);
        }

        // webHost is always a non-empty string, default "127.0.0.1"
        expect(typeof config.webHost).toBe("string");
        expect(config.webHost.length).toBeGreaterThan(0);

        if (env.WEB_HOST !== undefined && env.WEB_HOST.trim() !== "") {
          expect(config.webHost).toBe(env.WEB_HOST.trim());
        } else {
          expect(config.webHost).toBe("127.0.0.1");
        }

        // webPushIntervalMs is always a finite non-negative integer, default 5000
        expect(typeof config.webPushIntervalMs).toBe("number");
        expect(Number.isFinite(config.webPushIntervalMs)).toBe(true);
        expect(config.webPushIntervalMs).toBeGreaterThanOrEqual(0);
        expect(config.webPushIntervalMs).toBe(Math.floor(config.webPushIntervalMs));

        if (env.WEB_PUSH_INTERVAL_MS !== undefined && env.WEB_PUSH_INTERVAL_MS.trim() !== "") {
          const parsed = Number(env.WEB_PUSH_INTERVAL_MS);
          if (Number.isFinite(parsed) && parsed >= 0) {
            expect(config.webPushIntervalMs).toBe(Math.floor(parsed));
          } else {
            expect(config.webPushIntervalMs).toBe(5000);
          }
        } else {
          expect(config.webPushIntervalMs).toBe(5000);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: kiro-professor-webui, Property 11: Uptime formatting
describe("formatUptime — Property 11: Uptime formatting", () => {
  it("produces a human-readable string that represents the same duration within 1-second precision", () => {
    /**
     * Validates: Requirements 11.2
     *
     * For any non-negative millisecond value, formatUptime() produces a
     * human-readable string with hours/minutes/seconds that, when parsed
     * back, represents the same duration within 1-second precision.
     */
    const parseUptime = (s: string): number => {
      let totalMs = 0;
      const hourMatch = s.match(/(\d+)h/);
      const minMatch = s.match(/(\d+)m/);
      const secMatch = s.match(/(\d+)s/);
      if (hourMatch) totalMs += parseInt(hourMatch[1], 10) * 3600 * 1000;
      if (minMatch) totalMs += parseInt(minMatch[1], 10) * 60 * 1000;
      if (secMatch) totalMs += parseInt(secMatch[1], 10) * 1000;
      return totalMs;
    };

    fc.assert(
      fc.property(
        fc.nat({ max: 365 * 24 * 3600 * 1000 }),
        (ms) => {
          const result = formatUptime(ms);

          // Result is a non-empty string
          expect(result.length).toBeGreaterThan(0);

          // Result only contains valid time components (digits + h/m/s + spaces)
          expect(result).toMatch(/^(\d+h)?(\s?\d+m)?(\s?\d+s)?$/);

          // Round-trip: parsed value matches input within 1-second precision
          const parsed = parseUptime(result);
          const truncatedMs = Math.floor(ms / 1000) * 1000;
          expect(parsed).toBe(truncatedMs);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// Feature: kiro-professor-webui, Property 11: Uptime formatting
describe("formatUptime — Property 11: Uptime formatting", () => {
  it("produces a human-readable string that represents the same duration within 1-second precision", () => {
    /**
     * Validates: Requirements 11.2
     *
     * For any non-negative millisecond value, formatUptime() produces a
     * human-readable string with hours/minutes/seconds that, when parsed
     * back, represents the same duration within 1-second precision.
     */
    const parseUptime = (s: string): number => {
      let totalMs = 0;
      const hourMatch = s.match(/(\d+)h/);
      const minMatch = s.match(/(\d+)m/);
      const secMatch = s.match(/(\d+)s/);
      if (hourMatch) totalMs += parseInt(hourMatch[1], 10) * 3600 * 1000;
      if (minMatch) totalMs += parseInt(minMatch[1], 10) * 60 * 1000;
      if (secMatch) totalMs += parseInt(secMatch[1], 10) * 1000;
      return totalMs;
    };

    fc.assert(
      fc.property(
        fc.nat({ max: 365 * 24 * 3600 * 1000 }),
        (ms) => {
          const result = formatUptime(ms);

          // Result is a non-empty string
          expect(result.length).toBeGreaterThan(0);

          // Result only contains valid time components (digits + h/m/s + spaces)
          expect(result).toMatch(/^(\d+h)?(\s?\d+m)?(\s?\d+s)?$/);

          // Round-trip: parsed value matches input within 1-second precision
          const parsed = parseUptime(result);
          const truncatedMs = Math.floor(ms / 1000) * 1000;
          expect(parsed).toBe(truncatedMs);
        },
      ),
      { numRuns: 100 },
    );
  });
});
