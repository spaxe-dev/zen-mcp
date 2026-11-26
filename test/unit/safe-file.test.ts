import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ensurePrivateDir,
  readFileTextBounded,
} from "../../src/utils/safe-file.js";

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

describe("bounded file reads", () => {
  it("reads only regular files within the byte budget", () => {
    const dir = mkdtempSync(join(tmpdir(), "zen-mcp-read-"));
    const file = join(dir, "state.json");
    try {
      writeFileSync(file, "small", "utf8");
      assert.equal(readFileTextBounded(file, 8), "small");
      writeFileSync(file, "123456789", "utf8");
      assert.throws(() => readFileTextBounded(file, 8), /too large/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    "refuses a symlink instead of following it",
    { skip: process.platform === "win32" ? "symlink privileges vary" : false },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "zen-mcp-read-link-"));
      const target = join(dir, "target.json");
      const link = join(dir, "state.json");
      try {
        writeFileSync(target, "secret", "utf8");
        symlinkSync(target, link);
        assert.throws(() => readFileTextBounded(link, 64), /symbolic link/i);
        assert.equal(readFileSync(target, "utf8"), "secret");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

describe("private directory path checks", () => {
  it(
    "refuses to chmod or use a symlink as the private directory",
    { skip: process.platform === "win32" ? "symlink privileges vary" : false },
    () => {
      const root = mkdtempSync(join(tmpdir(), "zen-mcp-dir-link-"));
      const target = join(root, "target");
      const link = join(root, "private");
      try {
        mkdirSync(target);
        symlinkSync(target, link, "dir");
        assert.throws(() => ensurePrivateDir(link), /not a regular directory/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
