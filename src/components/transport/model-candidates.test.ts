import { describe, it, expect } from "vitest";
import {
  candidateKey,
  resolveCandidateAuth,
} from "./model-candidates.js";

describe("candidateKey", () => {
  it("keys by model/endpoint", () => {
    expect(candidateKey("m", "e")).toBe("m@e");
  });
  it("treats same model on different endpoints as distinct", () => {
    expect(candidateKey("m", "e1")).not.toBe(candidateKey("m", "e2"));
  });
});

describe("resolveCandidateAuth (#1757)", () => {
  const getKey = (name: string) => (name === "SET_KEY" ? "secret-value" : undefined);

  it("Pi-managed providers resolve no key and carry the mode", () => {
    expect(resolveCandidateAuth({ authSource: "pi" }, getKey, "inherited")).toEqual({ apiKey: undefined, authSource: "pi" });
  });

  it("Pi-managed providers never inherit another candidate's key", () => {
    expect(resolveCandidateAuth({ authSource: "pi", apiKeyEnv: undefined }, getKey, "inherited-key")).toEqual({
      apiKey: undefined,
      authSource: "pi",
    });
  });

  it("keyed providers resolve their own apiKeyEnv", () => {
    expect(resolveCandidateAuth({ apiKeyEnv: "SET_KEY" }, getKey, "inherited")).toEqual({ apiKey: "secret-value" });
  });

  it("keyless providers inherit the caller's key (historical behavior)", () => {
    expect(resolveCandidateAuth({}, getKey, "inherited")).toEqual({ apiKey: "inherited" });
  });
});
