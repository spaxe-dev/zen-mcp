// npm lifecycle hook: offer the consumer skill after a fresh install.
// A source checkout has no dist yet (npm ci runs before build), so exit
// quietly. The built runner owns all TTY and opt-out handling.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(root, "dist", "skill-offer.js");
if (!existsSync(runner)) process.exit(0);

const result = spawnSync(process.execPath, [runner], { stdio: "inherit" });
process.exit(result.status ?? 0);
