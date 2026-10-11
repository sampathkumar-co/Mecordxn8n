import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const steps = String(pkg.scripts["check:steps"] || "").split(" && ").filter(Boolean);
if (!steps.length) throw new Error("No check:steps are configured");
for (const [index, step] of steps.entries()) {
  const [command, ...args] = step.trim().split(/\s+/);
  if (!["node", "npm"].includes(command)) throw new Error("Unexpected check executable: " + command);
  console.log("[check " + (index + 1) + "/" + steps.length + "] " + step);
  const executable = process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
  const result = spawnSync(executable, args, { stdio: "inherit", shell: process.platform === "win32" && command === "npm" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
