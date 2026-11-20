import { TOOL_DESCRIPTIONS } from "./descriptions.js";

/** A tool group used by discovery, docs and the capability manifest. */
export type ToolCategory =
  | "browser"
  | "spaces"
  | "tabs"
  | "reading"
  | "evidence"
  | "interaction"
  | "layout"
  | "organization"
  | "history"
  | "coordination"
  | "sessions"
  | "templates"
  | "discovery";

/** The tool surface a client starts with. Ordered by breadth. */
export type ToolSurface = "research" | "core" | "full";

export const TOOL_SURFACES: readonly ToolSurface[] = ["research", "core", "full"];

export interface ToolMeta {
  name: string;
  category: ToolCategory;
  /** Surfaces this tool belongs to. Research and core are prefixes of full. */
  surfaces: readonly ToolSurface[];
}

/**
 * Research is the default. It covers the loop an agent repeats most often:
 * orient, open background sources, read and search them, verify quotes, and
 * hand the result back. Asking the user and collecting late answers are
 * decision support, so they live in Core; the gateway finds them when needed.
 */
const RESEARCH_TOOLS = [
  "zen_status",
  "zen_spaces_list",
  "zen_space_create",
  "zen_tabs_list",
  "zen_tabs_open",
  "zen_read_page",
  "zen_read_pages",
  "zen_find_text",
  "zen_search_tabs",
  "zen_show_evidence",
  "zen_show_evidence_batch",
  "zen_progress",
  "zen_events",
  "zen_config",
  "zen_notify",
  "zen_tools_search",
  "zen_tools_use",
] as const;

/**
 * Core adds operating the page and organizing the workspace: user questions,
 * interaction, layout, advanced tab control, folders, audit and evidence
 * cleanup. It still leaves history, watches, persistence and destructive
 * administration out.
 */
const CORE_ONLY_TOOLS = [
  "zen_ask",
  "zen_answers",
  "zen_launch",
  "zen_space_switch",
  "zen_tabs_close",
  "zen_tab_select",
  "zen_glance",
  "zen_split_view",
  "zen_split_close",
  "zen_pin_tabs",
  "zen_essentials",
  "zen_containers_list",
  "zen_folders_list",
  "zen_folder_create",
  "zen_folder_add_tabs",
  "zen_click",
  "zen_type",
  "zen_wait_for",
  "zen_clear_evidence",
  "zen_tabs_audit",
  "zen_tabs_group",
] as const;

/**
 * Full adds the long tail: history and bookmark lookup, monitoring, clipboard
 * handoff, audit review, session and template persistence, and space deletion.
 */
const FULL_ONLY_TOOLS = [
  "zen_space_delete",
  "zen_history_search",
  "zen_history_recently_closed",
  "zen_bookmarks_search",
  "zen_watch_add",
  "zen_watch_list",
  "zen_watch_remove",
  "zen_clipboard_write",
  "zen_audit_tail",
  "zen_session_save",
  "zen_session_list",
  "zen_session_restore",
  "zen_session_delete",
  "zen_space_templates",
  "zen_template_apply",
  "zen_template_save",
  "zen_template_delete",
] as const;

const CATEGORY_BY_TOOL: Record<string, ToolCategory> = {
  zen_status: "browser",
  zen_launch: "browser",
  zen_config: "browser",
  zen_audit_tail: "browser",
  zen_spaces_list: "spaces",
  zen_space_create: "spaces",
  zen_space_switch: "spaces",
  zen_space_delete: "spaces",
  zen_tabs_list: "tabs",
  zen_tabs_open: "tabs",
  zen_tabs_close: "tabs",
  zen_tab_select: "tabs",
  zen_pin_tabs: "tabs",
  zen_essentials: "tabs",
  zen_read_page: "reading",
  zen_read_pages: "reading",
  zen_find_text: "reading",
  zen_search_tabs: "reading",
  zen_show_evidence: "evidence",
  zen_show_evidence_batch: "evidence",
  zen_clear_evidence: "evidence",
  zen_click: "interaction",
  zen_type: "interaction",
  zen_wait_for: "interaction",
  zen_glance: "layout",
  zen_split_view: "layout",
  zen_split_close: "layout",
  zen_containers_list: "organization",
  zen_folders_list: "organization",
  zen_folder_create: "organization",
  zen_folder_add_tabs: "organization",
  zen_tabs_audit: "organization",
  zen_tabs_group: "organization",
  zen_history_search: "history",
  zen_history_recently_closed: "history",
  zen_bookmarks_search: "history",
  zen_progress: "coordination",
  zen_events: "coordination",
  zen_ask: "coordination",
  zen_answers: "coordination",
  zen_notify: "coordination",
  zen_watch_add: "coordination",
  zen_watch_list: "coordination",
  zen_watch_remove: "coordination",
  zen_clipboard_write: "coordination",
  zen_session_save: "sessions",
  zen_session_list: "sessions",
  zen_session_restore: "sessions",
  zen_session_delete: "sessions",
  zen_space_templates: "templates",
  zen_template_apply: "templates",
  zen_template_save: "templates",
  zen_template_delete: "templates",
  zen_tools_search: "discovery",
  zen_tools_use: "discovery",
};

