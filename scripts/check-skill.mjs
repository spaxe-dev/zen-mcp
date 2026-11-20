#!/usr/bin/env node
/**
 * Validates the consumer-facing Zen MCP skill against the live tool surface.
 *
 * Checks:
 *  1. SKILL.md frontmatter is valid and matches its directory name.
 *  2. SKILL.md stays within the 2,000-token budget (conservative estimate).
 *  3. Every local link and referenced file exists.
 *  4. Every reference file is reachable from SKILL.md and self-describing.
 *  5. Every zen_* identifier exists as a tool or prompt; every zen:// URI exists.
 *  6. Every example argument name exists in that tool's input schema, and every
 *     enum literal is valid.
 *  7. No parked or nonexistent capability is presented as a tool.
 *  8. Contributor-only instructions are not copied into the consumer skill.
 *
 * Usage: node scripts/check-skill.mjs
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(root, "skills", "zen-mcp");
const skillPath = path.join(skillDir, "SKILL.md");
const TOKEN_BUDGET = 2000;

const failures = [];
const passes = [];

function check(name, ok, detail = "") {
  if (ok) {
    passes.push(name);
  } else {
    failures.push(detail ? `${name}: ${detail}` : name);
  }
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Parses the small YAML subset used by skill frontmatter. */
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  const fields = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    fields[key] = value;
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

/** Conservative token estimate: max(char/4, word*1.33). */
function estimateTokens(text) {
  const chars = text.length;
  const words = text.split(/\s+/).filter(Boolean).length;
  return {
    chars,
    words,
    estimate: Math.max(Math.ceil(chars / 4), Math.ceil(words * 1.33)),
  };
}

/** Finds local markdown links and backticked .md references. */
function localReferences(text) {
  const found = [];
  const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let match;
  while ((match = linkRe.exec(text))) {
    const target = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
    found.push(target.split("#")[0]);
  }
  const tickRe = /`([^`\s]+\.md)`/g;
  while ((match = tickRe.exec(text))) {
    found.push(match[1]);
  }
  return found.filter((target) => target && !target.includes("://"));
}

function resolveLocal(target, baseDirs) {
  for (const base of baseDirs) {
    const candidate = path.resolve(base, target);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Extracts `zen_tool({ ... })` call examples, including nested braces. */
function extractCalls(text) {
  const calls = [];
  const re = /\b(zen_[a-z0-9_]+)\(\s*\{/g;
  let match;
  while ((match = re.exec(text))) {
    const open = text.indexOf("{", match.index + match[1].length);
    let depth = 0;
    let quote = null;
    let i = open;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\") i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    calls.push({
      name: match[1],
      body: text.slice(open + 1, i),
      line: lineOf(text, match.index),
    });
    re.lastIndex = i;
  }
  return calls;
}

/** Splits an object body on top-level commas. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === "\\") {
        current += body[i + 1] ?? "";
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    if (ch === "}" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function keysAndValues(body) {
  const entries = [];
  for (const part of splitTopLevel(body)) {
    if (part.startsWith("...")) continue;
    const index = part.indexOf(":");
    if (index === -1) {
      const key = part.replace(/^["'`]|["'`]$/g, "").trim();
      entries.push({ key, value: undefined, raw: part });
      continue;
    }
    const key = part.slice(0, index).trim().replace(/^["'`]|["'`]$/g, "");
    entries.push({ key, value: part.slice(index + 1).trim(), raw: part });
  }
  return entries;
}

/**
 * Error codes that are not tools but are still legitimate to document. They
 * look like tool names because the server names them with the zen_ prefix.
 */
const ERROR_CODES = new Set(["zen_not_found", "zen_not_ready"]);

const FORBIDDEN_TOKENS = [
  "zen_screenshot",
  "zen_capture",
  "zen_read_selection",
  "zen_selection",
  "zen_update",
  "zen_install",
  "zen_attach",
  "zen_eval",
  "zen_script",
  "zen_upload",
  "zen_download",
  "zen_execute",
];

const CONTRIBUTOR_MARKERS = [
  "MUTATING_TOOLS",
  "src/mcp/",
  "npm run build",
  "npm test",
  "npm run test:zen",
  "docs/handoff/",
];

