import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkForUpdate,
  compareVersions,
  detectPackageManager,
  isNewerVersion,
  PACKAGE_NAME,
  REGISTRY_URL,
  updateCommand,
} from "../../src/zen/updates.js";

const respond = (body: unknown, status = 200): any => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("version comparison", () => {
  it("orders plain versions", () => {
    assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
    assert.equal(compareVersions("1.3.0", "1.2.9"), 1);
    assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  });

  it("accepts a v prefix and build metadata", () => {
    assert.equal(compareVersions("v0.5.0", "0.4.9"), 1);
    assert.equal(compareVersions("1.0.0+build.7", "1.0.0"), 0);
  });

  it("sorts prereleases below the release", () => {
    assert.equal(compareVersions("1.0.0-beta.2", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
    assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.11"), -1);
    assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
    assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha"), 1);
  });

  it("returns null for values that are not versions", () => {
    assert.equal(compareVersions("latest", "1.0.0"), null);
    assert.equal(compareVersions("1.0", "1.0.0"), null);
    assert.equal(compareVersions("1.0.0", "not-a-version"), null);
  });

  it("reports newer releases only", () => {
    assert.equal(isNewerVersion("0.5.0", "0.4.0"), true);
    assert.equal(isNewerVersion("0.4.0", "0.4.0"), false);
    assert.equal(isNewerVersion("0.3.9", "0.4.0"), false);
    assert.equal(isNewerVersion("nonsense", "0.4.0"), false);
  });
});

describe("update check", () => {
  it("reports a newer release and queries the package's registry URL", async () => {
    let requested = "";
    const info = await checkForUpdate({
      currentVersion: "0.4.0",
      fetchImpl: async (url) => {
        requested = url;
        return respond({ name: PACKAGE_NAME, version: "0.5.0" });
      },
    });
    assert.equal(requested, REGISTRY_URL);
    assert.equal(info.latestVersion, "0.5.0");
    assert.equal(info.updateAvailable, true);
    assert.equal(info.error, undefined);
    assert.ok(info.checkedAt > 0);
  });

  it("does not report the current or an older release as an update", async () => {
    const same = await checkForUpdate({
      currentVersion: "0.4.0",
      fetchImpl: async () => respond({ version: "0.4.0" }),
    });
    assert.equal(same.updateAvailable, false);
    assert.equal(same.latestVersion, "0.4.0");

    const older = await checkForUpdate({
      currentVersion: "0.4.0",
      fetchImpl: async () => respond({ version: "0.3.9" }),
    });
    assert.equal(older.updateAvailable, false);
  });

  it("turns registry failures into a normal result", async () => {
    const httpError = await checkForUpdate({
      fetchImpl: async () => respond({}, 503),
    });
    assert.equal(httpError.latestVersion, null);
    assert.match(httpError.error ?? "", /HTTP 503/);

    const badBody = await checkForUpdate({
      fetchImpl: async () => respond({ version: "latest" }),
    });
    assert.equal(badBody.latestVersion, null);
    assert.match(badBody.error ?? "", /valid version/);

    const thrown = await checkForUpdate({
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(thrown.latestVersion, null);
    assert.equal(thrown.error, "offline");
  });

  it("names a timeout clearly", async () => {
    const info = await checkForUpdate({
      fetchImpl: async () => {
        const error = new Error("aborted");
        error.name = "TimeoutError";
        throw error;
      },
    });
    assert.equal(info.error, "the update check timed out");
  });
});

describe("package manager detection", () => {
  it("uses the user agent that invoked the process", () => {
    assert.equal(
      detectPackageManager({ npm_config_user_agent: "pnpm/9.1.0 npm/? node/v22" }),
      "pnpm"
    );
    assert.equal(
      detectPackageManager({ npm_config_user_agent: "yarn/1.22.22 npm/? node/v22" }),
      "yarn"
    );
    assert.equal(
      detectPackageManager({ npm_config_user_agent: "bun/1.1.0 npm/? node/v22" }),
      "bun"
    );
    assert.equal(
      detectPackageManager({ npm_config_user_agent: "npm/10.8.0 node/v22" }),
      "npm"
    );
  });

  it("falls back to the exec path, then npm", () => {
    assert.equal(
      detectPackageManager({ npm_execpath: "C:\\tools\\pnpm.cjs" }),
      "pnpm"
    );
    assert.equal(detectPackageManager({}), "npm");
  });

  it("builds the global install command for each manager", () => {
    assert.deepEqual(updateCommand("npm"), {
      command: "npm",
      args: ["install", "-g", `${PACKAGE_NAME}@latest`],
    });
    assert.deepEqual(updateCommand("pnpm"), {
      command: "pnpm",
      args: ["add", "-g", `${PACKAGE_NAME}@latest`],
    });
    assert.deepEqual(updateCommand("yarn"), {
      command: "yarn",
      args: ["global", "add", `${PACKAGE_NAME}@latest`],
    });
    assert.deepEqual(updateCommand("bun"), {
      command: "bun",
      args: ["add", "-g", `${PACKAGE_NAME}@latest`],
    });
  });
});
