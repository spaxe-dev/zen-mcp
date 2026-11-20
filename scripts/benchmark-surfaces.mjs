#!/usr/bin/env node
/**
 * Live task benchmark for Zen MCP tool surfaces.
 *
 * Starts a local page server, launches a headless owned Zen, connects an MCP
 * client, and runs the same local tasks against one server build. Consent is
 * disabled only for this benchmark harness; the product default stays on.
 *
 * Usage:
 *   node scripts/benchmark-surfaces.mjs --label new --out docs/context/bench-new.json
 *   node scripts/benchmark-surfaces.mjs --label old --server .tmp/bench-old/dist/cli.js \
 *     --out docs/context/bench-old.json
 */

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function args() {
  const out = { label: "run", server: path.join(root, "dist", "cli.js"), out: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--label") out.label = argv[++i];
    else if (argv[i] === "--server") out.server = path.resolve(root, argv[++i]);
    else if (argv[i] === "--out") out.out = argv[++i];
  }
  return out;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const PAGES = {
  "/pricing": `<!doctype html><html><head><title>Pricing</title></head><body>
<main id="pricing"><h1>Pricing</h1>
<p>The Team plan costs 12 dollars per user each month.</p>
<table><thead><tr><th>Plan</th><th>Price</th><th>SSO</th></tr></thead>
<tbody><tr><td>Team</td><td>$12</td><td>No</td></tr>
<tr><td>Enterprise</td><td>Contact sales</td><td>Yes</td></tr></tbody></table>
</main></body></html>`,
  "/other": `<!doctype html><html><head><title>Limits</title></head><body>
<main id="pricing"><h1>Limits</h1>
<table><thead><tr><th>Plan</th><th>Cache</th></tr></thead>
<tbody><tr><td>Team</td><td>100 GB</td></tr><tr><td>Enterprise</td><td>Unlimited</td></tr></tbody></table>
</main></body></html>`,
  "/docs": `<!doctype html><html><head><title>Docs</title></head><body>
<main><h1>Docs</h1><h2>Setup</h2><p>Install the client and sign in.</p>
<h2>Limits</h2><p>The free tier has 10 GB of egress.</p>
<p><a href="/article">Read the article</a></p></main></body></html>`,
  "/article": `<!doctype html><html><head><title>Article</title></head><body>
<main><h1>Article</h1><p>The lighthouse keeper checked the lamp at dawn.</p>
<p>Filler text for the reading benchmark. </p></main></body></html>`,
  "/form": `<!doctype html><html><head><title>Form</title></head><body>
<main><h1>Form</h1><input id="q" placeholder="Search" />
<button id="go" onclick="document.getElementById('done').textContent='Result: '+document.getElementById('q').value">Go</button>
<p id="done">Waiting</p></main></body></html>`,
};

async function startPages() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const html = PAGES[url.pathname] ?? PAGES["/docs"];
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

let encoder = null;
try {
  const tiktoken = await import("js-tiktoken");
  encoder = tiktoken.getEncoding("cl100k_base");
} catch {
  encoder = null;
}
function tokens(text) {
  return encoder ? encoder.encode(String(text ?? "")).length : estimateTokens(text);
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

function parse(result) {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const options = args();
  if (!existsSync(options.server)) throw new Error(`Missing server: ${options.server}`);
  if (await portOpen(2828)) {
    throw new Error("Port 2828 is in use. Quit the other Zen/Marionette instance first.");
  }

  const scratch = path.join(root, ".tmp", "bench", options.label);
  mkdirSync(scratch, { recursive: true });
  const profile = path.join(scratch, "profile");
  const dataDir = path.join(scratch, "data");
  mkdirSync(profile, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(scratch, "config.json"),
    JSON.stringify({ requireConsent: false, autoLaunch: true, auditLog: true }, null, 2)
  );

  const pages = await startPages();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.server, "serve"],
    cwd: path.dirname(path.dirname(options.server)),
    stderr: "pipe",
    env: {
      ...process.env,
      ZEN_MCP_CONFIG: path.join(scratch, "config.json"),
      ZEN_MCP_DATA_DIR: dataDir,
      ZEN_MCP_PROFILE: profile,
      ZEN_MCP_USE_DEFAULT_PROFILE: "0",
      ZEN_MCP_REQUIRE_CONSENT: "0",
      ZEN_MCP_CONSENT_TIMEOUT_SECONDS: "10",
      ZEN_MCP_LAUNCH_ARGS: "--headless",
      ZEN_MCP_READ_ONLY: "0",
      ZEN_MCP_ALLOWED_DOMAINS: "",
      ZEN_MCP_AUDIT_LOG: "1",
      ZEN_MCP_TOOL_SURFACE: "research",
      ZEN_MCP_NO_UPDATE_CHECK: "1",
    },
  });
  if (transport.stderr) transport.stderr.on("data", () => {});

  const client = new Client({ name: `bench-${options.label}`, version: "1.0.0" });
  const startedAt = performance.now();
  await client.connect(transport);
  const startupMs = Math.round(performance.now() - startedAt);

  const { tools } = await client.listTools();
  const exposed = new Set(tools.map((tool) => tool.name));
  const definitionChars = tools.reduce(
    (sum, tool) => sum + JSON.stringify(tool).length,
    0
  );
  const instructions = String(client.getInstructions() ?? "");
  const initialContext = {
    tools: tools.length,
    definitionChars,
    instructionsChars: instructions.length,
    combinedChars: definitionChars + instructions.length,
    tokens: tokens(
      JSON.stringify({ tools, instructions })
    ),
  };

  const calls = [];
  async function timed(fn, label) {
    const start = performance.now();
    const result = await fn();
    const entry = {
      tool: label,
      ms: Math.round(performance.now() - start),
      chars: textOf(result).length,
      tokens: tokens(textOf(result)),
      ok: result?.isError !== true,
    };
    calls.push(entry);
    return result;
  }

  async function callAny(tool, toolArgs = {}) {
    if (exposed.has(tool)) {
      return timed(
        () => client.callTool({ name: tool, arguments: toolArgs }),
        tool
      );
    }
    const found = parse(
      await timed(
        () =>
          client.callTool({
            name: "zen_tools_search",
            arguments: { name: tool },
          }),
        `search:${tool}`
      )
    );
    assert(found?.tool?.name === tool || found?.tools?.some((entry) => entry.name === tool), `search did not find ${tool}`);
    return timed(
      () =>
        client.callTool({
          name: "zen_tools_use",
          arguments: { tool, arguments: toolArgs },
        }),
      `use:${tool}`
    );
  }

  const tasks = [];
  async function runTask(name, fn) {
    const start = performance.now();
    const before = calls.length;
    try {
      await fn();
      const used = calls.slice(before);
      tasks.push({
        name,
        ok: true,
        ms: Math.round(performance.now() - start),
        calls: used,
        callCount: used.length,
        resultChars: used.reduce((sum, entry) => sum + entry.chars, 0),
        resultTokens: used.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0),
      });
    } catch (error) {
      const used = calls.slice(before);
      tasks.push({
        name,
        ok: false,
        ms: Math.round(performance.now() - start),
        calls: used,
        callCount: used.length,
        error: String(error?.message ?? error).slice(0, 500),
      });
    }
  }

  // Warm-up establishes the browser and measures launch separately.
  const launchStart = performance.now();
  const status = await timed(
    () => client.callTool({ name: "zen_status", arguments: {} }),
    "zen_status"
  );
  const launchMs = Math.round(performance.now() - launchStart);
  assert(status.isError !== true, `status failed: ${textOf(status).slice(0, 200)}`);

  const spaceName = `Bench ${options.label} ${Date.now()}`;
  await callAny("zen_space_create", { name: spaceName });
  const page = (name) => `${pages.base}${name}?bench=${options.label}-${Date.now()}`;

  await runTask("one-page", async () => {
    const open = await callAny("zen_tabs_open", {
      urls: [page("/pricing")],
      space: spaceName,
      background: true,
    });
    const tabId = parse(open).tabs?.[0]?.id ?? open.structuredContent?.tabs?.[0]?.id;
    assert(tabId, "no tab id from open");
    const read = await callAny("zen_read_page", {
      tabId,
      format: "markdown",
      selector: "#pricing",
      maxChars: 4000,
    });
    assert(textOf(read).includes("12"), "pricing text missing");
  });

  await runTask("multi-source", async () => {
    const open = await callAny("zen_tabs_open", {
      urls: [page("/docs"), page("/article"), page("/other")],
      space: spaceName,
      background: true,
    });
    const ids = (parse(open).tabs ?? []).map((tab) => tab.id).slice(0, 3);
    assert(ids.length >= 3, "expected three tabs");
    const batch = parse(
      await callAny("zen_read_pages", {
        tabIds: ids,
        format: "markdown",
        maxChars: 4000,
      })
    );
    assert(batch.pages?.filter((entry) => entry.ok).length >= 3, "batch read incomplete");
  });

  await runTask("compare", async () => {
    const open = await callAny("zen_tabs_open", {
      urls: [page("/pricing"), page("/other")],
      space: spaceName,
      background: true,
    });
    const ids = (parse(open).tabs ?? []).map((tab) => tab.id);
    let rows = 0;
    for (const tabId of ids) {
      const table = parse(
        await callAny("zen_read_page", { tabId, format: "tables" })
      );
      rows += table.tables?.[0]?.rows?.length ?? 0;
    }
    assert(rows >= 4, "expected comparison rows");
  });

  await runTask("verify", async () => {
    const url = page("/article");
    const result = parse(
      await callAny("zen_show_evidence", {
        url,
        quote: "The lighthouse keeper checked the lamp at dawn.",
        claim: "The keeper checked the lamp.",
      })
    );
    assert(result.ok === true && result.verified === true, "evidence not verified");
  });

  await runTask("cleanup-audit", async () => {
    const audit = parse(await callAny("zen_tabs_audit", {}));
    assert((audit.totals?.tabs ?? 0) >= 4, "audit missed benchmark tabs");
  });

  await runTask("interact", async () => {
    const open = await callAny("zen_tabs_open", {
      urls: [page("/form")],
      space: spaceName,
      background: true,
    });
    const tabId = parse(open).tabs?.[0]?.id;
    assert(tabId, "no form tab");
    const read = parse(
      await callAny("zen_read_page", { tabId, format: "interactive" })
    );
    const input = read.elements?.find((entry) => entry.placeholder === "Search");
    const button = read.elements?.find((entry) => entry.label === "Go");
    assert(input?.ref && button?.ref, "form controls missing");
    await callAny("zen_type", { tabId, ref: input.ref, text: "bench" });
    await callAny("zen_click", { tabId, ref: button.ref });
    await callAny("zen_wait_for", { tabId, selector: "#done", timeout_ms: 10000 });
    const done = await callAny("zen_read_page", { tabId, selector: "#done" });
    assert(textOf(done).includes("bench"), "form result missing");
  });

  if (exposed.has("zen_tools_search")) {
    await runTask("discover-open", async () => {
      const found = parse(
        await callAny("zen_tools_search", { query: "audit stale duplicates" })
      );
      assert(found.tools?.some((entry) => entry.name === "zen_tabs_audit"), "discovery missed audit");
      const used = parse(
        await callAny("zen_tools_use", {
          tool: "zen_tabs_audit",
          arguments: {},
          publish: true,
        })
      );
      assert((used.totals?.tabs ?? 0) >= 4, "gateway call returned no audit");
    });
  }

  const config = parse(await client.callTool({ name: "zen_config", arguments: {} }));
  const browserPid = config?.session?.browserPid ?? null;

  await client.close().catch(() => undefined);
  await pages.close();
  if (browserPid) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(browserPid), "/T", "/F"], {
          stdio: "ignore",
          timeout: 10_000,
        });
      } else {
        process.kill(browserPid, "SIGKILL");
      }
    } catch {
      // Already gone.
    }
  }

  const snapshot = {
    label: options.label,
    server: path.relative(root, options.server).replace(/\\/g, "/"),
    tokenizer: encoder ? "js-tiktoken/cl100k_base" : "chars/4 fallback",
    generatedAt: new Date().toISOString(),
    startupMs,
    launchMs,
    initialContext,
    tasks,
    totals: {
      taskMs: tasks.reduce((sum, task) => sum + task.ms, 0),
      calls: tasks.reduce((sum, task) => sum + (task.callCount ?? 0), 0),
      resultChars: tasks.reduce((sum, task) => sum + (task.resultChars ?? 0), 0),
      succeeded: tasks.filter((task) => task.ok).length,
      failed: tasks.filter((task) => !task.ok).length,
    },
  };

  if (options.out) {
    const out = path.resolve(root, options.out);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  console.log(JSON.stringify(snapshot, null, 2));
}

await main();
