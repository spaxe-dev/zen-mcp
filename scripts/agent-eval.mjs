#!/usr/bin/env node
/**
 * Deterministic agent evaluation: OLD vs NEW page representation.
 *
 * Both modes run the SAME policy functions over a normalized observation. Only
 * the allowed representation differs:
 *   old: zen_read_page format=text | snapshot | interactive (no semantic view)
 *   new: zen_read_page format=semantic (landmarks, headings, collections,
 *        dialogs, classification+confidence, elements and a text preview)
 *
 * There is no model in the loop: no LLM evaluation, deterministic policies
 * only. Each task asserts fixed expected facts against a local fixture page.
 *
 * Usage: ZEN_MCP_E2E=1 node scripts/agent-eval.mjs [--json <path>]
 *
 * Requires a built dist/ and a real Zen install. Launches its own Zen with a
 * throwaway profile; it never touches the user's browser.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const OLD_FORMATS = new Set(["text", "snapshot", "interactive"]);
const POLICIES = "No LLM evaluation; deterministic policies only.";

// --------------------------------------------------------------- fixtures

const doc = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `</head><body>${body}</body></html>`;

const CARDS = Array.from({ length: 5 }, (_, i) => {
  const n = i + 1;
  return `<article aria-label="Result ${n} — Lamp report ${n}">` +
    `<a href="/r/${n}">Result ${n} — Lamp report ${n}</a>` +
    `<button type="button">Save</button></article>`;
}).join("");

const PRODUCTS = [
  ["aurora", "Aurora Desk Lamp", 129],
  ["nimbus", "Nimbus Desk Lamp", 89],
  ["vela", "Vela Floor Lamp", 210],
].map(([id, name, price]) =>
  `<div class="card" data-product="${id}" aria-label="${name}, $${price}">` +
  `<h3>${name}</h3><p>$${price}</p><button type="button">Add to cart</button></div>`
).join("");

const POSTS = Array.from({ length: 4 }, (_, i) =>
  `<article aria-label="Post ${i + 1}"><h2>Post ${i + 1}</h2>` +
  `<p>Reply body ${i + 1} about slow builds.</p>` +
  `<button type="button">Reply</button></article>`
).join("");

const ROUTES = {
  "/article": () => doc("The Tidal Power Ledger",
    `<header><div class="brand">Field Notes</div><nav aria-label="Sections">` +
    `<a href="#overview">Overview</a><a href="#findings">Findings</a>` +
    `<a href="#method">Method</a></nav></header>` +
    `<aside><h1>Editor's picks</h1><p>Three unrelated stories.</p></aside>` +
    `<main><article><h1>The Tidal Power Ledger</h1>` +
    `<p>The tidal array produced 4.2 GWh last quarter.</p>` +
    `<section id="overview"><h2>Overview</h2><p>Sited in a tidal strait.</p></section>` +
    `<section id="findings"><h2>Findings</h2><p>Output rose with the spring tide.</p>` +
    `<section><h3>Storage outlook</h3><p>Buffers cover slack water.</p></section>` +
    `</section><section id="method"><h2>Method</h2><p>Sampled hourly.</p></section>` +
    `</article></main>` +
    `<footer><a href="#top">Back to top</a><a href="#privacy">Privacy</a></footer>`),
  "/search": () => doc("Search results for lamps",
    `<main><h1>Search results for lamps</h1>` +
    `<form role="search"><input type="search" name="q" aria-label="Search"></form>` +
    `<p>About 1,240 results</p><section aria-label="Results">${CARDS}</section>` +
    `<nav aria-label="Pagination"><a href="?page=1">1</a><a href="?page=2">2</a>` +
    `<a href="?page=3">3</a><a href="?page=2">Next</a></nav></main>`),
  "/products": () => doc("Lamp shop",
    `<main><h1>Lamp shop</h1><div class="grid">${PRODUCTS}</div>` +
    `<p id="picked">picked: none</p></main>` +
    `<script>document.querySelectorAll(".card").forEach(function (card) {` +
    `card.addEventListener("click", function () {` +
    `document.querySelector("#picked").textContent = "picked: " + card.dataset.product;` +
    `});});</script>`),
  "/dashboard": () => doc("Ops dashboard",
    `<main><h1>Ops dashboard</h1>` +
    `<table><caption>Incidents</caption><thead><tr><th>Metric</th><th>Value</th>` +
    `</tr></thead><tbody><tr><td>Open incidents</td><td>7</td></tr>` +
    `<tr><td>Resolved today</td><td>31</td></tr></tbody></table>` +
    `<table><caption>Queues</caption><thead><tr><th>Queue</th><th>Depth</th>` +
    `</tr></thead><tbody><tr><td>mail</td><td>12</td></tr>` +
    `<tr><td>sync</td><td>4</td></tr></tbody></table>` +
    `<nav aria-label="Dashboard sections"><a href="#overview">Overview</a>` +
    `<a href="#alerts">Alerts</a><a href="#runs">Runs</a></nav></main>`),
  "/login": () => doc("Sign in",
    `<main><h1>Sign in to Atlas</h1><form aria-label="Sign in">` +
    `<label for="email">Email</label><input id="email" type="email" autocomplete="username">` +
    `<label for="password">Password</label><input id="password" type="password">` +
    `<button type="submit">Sign in</button></form></main>`),
  "/docs": () => doc("Bridge documentation",
    `<main><h1>Bridge documentation</h1>` +
    `<pre><code># Configure the bridge\nzen.bridge --port 2828</code></pre>` +
    `<h2>Install</h2><p>Build the checkout first.</p><pre><code>npm ci</code></pre>` +
    `<h2 id="configure">Configure the bridge</h2>` +
    `<p>Point the bridge at a free port.</p>` +
    `<pre><code>ZEN_MCP_E2E=1 npm run test:zen</code></pre>` +
    `<h2>Troubleshoot</h2><pre><code>node dist/cli.js doctor</code></pre></main>`),
  "/thread": () => doc("Thread: build times",
    `<main><h1>Thread: build times</h1><section aria-label="Posts">${POSTS}</section>` +
    `<button type="button" id="open-report">Report thread</button>` +
    `<dialog id="report" aria-label="Report post" aria-modal="true">` +
    `<h2>Report post</h2><p>Send this thread to the moderators.</p>` +
    `<button type="button" id="cancel-report">Cancel</button>` +
    `<button type="button">Send report</button></dialog></main>` +
    `<script>document.querySelector("#open-report").addEventListener("click", function () {` +
    `document.querySelector("#report").showModal();});` +
    `document.querySelector("#cancel-report").addEventListener("click", function () {` +
    `document.querySelector("#report").close();});</script>`),
  "/shadow": () => doc("Widget workspace",
    `<main><h1>Widget workspace</h1><div id="shadow-host"></div>` +
    `<button type="button" id="rebuild">Rebuild widget</button>` +
    `<p id="shadow-state">idle</p>` +
    `<iframe src="/frame" title="helper frame"></iframe></main>` +
    `<script>var host = document.querySelector("#shadow-host");` +
    `var shadow = host.attachShadow({ mode: "open" });` +
    `function build() { shadow.innerHTML = '<button id="shadow-save" type="button">Shadow save</button>';` +
    `shadow.querySelector("#shadow-save").addEventListener("click", function () {` +
    `document.querySelector("#shadow-state").textContent = "shadow saved";}); }` +
    `build();document.querySelector("#rebuild").addEventListener("click", build);</script>`),
  "/frame": () => doc("Helper frame", `<main><button type="button">Frame action</button></main>`),
};

/** Title fragment used to wait for each tab after it opens. */
const WAIT_FOR = {
  article: "Tidal Power", search: "Search results for lamps", products: "Lamp shop",
  dashboard: "Ops dashboard", login: "Sign in", docs: "Bridge documentation",
  thread: "Thread: build times", shadow: "Widget workspace",
};

