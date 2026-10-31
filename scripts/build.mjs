import { build } from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  legalComments: "none",
};

await build({
  ...shared,
  entryPoints: [join(root, "src/cli.ts")],
  outfile: join(dist, "cli.js"),
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
});

await build({
  ...shared,
  entryPoints: [join(root, "src/bridge/entry.ts")],
  outfile: join(dist, "bridge.js"),
  platform: "browser",
  format: "iife",
  target: "firefox128",
  sourcemap: false,
  charset: "utf8",
});

chmodSync(join(dist, "cli.js"), 0o755);
