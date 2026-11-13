import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ensurePrivateDir } from "../../src/utils/safe-file.js";

describe("private directories", () => {
  it(
    "tightens a directory that already exists",
    { skip: process.platform === "win32" ? "POSIX modes only" : false },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "zen-mcp-private-"));
      const nested = join(dir, "data");
      try {
        mkdirSync(nested);
        chmodSync(nested, 0o755);
        ensurePrivateDir(nested);
        assert.equal(statSync(nested).mode & 0o777, 0o700);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