async function startFixtures() {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const page = ROUTES[pathname];
    if (!page) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    });
    res.end(page());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no fixture port");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------- session

function makeSession(client) {
  let active = null;
  const session = {
    scope() { active = { calls: 0, chars: 0 }; return active; },
    endScope() { const done = active ?? { calls: 0, chars: 0 }; active = null; return done; },
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: 120_000,
      });
      const text = result.content?.find((part) => part.type === "text")?.text ?? "";
      if (active) { active.calls += 1; active.chars += text.length; }
      let value = null;
      try { value = text ? JSON.parse(text) : null; } catch { value = null; }
      return { ok: !result.isError, text, value };
    },
    read(tabId, format, extra = {}) {
      return session.call("zen_read_page", { tabId, format, ...extra });
    },
    click(tabId, ref) {
      return session.call("zen_click", { tabId, ref });
    },
  };
  return session;
}

function merge(obs, result) {
  const value = result.value ?? {};
  if (typeof value.text === "string") obs.text += `${value.text}\n`;
  if (Array.isArray(value.elements)) obs.elements.push(...value.elements);
  if (Array.isArray(value.outline)) obs.outline.push(...value.outline);
  if (value.semantic) obs.semantic = value.semantic;
  if (Array.isArray(value.frames)) obs.frames.push(...value.frames);
  obs.last = value;
  return obs;
}