/** Short, stable aliases that help keyword search without bloating the list. */
const KEYWORDS_BY_TOOL: Record<string, readonly string[]> = {
  zen_read_page: ["page", "extract", "content", "article", "text"],
  zen_read_pages: ["batch", "pages", "sources", "extract"],
  zen_find_text: ["find", "phrase", "occurrence"],
  zen_search_tabs: ["grep", "tabs", "mentions"],
  zen_show_evidence: ["cite", "citation", "quote", "verify"],
  zen_show_evidence_batch: ["cite", "citations", "batch", "verify"],
  zen_tabs_audit: ["duplicates", "stale", "cleanup", "triage"],
  zen_tabs_group: ["folders", "domains", "organize"],
  zen_folder_create: ["group", "folder", "organize"],
  zen_session_save: ["snapshot", "layout", "save"],
  zen_space_templates: ["template", "layout", "preset"],
  zen_watch_add: ["monitor", "change", "alert"],
  zen_tools_search: ["discover", "catalogue", "catalog", "capabilities", "help"],
  zen_tools_use: ["invoke", "gateway", "hidden", "publish"],
};

export const ALL_TOOL_NAMES: readonly string[] = [
  ...RESEARCH_TOOLS,
  ...CORE_ONLY_TOOLS,
  ...FULL_ONLY_TOOLS,
];

const RESEARCH_SET: ReadonlySet<string> = new Set(RESEARCH_TOOLS);
const CORE_ONLY_SET: ReadonlySet<string> = new Set(CORE_ONLY_TOOLS);

function surfacesFor(name: string): readonly ToolSurface[] {
  if (RESEARCH_SET.has(name)) {
    return ["research", "core", "full"];
  }
  if (CORE_ONLY_SET.has(name)) {
    return ["core", "full"];
  }
  return ["full"];
}

export const TOOL_META: Record<string, ToolMeta> = Object.fromEntries(
  ALL_TOOL_NAMES.map((name) => [
    name,
    {
      name,
      category: CATEGORY_BY_TOOL[name] ?? "browser",
      surfaces: surfacesFor(name),
    },
  ])
);

const SURFACE_SETS: Record<ToolSurface, ReadonlySet<string>> = {
  research: new Set(RESEARCH_TOOLS),
  core: new Set([...RESEARCH_TOOLS, ...CORE_ONLY_TOOLS]),
  full: new Set(ALL_TOOL_NAMES),
};

export function toolsForSurface(surface: ToolSurface): ReadonlySet<string> {
  return SURFACE_SETS[surface] ?? SURFACE_SETS.research;
}

export function surfaceOf(name: string): readonly ToolSurface[] {
  return TOOL_META[name]?.surfaces ?? [];
}

/** First paragraph, trimmed at a word boundary for search results. */
export function summaryOf(name: string, maxChars = 220): string {
  const text = TOOL_DESCRIPTIONS[name] ?? "";
  const first = text.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (first.length <= maxChars) return first;
  const cut = first.slice(0, maxChars);
  const space = cut.lastIndexOf(" ");
  return `${(space > 60 ? cut.slice(0, space) : cut).trim()}...`;
}

export interface CatalogMatch extends ToolMeta {
  summary: string;
  keywords: readonly string[];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Keyword search over names, summaries, categories and aliases. A name match
 * always outranks a body match so "read" can still find zen_read_page.
 */
export function searchCatalog(
  query: string,
  options: { category?: string; limit?: number } = {}
): CatalogMatch[] {
  const limit = Math.max(1, Math.min(50, options.limit ?? 12));
  const terms = normalize(query).split(" ").filter(Boolean);
  const category = options.category?.trim().toLowerCase();
  const matches: Array<CatalogMatch & { score: number }> = [];

  for (const name of ALL_TOOL_NAMES) {
    const meta = TOOL_META[name];
    if (!meta) continue;
    if (category && meta.category !== category) continue;
    const summary = summaryOf(name);
    const keywords = KEYWORDS_BY_TOOL[name] ?? [];
    const haystack = normalize(
      [name, summary, meta.category, ...keywords].join(" ")
    );
    let score = 0;
    if (terms.length === 0) {
      score = 1;
    } else {
      const normalizedName = normalize(name);
      if (normalizedName === terms.join(" ")) score += 100;
      if (terms.every((term) => normalizedName.includes(term))) score += 40;
      for (const term of terms) {
        if (normalizedName.includes(term)) score += 8;
        if (haystack.includes(term)) score += 3;
      }
    }
    if (score > 0) {
      matches.push({ ...meta, summary, keywords, score });
    }
  }

  return matches
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map(({ score: _score, ...entry }) => entry);
}

/**
 * Catalogue invariants. Returns human-readable problems; an empty array means
 * the surfaces, descriptions and metadata agree with each other.
 */
export function validateCatalog(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const name of ALL_TOOL_NAMES) {
    if (seen.has(name)) problems.push(`duplicate tool in catalog: ${name}`);
    seen.add(name);
    if (!TOOL_DESCRIPTIONS[name]) problems.push(`missing description: ${name}`);
    if (!CATEGORY_BY_TOOL[name]) problems.push(`missing category: ${name}`);
  }
  for (const name of Object.keys(TOOL_DESCRIPTIONS)) {
    if (!seen.has(name)) problems.push(`description without a tool: ${name}`);
  }
  for (const name of RESEARCH_TOOLS) {
    if (!SURFACE_SETS.core.has(name)) {
      problems.push(`research tool missing from core: ${name}`);
    }
  }
  for (const name of SURFACE_SETS.core) {
    if (!SURFACE_SETS.full.has(name)) problems.push(`core tool missing from full: ${name}`);
  }
  if (RESEARCH_TOOLS.length < 16 || RESEARCH_TOOLS.length > 19) {
    problems.push(
      `research surface has ${RESEARCH_TOOLS.length} tools; the budget is 16-19`
    );
  }
  for (const name of ALL_TOOL_NAMES) {
    const first = (TOOL_DESCRIPTIONS[name] ?? "").split(/\n\s*\n/)[0] ?? "";
    if (first.length > 400) {
      problems.push(`description first paragraph over 400 chars: ${name} (${first.length})`);
    }
  }
  return problems;
}
