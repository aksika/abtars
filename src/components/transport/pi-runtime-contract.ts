/**
 * pi-runtime-contract.ts — pre-ready executable contract probe (#1573).
 *
 * `inspectPiRuntimeSurfaces()` answers a synchronous, side-effect-free
 * question: whether package metadata resolves to contained files. This probe
 * answers a different question: whether the executable values used by
 * `PiCoreTransport` exist. Answering that truthfully requires actual ESM
 * imports, so the probe is async and installation-scoped.
 *
 * `validatePiRuntimeContract()` is the single readiness gate. It resolves one
 * `PiInstallation`, loads every module through `loadPiModule()`, and requires:
 *
 *   1. a `compatible` installation state;
 *   2. `@earendil-works/pi-agent-core` with the `Agent` prototype methods the
 *      send path requires (reuses `validatePiAgentCoreModule()`);
 *   3. `@earendil-works/pi-ai` with a callable `createProvider`;
 *   4. every uniquely configured API family (`openai-completions`,
 *      `openai-responses`, `anthropic-messages`) with callable `stream` and
 *      `streamSimple`.
 *
 * None of the inspected constructors or functions is ever invoked, and no
 * process or provider request is spawned. Duplicate API formats collapse
 * before loading so each family imports exactly once. Failures are typed
 * (`PiRuntimeContractError`), bounded, and always carry the exact tested
 * install command. Raw loader messages and stacks are retained only as
 * `cause`; operator-facing text uses fixed component/capability labels.
 */

import { resolvePiInstallation, loadPiModule } from "../pi-installation.js";
import type { PiInstallation, PiModuleSpecifier } from "../pi-installation.js";
import { validatePiAgentCoreModule, PiCoreContractError } from "./pi-core-types.js";
import { pickPiApi, ensurePiThinkingClamp } from "./pi-ai-adapter.js";
import { formatPiPinnedInstallCommand } from "../../config/pi-compatibility.js";
import type { ModelCandidate } from "./model-candidates.js";

export type PiRuntimeComponent =
  | "installation"
  | "pi-agent-core"
  | "pi-ai"
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

/**
 * Typed bounded contract failure. `component` and `capability` come only from
 * the fixed required lists and the Pi installation state union; raw loader
 * text never enters the message.
 */
export class PiRuntimeContractError extends Error {
  readonly component: PiRuntimeComponent;
  readonly capability: string;
  readonly installationVersion?: string;
  readonly remediationCommand: string;

  constructor(message: string, options: {
    component: PiRuntimeComponent;
    capability: string;
    installationVersion?: string;
    cause?: unknown;
  }) {
    super(message, { cause: options.cause });
    this.name = "PiRuntimeContractError";
    this.component = options.component;
    this.capability = options.capability;
    this.installationVersion = options.installationVersion;
    this.remediationCommand = formatPiPinnedInstallCommand();
  }
}

function contractMessage(
  version: string | undefined,
  component: PiRuntimeComponent,
  capability: string,
  kind: "load" | "missing" | "unavailable",
): string {
  const detail = kind === "load"
    ? "load failed"
    : kind === "missing"
      ? `missing ${capability}`
      : `unavailable (${capability})`;
  return (
    `Pi runtime contract incompatible (${version ?? "unknown"}; ${component}; ${detail}).\n` +
    `Restore the tested Pi installation:\n  ${formatPiPinnedInstallCommand()}`
  );
}

/** External boundaries the probe resolves through; tests inject only these. */
export interface PiRuntimeContractDependencies {
  readonly resolveInstallation: typeof resolvePiInstallation;
  readonly loadModule: typeof loadPiModule;
}

/**
 * Probe the installed Pi runtime for every executable value the transport's
 * candidate chain needs. Resolves only when the complete contract holds;
 * otherwise throws `PiRuntimeContractError`. Stateless: a failed attempt never
 * poisons a later probe after the installation is repaired.
 */
