import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { MUTATING_TOOLS } from "../../src/mcp/guard.js";
import { createZenMcpServer } from "../../src/mcp/server.js";
import { ZenRuntime } from "../../src/zen/runtime.js";

/**
 * Tools that may implicitly launch Zen when autoLaunch is on. They do not
 * change browser state, so read-only mode keeps them available (read-only also
 * disables auto-launch), but their hint must not claim to be read-only.
 */
const AUTO_LAUNCH_TOOLS = new Set([
  "zen_status",
  "zen_spaces_list",
  "zen_tabs_list",
  "zen_containers_list",
  "zen_folders_list",
  "zen_history_search",
  "zen_history_recently_closed",
  "zen_bookmarks_search",
  "zen_read_page",
  "zen_read_pages",
  "zen_find_text",
  "zen_search_tabs",
  "zen_tabs_audit",
]);

const EXEMPT_TOOLS = new Set(AUTO_LAUNCH_TOOLS);

async function registeredTools() {
  const config = {
    ...DEFAULT_CONFIG,
    auditLog: false,
    autoLaunch: false,
  };
  const runtime = new ZenRuntime({ config });
  const server = createZenMcpServer(runtime, config);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "zen-mcp-policy-test",
    version: "0.0.0",
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.listTools();
    return result.tools;
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

describe("tool policy", () => {
  it("keeps read-only hints in sync with MUTATING_TOOLS", async () => {
    const tools = await registeredTools();
    const names = new Set(tools.map((tool) => tool.name));

    for (const name of MUTATING_TOOLS) {
      assert.ok(
        names.has(name),
        `${name} is in MUTATING_TOOLS but no tool is registered with that name`
      );
    }

    for (const tool of tools) {
      const readOnlyHint = tool.annotations?.readOnlyHint;
      if (MUTATING_TOOLS.has(tool.name)) {
        assert.equal(
          readOnlyHint,
          false,
          `${tool.name} is blocked in read-only mode but is not marked readOnlyHint:false`
        );
      } else if (readOnlyHint === false) {
        assert.ok(
          EXEMPT_TOOLS.has(tool.name),
          `${tool.name} claims to change state but is missing from MUTATING_TOOLS`
        );
      }
    }

    for (const name of EXEMPT_TOOLS) {
      assert.ok(names.has(name), `${name} is exempt but not registered`);
      assert.equal(
        MUTATING_TOOLS.has(name),
        false,
        `${name} is exempt and must stay available in read-only mode`
      );
    }
  });

  it("caps tab id arrays in the tool schemas", async () => {
    const tools = await registeredTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of [
      "zen_tabs_close",
      "zen_folder_create",
      "zen_folder_add_tabs",
    ]) {
      const schema = byName.get(name)?.inputSchema as
        | { properties?: { tabIds?: { maxItems?: number } } }
        | undefined;
      assert.equal(
        schema?.properties?.tabIds?.maxItems,
        100,
        `${name} must cap tabIds at 100`
      );
    }
  });
});
