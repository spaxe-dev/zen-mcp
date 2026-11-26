import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CONFIG, type ZenMcpConfig } from "../../src/config.js";
import { toolsForSurface } from "../../src/mcp/catalog.js";
import { createZenMcpServer } from "../../src/mcp/server.js";
import { ZenRuntime } from "../../src/zen/runtime.js";
import {
  fullPolicySnapshot,
  legacyPolicySnapshot,
} from "./policy-fixtures.js";

interface Harness {
  client: Client;
  close: () => Promise<void>;
}

async function createHarness(overrides: Partial<ZenMcpConfig> = {}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "zen-mcp-discovery-"));
  const config: ZenMcpConfig = {
    ...DEFAULT_CONFIG,
    auditLog: false,
    autoLaunch: false,
    dataDir,
    ...overrides,
  };
  const runtime = new ZenRuntime({ config });
  const policy =
    overrides.readOnly || (overrides.allowedDomains?.length ?? 0) > 0
      ? legacyPolicySnapshot({
          readOnly: overrides.readOnly,
          allowedDomains: overrides.allowedDomains,
        })
      : fullPolicySnapshot();
  const server = createZenMcpServer(runtime, config, policy);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "zen-mcp-discovery-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
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

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  assert.ok("content" in result, `${name} returned no content`);
  return result as unknown as ToolResult;
}

function textOf(result: ToolResult): string {
  return String(result.content[0]?.text ?? "");
}

function jsonOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

describe("discovery gateway", () => {
  it("exposes only the default research surface", async () => {
    const harness = await createHarness();
    try {
      const { tools } = await harness.client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [...toolsForSurface("research")].sort());
      assert.equal(names.includes("zen_tabs_audit"), false);
      assert.ok(names.includes("zen_tools_search"));
      assert.ok(names.includes("zen_tools_use"));
    } finally {
      await harness.close();
    }
  });

  it("searches hidden tools and returns their input schema on demand", async () => {
    const harness = await createHarness();
    try {
      const search = jsonOf(
        await call(harness.client, "zen_tools_search", { query: "audit" })
      );
      const tools = search.tools as Array<Record<string, unknown>>;
      const audit = tools.find((tool) => tool.name === "zen_tabs_audit");
      assert.ok(audit, "expected zen_tabs_audit in search results");
      assert.equal(audit.exposed, false);
      assert.equal(audit.mutating, false);
      assert.deepEqual(audit.surfaces, ["core", "full"]);

      const described = jsonOf(
        await call(harness.client, "zen_tools_search", { name: "zen_tabs_audit" })
      );
      const tool = described.tool as Record<string, unknown>;
      assert.equal(tool.name, "zen_tabs_audit");
      assert.equal(tool.exposed, false);
      assert.equal((tool.inputSchema as Record<string, unknown>).type, "object");
    } finally {
      await harness.close();
    }
  });

  it("invokes a hidden tool through the gateway with its normal result", async () => {
    const harness = await createHarness();
    try {
      const result = await call(harness.client, "zen_tools_use", {
        tool: "zen_tabs_audit",
        arguments: {},
      });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Zen is not running/);
    } finally {
      await harness.close();
    }
  });

  it("keeps read-only policy on the target tool, not the gateway", async () => {
    const harness = await createHarness({ readOnly: true });
    try {
      const blocked = await call(harness.client, "zen_tools_use", {
        tool: "zen_tabs_open",
        arguments: { urls: ["https://example.com"] },
      });
      assert.equal(blocked.isError, true);
      assert.match(textOf(blocked), /\(restricted\)/);

      const allowed = await call(harness.client, "zen_tools_use", {
        tool: "zen_tabs_audit",
        arguments: {},
      });
      assert.match(textOf(allowed), /Zen is not running/);
    } finally {
      await harness.close();
    }
  });

  it("keeps the domain allowlist on the target tool", async () => {
    const harness = await createHarness({ allowedDomains: ["example.com"] });
    try {
      const blocked = await call(harness.client, "zen_tools_use", {
        tool: "zen_tabs_open",
        arguments: { urls: ["https://not-example.test/page"] },
      });
      assert.equal(blocked.isError, true);
      assert.match(textOf(blocked), /\(site_default_denied\)/);
    } finally {
      await harness.close();
    }
  });

  it("rejects unknown tools and invalid arguments", async () => {
    const harness = await createHarness();
    try {
      const unknown = jsonOf(
        await call(harness.client, "zen_tools_use", { tool: "zen_missing" })
      );
      assert.equal(unknown.code, "invalid_args");

      const invalid = jsonOf(
        await call(harness.client, "zen_tools_use", {
          tool: "zen_space_create",
          arguments: {},
        })
      );
      assert.equal(invalid.code, "invalid_args");
      assert.match(String(invalid.message), /name/);

      const self = jsonOf(
        await call(harness.client, "zen_tools_use", { tool: "zen_tools_use" })
      );
      assert.equal(self.code, "invalid_args");
    } finally {
      await harness.close();
    }
  });

  it("publishes a tool for direct calls and audits the target name", async () => {
    const harness = await createHarness({ auditLog: true });
    try {
      await call(harness.client, "zen_tools_use", {
        tool: "zen_tabs_audit",
        arguments: {},
      });

      const published = await call(harness.client, "zen_tools_use", {
        tool: "zen_audit_tail",
        arguments: { limit: 10 },
        publish: true,
      });
      assert.equal(published.isError, undefined);

      const afterPublish = await harness.client.listTools();
      const names = afterPublish.tools.map((tool) => tool.name);
      assert.ok(names.includes("zen_audit_tail"));

      const direct = await call(harness.client, "zen_audit_tail", { limit: 10 });
      assert.equal(direct.isError, undefined);
      const entries = (direct.structuredContent as { entries: Array<Record<string, unknown>> })
        .entries;
      assert.ok(
        entries.some((entry) => entry.tool === "zen_tabs_audit"),
        "the gateway must audit the target tool name"
      );
    } finally {
      await harness.close();
    }
  });
});
