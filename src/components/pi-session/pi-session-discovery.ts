import { logWarn } from "../logger.js";
import { loadPiModule, resolvePiInstallation } from "../pi-installation.js";
import type { PiSessionManagerCtor } from "./pi-session-adapter.js";

const TAG = "pi-session-discovery";

/**
 * Load the real Pi SessionManager constructor through installed-Pi
 * discovery. Never a static runtime import: the published bundle must not
 * inline the devDependency copy ahead of the operator's installation.
 */
export async function loadPiSessionManager(): Promise<PiSessionManagerCtor | null> {
  const resolved = resolvePiInstallation();
  if (resolved.state !== "compatible") {
    logWarn(TAG, `Pi unavailable (${resolved.state}) — Pi-owned sessions cannot open`);
    return null;
  }
  try {
    const mod = await loadPiModule<{ SessionManager?: PiSessionManagerCtor }>(
      resolved.installation,
      { package: "@earendil-works/pi-coding-agent" },
    );
    if (!mod.SessionManager) {
      logWarn(TAG, "Pi coding-agent root has no SessionManager — Pi-owned sessions cannot open");
      return null;
    }
    return mod.SessionManager;
  } catch (err) {
    logWarn(TAG, `Pi SessionManager load failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
