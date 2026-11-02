import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  agentSetupPrompt,
  applyClient,
  catalog,
  clientIds,
  mergeJsonServer,
  mergeTomlServer,
} from "../../src/onboard/clients.js";
import {
  buildOptions,
  moveCursor,
  pickClients,
  pickerResult,
  toggleAll,
} from "../../src/onboard/picker.js";

const SERVER = { command: "zen-mcp", args: ["serve"] };

describe("onboard clients", () => {
  it("merges a server into JSON without touching other entries", () => {
    const existing = JSON.stringify(
      {
        theme: "dark",
        mcpServers: { other: { command: "other" } },
      },
      null,
      2
    );
    const parsed = JSON.parse(mergeJsonServer(existing, "mcpServers", SERVER));

    assert.equal(parsed.theme, "dark");
    assert.deepEqual(parsed.mcpServers.other, { command: "other" });
    assert.deepEqual(parsed.mcpServers["zen-mcp"], SERVER);
  });

  it("replaces an existing zen-mcp entry and creates the key when missing", () => {
    const replaced = JSON.parse(
      mergeJsonServer(
        JSON.stringify({ servers: { "zen-mcp": { command: "old" } } }),
        "servers",
        { type: "stdio", ...SERVER }
      )
    );
    assert.deepEqual(replaced.servers["zen-mcp"], {
      type: "stdio",
      ...SERVER,
    });

    const created = JSON.parse(
      mergeJsonServer(undefined, "context_servers", SERVER)
    );
    assert.deepEqual(created.context_servers["zen-mcp"], SERVER);
  });

  it("refuses to overwrite a non-object server map or broken JSON", () => {
    assert.throws(
      () => mergeJsonServer('{"mcpServers": []}', "mcpServers", SERVER),
      /"mcpServers" is not a JSON object/
    );
    assert.throws(
      () => mergeJsonServer("{ nope", "mcpServers", SERVER),
      /not valid JSON/
    );
  });

  it("preserves comments and trailing commas in JSONC files", () => {
    const original = [
      "{",
      "  // keep this theme comment",
      '  "theme": "dark",',
      '  "context_servers": {',
      '    "other": { "command": "other" }, // keep this server',
      "  },",
      "}",
      "",
    ].join("\n");

    const next = mergeJsonServer(original, "context_servers", SERVER);
    assert.match(next, /\/\/ keep this theme comment/);
    assert.match(next, /\/\/ keep this server/);
    assert.match(
      next,
      /"other": \{ "command": "other" \}, \/\/ keep this server/
    );

    const parsed = parseLooseJsonc(next);
    assert.deepEqual(parsed.context_servers.other, { command: "other" });
    assert.deepEqual(parsed.context_servers["zen-mcp"], SERVER);
  });

  it("adds a missing JSONC key and replaces an inline entry", () => {
    const added = mergeJsonServer(
      '{\n  // servers live here\n  "theme": "dark"\n}\n',
      "mcpServers",
      SERVER
    );
    assert.match(added, /\/\/ servers live here/);
    assert.deepEqual(parseLooseJsonc(added).mcpServers["zen-mcp"], SERVER);

    const replaced = mergeJsonServer(
      '{\n  "servers": {\n    // server list\n    "zen-mcp": { "command": "old" }\n  }\n}\n',
      "servers",
      { type: "stdio", ...SERVER }
    );
    assert.match(replaced, /\/\/ server list/);
    assert.deepEqual(parseLooseJsonc(replaced).servers["zen-mcp"], {
      type: "stdio",
      ...SERVER,
    });

    const inline = mergeJsonServer(
      '{"context_servers": {}}',
      "context_servers",
      SERVER
    );
    assert.deepEqual(JSON.parse(inline).context_servers["zen-mcp"], SERVER);
  });

  it("appends and replaces a TOML server table only", () => {
    const original = [
      "# my codex config",
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
      "[features]",
      "web_search = true",
      "",
    ].join("\n");

    const appended = mergeTomlServer(
      original,
      "mcp_servers.zen-mcp",
      SERVER
    );
    assert.match(appended, /# my codex config/);
    assert.match(appended, /\[mcp_servers\.other\]\ncommand = "other"/);
    assert.match(
      appended,
      /\[mcp_servers\.zen-mcp\]\ncommand = "zen-mcp"\nargs = \["serve"\]/
    );
    assert.match(appended, /\[features\]\nweb_search = true/);

    const replaced = mergeTomlServer(
      appended,
      "mcp_servers.zen-mcp",
      { command: "node", args: ["dist/cli.js"] }
    );
    assert.equal(
      (replaced.match(/\[mcp_servers\.zen-mcp\]/g) ?? []).length,
      1
    );
    assert.match(replaced, /command = "node"\nargs = \["dist\/cli\.js"\]/);
    assert.match(replaced, /\[features\]\nweb_search = true/);
  });

  it("handles quoted TOML table headers", () => {
    const replaced = mergeTomlServer(
      '[mcp_servers."zen-mcp"]\ncommand = "old"\nargs = []\n\n[features]\nx = true\n',
      "mcp_servers.zen-mcp",
      SERVER
    );
    assert.match(replaced, /command = "zen-mcp"\nargs = \["serve"\]/);
    assert.match(replaced, /\[features\]\nx = true/);
  });

  it("lists the supported client ids", () => {
    assert.deepEqual(clientIds(), [
      "claude-code",
      "claude-desktop",
      "cursor",
      "vscode",
      "codex",
      "gemini-cli",
      "windsurf",
      "cline",
      "zed",
    ]);
  });

  it("resolves platform-specific config paths", () => {
    const home = join(tmpdir(), "zen-mcp-home");
    const win = Object.fromEntries(
      catalog({
        home,
        platform: "win32",
        env: { APPDATA: join(home, "AppData", "Roaming") },
      }).map((entry) => [entry.id, entry])
    );
    assert.equal(
      win["claude-desktop"].configPath,
      join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json")
    );
    assert.equal(
      win["vscode"].configPath,
      join(home, "AppData", "Roaming", "Code", "User", "mcp.json")
    );
    assert.equal(
      win["zed"].configPath,
      join(home, "AppData", "Roaming", "Zed", "settings.json")
    );

    const linux = Object.fromEntries(
      catalog({
        home,
        platform: "linux",
        env: { XDG_CONFIG_HOME: join(home, "xdg") },
      }).map((entry) => [entry.id, entry])
    );
    assert.equal(
      linux["vscode"].configPath,
      join(home, "xdg", "Code", "User", "mcp.json")
    );
    assert.equal(
      linux["zed"].configPath,
      join(home, "xdg", "zed", "settings.json")
    );

    const mac = Object.fromEntries(
      catalog({ home, platform: "darwin", env: {} }).map((entry) => [
        entry.id,
        entry,
      ])
    );
    assert.equal(
      mac["claude-desktop"].configPath,
      join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      )
    );
  });

  it("uses CODEX_HOME when it is set", () => {
    const codex = catalog({
      home: join(tmpdir(), "zen-mcp-home"),
      platform: "linux",
      env: { CODEX_HOME: join(tmpdir(), "custom-codex") },
    }).find((entry) => entry.id === "codex");
    assert.equal(
      codex?.configPath,
      join(tmpdir(), "custom-codex", "config.toml")
    );
  });

  describe("applyClient", () => {
    const temp = mkdtempSync(join(tmpdir(), "zen-mcp-onboard-"));
    const context = {
      home: temp,
      platform: "linux" as const,
      env: { XDG_CONFIG_HOME: join(temp, "config") },
      command: "zen-mcp",
    };

    after(() => rmSync(temp, { recursive: true, force: true }));

    it("updates Cursor while keeping other servers", () => {
      const path = join(temp, ".cursor", "mcp.json");
      mkdirSync(join(temp, ".cursor"), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ mcpServers: { other: { command: "other" } } }),
        "utf8"
      );

      const result = applyClient("cursor", context);
      assert.equal(result.status, "ok");
      assert.equal(result.path, path);

      const parsed = JSON.parse(readFileSync(path, "utf8"));
      assert.deepEqual(parsed.mcpServers.other, { command: "other" });
      assert.deepEqual(parsed.mcpServers["zen-mcp"], SERVER);
    });

    it("writes the VS Code stdio server shape", () => {
      const result = applyClient("vscode", context);
      assert.equal(result.status, "ok");

      const parsed = JSON.parse(readFileSync(result.path, "utf8"));
      assert.deepEqual(parsed.servers["zen-mcp"], {
        type: "stdio",
        ...SERVER,
      });
    });

    it("writes the Zed context server shape", () => {
      const result = applyClient("zed", context);
      assert.equal(result.status, "ok");

      const parsed = JSON.parse(readFileSync(result.path, "utf8"));
      assert.deepEqual(parsed.context_servers["zen-mcp"], SERVER);
    });

    it("writes a Codex TOML table", () => {
      mkdirSync(join(temp, ".codex"), { recursive: true });
      const path = join(temp, ".codex", "config.toml");
      writeFileSync(path, '[features]\nweb_search = true\n', "utf8");

      const result = applyClient("codex", context);
      assert.equal(result.status, "ok");

      const text = readFileSync(path, "utf8");
      assert.match(
        text,
        /\[mcp_servers\.zen-mcp\]\ncommand = "zen-mcp"\nargs = \["serve"\]/
      );
      assert.match(text, /\[features\]\nweb_search = true/);
    });

    it("reports unknown clients and leaves a broken file alone", () => {
      assert.equal(applyClient("nope", context).status, "failed");

      const path = join(temp, ".gemini", "settings.json");
      mkdirSync(join(temp, ".gemini"), { recursive: true });
      writeFileSync(path, "{ nope", "utf8");
      const result = applyClient("gemini-cli", context);
      assert.equal(result.status, "failed");
      assert.equal(readFileSync(path, "utf8"), "{ nope");
    });
  });

  it("prints a paste-ready runbook for other clients", () => {
    const prompt = agentSetupPrompt("node /opt/zen/dist/cli.js", {
      home: "C:\\Users\\test",
      platform: "win32",
      env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
    });
    assert.match(prompt, /Name: zen-mcp/);
    assert.match(prompt, /Command: node \/opt\/zen\/dist\/cli\.js/);
    assert.match(prompt, /Arguments: \["serve"\]/);
    assert.match(prompt, /Do not ask me to run any of these commands/);
    assert.match(prompt, /%USERPROFILE%\\\.claude\.json/);
    assert.match(prompt, /%APPDATA%\\Claude\\claude_desktop_config\.json/);
    assert.match(prompt, /mcp_servers\.zen-mcp/);
    assert.match(prompt, /Preserve every existing server/);
    assert.match(prompt, /exactly one `zen-mcp`/);
    assert.match(prompt, /Allow this session/);
    assert.ok(!prompt.includes("C:\\Users\\test"));
    assert.doesNotMatch(prompt, /—/);
  });

  it("uses home-relative placeholders on POSIX", () => {
    const prompt = agentSetupPrompt("zen-mcp", {
      home: "/home/test",
      platform: "linux",
      env: {},
    });
    assert.match(prompt, /~\/\.claude\.json/);
    assert.match(prompt, /~\/\.config\/Claude\/claude_desktop_config\.json/);
    assert.ok(!prompt.includes("/home/test"));

    const xdg = agentSetupPrompt("zen-mcp", {
      home: "/home/test",
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/home/test/xdg" },
    });
    assert.match(
      xdg,
      /\$XDG_CONFIG_HOME\/Claude\/claude_desktop_config\.json/
    );
    assert.ok(!xdg.includes("/home/test"));
  });
});

