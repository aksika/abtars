import { loadUsers } from "./user-registry.js";

/** Single source of truth for master userId. Throws if no master configured. */
export function getMasterUserId(): string {
  const master = loadUsers().users.find(u => u.role === "master");
  if (!master) throw new Error("No master user in users.json — run onboard");
  return master.userId;
}
