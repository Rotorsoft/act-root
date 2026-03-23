#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, "..");
// pnpm sets INIT_CWD to the directory where the user ran the command
const userCwd = process.env.INIT_CWD || process.cwd();
const target = process.argv[2] ? resolve(userCwd, process.argv[2]) : "";
const actCmd = target ? `ActDiagram ${target}` : "ActDiagram";

try {
  execFileSync(
    "nvim",
    [
      "--cmd",
      `set runtimepath+=${pluginRoot}`,
      "-c",
      'lua require("act-nvim").setup()',
      "-c",
      actCmd,
    ],
    { stdio: "inherit", cwd: userCwd },
  );
} catch {
  // nvim exited
}
