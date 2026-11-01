import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [dirArg, ...flags] = process.argv.slice(2);
if (!dirArg) {
  console.error("usage: node scripts/run-tests.mjs <test-dir> [node --test flags]");
  process.exit(2);
}

const dir = join(root, dirArg);
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => join(dir, name));
if (files.length === 0) {
  console.error(`No .test.ts files found in ${dir}`);
  process.exit(1);
}

// Windows shells do not expand globs, so expand them here for every platform.
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...flags, ...files],
  { cwd: root, stdio: "inherit" }
);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
