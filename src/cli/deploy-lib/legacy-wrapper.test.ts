import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyLegacyAbmindWrapper, type LegacyWrapperOwnership } from "./legacy-wrapper.js";

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "legacy-wrapper-test-"));
  return dir;
}

const MULTI_RES_WRAPPER = `#!/usr/bin/env bash
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"
export NODE_PATH="$HOME/.local/lib/node_modules:\${NODE_PATH:-}"
# Resolve abmind CLI — global install is canonical under #1243 (no longer bundled in the release)
LOCAL_CLI="$HOME/.local/lib/node_modules/abmind/dist/cli/abmind.js"
GLOBAL_CLI="$(npm root -g 2>/dev/null)/abmind/dist/cli/abmind.js"
SRC_CLI="$HOME/.abmind/src/abmind/dist/cli/abmind.js"
if [ -f "$LOCAL_CLI" ]; then
  exec node "$LOCAL_CLI" "$@"
fi
`;

const BUNDLED_WRAPPER = `#!/usr/bin/env bash
export NODE_PATH="$HOME/.local/lib/node_modules:\${NODE_PATH:-}"
# abmind CLI wrappers — point at the bundled copy inside the release
exec node "/Users/akos/.abtars/app/node_modules/abmind/dist/cli/abmind.js" "$@"
`;

describe("classifyLegacyAbmindWrapper", () => {
  it("classifies multi-resolution abtars wrapper as abtars-generated", () => {
    const dir = tmpDir();
    const f = join(dir, "abmind");
    writeFileSync(f, MULTI_RES_WRAPPER);
    expect(classifyLegacyAbmindWrapper(f)).toBe<LegacyWrapperOwnership>("abtars-generated");
    unlinkSync(f);
    rmdirSync(dir);
  });

  it("classifies bundled-path wrapper as abtars-generated", () => {
    const dir = tmpDir();
    const f = join(dir, "abmind");
    writeFileSync(f, BUNDLED_WRAPPER);
    expect(classifyLegacyAbmindWrapper(f)).toBe<LegacyWrapperOwnership>("abtars-generated");
    unlinkSync(f);
    rmdirSync(dir);
  });

  it("classifies npm symlink as npm-symlink", () => {
    const dir = tmpDir();
    const target = join(dir, "target");
    const link = join(dir, "abmind");
    writeFileSync(target, "dummy");
    symlinkSync(target, link);
    expect(classifyLegacyAbmindWrapper(link)).toBe<LegacyWrapperOwnership>("npm-symlink");
    unlinkSync(link);
    unlinkSync(target);
    rmdirSync(dir);
  });

  it("classifies unknown regular file as unknown", () => {
    const dir = tmpDir();
    const f = join(dir, "abmind");
    writeFileSync(f, "#!/usr/bin/env bash\necho hello");
    expect(classifyLegacyAbmindWrapper(f)).toBe<LegacyWrapperOwnership>("unknown");
    unlinkSync(f);
    rmdirSync(dir);
  });

  it("classifies missing path as missing", () => {
    expect(classifyLegacyAbmindWrapper("/nonexistent/abmind")).toBe<LegacyWrapperOwnership>("missing");
  });
});