async function loadSurface() {
  if (!existsSync(path.join(root, "dist", "cli.js"))) {
    throw new Error(
      "dist/cli.js is missing. Run `npm run build` before checking the skill."
    );
  }
  const scratch = path.join(root, ".tmp", "skill-check");
  mkdirSync(scratch, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "cli.js"), "serve"],
    cwd: root,
    stderr: "pipe",
    env: {
      ...process.env,
      ZEN_MCP_NO_UPDATE_CHECK: "1",
      ZEN_MCP_CONFIG: path.join(scratch, "config.json"),
      ZEN_MCP_DATA_DIR: path.join(scratch, "data"),
    },
  });
  if (transport.stderr) {
    transport.stderr.on("data", () => {});
  }
  const client = new Client(
    { name: "zen-mcp-skill-check", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  try {
    const [tools, prompts, resources] = await Promise.all([
      client.listTools(),
      client.listPrompts(),
      client.listResources(),
    ]);
    const catalog = JSON.parse(
      (
        await client.readResource({ uri: "zen://capabilities" })
      ).contents?.find((entry) => "text" in entry)?.text ?? "{}"
    );
    const schemas = new Map();
    for (const entry of catalog.tools ?? []) {
      const result = await client.callTool({
        name: "zen_tools_search",
        arguments: { name: entry.name },
      });
      const text = result.content?.find((part) => part.type === "text")?.text ?? "{}";
      try {
        const parsed = JSON.parse(text);
        if (parsed?.tool?.inputSchema) schemas.set(entry.name, parsed.tool.inputSchema);
      } catch {
        // Reported as an unknown tool below.
      }
    }
    return {
      tools: tools.tools,
      prompts: prompts.prompts,
      resources: resources.resources,
      catalogTools: catalog.tools ?? [],
      schemas,
    };
  } finally {
    await client.close();
  }
}

async function main() {
  if (!existsSync(skillPath)) {
    console.error(`Missing ${path.relative(root, skillPath)}`);
    process.exit(1);
  }

  const skillText = readFileSync(skillPath, "utf8");
  const front = parseFrontmatter(skillText);
  check("frontmatter parses", front !== null, "expected a leading --- block");
  if (front) {
    const { fields } = front;
    const dirName = path.basename(skillDir);
    check("name present", Boolean(fields.name), "name is required");
    check("description present", Boolean(fields.description), "description is required");
    check(
      "name matches directory",
      fields.name === dirName,
      `frontmatter name "${fields.name}" vs directory "${dirName}"`
    );
    check(
      "name format",
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name ?? ""),
      "use lowercase letters, digits, and hyphens"
    );
    check(
      "description length",
      (fields.description ?? "").length <= 1024,
      "keep the description at or below 1024 characters"
    );
  }

  const budget = estimateTokens(skillText);
  check(
    "token budget",
    budget.estimate <= TOKEN_BUDGET,
    `estimated ${budget.estimate} tokens (max ${TOKEN_BUDGET}); ` +
      `${budget.chars} chars, ${budget.words} words`
  );

  // The operating manual must keep the sections the skill promises.
  const requiredSections = [
    "## Principles",
    "## Mental model",
    "## First move",
    "## Cheapest perception",
    "## Playbooks",
    "## Evidence discipline",
    "## Etiquette",
    "## Safety",
    "## Efficiency",
    "## Finish",
    "## References",
  ];
  const missingSections = requiredSections.filter(
    (section) => !skillText.includes(section)
  );
  check(
    "required sections present",
    missingSections.length === 0,
    missingSections.join(", ")
  );

  const playbookCount = (skillText.match(/^\d+\. \*\*/gm) ?? []).length;
  check(
    "playbook coverage",
    playbookCount >= 8,
    `found ${playbookCount} numbered playbooks, expected at least 8`
  );

  const files = walk(skillDir);
  const references = files
    .filter((file) => file.startsWith(path.join(skillDir, "references")))
    .sort();

  // Every local link and backticked .md reference must resolve.
  const bases = [skillDir, path.join(skillDir, "references"), root];
  const docFiles = files.filter((file) => file.endsWith(".md"));
  const unresolved = [];
  for (const file of docFiles) {
    const text = readFileSync(file, "utf8");
    for (const target of localReferences(text)) {
      if (!resolveLocal(target, bases)) {
        unresolved.push(`${path.relative(skillDir, file)} -> ${target}`);
      }
    }
  }
  check("local links resolve", unresolved.length === 0, unresolved.join("; "));

  // Progressive disclosure: every reference is linked from SKILL.md.
  const orphaned = references.filter((file) => {
    const name = path.basename(file);
    return !skillText.includes(name);
  });
  check(
    "references linked from SKILL.md",
    orphaned.length === 0,
    orphaned.map((file) => path.basename(file)).join(", ")
  );

  // Each reference explains when to read it.
  const missingWhen = references.filter((file) => {
    const text = readFileSync(file, "utf8");
    return !/read this when/i.test(text);
  });
  check(
    "references state when to read",
    missingWhen.length === 0,
    missingWhen.map((file) => path.basename(file)).join(", ")
  );

  // Contributor material must not leak into the consumer skill.
  const leaked = [];
  for (const file of docFiles) {
    const text = readFileSync(file, "utf8");
    for (const marker of CONTRIBUTOR_MARKERS) {
      if (text.includes(marker)) {
        leaked.push(`${path.relative(skillDir, file)} contains "${marker}"`);
      }
    }
  }
  check("no contributor-only instructions", leaked.length === 0, leaked.join("; "));

  let surface;
  try {
    surface = await loadSurface();
  } catch (error) {
    console.error(`Could not read the MCP surface: ${error.message}`);
    process.exit(1);
  }

  const toolNames = new Set(surface.catalogTools.map((tool) => tool.name));
  const promptNames = new Set(surface.prompts.map((prompt) => prompt.name));
  const resourceUris = new Set(surface.resources.map((entry) => entry.uri));
  const documentedTools = surface.schemas;

  // Every zen_* identifier is a real tool or prompt.
  const identifiers = new Set();
  const uriMentions = new Set();
  for (const file of docFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bzen_[a-z0-9_]+\b/g)) {
      identifiers.add(match[0]);
    }
    for (const match of text.matchAll(/\bzen:\/\/[a-z0-9_-]+\b/g)) {
      uriMentions.add(match[0]);
    }
  }
  const unknown = [...identifiers].filter(
    (name) =>
      !toolNames.has(name) && !promptNames.has(name) && !ERROR_CODES.has(name)
  );
  check("documented tools and prompts exist", unknown.length === 0, unknown.join(", "));

  const unknownUris = [...uriMentions].filter((uri) => !resourceUris.has(uri));
  check("documented resources exist", unknownUris.length === 0, unknownUris.join(", "));

  // Parked or nonexistent capabilities must not appear as identifiers.
  const forbidden = [...identifiers].filter((name) =>
    FORBIDDEN_TOKENS.includes(name)
  );
  check("no parked capability names", forbidden.length === 0, forbidden.join(", "));

  // Example arguments must exist in the tool schema, with valid enums.
  const badArgs = [];
  const badEnums = [];
  for (const file of docFiles) {
    const text = readFileSync(file, "utf8");
    for (const call of extractCalls(text)) {
      const schema = documentedTools.get(call.name);
      if (!schema) continue; // tool existence is reported above
      const properties = schema.properties ?? {};
      for (const entry of keysAndValues(call.body)) {
        if (!entry.key || !/^[A-Za-z_$][\w$]*$/.test(entry.key)) continue;
        if (!(entry.key in properties)) {
          badArgs.push(
            `${path.relative(skillDir, file)}:${call.line} ${call.name} unknown argument "${entry.key}"`
          );
          continue;
        }
        const prop = properties[entry.key];
        const literal = entry.value?.match(/^["']([^"']*)["']$/);
        if (literal && Array.isArray(prop?.enum) && !prop.enum.includes(literal[1])) {
          badEnums.push(
            `${path.relative(skillDir, file)}:${call.line} ${call.name}.${entry.key}="${literal[1]}" not in ${prop.enum.join("|")}`
          );
        }
        // Validate nested citation objects for the evidence batch.
        if (entry.key === "citations" && Array.isArray(prop?.items?.properties)) {
          const itemProps = prop.items.properties;
          for (const nested of entry.value.matchAll(/\{([^{}]*)\}/g)) {
            for (const nestedEntry of keysAndValues(nested[1])) {
              if (!nestedEntry.key || !/^[A-Za-z_$][\w$]*$/.test(nestedEntry.key)) continue;
              if (!(nestedEntry.key in itemProps)) {
                badArgs.push(
                  `${path.relative(skillDir, file)}:${call.line} ${call.name}.citations unknown argument "${nestedEntry.key}"`
                );
              }
            }
          }
        }
      }
    }
  }
  check("example arguments match schemas", badArgs.length === 0, badArgs.join("; "));
  check("example enum values are valid", badEnums.length === 0, badEnums.join("; "));

  for (const name of passes) {
    console.log(`ok   ${name}`);
  }
  console.log(
    `\nSKILL.md estimate: ${budget.estimate} tokens ` +
      `(${budget.chars} chars, ${budget.words} words; budget ${TOKEN_BUDGET}).`
  );
  console.log(
    `Catalog: ${surface.catalogTools.length} tools, ${surface.prompts.length} prompts, ` +
      `${surface.resources.length} resources; exposed: ${surface.tools.length} tools.`
  );

  if (failures.length) {
    console.error("\nFAIL");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  console.log("\nAll skill checks passed.");
}

await main();
