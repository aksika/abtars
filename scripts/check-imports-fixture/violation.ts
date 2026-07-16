import { acquireLock } from "abmind/deploy-lib/shared-native-deps-lock.js";

export function doLock() {
  acquireLock("abtars", "test", "token");
}