async function observe(session, tabId, mode, formats) {
  const obs = { mode, text: "", elements: [], outline: [], frames: [], semantic: null, last: null };
  for (const format of formats) {
    if (mode === "old" && !OLD_FORMATS.has(format)) throw new Error(`old mode may not request ${format}`);
    const result = await session.read(tabId, format);
    if (!result.ok) throw new Error(`${format} read failed: ${result.text.slice(0, 200)}`);
    merge(obs, result);
  }
  return obs;
}

// ------------------------------------------------------------------ tasks

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const regions = (semantic, role) => semantic?.regions.filter((entry) => entry.role === role) ?? [];
const textOf = (result) => result.value?.text ?? result.text;

/**
 * One hand-written policy per task. The same `run` executes in both modes; the
 * observation is simply emptier in old mode (no semantic field).
 */
const TASKS = [
  {
    id: "article-main-heading", tab: "article",
    title: "Find the main article heading, not the aside decoy",
    formats: { old: ["snapshot"], new: ["semantic"] },
    expected: { heading: "The Tidal Power Ledger" }, primary: ["heading"],
    run({ obs }) {
      const main = regions(obs.semantic, "main")[0];
      const levelOnes = [...(obs.semantic?.headings ?? obs.outline)].filter((h) => h.level === 1);
      const heading = main?.heading || levelOnes[0]?.text || null;
      return {
        facts: { heading },
        ambiguous: !main && levelOnes.length > 1,
        wrongSelections: heading && heading !== "The Tidal Power Ledger" ? 1 : 0,
      };
    },
  },
  {
    id: "nav-sections", tab: "article",
    title: "Identify the section navigation landmark and its link count",
    formats: { old: ["snapshot"], new: ["semantic"] },
    expected: { nav: "Sections", links: 3 }, primary: ["nav", "links"],
    run({ obs }) {
      const nav = regions(obs.semantic, "navigation")[0];
      // Flat link lists are exposed as landmark link counts, not as item
      // samples, so the fact is the landmark label plus its link count.
      const hashLinks = obs.elements.filter(
        (e) => e.tag === "a" && String(e.href ?? "").includes("#")
      );
      return {
        facts: nav
          ? { nav: nav.label, links: nav.links }
          : { nav: null, links: null },
        ambiguous: !nav && hashLinks.length > 1,
        wrongSelections: 0,
      };
    },
  },
  {
    id: "search-results-count", tab: "search",
    title: "Find the result count, card count and pagination landmark",
    formats: { old: ["snapshot"], new: ["semantic"] },
    expected: { total: "1,240", cards: 5, pagination: "Pagination" },
    primary: ["total", "cards", "pagination"],
    run({ obs }) {
      const total = /about\s+([\d,]+)\s+results/i.exec(obs.text)?.[1] ?? null;
      let cards = null;
      let pagination = null;
      if (obs.semantic) {
        cards = obs.semantic.collections.find((entry) =>
          entry.sample.length > 0 && entry.sample.every((s) => /^result \d/i.test(s.label))
        )?.count ?? null;
        pagination = regions(obs.semantic, "navigation")[0]?.label ?? null;
      } else {
        cards = obs.elements.filter((e) => /^result \d/i.test(e.label)).length;
      }
      return { facts: { total, cards, pagination } };
    },
  },
  {
    id: "product-add-to-cart", tab: "products",
    title: "Choose the Add to cart control for the Nimbus card",
    formats: { old: ["snapshot"], new: ["semantic"] },
    expected: { picked: "nimbus" }, primary: ["picked"],
    async run({ obs, session, tabId }) {
      const buttons = obs.elements.filter((e) => /^add to cart$/i.test(e.label));
      const cards = obs.semantic?.collections.find((entry) =>
        entry.count === buttons.length && entry.sample.every((s) => /lamp/i.test(s.label)));
      let index = 0;
      let ambiguous = buttons.length > 1;
      if (cards) {
        const found = cards.sample.findIndex((s) => /nimbus desk lamp/i.test(s.label));
        if (found >= 0) { index = found; ambiguous = false; }
      }
      // Cards and their buttons share document order, so the card index picks
      // the button index. The click marker below still verifies the result.
      const button = buttons[Math.min(index, Math.max(0, buttons.length - 1))];
      let picked = null;
      if (button) {
        await session.click(tabId, button.ref);
        const verify = await session.read(tabId, "text", { selector: "#picked" });
        picked = /picked:\s*([a-z]+)/i.exec(textOf(verify))?.[1]?.toLowerCase() ?? null;
      }
      return { facts: { picked }, ambiguous, wrongSelections: picked && picked !== "nimbus" ? 1 : 0 };
    },
  },
  {
    id: "dashboard-page-type", tab: "dashboard",
    title: "Read the incidents value and classify the dashboard",
    formats: { old: ["snapshot"], new: ["semantic"] },
    expected: { incidents: "7", type: "dashboard" }, primary: ["incidents", "type"],
    run({ obs }) {
      return {
        facts: {
          incidents: /open incidents\s+(\d+)/i.exec(obs.text)?.[1] ?? null,
          type: obs.semantic?.classification ?? null,
        },
      };
    },
  },
  {
    id: "login-form", tab: "login",
    title: "Detect the login form and its submit control",
    formats: { old: ["interactive"], new: ["semantic"] },
    expected: { password: true, email: true, submit: "Sign in", type: "login" },
    primary: ["password", "email", "submit"],
    run({ obs }) {
      const has = (test) => obs.elements.some(test);
      return {
        facts: {
          password: has((e) => String(e.type ?? "").toLowerCase() === "password"),
          email: has((e) => String(e.type ?? "").toLowerCase() === "email"),
          submit: obs.elements.find((e) => /^sign in$/i.test(e.label))?.label ?? null,
          type: obs.semantic?.classification ?? null,
        },
      };
    },
  },
  {
    id: "docs-heading", tab: "docs",
    title: "Find the documentation heading, not the code-block example",
    formats: { old: ["text"], new: ["semantic"] },
    expected: { heading: "Configure the bridge", level: 2, type: "documentation" },
    primary: ["heading", "level"],
    run({ obs }) {
      if (obs.semantic) {
        const heading = obs.semantic.headings.find((h) => /^configure the bridge$/i.test(h.text));
        return { facts: { heading: heading?.text ?? null, level: heading?.level ?? null, type: obs.semantic.classification } };
      }
      const matches = [...obs.text.matchAll(/configure the bridge/gi)];
      return {
        facts: { heading: matches[0]?.[0] ?? null, level: null, type: null },
        ambiguous: matches.length > 1,
        wrongSelections: 0,
      };
    },
  },
  {
    id: "modal-dialog", tab: "thread",
    title: "Open and identify the modal dialog on a discussion page",
    formats: { old: ["snapshot"], new: ["semantic"] },
    expected: { dialog: "Report post", modal: true, posts: 4 },
    primary: ["dialog", "modal"],
    async run({ obs, session, tabId, reobserve }) {
      const opener = obs.elements.find((e) => /report thread/i.test(e.label));
      if (!opener) return { facts: { dialog: null, modal: null, posts: null } };
      await session.click(tabId, opener.ref);
      const after = await reobserve();
      let dialog = null;
      let posts = null;
      if (after.semantic) {
        dialog = after.semantic.dialogs.find((entry) => /report post/i.test(entry.label)) ?? null;
        posts = after.semantic.collections.find((entry) =>
          entry.count > 0 && entry.sample.every((s) => /^post \d/i.test(s.label)))?.count ?? null;
      } else {
        posts = after.elements.filter((e) => /^reply$/i.test(e.label)).length;
      }
      const cancel = after.elements.find((e) => /^cancel$/i.test(e.label));
      if (cancel) await session.click(tabId, cancel.ref);
      return { facts: { dialog: dialog?.label ?? null, modal: dialog?.modal ?? null, posts } };
    },
  },
  {
    id: "stale-ref-recovery", tab: "shadow",
    title: "Recover when a shadow-root ref goes stale after a mutation",
    formats: { old: ["snapshot"], new: ["semantic"] },
    expected: { stale: true, recovered: true, saved: true },
    primary: ["stale", "recovered"],
    async run({ obs, session, tabId, reobserve }) {
      const first = obs.elements.find((e) => /^shadow save$/i.test(e.label));
      const rebuild = obs.elements.find((e) => /^rebuild widget$/i.test(e.label));
      if (!first || !rebuild) return { facts: { stale: false, recovered: false, saved: false } };
      await session.click(tabId, rebuild.ref);
      const stale = (await session.click(tabId, first.ref)).ok === false;
      const after = await reobserve();
      const fresh = after.elements.find((e) => /^shadow save$/i.test(e.label));
      const recovered = fresh ? (await session.click(tabId, fresh.ref)).ok : false;
      const state = await session.read(tabId, "text", { selector: "#shadow-state" });
      const saved = /shadow saved/i.test(textOf(state));
      return { facts: { stale, recovered, saved }, recovered };
    },
  },
];

