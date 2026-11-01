import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SERVER_VERSION } from "../../src/shared/brand.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("reports the published package version", () => {
  const pkg = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8")
  ) as { version: string };
  assert.equal(SERVER_VERSION, pkg.version);
});
