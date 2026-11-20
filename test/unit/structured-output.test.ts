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

const TOOL_COUNT = 55;
const NO_OUTPUT_SCHEMA = new Set(["zen_tools_use"]);

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
    toolSurface: "full",
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
        [...Object.keys(TOOL_OUTPUT_SCHEMAS), ...NO_OUTPUT_SCHEMA].sort(),
        "every registered tool needs an output schema or a documented exemption"
      );

      for (const tool of tools) {
        if (NO_OUTPUT_SCHEMA.has(tool.name)) {
          assert.equal(
            tool.outputSchema,
            undefined,
            `${tool.name} proxies another tool and must not declare a fixed output schema`
          );
          continue;
        }
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

  it("omits redundant schema boilerplate from tools/list", async () => {
    const harness = await createHarness();
    try {
      const { tools } = await harness.client.listTools();
      const walk = (node: unknown, path: string): void => {
        if (Array.isArray(node)) {
          node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
          return;
        }
        if (!node || typeof node !== "object") return;
        const record = node as Record<string, unknown>;
        assert.equal(record.$schema, undefined, `${path} repeats $schema`);
        const additional = record.additionalProperties;
        if (additional && typeof additional === "object") {
          assert.notEqual(
            Object.keys(additional).length,
            0,
            `${path} keeps the default additionalProperties`
          );
        }
        for (const [key, value] of Object.entries(record)) {
          walk(value, `${path}.${key}`);
        }
      };
      for (const tool of tools) {
        walk(tool.inputSchema, `${tool.name}.inputSchema`);
        walk(tool.outputSchema, `${tool.name}.outputSchema`);
      }
      const readPage = tools.find((tool) => tool.name === "zen_read_page");
      assert.ok(
        readPage?.outputSchema?.properties?.semantic,
        "compaction must keep the declared semantic contract"
      );
    } finally {
      await harness.close();
    }
  });

  it("offers snapshot on zen_read_page only", async () => {
    const harness = await createHarness();
    try {
      const { tools } = await harness.client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const readPage = byName.get("zen_read_page");
      assert.ok(readPage, "zen_read_page is registered");
      const single = readPage.inputSchema.properties?.format as
        | { enum?: string[] }
        | undefined;
      assert.ok(single?.enum?.includes("snapshot"));
      assert.ok(single?.enum?.includes("interactive"));
      assert.ok(
        readPage.outputSchema?.properties?.snapshotId,
        "snapshot fields are declared in the output schema"
      );
      assert.ok(readPage.outputSchema?.properties?.limitations);

      const readPages = byName.get("zen_read_pages");
      assert.ok(readPages, "zen_read_pages is registered");
      const batch = readPages.inputSchema.properties?.format as
        | { enum?: string[] }
        | undefined;
      assert.ok(batch?.enum?.includes("interactive"));
      assert.equal(batch?.enum?.includes("snapshot"), false);
    } finally {
      await harness.close();
    }
  });

  it("keeps lean region and element fields optional in the contract", async () => {
    const harness = await createHarness();
    try {
      const { tools } = await harness.client.listTools();
      const readPage = tools.find((tool) => tool.name === "zen_read_page");
      const properties = readPage?.outputSchema?.properties as
        | Record<string, any>
        | undefined;
      assert.ok(properties, "zen_read_page declares an output schema");
      const region = properties.semantic?.properties?.regions?.items;
      assert.ok(region, "regions are declared");
      const requiredRegions = new Set<string>(region.required ?? []);
      for (const key of ["label", "ref", "controls", "links", "items"]) {
        assert.equal(
          requiredRegions.has(key),
          false,
          `${key} must stay optional so lean output validates`
        );
      }
      const element = properties.elements?.items;
      assert.ok(element, "elements are declared");
      assert.equal(
        new Set<string>(element.required ?? []).has("value"),
        false,
        "value must stay optional for snapshot and semantic reads"
      );
    } finally {
      await harness.close();
    }
  });

  it("declares the action target, effect, delta and error fields the runtime returns", () => {
    const effect = {
      changed: true,
      urlChanged: false,
      titleChanged: false,
      domChanged: true,
      valueChanged: false,
      waitedMs: 420,
      readyState: "complete",
      attribution: "observed_after_action_not_proven",
      delta: {
        addedControls: [{ role: "button", name: "Save", type: null }],
        removedControls: [],
        changedControls: [
          {
            role: "checkbox",
            name: "Notify",
            type: "checkbox",
            changes: ["checked"],
          },
        ],
        addedHeadings: ["Saved"],
        removedHeadings: [],
        addedAlerts: [],
        removedAlerts: [],
        textChanged: true,
        textLengthDelta: 12,
        readyState: "complete",
      },
    };
    const success = {
      clicked: true,
      tabId: "tab-1",
      url: "https://example.com/",
      title: "Example",
      target: {
        tag: "button",
        role: "button",
        label: "Save",
        type: null,
        sensitive: false,
      },
      effect,
    };
    assert.equal(
      TOOL_OUTPUT_SCHEMAS.zen_click.safeParse(success).success,
      true,
      "a success result with a full effect must validate"
    );

    const probeFailed = {
      changed: false,
      urlChanged: false,
      titleChanged: false,
      domChanged: false,
      valueChanged: false,
      waitedMs: 16,
      probeFailed: true,
    };
    assert.equal(
      TOOL_OUTPUT_SCHEMAS.zen_click.safeParse({ ...success, effect: probeFailed })
        .success,
      true,
      "a probe failure omits attribution, delta and readyState"
    );

    const failure = {
      error: {
        code: "stale_reference",
        message: "Ref e9 is stale (stale_reference)",
        category: "stale_reference",
        retryable: false,
        stateChanged: false,
        recovery: 'Call zen_read_page with format="snapshot" and use a new ref.',
        details: { ref: "e9" },
      },
    };
    assert.equal(
      TOOL_OUTPUT_SCHEMAS.zen_click.safeParse(failure).success,
      true,
      "a structured error must validate"
    );
  });

  it("mirrors the text block in structuredContent for local tools", async () => {
    const harness = await createHarness();
    try {
      const config = await callTool(harness.client, "zen_config");
      assert.equal(config.isError, undefined);
      const configStructured = structuredOf(config);
      const configText = textOf(config);
      assert.deepEqual(
        configStructured,
        JSON.parse(configText),
        "zen_config structuredContent must match the text block"
      );
      assert.equal(
        configText,
        JSON.stringify(configStructured),
        "the text block is compact JSON with no indentation"
      );
      assert.ok(!configText.includes("\n"), "a payload is a single line");
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
