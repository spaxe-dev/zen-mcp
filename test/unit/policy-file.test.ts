import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  PolicyFileError,
  initPolicyFile,
  loadPolicySnapshot,
  policyFilePath,
  policyLockFilePath,
  readPolicyFile,
  savePolicyFile,
  updatePolicyFile,
} from "../../src/shared/policy-file.js";
import { POLICY_MAX_BYTES, serializePolicy } from "../../src/shared/policy-schema.js";
import { createPolicy } from "../../src/shared/policy.js";

const BASE_TMP = existsSync("D:/tmp") || existsSync("D:\\tmp") ? "D:/tmp" : tmpdir();
const NOW = new Date("2026-01-01T00:00:00.000Z");

function tempFile(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(BASE_TMP, "zen-policy-"));
  return {
    dir,
    file: join(dir, "policy.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function expectPolicyError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof PolicyFileError, String(error));
    assert.equal(error.code, code, error.message);
    return true;
  });
}

describe("loading the effective policy", () => {
  it("treats a missing file as restricted without creating it", () => {
    const { file, cleanup } = tempFile();
    try {
      const snapshot = loadPolicySnapshot({ file, now: NOW });
      assert.equal(snapshot.source, "default");
      assert.equal(snapshot.policy.mode, "restricted");
      assert.equal(snapshot.revision, 0);
      assert.match(snapshot.warnings.join(" "), /policy init/);
      assert.equal(existsSync(file), false);
    } finally {
      cleanup();
    }
  });

  it("uses legacy settings in memory when no file exists", () => {
    const { file, cleanup } = tempFile();
    try {
      const snapshot = loadPolicySnapshot({
        file,
        now: NOW,
        legacy: { readOnly: true, allowedDomains: ["example.com"] },
      });
      assert.equal(snapshot.source, "legacy");
      assert.equal(snapshot.policy.mode, "permissive");
      assert.equal(snapshot.policy.websites.default, "deny");
      assert.equal(snapshot.policy.restrictions["page.click"], "deny");
      assert.match(snapshot.warnings.join(" "), /policy init/);
      assert.equal(existsSync(file), false);
    } finally {
      cleanup();
    }
  });

  it("prefers a valid file and warns that legacy settings still apply", () => {
    const { file, cleanup } = tempFile();
    try {
      savePolicyFile(createPolicy({ mode: "normal", now: NOW }), { file });
      const snapshot = loadPolicySnapshot({
        file,
        legacy: { readOnly: true },
        now: NOW,
      });
      assert.equal(snapshot.source, "file");
      assert.equal(snapshot.policy.mode, "normal");
      assert.match(snapshot.warnings.join(" "), /still apply/);
    } finally {
      cleanup();
    }
  });

  it("fails closed on an invalid file even when legacy settings exist", () => {
    const { file, cleanup } = tempFile();
    try {
      writeFileSync(file, '{"schemaVersion":1,"mode":"full"');
      const snapshot = loadPolicySnapshot({
        file,
        legacy: { readOnly: true },
        now: NOW,
      });
      assert.equal(snapshot.source, "invalid");
      assert.equal(snapshot.revision, 0);
      assert.equal(snapshot.errorCode, "invalid_json");
      assert.ok(snapshot.error);
      assert.match(snapshot.warnings.join(" "), /denied/);
    } finally {
      cleanup();
    }
  });

  it("reports an oversized file as an io error and refuses to read it", () => {
    const { file, cleanup } = tempFile();
    try {
      writeFileSync(file, "x".repeat(POLICY_MAX_BYTES + 1));
      const read = readPolicyFile(file);
      assert.equal(read.status, "invalid");
      if (read.status === "invalid") assert.equal(read.code, "io_error");
      assert.equal(loadPolicySnapshot({ file, now: NOW }).source, "invalid");
    } finally {
      cleanup();
    }
  });

  it("reports a missing file distinctly", () => {
    const { file, cleanup } = tempFile();
    try {
      assert.deepEqual(readPolicyFile(file), { status: "missing" });
    } finally {
      cleanup();
    }
  });
});