export async function validatePiRuntimeContract(
  candidates: readonly Pick<ModelCandidate, "apiFormat">[],
  dependencies?: Partial<PiRuntimeContractDependencies>,
): Promise<void> {
  const resolveInstallation = dependencies?.resolveInstallation ?? resolvePiInstallation;
  const loadModule = dependencies?.loadModule ?? loadPiModule;

  const result = resolveInstallation();
  if (result.state !== "compatible") {
    throw new PiRuntimeContractError(
      contractMessage(undefined, "installation", result.state, "unavailable"),
      { component: "installation", capability: result.state },
    );
  }
  const installation: PiInstallation = result.installation;

  const agentCoreSpec: PiModuleSpecifier = { package: "@earendil-works/pi-agent-core" };
  let agentCoreModule: unknown;
  try {
    agentCoreModule = await loadModule(installation, agentCoreSpec);
  } catch (cause) {
    throw new PiRuntimeContractError(
      contractMessage(installation.version, "pi-agent-core", "module-load", "load"),
      { component: "pi-agent-core", capability: "module-load", installationVersion: installation.version, cause },
    );
  }
  try {
    validatePiAgentCoreModule(agentCoreModule, installation.version);
  } catch (cause) {
    if (cause instanceof PiCoreContractError) {
      throw new PiRuntimeContractError(
        contractMessage(installation.version, "pi-agent-core", cause.missingCapability ?? "Agent", "missing"),
        { component: "pi-agent-core", capability: cause.missingCapability ?? "Agent", installationVersion: installation.version, cause },
      );
    }
    throw new PiRuntimeContractError(
      contractMessage(installation.version, "pi-agent-core", "contract", "missing"),
      { component: "pi-agent-core", capability: "contract", installationVersion: installation.version, cause },
    );
  }

  const aiSpec: PiModuleSpecifier = { package: "@earendil-works/pi-ai" };
  let aiModule: unknown;
  try {
    aiModule = await loadModule(installation, aiSpec);
  } catch (cause) {
    throw new PiRuntimeContractError(
      contractMessage(installation.version, "pi-ai", "module-load", "load"),
      { component: "pi-ai", capability: "module-load", installationVersion: installation.version, cause },
    );
  }
  if (!aiModule || typeof aiModule !== "object" || typeof (aiModule as Record<string, unknown>).createProvider !== "function") {
    throw new PiRuntimeContractError(
      contractMessage(installation.version, "pi-ai", "createProvider", "missing"),
      { component: "pi-ai", capability: "createProvider", installationVersion: installation.version },
    );
  }

  // #1746: retain clamp population from the pi-ai root module already loaded
  // here. buildTransport() populates it before construction, including the
  // /reset path; this call also covers transports initialized outside that
  // composition boundary. Never throws — a root module without a callable
  // clamp just leaves the slot unset (pass-through).
  await ensurePiThinkingClamp(aiModule as Record<string, unknown>);

  // The same mapping live requests use; duplicates collapse before loading.
  // pickPiApi's declared return type is the wider pi Api union; the three
  // families it can actually produce are exactly the api components here.
  const apiNames = [
    ...new Set(candidates.map((candidate) => pickPiApi(candidate.apiFormat) as PiRuntimeComponent)),
  ];
  for (const api of apiNames) {
    const apiSpec: PiModuleSpecifier = { package: "@earendil-works/pi-ai", subpath: `api/${api}` };
    let apiModule: unknown;
    try {
      apiModule = await loadModule(installation, apiSpec);
    } catch (cause) {
      throw new PiRuntimeContractError(
        contractMessage(installation.version, api, "module-load", "load"),
        { component: api, capability: "module-load", installationVersion: installation.version, cause },
      );
    }
    if (!apiModule || typeof apiModule !== "object") {
      throw new PiRuntimeContractError(
        contractMessage(installation.version, api, "module-load", "load"),
        { component: api, capability: "module-load", installationVersion: installation.version },
      );
    }
    const apiRecord = apiModule as Record<string, unknown>;
    for (const capability of ["stream", "streamSimple"] as const) {
      if (typeof apiRecord[capability] !== "function") {
        throw new PiRuntimeContractError(
          contractMessage(installation.version, api, capability, "missing"),
          { component: api, capability, installationVersion: installation.version },
        );
      }
    }
  }
}
