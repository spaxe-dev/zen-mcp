import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CONFIG, type ZenMcpConfig } from "../../src/config.js";
import { TOOL_OUTPUT_SCHEMAS } from "../../src/mcp/output-schemas.js";
import { createZenMcpServer } from "../../src/mcp/server.js";
import { ZenRuntime } from "../../src/zen/runtime.js";

const TOOL_COUNT = 53;

interface Harness {
  client: Client;
  runtime: ZenRuntime;
  close: () => Promise<void>;
}

/**
 * Wires a server and client over InMemoryTransport. The data directory is a
 * throwaway temp dir so session and template reads stay independent from the
 * developer's real Zen MCP data.
 */
async function createHarness(
  overrides: Partial<ZenMcpConfig> = {}
): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "zen-mcp-structured-"));
  const config: ZenMcpConfig = {
    ...DEFAULT_CONFIG,
    auditLog: false,
    autoLaunch: false,
    dataDir,
    ...overrides,
  };
  const runtime = new ZenRuntime({ config });
  const server = createZenMcpServer(runtime, config);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "zen-mcp-structured-output-test",
    version: "0.0.0",
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    runtime,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await runtime.shutdown().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Calls a tool and narrows the SDK result union (which also allows the legacy
 * `toolResult` shape) to the content form every Zen tool returns.
 */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  assert.ok("content" in result, `${name} returned no content`);
  return result as unknown as ToolResult;
}

/** The text block `guarded` always returns first. */
function textOf(result: ToolResult): string {
  const first = result.content[0];
  assert.ok(first, "expected at least one content block");
  assert.equal(first.type, "text");
  return String(first.text);
}

/** structuredContent is loosely typed by the SDK, so read it by key. */
function structuredOf(result: ToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("structured tool results", () => {
  it("declares an output schema for every tool", async () => {
    const harness = await createHarness();
    try {
      const { tools } = await harness.client.listTools();

      assert.equal(
        tools.length,
        TOOL_COUNT,
        `expected ${TOOL_COUNT} registered tools, found ${tools.length}`
      );
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        Object.keys(TOOL_OUTPUT_SCHEMAS).sort(),
        "every registered tool needs an entry in TOOL_OUTPUT_SCHEMAS"
      );

      for (const tool of tools) {
        assert.ok(tool.outputSchema, `${tool.name} has no outputSchema`);
        assert.equal(
          tool.outputSchema.type,
          "object",
          `${tool.name} outputSchema must describe an object`
        );
        const properties = tool.outputSchema.properties;
        assert.ok(
          properties && Object.keys(properties).length > 0,
          `${tool.name} outputSchema must not be empty`
        );
      }
    } finally {
      await harness.close();
    }
  });

  it("mirrors the text block in structuredContent for local tools", async () => {
    const harness = await createHarness();
    try {
      const config = await callTool(harness.client, "zen_config");
      assert.equal(config.isError, undefined);
      const configStructured = structuredOf(config);
      assert.deepEqual(
        configStructured,
        JSON.parse(textOf(config)),
        "zen_config structuredContent must match the text block"
      );
      assert.equal(configStructured.readOnly, false);

      const watches = await callTool(harness.client, "zen_watch_list");
      assert.equal(watches.isError, undefined);
      const watchesStructured = structuredOf(watches);
      assert.deepEqual(
        watchesStructured,
        JSON.parse(textOf(watches)),
        "zen_watch_list structuredContent must match the text block"
      );
      assert.deepEqual(watchesStructured.watches, []);
    } finally {
      await harness.close();
    }
  });

  it("returns policy errors without structuredContent", async () => {
    const harness = await createHarness({ readOnly: true });
    try {
      const result = await callTool(harness.client, "zen_space_create", {
        name: "blocked-space",
      });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.match(textOf(result), /read-only mode/);
    } finally {
      await harness.close();
    }
  });

  it("returns paused and handler errors without structuredContent", async () => {
    const harness = await createHarness();
    try {
      harness.runtime.hub.grantAccess();
      harness.runtime.hub.pause("structured output test");
      assert.equal(harness.runtime.paused, true);

      const paused = await callTool(harness.client, "zen_status");
      assert.equal(paused.isError, true);
      assert.equal(paused.structuredContent, undefined);
      assert.match(textOf(paused), /paused/);

      harness.runtime.hub.resume();
      assert.equal(harness.runtime.paused, false);

      const thrown = await callTool(harness.client, "zen_glance");
      assert.equal(thrown.isError, true);
      assert.equal(thrown.structuredContent, undefined);
      assert.match(textOf(thrown), /url or a tabId/);
    } finally {
      await harness.close();
    }
  });
});
