import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  FIXTURE_SOCKET_LINK_LIMIT,
  FIXTURE_SOCKET_LINK_NAME,
  fixtureSocketLinkPath,
} from "./bridge-config.js";

// Real macOS $TMPDIR shape (50 chars) plus the compact runRoot leaf.
// Linux /tmp is 4 chars, which is why CI stayed green while macOS
// local-unix lanes died on connect EINVAL (#1841 follow-up).
const LONG_CONFIG_DIR =
  "/var/folders/qx/m785t7hs7f7dl5tq2fsf0x8w0000gp/T/pp-l-abcdef/abtars-home/config";

describe("fixture socket link path (#1841 follow-up)", () => {
  it("stays within the limit under a long macOS TMPDIR", () => {
    const link = fixtureSocketLinkPath(LONG_CONFIG_DIR);
    expect(link).toBe(join(LONG_CONFIG_DIR, FIXTURE_SOCKET_LINK_NAME));
    expect(link.length).toBeLessThanOrEqual(FIXTURE_SOCKET_LINK_LIMIT);
  });

  it("rejects over-limit config dirs with an actionable message", () => {
    const bad = `${"/y".repeat(55)}/abtars-home/config`;
    expect(() => fixtureSocketLinkPath(bad)).toThrow(/exceeds 100 chars/);
  });
});
