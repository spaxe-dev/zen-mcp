import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { configFilePath, loadConfig, saveConfig } from "../../src/config.js";

describe("config", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "zen-mcp-config-"));
  const configPath = join(tempDir, "config.json");
  const saved = {
    config: process.env.ZEN_MCP_CONFIG,
    zenPath: process.env.ZEN_MCP_ZEN_PATH,
    profile: process.env.ZEN_MCP_PROFILE,
    port: process.env.ZEN_MCP_MARIONETTE_PORT,
  };

  before(() => {
    process.env.ZEN_MCP_CONFIG = configPath;
    delete process.env.ZEN_MCP_ZEN_PATH;
    delete process.env.ZEN_MCP_PROFILE;
    delete process.env.ZEN_MCP_MARIONETTE_PORT;
  });

  after(() => {
    restore("ZEN_MCP_CONFIG", saved.config);
    restore("ZEN_MCP_ZEN_PATH", saved.zenPath);
    restore("ZEN_MCP_PROFILE", saved.profile);
    restore("ZEN_MCP_MARIONETTE_PORT", saved.port);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses the configured path and built-in defaults", () => {
    assert.equal(configFilePath(), configPath);
    const config = loadConfig();
    assert.equal(config.autoLaunch, true);
    assert.equal(config.marionettePort, 2828);
    assert.equal(config.askTimeoutSeconds, 120);
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
    try {
      const config = loadConfig();
      assert.equal(config.zenPath, "/custom/zen");
      assert.equal(config.marionettePort, 3333);
      assert.equal(config.autoLaunch, false);
    } finally {
      delete process.env.ZEN_MCP_ZEN_PATH;
      delete process.env.ZEN_MCP_MARIONETTE_PORT;
    }
  });

  it("explains broken JSON", () => {
    writeFileSync(configPath, "{ nope", "utf8");
    assert.throws(() => loadConfig(), /Could not parse .*config\.json/);
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
