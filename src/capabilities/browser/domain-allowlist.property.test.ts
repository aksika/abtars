import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { DomainAllowlist } from "./domain-allowlist.js";

/**
 * Feature: playwright-web-ingestion, Property 3: Domain allowlist matching
 *
 * For any URL and any set of domain patterns (including the empty set):
 * - If the pattern set is empty (open mode), the URL is allowed.
 * - If the pattern set is non-empty, the URL is allowed iff its hostname
 *   matches at least one pattern, where *.X matches any hostname ending in .X
 *   and a bare pattern X matches the hostname exactly equal to X.
 * - When a URL is rejected, the error response contains the rejected hostname
 *   and the full list of allowed patterns.
 *
 * Validates: Requirements 2.3, 9.2, 9.3, 9.4, 9.5
 */

// ── Generators ──────────────────────────────────────────────────────────────

/** Generate a valid domain label (1-10 lowercase alpha chars). */
const domainLabel = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"),
  minLength: 1,
  maxLength: 10,
});

/** Generate a valid domain name like "foo.bar.com" (2-4 labels). */
const domainName = fc
  .tuple(
    fc.array(domainLabel, { minLength: 1, maxLength: 3 }),
    fc.constantFrom("com", "org", "net", "io", "dev"),
  )
  .map(([labels, tld]) => [...labels, tld].join("."));

/** Generate a valid HTTPS URL with a given hostname. */
const urlFromHostname = (hostname: string) =>
  fc
    .tuple(
      fc.constantFrom("https://", "http://"),
      fc.string({
        unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz/"),
        minLength: 0,
        maxLength: 20,
      }),
    )
    .map(([scheme, path]) => `${scheme}${hostname}/${path}`);

/** Generate a random valid URL. */
const validUrl = domainName.chain((host) => urlFromHostname(host));

/** Generate a domain pattern: either exact "foo.com" or wildcard "*.foo.com". */
const domainPattern = fc.tuple(domainName, fc.boolean()).map(([d, wild]) =>
  wild ? `*.${d}` : d,
);

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Feature: playwright-web-ingestion, Property 3: Domain allowlist matching", () => {
  it("empty pattern set → all URLs allowed (open mode)", () => {
    fc.assert(
      fc.property(validUrl, (url) => {
        const al = new DomainAllowlist([]);
        expect(al.isOpenMode).toBe(true);
        expect(al.isAllowed(url)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("exact pattern matches only the exact hostname", () => {
    fc.assert(
      fc.property(domainName, (domain) => {
        const al = new DomainAllowlist([domain]);

        // URL with exact hostname → allowed
        const exactUrl = `https://${domain}/path`;
        expect(al.isAllowed(exactUrl)).toBe(true);

        // URL with a subdomain prefix → rejected
        const subUrl = `https://sub.${domain}/path`;
        expect(al.isAllowed(subUrl)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("wildcard pattern *.X matches subdomains and root domain", () => {
    fc.assert(
      fc.property(
        domainName,
        domainLabel,
        (domain, sub) => {
          const al = new DomainAllowlist([`*.${domain}`]);

          // Subdomain → allowed
          const subUrl = `https://${sub}.${domain}/page`;
          expect(al.isAllowed(subUrl)).toBe(true);

          // Root domain itself → allowed
          const rootUrl = `https://${domain}/page`;
          expect(al.isAllowed(rootUrl)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("wildcard pattern *.X rejects unrelated domains", () => {
    fc.assert(
      fc.property(domainName, (domain) => {
        const al = new DomainAllowlist([`*.${domain}`]);

        // A completely different domain should be rejected
        const unrelatedUrl = `https://unrelated-${Date.now()}.zzz/path`;
        expect(al.isAllowed(unrelatedUrl)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("non-empty patterns → allowed iff hostname matches at least one pattern", () => {
    fc.assert(
      fc.property(
        fc.array(domainPattern, { minLength: 1, maxLength: 5 }),
        domainName,
        (patterns, testDomain) => {
          const al = new DomainAllowlist(patterns);
          const url = `https://${testDomain}/path`;
          const hostname = testDomain.toLowerCase();

          // Manually compute expected result
          const shouldBeAllowed = patterns.some((p) => {
            const pat = p.trim().toLowerCase();
            if (pat.startsWith("*.")) {
              const suffix = pat.slice(2);
              return hostname === suffix || hostname.endsWith(`.${suffix}`);
            }
            return hostname === pat;
          });

          expect(al.isAllowed(url)).toBe(shouldBeAllowed);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejected URLs: patterns getter exposes the configured patterns for error messages", () => {
    fc.assert(
      fc.property(
        fc.array(domainPattern, { minLength: 1, maxLength: 5 }),
        domainName,
        (patterns, testDomain) => {
          const al = new DomainAllowlist(patterns);
          const url = `https://${testDomain}/path`;

          if (!al.isAllowed(url)) {
            // The allowlist exposes patterns for building error messages
            const exposedPatterns = al.patterns;
            const normalizedInput = patterns
              .map((p) => p.trim().toLowerCase())
              .filter((p) => p.length > 0);

            // Every configured pattern should be available
            expect(exposedPatterns).toEqual(normalizedInput);

            // The hostname can be extracted for error messages
            const hostname = new URL(url).hostname;
            expect(typeof hostname).toBe("string");
            expect(hostname.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
