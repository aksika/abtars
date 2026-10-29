/**
 * transport-config.ts — public façade for transport configuration.
 * Re-exports only: implementation lives in transport-config/{types,validator,loader,writer,resolver}.
 * #1466: Read-only loading, pure validation, explicit atomic persistence.
 * Never writes or repairs during loading.
 */

export * from "./transport-config/types.js";
export * from "./transport-config/validator.js";
export {
  configDir,
  loadModels,
  computeCostDisplay,
  loadTransportStructured,
  loadTransport,
  clearTransportCache,
} from "./transport-config/loader.js";
export * from "./transport-config/writer.js";
export * from "./transport-config/resolver.js";
