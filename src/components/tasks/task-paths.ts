import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { abtarsHome } from "../../paths.js";
import { localDate } from "../../utils/date.js";

/**
 * #1594: shared path semantics between runtime task loading and the
 * `abtars-task validate` dry run. Preserves the two distinct runtime
 * contracts so validation answers the same questions the scheduler will.
 */

/** Resolve a taskFile exactly like `loadTaskPackage()`: leading `~` maps to
 *  the user's home, then `path.resolve()` — a relative task file is relative
 *  to the process cwd. */
export function resolveTaskFilePath(taskFile: string): string {
  return resolve(taskFile.replace(/^~/, homedir()));
}

/** Resolve a report-contract path exactly like report preflight: leading `~`
 *  maps to the user's home, `{today}` is substituted with the local date,
 *  a relative path lands below `<abtarsHome>/workspace/<taskId>`, and the
 *  result is `path.resolve()`d. */
export function resolveTaskContractPath(configuredPath: string, taskId: string): string {
  let p = configuredPath.replace(/^~/, homedir());
  p = p.replace(/\{today\}/g, localDate());
  if (!p.startsWith("/")) {
    p = join(abtarsHome(), "workspace", taskId, p);
  }
  return resolve(p);
}
