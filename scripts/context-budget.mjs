#!/usr/bin/env node
/**
 * Measures the always-on context cost of the Zen MCP tool surface.
 *
 * It talks to a real server over stdio, so the numbers come from the same
 * `tools/list` payload and server instructions a client receives. Token counts
 * use a documented characters/4 fallback so CI needs no extra dependency. When
 * `js-tiktoken` is resolvable it is used as a cross-check and reported.
 *
 * Usage:
 *   node scripts/context-budget.mjs
 *   node scripts/context-budget.mjs --surface full --out docs/context/baseline.json
 *   node scripts/context-budget.mjs --compare docs/context/baseline.json
 *   node scripts/context-budget.mjs --check docs/context/budget.json
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = path.join(root, ".tmp", "context-budget");
const SURFACES = ["research", "core", "full"];

function parseArgs(argv) {
  const options = {
    surfaces: [],
    out: null,
    compare: null,
    check: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--surface") {
      const value = argv[++index];
      if (!SURFACES.includes(value)) {
        throw new Error(`Unknown surface "${value}". Use ${SURFACES.join(", ")}.`);
      }
      options.surfaces.push(value);
    } else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--compare") options.compare = argv[++index];
    else if (arg === "--check") options.check = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/context-budget.mjs [--surface research|core|full] " +
          "[--out file] [--compare file] [--check file] [--json]"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument "${arg}"`);
    }
  }
  if (options.surfaces.length === 0) options.surfaces = ["research"];
  return options;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

let tokenizer = null;
try {
  const tiktoken = await import("js-tiktoken");
  const encoding = tiktoken.getEncoding("cl100k_base");
  tokenizer = {
    name: "js-tiktoken/cl100k_base",
    count: (text) => encoding.encode(text).length,
  };
} catch {
  tokenizer = { name: "chars/4 fallback", count: estimateTokens };
}

function firstParagraph(description) {
  if (!description) return "";
  const trimmed = description.trim();
  const split = trimmed.split(/\n\s*\n/);
  return (split[0] ?? "").trim();
}

function compact(value) {
  return JSON.stringify(value);
}

function toolMetrics(tool) {
  const definition = {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    _meta: tool._meta,
  };
  const serialized = compact(definition);
  const inputSchema = compact(tool.inputSchema ?? {});
  const outputSchema = compact(tool.outputSchema ?? {});
  const description = String(tool.description ?? "");
  const first = firstParagraph(description);
  return {
    name: tool.name,
    nameChars: tool.name.length,
    descriptionChars: description.length,
    firstParagraphChars: first.length,
    inputSchemaChars: inputSchema.length,
    outputSchemaChars: outputSchema.length,
    definitionChars: serialized.length,
    definitionTokens: tokenizer.count(serialized),
    firstParagraph: first,
  };
}

async function measureSurface(surface) {
  const scratch = path.join(SCRATCH, surface);
  mkdirSync(scratch, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "cli.js"), "serve"],
    cwd: root,
    stderr: "pipe",
    env: {
      ...process.env,
      ZEN_MCP_NO_UPDATE_CHECK: "1",
      ZEN_MCP_READ_ONLY: "1",
      ZEN_MCP_TOOL_SURFACE: surface,
      ZEN_MCP_CONFIG: path.join(scratch, "config.json"),
      ZEN_MCP_DATA_DIR: path.join(scratch, "data"),
    },
  });
  if (transport.stderr) transport.stderr.on("data", () => {});
  const client = new Client(
    { name: "zen-mcp-context-budget", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  try {
    const instructions = String(client.getInstructions() ?? "");
    const { tools } = await client.listTools();
    const { resources } = await client.listResources();
    const resourceUris = resources.map((resource) => resource.uri);

    let manifestToolCount = null;
    let manifestProblems = [];
    if (resourceUris.includes("zen://capabilities")) {
      const read = await client.readResource({ uri: "zen://capabilities" });
      const first = read.contents?.[0];
      const text = first && "text" in first ? first.text : "{}";
      const manifest = JSON.parse(text);
      manifestToolCount = Array.isArray(manifest.tools) ? manifest.tools.length : 0;
      manifestProblems = (manifest.tools ?? [])
        .filter(
          (tool) =>
            !tool.name ||
            !tool.summary ||
            !tool.category ||
            !Array.isArray(tool.surfaces) ||
            tool.surfaces.length === 0
        )
        .map((tool) => tool.name ?? "(unnamed)");
    }

    const undiscoverable = [];
    if (surface === "research" && manifestToolCount) {
      const read = await client.readResource({ uri: "zen://capabilities" });
      const first = read.contents?.[0];
      const manifest = JSON.parse(first && "text" in first ? first.text : "{}");
      for (const tool of manifest.tools ?? []) {
        const found = await client.callTool({
          name: "zen_tools_search",
          arguments: { name: tool.name },
        });
        const text = found.content?.find((entry) => entry.type === "text")?.text ?? "{}";
        try {
          const result = JSON.parse(text);
          if (result?.tool?.name !== tool.name) undiscoverable.push(tool.name);
        } catch {
          undiscoverable.push(tool.name);
        }
      }
    }

    const metrics = tools.map(toolMetrics).sort((a, b) => b.definitionChars - a.definitionChars);
    const definitionChars = metrics.reduce((sum, entry) => sum + entry.definitionChars, 0);
    const definitionTokens = metrics.reduce((sum, entry) => sum + entry.definitionTokens, 0);
    const envelopeChars = compact({ tools }).length;
    const overBudget = metrics.filter((entry) => entry.firstParagraphChars > 400);
    return {
      surface,
      toolCount: tools.length,
      toolNames: tools.map((tool) => tool.name),
      resourceCount: resources.length,
      resourceUris,
      manifestToolCount,
      manifestProblems,
      undiscoverable,
      instructionsChars: instructions.length,
      instructionsTokens: tokenizer.count(instructions),
      instructionsPreview: instructions.slice(0, 240),
      definitionChars,
      definitionTokens,
      envelopeChars,
      combinedChars: definitionChars + instructions.length,
      combinedTokens: definitionTokens + tokenizer.count(instructions),
      descriptionChars: metrics.reduce((sum, entry) => sum + entry.descriptionChars, 0),
      inputSchemaChars: metrics.reduce((sum, entry) => sum + entry.inputSchemaChars, 0),
      outputSchemaChars: metrics.reduce((sum, entry) => sum + entry.outputSchemaChars, 0),
      firstParagraphChars: metrics.reduce(
        (sum, entry) => sum + entry.firstParagraphChars,
        0
      ),
      overBudgetCount: overBudget.length,
      overBudget: overBudget.map((entry) => ({
        name: entry.name,
        firstParagraphChars: entry.firstParagraphChars,
      })),
      tools: metrics,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function percent(delta, base) {
  if (!base) return 0;
  return Math.round((delta / base) * 1000) / 10;
}

function printSurface(result, full) {
  console.log(`\n=== ${result.surface.toUpperCase()} surface ===`);
  console.log(`tools                 ${result.toolCount}`);
  console.log(`instructions          ${result.instructionsChars} chars (${result.instructionsTokens} tokens)`);
  console.log(`tool definitions      ${result.definitionChars} chars (${result.definitionTokens} tokens)`);
  console.log(`combined              ${result.combinedChars} chars (${result.combinedTokens} tokens)`);
  console.log(`descriptions          ${result.descriptionChars} chars`);
  console.log(`input schemas         ${result.inputSchemaChars} chars`);
  console.log(`output schemas        ${result.outputSchemaChars} chars`);
  console.log(`first paragraphs >400 ${result.overBudgetCount}`);
  if (result.manifestToolCount !== null) {
    console.log(`capability manifest   ${result.manifestToolCount} tools`);
  }
  if (result.undiscoverable.length > 0) {
    console.log(`not discoverable      ${result.undiscoverable.join(", ")}`);
  }
  if (full && result.surface !== "full") {
    console.log(
      `vs full               -${percent(full.combinedChars - result.combinedChars, full.combinedChars)}% chars, ` +
        `-${percent(full.combinedTokens - result.combinedTokens, full.combinedTokens)}% tokens`
    );
  }
  console.log("largest tool definitions:");
  for (const tool of result.tools.slice(0, 8)) {
    console.log(
      `  ${tool.name.padEnd(28)} ${String(tool.definitionChars).padStart(6)} chars  ` +
        `${String(tool.definitionTokens).padStart(5)} tokens`
    );
  }
}

function compare(baseline, current) {
  console.log("\n=== before / after ===");
  const baselineFull = baseline.surfaces?.full;
  for (const surface of Object.keys(current)) {
    const before = baseline.surfaces?.[surface] ?? baselineFull;
    const after = current[surface];
    if (!before) continue;
    const label = baseline.surfaces?.[surface] ? surface : `${surface} vs 0.5.0 full`;
    console.log(
      `${label.padEnd(20)} ${String(before.toolCount).padStart(3)} -> ${String(after.toolCount).padStart(3)} tools | ` +
        `${before.combinedChars} -> ${after.combinedChars} chars | ` +
        `${before.combinedTokens} -> ${after.combinedTokens} tokens | ` +
        `-${percent(before.combinedChars - after.combinedChars, before.combinedChars)}% chars`
    );
  }
  if (baselineFull && current.research) {
    console.log(
      `default reduction vs 0.5.0 full: ` +
        `-${percent(baselineFull.combinedChars - current.research.combinedChars, baselineFull.combinedChars)}% chars, ` +
        `-${percent(baselineFull.combinedTokens - current.research.combinedTokens, baselineFull.combinedTokens)}% tokens`
    );
  }
}

function runChecks(budgetPath, current) {
  if (!existsSync(budgetPath)) {
    throw new Error(`Budget file not found: ${budgetPath}`);
  }
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  const baselinePath = path.resolve(root, budget.baseline ?? "docs/context/baseline-0.5.0.json");
  const baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, "utf8"))
    : null;
  const failures = [];
  const research = current.research;
  if (!research) failures.push("research surface was not measured");

  if (research) {
    if (budget.researchToolMin && research.toolCount < budget.researchToolMin) {
      failures.push(`research tools ${research.toolCount} < ${budget.researchToolMin}`);
    }
    if (budget.researchToolMax && research.toolCount > budget.researchToolMax) {
      failures.push(`research tools ${research.toolCount} > ${budget.researchToolMax}`);
    }
    if (research.overBudgetCount > 0) {
      failures.push(
        `${research.overBudgetCount} exposed descriptions exceed ` +
          `${budget.firstParagraphMaxChars ?? 400} characters: ` +
          research.overBudget.map((entry) => entry.name).join(", ")
      );
    }
    for (const name of budget.requiredResearchTools ?? []) {
      if (!research.toolNames.includes(name)) {
        failures.push(`research surface is missing ${name}`);
      }
    }
    if (research.manifestProblems.length > 0) {
      failures.push(
        `capability manifest entries are incomplete: ${research.manifestProblems.join(", ")}`
      );
    }
    if (research.undiscoverable.length > 0) {
      failures.push(
        `tools are not discoverable by name: ${research.undiscoverable.join(", ")}`
      );
    }
    if (budget.requireManifest && !research.resourceUris.includes(budget.requireManifest)) {
      failures.push(`missing resource ${budget.requireManifest}`);
    }
    if (research.manifestToolCount < (budget.minManifestTools ?? 0)) {
      failures.push(
        `manifest has ${research.manifestToolCount} tools, expected at least ${budget.minManifestTools}`
      );
    }
    if (baseline && budget.minDefaultReductionPct !== undefined) {
      const base = baseline.surfaces?.full;
      if (base) {
        const reduction =
          ((base.combinedChars - research.combinedChars) / base.combinedChars) * 100;
        if (reduction < budget.minDefaultReductionPct) {
          failures.push(
            `default reduction ${reduction.toFixed(1)}% < ${budget.minDefaultReductionPct}%`
          );
        }
      }
    }
  }

  for (const [surface, result] of Object.entries(current)) {
    if (budget.instructionsMaxChars && result.instructionsChars > budget.instructionsMaxChars) {
      failures.push(
        `${surface} instructions ${result.instructionsChars} > ${budget.instructionsMaxChars}`
      );
    }
    const snapshot = budget.surfaces?.[surface];
    if (snapshot) {
      if (snapshot.toolCount !== undefined && result.toolCount !== snapshot.toolCount) {
        failures.push(
          `${surface} tool count ${result.toolCount} != budget ${snapshot.toolCount}`
        );
      }
      if (
        snapshot.definitionCharsMax !== undefined &&
        result.definitionChars > snapshot.definitionCharsMax
      ) {
        failures.push(
          `${surface} tool definition chars ${result.definitionChars} > ${snapshot.definitionCharsMax}`
        );
      }
    }
  }
  if (failures.length) {
    console.error("\nCONTEXT BUDGET FAILED");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\nContext budget checks passed.");
}

const options = parseArgs(process.argv.slice(2));
const measured = {};
for (const surface of options.surfaces) {
  measured[surface] = await measureSurface(surface);
}

const full = measured.full ?? (options.surfaces.includes("full") ? measured.full : null);
for (const result of Object.values(measured)) {
  printSurface(result, full);
}

const snapshot = {
  generatedAt: new Date().toISOString(),
  gitCommit: gitCommit(),
  serverVersion: "0.5.0",
  tokenizer: tokenizer.name,
  surfaces: measured,
};

if (options.out) {
  const outPath = path.resolve(root, options.out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(root, outPath)}`);
}

if (options.compare) {
  const baselinePath = path.resolve(root, options.compare);
  compare(JSON.parse(readFileSync(baselinePath, "utf8")), measured);
}

if (options.check) {
  runChecks(path.resolve(root, options.check), measured);
}

if (options.json) {
  console.log(JSON.stringify(snapshot, null, 2));
}
