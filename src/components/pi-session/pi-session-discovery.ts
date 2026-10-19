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
    const mod = await loadPiModule<{ SessionManager?: unknown }>(
      resolved.installation,
      { package: "@earendil-works/pi-coding-agent" },
    );
    const candidate = mod.SessionManager as Partial<PiSessionManagerCtor> | undefined;
    if (
      !candidate ||
      typeof candidate.create !== "function" ||
      typeof candidate.open !== "function" ||
      typeof candidate.findById !== "function" ||
      typeof candidate.forkFrom !== "function"
    ) {
      logWarn(TAG, "Pi coding-agent root has no usable SessionManager surface — Pi-owned sessions cannot open");
      return null;
    }
    return candidate as PiSessionManagerCtor;
  } catch (err) {
    logWarn(TAG, `Pi SessionManager load failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
