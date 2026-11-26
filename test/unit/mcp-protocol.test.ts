import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  LoggingMessageNotificationSchema,
  ResourceListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_CONFIG, type ZenMcpConfig } from "../../src/config.js";
import { createZenMcpServer } from "../../src/mcp/server.js";
import { ZenRuntime } from "../../src/zen/runtime.js";
import {
  fullPolicySnapshot,
  legacyPolicySnapshot,
} from "./policy-fixtures.js";

interface Harness {
  client: Client;
  server: McpServer;
  runtime: ZenRuntime;
  dataDir: string;
  close: () => Promise<void>;
}

async function createHarness(
  overrides: Partial<ZenMcpConfig> = {}
): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "zen-mcp-protocol-"));
  const config: ZenMcpConfig = {
    ...DEFAULT_CONFIG,
    auditLog: false,
    autoLaunch: false,
    dataDir,
    toolSurface: "full",
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
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "zen-mcp-protocol-test",
    version: "0.0.0",
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    runtime,
    dataDir,
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

async function callTool(
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

/** Tools are invoked directly with a fabricated extra to avoid transport races. */
type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;

function toolHandler(server: McpServer, name: string): Handler {
  const internals = server as unknown as {
    _registeredTools: Record<string, { handler: Handler }>;
  };
  const tool = internals._registeredTools[name];
  assert.ok(tool, `${name} is not registered`);
  return tool.handler;
}

interface SentNotification {
  method: string;
  params?: Record<string, unknown>;
}

function fabricatedExtra(options: {
  token?: string | number;
  signal?: AbortSignal;
  sent?: SentNotification[];
} = {}): unknown {
  const extra: {
    signal: AbortSignal;
    _meta?: { progressToken: string | number };
    sendNotification: (notification: SentNotification) => Promise<void>;
  } = {
    signal: options.signal ?? new AbortController().signal,
    sendNotification: async (notification) => {
      options.sent?.push(notification);
    },
  };
  if (options.token !== undefined) {
    extra._meta = { progressToken: options.token };
  }
  return extra;
}

function pageFor(tabId: string): unknown {
  return {
    tabId,
    url: `https://example.com/${tabId}`,
    title: `Page ${tabId}`,
    text: `text ${tabId}`,
    format: "text",
  };
}

/** Stops the runtime from reaching for a browser and lets readTab be stubbed. */
function stubReads(
  runtime: ZenRuntime,
  readTab: (params: { tabId: string }) => Promise<unknown>
): void {
  const internal = runtime as unknown as {
    connect: () => Promise<void>;
    hub: { readTab: (params: { tabId: string }) => Promise<unknown> };
  };
  internal.connect = async () => undefined;
  internal.hub.readTab = readTab;
}

function settle(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("audit preflight", () => {
  it("writes a durable request record before returning the tool outcome", async () => {
    const harness = await createHarness({ auditLog: true });
    try {
      const result = await callTool(harness.client, "zen_audit_tail", {
        limit: 1,
      });
      assert.equal(result.isError, undefined);
      const entries = readFileSync(join(harness.dataDir, "audit.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { phase?: string; executed: boolean });
      assert.deepEqual(
        entries.map((entry) => entry.phase),
        ["started", "completed"]
      );
      assert.equal(entries[1]?.executed, true);
    } finally {
      await harness.close();
    }
  });

  it("does not invoke a browser handler when the start record cannot be written", async () => {
    const blocker = join(tmpdir(), `zen-mcp-audit-blocker-${process.pid}`);
    writeFileSync(blocker, "not a directory", "utf8");
    const harness = await createHarness({
      auditLog: true,
      dataDir: join(blocker, "audit"),
    });
    let invoked = false;
    (harness.runtime as unknown as { status: () => unknown }).status = () => {
      invoked = true;
      return { ok: true };
    };
    try {
      const result = await callTool(harness.client, "zen_status");
      assert.equal(result.isError, true);
      assert.match(textOf(result), /audit log could not record/i);
      assert.equal(invoked, false);
    } finally {
      await harness.close();
      rmSync(blocker, { force: true });
    }
  });
});

describe("audit execution truthfulness", () => {
  it("never reports executed:false for a started operation after cancellation", async () => {
    const harness = await createHarness({ auditLog: true });
    try {
      const handler = toolHandler(harness.server, "zen_space_create");
      const runtime = harness.runtime as unknown as {
        connect: () => Promise<void>;
        hub: { createSpace: () => Promise<unknown> };
      };
      runtime.connect = async () => undefined;
      let release!: (value: unknown) => void;
      runtime.hub.createSpace = () =>
        new Promise((resolve) => {
          release = resolve;
        });
      const controller = new AbortController();
      const pending = handler(
        { name: "Audit test" },
        fabricatedExtra({ signal: controller.signal })
      );
      await settle(20);
      controller.abort();
      const result = await pending;
      assert.equal(result.isError, true);

      const entries = readFileSync(join(harness.dataDir, "audit.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const started = entries.find((entry) => entry.phase === "started");
      const abandoned = entries.find((entry) => entry.phase === "abandoned");
      assert.ok(started);
      assert.ok(abandoned);
      assert.equal(started.executed, false);
      assert.equal(abandoned.executed, true);
      assert.equal(abandoned.execution, "outcome_unknown");
      assert.equal(abandoned.mutation, "unknown");
      assert.equal(abandoned.operationId, started.operationId);

      release({
        created: true,
        space: { id: "space-x", name: "Audit test", active: false, index: 1 },
        activeSpaceId: null,
        switched: false,
      });
      await settle(25);
      const settled = readFileSync(join(harness.dataDir, "audit.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.phase === "settled");
      assert.ok(settled);
      assert.equal(settled.executed, true);
      assert.equal(settled.operationId, started.operationId);
    } finally {
      await harness.close();
    }
  });
});

describe("progress notifications", () => {
  it("reports start and finish for a single page read", async () => {
    const harness = await createHarness();
    try {
      stubReads(harness.runtime, async (params) => pageFor(params.tabId));
      const sent: SentNotification[] = [];
      const handler = toolHandler(harness.server, "zen_read_page");

      const result = await handler(
        { tabId: "tab-one" },
        fabricatedExtra({ token: "token-1", sent })
      );

      assert.equal(result.isError, undefined);
      assert.deepEqual(
        sent.map((notification) => notification.params),
        [
          {
            progressToken: "token-1",
            progress: 1,
            total: 2,
            message: "reading page",
          },
          {
            progressToken: "token-1",
            progress: 2,
            total: 2,
            message: "page read",
          },
        ]
      );
    } finally {
      await harness.close();
    }
  });

  it("reports one notification per finished tab", async () => {
    const harness = await createHarness();
    try {
      stubReads(harness.runtime, async (params) => pageFor(params.tabId));
      const sent: SentNotification[] = [];
      const handler = toolHandler(harness.server, "zen_read_pages");

      const result = await handler(
        { tabIds: ["a", "b", "c"] },
        fabricatedExtra({ token: 7, sent })
      );

      assert.equal(result.isError, undefined);
      assert.equal(sent.length, 3);
      assert.deepEqual(
        sent.map((notification) => notification.params?.progress),
        [1, 2, 3]
      );
      assert.deepEqual(
        sent.map((notification) => notification.params?.total),
        [3, 3, 3]
      );
      assert.deepEqual(
        sent.map((notification) => notification.params?.progressToken),
        [7, 7, 7]
      );
      assert.equal(sent[0].params?.message, "read 1 of 3 pages");
    } finally {
      await harness.close();
    }
  });

  it("sends nothing when the client omits a progress token", async () => {
    const harness = await createHarness();
    try {
      stubReads(harness.runtime, async (params) => pageFor(params.tabId));
      const sent: SentNotification[] = [];
      const handler = toolHandler(harness.server, "zen_read_page");

      const result = await handler(
        { tabId: "tab-one" },
        fabricatedExtra({ sent })
      );

      assert.equal(result.isError, undefined);
      assert.deepEqual(sent, []);
    } finally {
      await harness.close();
    }
  });
});

describe("cancellation", () => {
  it("returns a cancellation error when the signal aborts mid-request", async () => {
    const harness = await createHarness();
    try {
      const controller = new AbortController();
      let markStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let finishRead: (value: unknown) => void = () => undefined;
      stubReads(
        harness.runtime,
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
            markStarted();
          })
      );
      const handler = toolHandler(harness.server, "zen_read_page");

      const pending = handler(
        { tabId: "tab-one" },
        fabricatedExtra({ signal: controller.signal, token: "token-1" })
      );
      await started;
      controller.abort();
      const result = await pending;
      finishRead(pageFor("tab-one"));

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.match(textOf(result), /cancelled/);
    } finally {
      await harness.close();
    }
  });

  it("never calls the handler when the signal is already aborted", async () => {
    const harness = await createHarness();
    try {
      let calls = 0;
      stubReads(harness.runtime, async (params) => {
        calls += 1;
        return pageFor(params.tabId);
      });
      const sent: SentNotification[] = [];
      const handler = toolHandler(harness.server, "zen_read_page");

      const result = await handler(
        { tabId: "tab-one" },
        fabricatedExtra({ signal: AbortSignal.abort(), token: "token-1", sent })
      );

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.match(textOf(result), /cancelled/);
      assert.equal(calls, 0, "handler must not run for an aborted request");
      assert.deepEqual(sent, []);
    } finally {
      await harness.close();
    }
  });
});

describe("client logging", () => {
  it("sanitizes URLs and never includes arguments or page text", async () => {
    const harness = await createHarness();
    try {
      const logs: Array<Record<string, unknown>> = [];
      harness.client.setNotificationHandler(
        LoggingMessageNotificationSchema,
        (notification) => {
          logs.push(notification.params as unknown as Record<string, unknown>);
        }
      );
      stubReads(harness.runtime, async () => {
        throw new Error("cannot read https://internal.example/secret?token=abc");
      });

      const result = await callTool(harness.client, "zen_read_page", {
        tabId: "tab-secret",
      });
      assert.equal(result.isError, true);
      await settle();

      assert.ok(logs.length >= 1, "expected a logging notification");
      const data = logs.map((entry) => String(entry.data)).join("\n");
      assert.match(data, /zen_read_page \(error\)/);
      assert.match(data, /\[redacted-url\]/);
      assert.doesNotMatch(data, /internal\.example/);
      assert.doesNotMatch(data, /tab-secret/);
      assert.doesNotMatch(data, /secret\?token/);
    } finally {
      await harness.close();
    }
  });

  it("logs policy refusals without leaking tool arguments", async () => {
    const harness = await createHarness({ readOnly: true });
    try {
      const logs: Array<Record<string, unknown>> = [];
      harness.client.setNotificationHandler(
        LoggingMessageNotificationSchema,
        (notification) => {
          logs.push(notification.params as unknown as Record<string, unknown>);
        }
      );

      const result = await callTool(harness.client, "zen_space_create", {
        name: "do-not-log-this",
      });
      assert.equal(result.isError, true);
      await settle();

      assert.ok(logs.length >= 1, "expected a logging notification");
      const data = logs.map((entry) => String(entry.data)).join("\n");
      assert.match(data, /zen_space_create \(restricted\)/);
      assert.doesNotMatch(data, /do-not-log-this/);
    } finally {
      await harness.close();
    }
  });
});

describe("resources", () => {
  it("gives every JSON resource a title", async () => {
    const harness = await createHarness();
    try {
      const { resources } = await harness.client.listResources();
      const titles = Object.fromEntries(
        resources.map((resource) => [resource.uri, resource.title])
      );

      assert.deepEqual(titles, {
        "zen://status": "Zen status",
        "zen://spaces": "Zen spaces",
        "zen://tabs": "Zen tabs",
        "zen://questions": "Open questions",
        "zen://watches": "Page watches",
        "zen://capabilities": "Zen capabilities",
      });
    } finally {
      await harness.close();
    }
  });

  it("returns resource payloads as compact JSON", async () => {
    const harness = await createHarness();
    try {
      const read = await harness.client.readResource({
        uri: "zen://capabilities",
      });
      const first = read.contents?.[0];
      const text = first && "text" in first ? first.text : "";
      assert.ok(text.length > 0);
      assert.equal(text, JSON.stringify(JSON.parse(text)));
      assert.ok(!text.includes("\n"), "resource text is a single line");
    } finally {
      await harness.close();
    }
  });

  it("announces list changes after a resource-changing tool succeeds", async () => {
    const harness = await createHarness();
    try {
      let changes = 0;
      harness.client.setNotificationHandler(
        ResourceListChangedNotificationSchema,
        () => {
          changes += 1;
        }
      );
      const internal = harness.runtime as unknown as {
        connect: () => Promise<void>;
        hub: { switchSpace: (params: { space: string }) => Promise<unknown> };
      };
      internal.connect = async () => undefined;
      internal.hub.switchSpace = async () => ({
        space: {
          id: "space-1",
          name: "Space 1",
          icon: null,
          active: true,
          index: 0,
          containerTabId: 1,
        },
        activeSpaceId: "space-1",
      });

      const result = await callTool(harness.client, "zen_space_switch", {
        space: "Space 1",
      });
      assert.equal(result.isError, undefined);
      await settle();

      assert.ok(changes >= 1, "expected a resources/list_changed notification");
    } finally {
      await harness.close();
    }
  });
});

describe("schema rejection audit", () => {
  function auditLines(dataDir: string): Array<Record<string, unknown>> {
    const text = readFileSync(join(dataDir, "audit.jsonl"), "utf8").trim();
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("audits a schema-invalid call with invalid_args and redacted arguments", async () => {
    const harness = await createHarness({ auditLog: true });
    try {
      const result = await callTool(harness.client, "zen_type", {
        tabId: 123,
        text: "do-not-store-this-typed-text",
      });

      assert.equal(result.isError, true);
      const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
      assert.equal(payload.code, "invalid_args");

      const lines = auditLines(harness.dataDir);
      assert.equal(lines.length, 1);
      const record = lines[0]!;
      assert.equal(record.tool, "zen_type");
      assert.equal(record.ok, false);
      assert.equal(record.executed, false);
      assert.equal((record.error as { code?: string }).code, "invalid_args");
      assert.equal(record.capability, "page.type");
      assert.equal(record.mode, "full");
      assert.equal(record.policyRevision, 1);
      assert.equal(record.policySource, "file");
      const args = record.args as Record<string, unknown>;
      assert.equal(args.tabId, 123);
      assert.match(String(args.text), /^<redacted /);
      assert.doesNotMatch(
        JSON.stringify(record),
        /do-not-store-this-typed-text/
      );
    } finally {
      await harness.close();
    }
  });

  it("audits schema-invalid arguments passed through zen_tools_use", async () => {
    const harness = await createHarness({ auditLog: true });
    try {
      const result = await callTool(harness.client, "zen_tools_use", {
        tool: "zen_type",
        arguments: { tabId: 456, text: "hidden-secret-text" },
      });

      assert.equal(result.isError, true);
      const lines = auditLines(harness.dataDir);
      const invalid = lines.find(
        (line) => line.tool === "zen_type" && line.executed === false
      );
      assert.ok(invalid, "expected an invalid_args audit line for zen_type");
      assert.equal((invalid.error as { code?: string }).code, "invalid_args");
      assert.doesNotMatch(JSON.stringify(invalid), /hidden-secret-text/);
    } finally {
      await harness.close();
    }
  });

  it("does not add an invalid_args record for a valid call", async () => {
    const harness = await createHarness({ auditLog: true });
    try {
      const result = await callTool(harness.client, "zen_audit_tail", {
        limit: 1,
      });
      assert.equal(result.isError, undefined);

      const lines = auditLines(harness.dataDir);
      assert.equal(lines.length, 2);
      assert.deepEqual(
        lines.map((line) => line.phase),
        ["started", "completed"]
      );
      const completed = lines[1]!;
      assert.equal(completed.tool, "zen_audit_tail");
      assert.equal(completed.executed, true);
      assert.equal(completed.ok, true);
      assert.equal(completed.capability, "audit.read");
      assert.equal(completed.mode, "full");
      assert.equal(completed.policyRevision, 1);
      assert.equal(completed.policySource, "file");
    } finally {
      await harness.close();
    }
  });
});

describe("server info", () => {
  it("advertises a title and the project website", async () => {
    const harness = await createHarness();
    try {
      const info = harness.client.getServerVersion();
      assert.ok(info);
      assert.equal(info.name, "zen-mcp");
      assert.equal(info.title, "Zen MCP");
      assert.equal(info.websiteUrl, "https://github.com/spaxe-dev/zen-mcp");
      assert.ok(info.version);
    } finally {
      await harness.close();
    }
  });
});
