import { logInfo, logWarn } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import { getSystemTaskRegistry } from "../components/tasks/system-task-registry.js";
import { readLastPromptAt } from "../components/transport/bridge-lock-transport.js";

export async function phasePower(ctx: BootCtx): Promise<PhaseResult> {
  const registry = getSystemTaskRegistry();

  if (!ctx.heartbeat) {
    ctx.phaseHealth.set(phasePower.name, { status: "skipped", error: "no heartbeat" });
    logWarn("boot", `${phasePower.name}: skipping — heartbeat not available`);
    if (!registry.has("hardware-sleep")) {
      registry.register("hardware-sleep", () => ({ status: "failed", error: "hardware-sleep unavailable: heartbeat not initialized" }));
    }
    return "skipped";
  }

  const { createPowerSafetyProbe } = await import("../capabilities/power/power-safety-probe.js");
  const { MacPowerAdapter } = await import("../capabilities/power/mac-power-adapter.js");
  const { PowerTransitionStore } = await import("../capabilities/power/power-transition-store.js");
  const { HardwareSleepController } = await import("../capabilities/power/hardware-sleep-controller.js");

  const platform = process.platform;
  const isDarwin = platform === "darwin";
  const isLinux = platform === "linux";

  const transitionStore = new PowerTransitionStore();

  const probe = createPowerSafetyProbe({
    lastPromptAt: () => readLastPromptAt(),
    isAnyExecutionActive: () => {
      return ctx.cronQueue?.currentJob !== null;
    },
    isSleepCycleActive: () => ctx.sleepHandle?.isActive === true,
    isTaskQueueEmpty: () => (ctx.cronQueue?.pending ?? 0) === 0,
    isMaintenanceActive: () => false,
    isTransitionActive: () => transitionStore.isActive(),
    isPlatformSupported: () => isDarwin || isLinux,
  });

  const adapter = isDarwin
    ? new MacPowerAdapter(async (executable: string, args: readonly string[]) => {
        const { execFile } = await import("node:child_process");
        return new Promise((resolve) => {
          execFile(executable, args as string[], { timeout: 15000 }, (err: unknown, stdout: string, stderr: string) => {
            const nodeErr = err as (NodeJS.ErrnoException & { code?: string }) | null;
            if (nodeErr && nodeErr.code === "ENOENT") {
              resolve({ stdout: "", stderr: `not found: ${executable}`, exitCode: 127 });
            } else if (nodeErr) {
              resolve({ stdout, stderr, exitCode: nodeErr.code === "ETIMEDOUT" ? 124 : 1 });
            } else {
              resolve({ stdout, stderr, exitCode: 0 });
            }
          });
        });
      })
    : null;

  const controller = new HardwareSleepController(probe, adapter, transitionStore);

  if (!registry.has("hardware-sleep")) {
    registry.register("hardware-sleep", (entry) => controller.attempt(entry));
    logInfo("boot", "registered system action hardware-sleep");
  }

  return "ran";
}