describe("onboard picker", () => {
  const client = (
    id: string,
    overrides: { detected?: boolean; popular?: boolean } = {}
  ) => ({
    id,
    label: id,
    detail: "",
    popular: overrides.popular ?? false,
    detected: overrides.detected ?? false,
    configPath: "",
    format: "json" as const,
  });

  it("preselects detected clients when any are found", () => {
    const options = buildOptions([
      client("a", { detected: true, popular: true }),
      client("b", { popular: true }),
      client("c", { detected: true }),
    ]);
    assert.deepEqual(
      options.filter((option) => option.selected).map((option) => option.id),
      ["a", "c"]
    );
    assert.equal(options.at(-1)?.id, "other");
    assert.equal(options.at(-1)?.selected, false);
  });

  it("checks nothing when nothing is detected", () => {
    const options = buildOptions([
      client("a", { popular: true }),
      client("b"),
    ]);
    assert.deepEqual(
      options.filter((option) => option.selected).map((option) => option.id),
      []
    );
  });

  it("wraps the cursor and toggles every client but not Other", () => {
    const options = buildOptions([client("a"), client("b")]);
    assert.equal(moveCursor(options, 0, -1), options.length - 1);
    assert.equal(moveCursor(options, options.length - 1, 1), 0);

    const all = toggleAll(options, true);
    assert.ok(all.filter((option) => !option.other).every((option) => option.selected));
    assert.equal(all.at(-1)?.selected, false);
  });

  it("reports clients and Other separately", () => {
    const options = buildOptions([client("a")]).map((option) =>
      option.id === "a" || option.other ? { ...option, selected: true } : option
    );
    assert.deepEqual(pickerResult(options), { selected: ["a"], other: true });
  });

  it("renders, toggles and confirms from keypress events", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const options = buildOptions([
      client("first", { detected: true }),
      client("second"),
    ]);

    const pending = pickClients(options, {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    input.emit("keypress", undefined, key("down"));
    input.emit("keypress", " ", key("space"));
    input.emit("keypress", undefined, key("return"));

    const result = await pending;
    assert.deepEqual(result, { selected: ["first", "second"], other: false });
    const plain = output.text.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain, /ZEN MCP/);
    assert.match(plain, /\[●\] first/);
    assert.match(plain, /Selection confirmed/);
    assert.equal(input.raw, false);
  });
});

class FakeInput extends EventEmitter {
  isTTY = true;
  raw = true;

  setRawMode(value: boolean): this {
    this.raw = value;
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }
}

class FakeOutput {
  isTTY = true;
  text = "";

  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

function key(name: string) {
  return { name, ctrl: false, meta: false, shift: false };
}

function parseLooseJsonc(text: string): Record<string, any> {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(stripped);
}
