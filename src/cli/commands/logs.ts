import { spawn } from "node:child_process";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";


export async function logs(): Promise<number> {
  const date = new Date().toISOString().slice(0, 10);
  const logFile = join(abtarsHome(), "logs", `bridge-${date}.log`);
  const child = spawn("tail", ["-f", "-n", "50", logFile], { stdio: "inherit" });
  return new Promise((resolve) => child.on("close", (code) => resolve(code ?? 0)));
}