// ----------------------------------------------------------------- runner

async function runTask(session, task, mode, tabId) {
  const started = Date.now();
  const reobserve = () => observe(session, tabId, mode, task.formats[mode]);
  let outcome = {};
  session.scope();
  try {
    outcome = await task.run({ mode, obs: await reobserve(), session, tabId, reobserve });
  } catch (error) {
    outcome = { facts: {}, error: String(error?.message ?? error) };
  }
  const counted = session.endScope();
  const facts = outcome.facts ?? {};
  const expected = task.expected;
  return {
    id: task.id, mode,
    success: task.primary.every((key) => same(facts[key], expected[key])),
    complete: Object.keys(expected).every((key) => same(facts[key], expected[key])),
    toolCalls: counted.calls, contextChars: counted.chars,
    ambiguous: outcome.ambiguous === true,
    wrongSelections: outcome.wrongSelections ?? 0,
    recovered: typeof outcome.recovered === "boolean" ? outcome.recovered : null,
    facts, expected, error: outcome.error ?? null, ms: Date.now() - started,
  };
}

function totalsOf(entries) {
  const sum = (key) => entries.reduce((total, entry) => total + entry[key], 0);
  return {
    tasks: entries.length,
    success: entries.filter((entry) => entry.success).length,
    complete: entries.filter((entry) => entry.complete).length,
    toolCalls: sum("toolCalls"),
    contextChars: sum("contextChars"),
    ambiguous: entries.filter((entry) => entry.ambiguous).length,
    wrongSelections: sum("wrongSelections"),
    recovered: entries.filter((entry) => entry.recovered === true).length,
    recoveryTasks: entries.filter((entry) => entry.recovered !== null).length,
  };
}