describe("explicit migration", () => {
  it("initializes a missing file as restricted", () => {
    const { file, cleanup } = tempFile();
    try {
      const snapshot = initPolicyFile({ file, now: NOW });
      assert.equal(snapshot.policy.mode, "restricted");
      assert.equal(snapshot.policy.revision, 1);
      assert.equal(snapshot.source, "file");
      assert.equal(existsSync(file), true);
      const read = readPolicyFile(file);
      assert.equal(read.status, "valid");
    } finally {
      cleanup();
    }
  });

  it("migrates explicit legacy restrictions exactly", () => {
    const { file, cleanup } = tempFile();
    try {
      const snapshot = initPolicyFile({
        file,
        now: NOW,
        legacy: { readOnly: true, allowedDomains: ["example.com"] },
      });
      assert.equal(snapshot.policy.mode, "permissive");
      assert.equal(snapshot.policy.websites.default, "deny");
      assert.deepEqual(snapshot.policy.websites.allow, ["example.com"]);
      assert.equal(snapshot.policy.restrictions["nav.open"], "deny");
    } finally {
      cleanup();
    }
  });

  it("refuses to overwrite an existing file", () => {
    const { file, cleanup } = tempFile();
    try {
      savePolicyFile(createPolicy({ mode: "full", now: NOW }), { file });
      const before = readFileSync(file, "utf8");
      expectPolicyError(() => initPolicyFile({ file, now: NOW }), "policy_exists");
      assert.equal(readFileSync(file, "utf8"), before);
    } finally {
      cleanup();
    }
  });

  it("does not initialize on a read", () => {
    const { file, cleanup } = tempFile();
    try {
      loadPolicySnapshot({ file, now: NOW });
      assert.equal(existsSync(file), false);
    } finally {
      cleanup();
    }
  });
});

describe("revision conflicts", () => {
  it("accepts revision 1 for the first write and increments on updates", () => {
    const { file, cleanup } = tempFile();
    try {
      savePolicyFile(createPolicy({ mode: "restricted", revision: 1, now: NOW }), {
        file,
      });
      const second = savePolicyFile(
        createPolicy({ mode: "normal", revision: 2, now: NOW }),
        { file, expectedRevision: 1 }
      );
      assert.equal(second.policy.revision, 2);
      const third = updatePolicyFile(
        (policy) => {
          policy.mode = "permissive";
        },
        { file, now: NOW }
      );
      assert.equal(third.policy.revision, 3);
      assert.equal(third.policy.mode, "permissive");
      assert.equal(third.policy.writer, "cli");
    } finally {
      cleanup();
    }
  });

  it("rejects a stale expected revision", () => {
    const { file, cleanup } = tempFile();
    try {
      savePolicyFile(createPolicy({ revision: 1, now: NOW }), { file });
      savePolicyFile(createPolicy({ revision: 2, now: NOW }), { file });
      expectPolicyError(
        () =>
          savePolicyFile(createPolicy({ revision: 3, now: NOW }), {
            file,
            expectedRevision: 1,
          }),
        "revision_conflict"
      );
    } finally {
      cleanup();
    }
  });

  it("rejects a revision that does not increment by exactly one", () => {
    const { file, cleanup } = tempFile();
    try {
      savePolicyFile(createPolicy({ revision: 1, now: NOW }), { file });
      expectPolicyError(
        () => savePolicyFile(createPolicy({ revision: 4, now: NOW }), { file }),
        "revision_conflict"
      );
    } finally {
      cleanup();
    }
  });

  it("rejects a first write that expects an existing revision", () => {
    const { file, cleanup } = tempFile();
    try {
      expectPolicyError(
        () =>
          savePolicyFile(createPolicy({ revision: 1, now: NOW }), {
            file,
            expectedRevision: 1,
          }),
        "revision_conflict"
      );
      expectPolicyError(
        () => savePolicyFile(createPolicy({ revision: 2, now: NOW }), { file }),
        "revision_conflict"
      );
    } finally {
      cleanup();
    }
  });

  it("refuses to mutate a missing or invalid policy", () => {
    const { file, cleanup } = tempFile();
    try {
      expectPolicyError(() => updatePolicyFile(() => {}, { file }), "policy_missing");
      writeFileSync(file, "not json");
      expectPolicyError(
        () => updatePolicyFile(() => {}, { file }),
        "invalid_policy"
      );
    } finally {
      cleanup();
    }
  });

  it("refuses to write an invalid policy", () => {
    const { file, cleanup } = tempFile();
    try {
      const policy = createPolicy({ mode: "full", now: NOW });
      (policy.restrictions as Record<string, string>)["page.click"] = "allow";
      expectPolicyError(() => savePolicyFile(policy, { file }), "invalid_policy");
      assert.equal(existsSync(file), false);
    } finally {
      cleanup();
    }
  });
});

