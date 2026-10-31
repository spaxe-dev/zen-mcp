import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { configFilePath, loadConfig, saveConfig } from "../../src/config.js";

const OVERRIDE_ENV = [
  "ZEN_MCP_ZEN_PATH",
  "ZEN_MCP_PROFILE",
  "ZEN_MCP_MARIONETTE_PORT",
  "ZEN_MCP_USE_DEFAULT_PROFILE",
  "ZEN_MCP_REQUIRE_CONSENT",
  "ZEN_MCP_CONSENT_TIMEOUT_SECONDS",
  "ZEN_MCP_LAUNCH_ARGS",
  "ZEN_MCP_READ_ONLY",
  "ZEN_MCP_AUDIT_LOG",
  "ZEN_MCP_ALLOWED_DOMAINS",
  "ZEN_MCP_WATCH_MIN_INTERVAL_SECONDS",
] as const;

describe("config", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "zen-mcp-config-"));
  const configPath = join(tempDir, "config.json");
  const saved: Partial<Record<string, string>> = {
    ZEN_MCP_CONFIG: process.env.ZEN_MCP_CONFIG,
  };
  for (const name of OVERRIDE_ENV) saved[name] = process.env[name];

  before(() => {
    process.env.ZEN_MCP_CONFIG = configPath;
    for (const name of OVERRIDE_ENV) delete process.env[name];
  });

  after(() => {
    for (const [name, value] of Object.entries(saved)) {
      restore(name, value);
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses the configured path and built-in defaults", () => {
    assert.equal(configFilePath(), configPath);
    const config = loadConfig();
    assert.equal(config.autoLaunch, true);
    assert.equal(config.marionettePort, 2828);
    assert.equal(config.askTimeoutSeconds, 120);
    assert.equal(config.useDefaultProfile, false);
    assert.equal(config.requireConsent, true);
    assert.equal(config.consentTimeoutSeconds, 90);
    assert.deepEqual(config.launchArgs, []);
  });

  it("merges updates into an existing file", () => {
    saveConfig({ autoLaunch: false, askTimeoutSeconds: 30 });
    const config = loadConfig();
    assert.equal(config.autoLaunch, false);
    assert.equal(config.askTimeoutSeconds, 30);
    assert.equal(config.marionettePort, 2828);
  });

  it("lets environment variables override the file", () => {
    process.env.ZEN_MCP_ZEN_PATH = "/custom/zen";
    process.env.ZEN_MCP_MARIONETTE_PORT = "3333";
    process.env.ZEN_MCP_USE_DEFAULT_PROFILE = "1";
    process.env.ZEN_MCP_REQUIRE_CONSENT = "0";
    process.env.ZEN_MCP_CONSENT_TIMEOUT_SECONDS = "30";
    process.env.ZEN_MCP_LAUNCH_ARGS = "--headless  --new-instance";
    try {
      const config = loadConfig();
      assert.equal(config.zenPath, "/custom/zen");
      assert.equal(config.marionettePort, 3333);
      assert.equal(config.autoLaunch, false);
      assert.equal(config.useDefaultProfile, true);
      assert.equal(config.requireConsent, false);
      assert.equal(config.consentTimeoutSeconds, 30);
      assert.deepEqual(config.launchArgs, ["--headless", "--new-instance"]);
    } finally {
      for (const name of OVERRIDE_ENV) delete process.env[name];
    }
  });

  it("explains broken JSON", () => {
    writeFileSync(configPath, "{ nope", "utf8");
    assert.throws(() => loadConfig(), /Could not parse .*config\.json/);
  });

  it("trims safety environment values and accepts on/off", () => {
    writeFileSync(configPath, "{}", "utf8");
    process.env.ZEN_MCP_READ_ONLY = " TRUE ";
    process.env.ZEN_MCP_AUDIT_LOG = "off";
    try {
      const config = loadConfig();
      assert.equal(config.readOnly, true);
      assert.equal(config.auditLog, false);
    } finally {
      delete process.env.ZEN_MCP_READ_ONLY;
      delete process.env.ZEN_MCP_AUDIT_LOG;
    }
  });

  it("falls back to the file when an environment boolean is unrecognized", () => {
    writeFileSync(configPath, JSON.stringify({ readOnly: true }), "utf8");
    process.env.ZEN_MCP_READ_ONLY = "enabled";
    try {
      assert.equal(loadConfig().readOnly, true);
    } finally {
      delete process.env.ZEN_MCP_READ_ONLY;
    }
  });

  it("ignores non-boolean file values and bounds numbers", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        readOnly: "false",
        requireConsent: "no",
        watchdog: "nope",
        watchMinIntervalSeconds: 10_000_000,
        marionettePort: 999_999,
        consentTimeoutSeconds: "nope",
      }),
      "utf8"
    );
    const config = loadConfig();
    assert.equal(config.readOnly, false);
    assert.equal(config.requireConsent, true);
    assert.equal(config.watchMinIntervalSeconds, 3600);
    assert.equal(config.marionettePort, 65535);
    assert.equal(config.consentTimeoutSeconds, 90);
  });

  it("does not bake environment overrides into the config file", () => {
    writeFileSync(configPath, JSON.stringify({ autoLaunch: true }), "utf8");
    process.env.ZEN_MCP_ZEN_PATH = "/custom/zen";
    try {
      saveConfig({ autoLaunch: false });
    } finally {
      delete process.env.ZEN_MCP_ZEN_PATH;
    }
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(saved.autoLaunch, false);
    assert.equal(saved.zenPath, undefined);
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