function flags(entry) {
  const notes = [];
  if (entry.ambiguous) notes.push("ambiguous");
  if (entry.wrongSelections) notes.push(`wrong:${entry.wrongSelections}`);
  if (!entry.complete) notes.push("incomplete");
  if (entry.recovered === false) notes.push("no-recovery");
  if (entry.error) notes.push("error");
  return notes.length ? notes.join(",") : "-";
}

function printTable(rows) {
  const header =
    "task".padEnd(24) + " old  new  " +
    "calls o->n".padEnd(12) + "chars o->n".padEnd(22) + "notes";
  console.log(header);
  console.log("-".repeat(header.length + 26));
  for (const row of rows) {
    console.log(
      row.id.padEnd(24) +
        ` ${row.old.success ? "PASS" : "FAIL"} ${row.new.success ? "PASS" : "FAIL"}  ` +
        `${row.old.toolCalls} -> ${row.new.toolCalls}`.padEnd(12) +
        `${row.old.contextChars} -> ${row.new.contextChars}`.padEnd(22) +
        `old:${flags(row.old)} new:${flags(row.new)}`
    );
  }
}

function findRegressions(rows) {
  const found = [];
  for (const row of rows) {
    if (row.old.success && !row.new.success) found.push(`${row.id}: new mode lost success`);
    if (row.old.complete && !row.new.complete) found.push(`${row.id}: new mode lost completeness`);
    if (row.new.wrongSelections > row.old.wrongSelections) found.push(`${row.id}: new mode made more wrong selections`);
    if (!row.old.ambiguous && row.new.ambiguous) found.push(`${row.id}: new mode became ambiguous`);
    if (row.old.recovered === true && row.new.recovered === false) found.push(`${row.id}: new mode failed to recover`);
  }
  return found;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- cleanup

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await sleep(250);
  }
  return !processAlive(pid);
}