describe("locking", () => {
  it("refuses to write while a fresh lock exists", () => {
    const { file, cleanup } = tempFile();
    try {
      writeFileSync(policyLockFilePath(file), "held");
      expectPolicyError(
        () => savePolicyFile(createPolicy({ now: NOW }), { file }),
        "locked"
      );
      assert.equal(existsSync(file), false);
    } finally {
      cleanup();
    }
  });

  it("fails closed on a stale lock until it is manually cleared", () => {
    const { file, cleanup } = tempFile();
    try {
      const lock = policyLockFilePath(file);
      writeFileSync(lock, "stale");
      expectPolicyError(
        () => savePolicyFile(createPolicy({ now: NOW }), { file }),
        "locked"
      );
      assert.equal(existsSync(file), false);
      assert.equal(existsSync(lock), true);

      rmSync(lock);
      const snapshot = savePolicyFile(createPolicy({ now: NOW }), { file });
      assert.equal(snapshot.policy.revision, 1);
      assert.equal(existsSync(file), true);
      assert.equal(existsSync(lock), false);
    } finally {
      cleanup();
    }
  });

  it("releases the lock after a successful and a failed write", () => {
    const { file, cleanup } = tempFile();
    try {
      const lock = policyLockFilePath(file);
      savePolicyFile(createPolicy({ now: NOW }), { file });
      assert.equal(existsSync(lock), false);
      expectPolicyError(
        () => savePolicyFile(createPolicy({ revision: 5, now: NOW }), { file }),
        "revision_conflict"
      );
      assert.equal(existsSync(lock), false);
    } finally {
      cleanup();
    }
  });
});

describe("atomic owner-only writes", () => {
  it("leaves only the policy file behind", () => {
    const { dir, file, cleanup } = tempFile();
    try {
      savePolicyFile(createPolicy({ mode: "normal", now: NOW }), { file });
      assert.deepEqual(readdirSync(dir), ["policy.json"]);
      assert.equal(readFileSync(file, "utf8"), serializePolicy(createPolicy({ mode: "normal", now: NOW })));
    } finally {
      cleanup();
    }
  });

  it("does not partially replace the previous file on an invalid update", () => {
    const { file, cleanup } = tempFile();
    try {
      savePolicyFile(createPolicy({ mode: "normal", now: NOW }), { file });
      const before = readFileSync(file, "utf8");
      expectPolicyError(
        () =>
          updatePolicyFile(
            (policy) => {
              (policy.restrictions as Record<string, string>)["page.click"] =
                "allow";
            },
            { file, now: NOW }
          ),
        "invalid_policy"
      );
      assert.equal(readFileSync(file, "utf8"), before);
    } finally {
      cleanup();
    }
  });

  it(
    "writes the policy with owner-only permissions",
    { skip: process.platform === "win32" ? "POSIX modes only" : false },
    () => {
      const { file, cleanup } = tempFile();
      try {
        savePolicyFile(createPolicy({ now: NOW }), { file });
        assert.equal(statSync(file).mode & 0o777, 0o600);
      } finally {
        cleanup();
      }
    }
  );
});

describe("policy path", () => {
  it("follows ZEN_MCP_CONFIG and places policy.json beside it", () => {
    const previous = process.env.ZEN_MCP_CONFIG;
    const dir = mkdtempSync(join(BASE_TMP, "zen-policy-env-"));
    const config = join(dir, "config.json");
    try {
      process.env.ZEN_MCP_CONFIG = config;
      assert.equal(policyFilePath(), join(dir, "policy.json"));
      assert.equal(policyLockFilePath(), join(dir, "policy.json.lock"));
      const snapshot = initPolicyFile({ now: NOW });
      assert.equal(snapshot.policy.mode, "restricted");
      assert.equal(existsSync(join(dir, "policy.json")), true);
    } finally {
      if (previous === undefined) delete process.env.ZEN_MCP_CONFIG;
      else process.env.ZEN_MCP_CONFIG = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the config directory when initializing", () => {
    const previous = process.env.ZEN_MCP_CONFIG;
    const dir = mkdtempSync(join(BASE_TMP, "zen-policy-env-"));
    const config = join(dir, "nested", "deeper", "config.json");
    try {
      process.env.ZEN_MCP_CONFIG = config;
      initPolicyFile({ now: NOW });
      assert.equal(existsSync(join(dir, "nested", "deeper", "policy.json")), true);
    } finally {
      if (previous === undefined) delete process.env.ZEN_MCP_CONFIG;
      else process.env.ZEN_MCP_CONFIG = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("directory handling", () => {
  it("reads a policy created in a nested explicit directory", () => {
    const { dir, cleanup } = tempFile();
    try {
      const nested = join(dir, "a", "b");
      mkdirSync(nested, { recursive: true });
      const file = join(nested, "policy.json");
      savePolicyFile(createPolicy({ mode: "full", now: NOW }), { file });
      assert.equal(readPolicyFile(file).status, "valid");
    } finally {
      cleanup();
    }
  });
});