function killTree(pid) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 10_000 });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}

function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Windows may hold a handle briefly; the next run uses a new directory.
  }
}

// ------------------------------------------------------------------- main

function gate() {
  if (process.env.ZEN_MCP_E2E !== "1") {
    console.error(
      "agent-eval is opt-in: it launches a real Zen (headless by default).\n" +
        "Run it with: ZEN_MCP_E2E=1 node scripts/agent-eval.mjs"
    );
    process.exit(2);
  }
  if (!existsSync(CLI)) {
    console.error(
      `agent-eval needs a built server: ${path.relative(ROOT, CLI)} is missing.\nRun: npm run build`
    );
    process.exit(2);
  }
}

function parseArgs(argv) {
  const options = { json: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json") {
      options.json = argv[++index] ?? null;
      if (!options.json) throw new Error("--json needs a path");
    } else if (argv[index] === "--help" || argv[index] === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument "${argv[index]}"`);
    }
  }
  return options;
}

async function main() {
  gate();
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error.message));
    process.exit(2);
  }
  if (options.help) {
    console.log("Usage: ZEN_MCP_E2E=1 node scripts/agent-eval.mjs [--json <path>]");
    return 0;
  }

  const fixtures = await startFixtures();
  const base = process.platform === "win32" ? "D:\\tmp" : tmpdir();
  mkdirSync(base, { recursive: true });
  const dataDir = mkdtempSync(path.join(base, "zen-mcp-eval-"));
  const profileDir = mkdtempSync(path.join(base, `zen-mcp-eval-profile-${process.pid}-`));
  const launchArgs = process.env.ZEN_MCP_TEST_HEADFUL === "1" ? [] : ["--headless"];
  const port = String(
    process.env.ZEN_MCP_EVAL_MARIONETTE_PORT ??
      process.env.ZEN_MCP_TEST_MARIONETTE_PORT ?? 2828
  );
  const env = {
    ...process.env,
    ZEN_MCP_CONFIG: path.join(dataDir, "config.json"),
    ZEN_MCP_DATA_DIR: dataDir,
    ZEN_MCP_PROFILE: profileDir,
    ZEN_MCP_USE_DEFAULT_PROFILE: "0",
    ZEN_MCP_REQUIRE_CONSENT: "0",
    ZEN_MCP_CONSENT_TIMEOUT_SECONDS: "5",
    ZEN_MCP_LAUNCH_ARGS: launchArgs.join(" "),
    ZEN_MCP_MARIONETTE_PORT: port,
    ZEN_MCP_READ_ONLY: "0",
    ZEN_MCP_ALLOWED_DOMAINS: "",
    ZEN_MCP_AUDIT_LOG: "1",
    ZEN_MCP_WATCH_MIN_INTERVAL_SECONDS: "5",
    ZEN_MCP_TOOL_SURFACE: "full",
    ZEN_MCP_NO_UPDATE_CHECK: "1",
  };

  let client = null;
  let spaceId = "";
  let tabIds = {};
  let browserPid = null;
  try {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [CLI, "serve"], cwd: ROOT, env, stderr: "pipe",
    });
    if (transport.stderr) transport.stderr.on("data", () => {});
    client = new Client({ name: "zen-mcp-agent-eval", version: "1.0.0" });
    await client.connect(transport);
    const session = makeSession(client);

    const status = await session.call("zen_status");
    if (!status.ok) throw new Error(`zen_status failed: ${status.text}`);
    const created = await session.call("zen_space_create", { name: "Agent evaluation" });
    if (!created.ok) throw new Error(`space create failed: ${created.text}`);
    spaceId = created.value.space.id;

    const names = Object.keys(ROUTES)
      .filter((key) => key !== "/frame")
      .map((key) => key.slice(1));
    const opened = await session.call("zen_tabs_open", {
      urls: names.map((name) => `${fixtures.base}/${name}`),
      space: spaceId,
      background: true,
    });
    if (!opened.ok) throw new Error(`tabs open failed: ${opened.text}`);
    opened.value.tabs.forEach((tab, index) => {
      const name = names.find(
        (candidate) =>
          tab.requestedUrl === `${fixtures.base}/${candidate}` ||
          tab.url === `${fixtures.base}/${candidate}`
      );
      tabIds[name ?? names[index]] = tab.id;
    });
    for (const name of names) {
      const waited = await session.call("zen_wait_for", {
        tabId: tabIds[name], title_contains: WAIT_FOR[name], timeout_ms: 30_000,
      });
      if (!waited.ok || waited.value?.matched !== true) {
        throw new Error(`tab "${name}" did not load: ${waited.text}`);
      }
    }

    console.log("Agent evaluation: OLD (text/snapshot/interactive) vs NEW (semantic).");
    console.log(`${POLICIES} Fixtures: ${fixtures.base} | space ${spaceId}\n`);

    const rows = [];
    for (const task of TASKS) {
      const tabId = tabIds[task.tab];
      rows.push({
        id: task.id, title: task.title,
        old: await runTask(session, task, "old", tabId),
        new: await runTask(session, task, "new", tabId),
      });
    }

    const oldTotals = totalsOf(rows.map((row) => row.old));
    const newTotals = totalsOf(rows.map((row) => row.new));
    const regressions = findRegressions(rows);

    printTable(rows);
    console.log("\naggregate");
    for (const [label, totals] of [["old", oldTotals], ["new", newTotals]]) {
      console.log(
        `  ${label}  success ${totals.success}/${totals.tasks}  ` +
          `complete ${totals.complete}/${totals.tasks}  calls ${totals.toolCalls}  ` +
          `chars ${totals.contextChars}  ambiguous ${totals.ambiguous}  ` +
          `wrong ${totals.wrongSelections}  ` +
          `recovered ${totals.recovered}/${totals.recoveryTasks}`
      );
    }
    const deltaChars = newTotals.contextChars - oldTotals.contextChars;
    console.log(
      `  delta chars ${deltaChars >= 0 ? "+" : ""}${deltaChars}  ` +
        `delta calls ${newTotals.toolCalls - oldTotals.toolCalls}`
    );
    console.log(
      regressions.length
        ? `\nREGRESSIONS (${regressions.length}):\n  - ${regressions.join("\n  - ")}`
        : "\nNo NEW-mode regressions against OLD mode."
    );
    console.log(`\n${POLICIES}`);

    let version = null;
    try {
      version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
    } catch {
      version = null;
    }
    const summary = {
      harness: "scripts/agent-eval.mjs",
      llm: false,
      deterministic: true,
      policy: POLICIES,
      generatedAt: new Date().toISOString(),
      gitCommit: gitCommit(),
      serverVersion: version,
      platform: process.platform,
      headless: launchArgs.includes("--headless"),
      tasks: rows.map((row) => ({
        id: row.id, title: row.title, old: row.old, new: row.new,
        delta: {
          toolCalls: row.new.toolCalls - row.old.toolCalls,
          contextChars: row.new.contextChars - row.old.contextChars,
        },
      })),
      totals: { old: oldTotals, new: newTotals },
      regressions,
    };
    console.log(`\n${JSON.stringify(summary, null, 2)}`);

    if (options.json) {
      const outPath = path.resolve(process.cwd(), options.json);
      mkdirSync(path.dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
      console.error(`Wrote ${outPath}`);
    }
    return regressions.length ? 1 : 0;
  } finally {
    if (client) {
      try {
        if (spaceId) await makeSession(client).call("zen_space_delete", { space: spaceId });
      } catch {
        // Best effort.
      }
      try {
        const config = await makeSession(client).call("zen_config");
        browserPid = config.value?.session?.browserPid ?? null;
      } catch {
        // The server may already be stopping.
      }
      await client.close().catch(() => undefined);
    }
    if (browserPid && !(await waitForExit(browserPid, 20_000))) killTree(browserPid);
    await fixtures.close();
    removeDir(profileDir);
    removeDir(dataDir);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`agent-eval failed: ${error?.stack ?? error}`);
    process.exit(2);
  });
