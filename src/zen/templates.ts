import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWritePrivate,
  readFileTextBounded,
} from "../utils/safe-file.js";
import type {
  CreateFolderParams,
  CreateFolderResult,
  CreateSpaceParams,
  CreateSpaceResult,
  FoldersResult,
  OpenedTab,
  OpenTabsParams,
  OpenTabsResult,
  Space,
  SpacesResult,
  TabsListParams,
  TabsResult,
} from "../shared/protocol.js";

const FILE_NAME = "templates.json";
const BATCH_SIZE = 30;
const MAX_NAME_LENGTH = 64;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_USER_TEMPLATES = 100;
const MAX_FOLDERS_PER_TEMPLATE = 100;
const MAX_URLS_PER_TEMPLATE = 2000;
const MAX_URL_LENGTH = 4096;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_ICON_LENGTH = 200;
const MAX_CREATED_AT_LENGTH = 64;

export interface SpaceTemplateFolder {
  label: string;
  urls: string[];
}

export interface SpaceTemplate {
  name: string;
  label: string;
  description: string;
  icon: string | null;
  builtIn: boolean;
  createdAt?: string;
  folders: SpaceTemplateFolder[];
  looseUrls: string[];
}

export interface TemplateApplyResult {
  template: string;
  space: Space;
  tabsOpened: number;
  foldersCreated: number;
  tabsFailed: number;
  warnings: string[];
}

export interface TemplateSaveOptions {
  description?: string;
  icon?: string;
  windowId?: string;
}

export interface TemplateApplyOptions {
  spaceName?: string;
  switchTo?: boolean;
  windowId?: string;
}

/** Only the hub calls this module needs. */
export interface TemplateHub {
  listSpaces(windowId?: string): Promise<SpacesResult>;
  listTabs(params: TabsListParams, windowId?: string): Promise<TabsResult>;
  listFolders(windowId?: string): Promise<FoldersResult>;
  createSpace(
    params: CreateSpaceParams,
    windowId?: string
  ): Promise<CreateSpaceResult>;
  openTabs(params: OpenTabsParams, windowId?: string): Promise<OpenTabsResult>;
  createFolder(
    params: CreateFolderParams,
    windowId?: string
  ): Promise<CreateFolderResult>;
}

export interface TemplateStoreOptions {
  /** Directory that holds templates.json. */
  dir: string;
  hub: TemplateHub;
}

interface TemplatesFile {
  version: 1;
  templates: SpaceTemplate[];
}

function template(
  name: string,
  label: string,
  description: string,
  icon: string,
  folders: SpaceTemplateFolder[],
  looseUrls: string[]
): SpaceTemplate {
  return {
    name,
    label,
    description,
    icon,
    builtIn: true,
    folders,
    looseUrls,
  };
}

export const BUILTIN_TEMPLATES: SpaceTemplate[] = [
  template(
    "research",
    "Research",
    "Sources for a literature scan: reference works, preprints and citation indexes.",
    "🔬",
    [
      {
        label: "Sources",
        urls: [
          "https://en.wikipedia.org",
          "https://arxiv.org",
          "https://scholar.google.com",
          "https://www.semanticscholar.org",
        ],
      },
    ],
    []
  ),
  template(
    "github-triage",
    "GitHub Triage",
    "Notifications, pull requests, issues and workflow runs for the repos you watch.",
    "🐙",
    [
      {
        label: "Review",
        urls: [
          "https://github.com/notifications",
          "https://github.com/pulls",
          "https://github.com/issues",
        ],
      },
      {
        label: "CI",
        urls: ["https://github.com/actions"],
      },
    ],
    []
  ),
  template(
    "news",
    "News",
    "A quick briefing from a tech aggregator and three general news wires.",
    "📰",
    [],
    [
      "https://news.ycombinator.com",
      "https://www.reuters.com",
      "https://apnews.com",
      "https://www.bbc.com/news",
    ]
  ),
  template(
    "docs",
    "Docs",
    "Everyday web development references: platform docs, compatibility and answers.",
    "📚",
    [],
    [
      "https://developer.mozilla.org",
      "https://caniuse.com",
      "https://stackoverflow.com",
    ]
  ),
];

export class TemplateStore {
  readonly #dir: string;
  readonly #hub: TemplateHub;
  #warnedInvalid = false;

  constructor(options: TemplateStoreOptions) {
    this.#dir = options.dir;
    this.#hub = options.hub;
  }

  /** Absolute path of the templates file. */
  get path(): string {
    return join(this.#dir, FILE_NAME);
  }

  /** Built-in templates first, then user templates in save order. */
  list(): SpaceTemplate[] {
    return [
      ...BUILTIN_TEMPLATES.map(cloneTemplate),
      ...this.#read().templates.map(cloneTemplate),
    ];
  }

  get(name: string): SpaceTemplate | null {
    const key = name.trim().toLowerCase();
    const found = this.list().find(
      (entry) => entry.name.toLowerCase() === key
    );
    return found ?? null;
  }

  /** Turn a live space into a reusable user template. */
  async saveFromSpace(
    spaceName: string,
    name: string,
    options: TemplateSaveOptions = {}
  ): Promise<SpaceTemplate> {
    const display = validateName(name);
    if (this.get(display)) {
      throw new Error(`A template named "${display}" already exists.`);
    }

    const windowId = options.windowId;
    const spacesResult = await this.#hub.listSpaces(windowId);
    const key = spaceName.trim().toLowerCase();
    const space = spacesResult.spaces.find(
      (entry) =>
        entry.id === spaceName || entry.name.toLowerCase() === key
    );
    if (!space) {
      throw new Error(`Space "${spaceName.trim()}" not found.`);
    }

    const [tabsResult, foldersResult] = await Promise.all([
      this.#hub.listTabs(
        { space: space.id, limit: MAX_URLS_PER_TEMPLATE },
        windowId
      ),
      this.#hub.listFolders(windowId),
    ]);
    if (tabsResult.total > tabsResult.tabs.length) {
      throw new Error(
        `Space "${space.name}" has ${tabsResult.total} tabs; a template can ` +
          `hold at most ${MAX_URLS_PER_TEMPLATE}.`
      );
    }
    const folderById = new Map(
      foldersResult.folders.map((folder) => [folder.id, folder])
    );
    const folders = new Map<string, string[]>();
    const looseUrls: string[] = [];

    const tabs = tabsResult.tabs
      .filter((tab) => !tab.essential)
      .sort((a, b) => a.index - b.index);
    for (const tab of tabs) {
      const url = httpUrl(tab.url);
      if (!url) continue;
      const folderRecord = tab.folderId
        ? folderById.get(tab.folderId)
        : undefined;
      const label = folderRecord?.label ?? tab.folderLabel ?? null;
      if (label) {
        const urls = folders.get(label) ?? [];
        urls.push(url);
        folders.set(label, urls);
      } else {
        looseUrls.push(url);
      }
    }

    const saved: SpaceTemplate = {
      name: display,
      label: display,
      description: boundedText(
        options.description,
        MAX_DESCRIPTION_LENGTH
      ),
      icon: boundedText(options.icon, MAX_ICON_LENGTH) || null,
      builtIn: false,
      createdAt: new Date().toISOString(),
      folders: Array.from(folders, ([label, urls]) => ({ label, urls })),
      looseUrls,
    };

    this.#commit((current) => {
      if (findUserTemplate(current, display)) {
        throw new Error(`A template named "${display}" already exists.`);
      }
      if (current.templates.length >= MAX_USER_TEMPLATES) {
        throw new Error(
          `Template storage holds at most ${MAX_USER_TEMPLATES} templates. ` +
            "Delete one first."
        );
      }
      current.templates.push(saved);
    });
    return cloneTemplate(saved);
  }

  /** Remove a user template. Built-ins cannot be deleted. */
  delete(name: string): boolean {
    const key = name.trim().toLowerCase();
    if (
      BUILTIN_TEMPLATES.some(
        (entry) => entry.name.toLowerCase() === key
      )
    ) {
      throw new Error(`Built-in template "${name.trim()}" cannot be deleted.`);
    }
    let removed = false;
    this.#commit((file) => {
      const index = file.templates.findIndex(
        (entry) => entry.name.toLowerCase() === key
      );
      if (index === -1) return;
      file.templates.splice(index, 1);
      removed = true;
    });
    return removed;
  }

  /** Create a new space from a template. Partial failures become warnings. */
  async apply(
    name: string,
    options: TemplateApplyOptions = {}
  ): Promise<TemplateApplyResult> {
    const template = this.get(name);
    if (!template) {
      throw new Error(`Template "${name.trim()}" not found.`);
    }

    const windowId = options.windowId;
    const spacesResult = await this.#hub.listSpaces(windowId);
    const taken = new Set(
      spacesResult.spaces.map((space) => space.name.toLowerCase())
    );
    const desired = (options.spaceName?.trim() || template.label || template.name)
      .slice(0, MAX_NAME_LENGTH);
    const created = await this.#hub.createSpace(
      {
        name: uniqueSpaceName(desired, taken),
        ...(template.icon ? { icon: template.icon } : {}),
        switchTo: options.switchTo ?? false,
      },
      windowId
    );
    const space = created.space;
    const warnings: string[] = [];
    let tabsOpened = 0;
    let tabsFailed = 0;
    let foldersCreated = 0;

    const openUrls = async (
      urls: string[],
      label: string
    ): Promise<OpenedTab[]> => {
      const opened: OpenedTab[] = [];
      for (let start = 0; start < urls.length; start += BATCH_SIZE) {
        const batch = urls.slice(start, start + BATCH_SIZE);
        try {
          const result = await this.#hub.openTabs(
            {
              urls: batch,
              space: space.id,
              background: true,
              switchTo: false,
            },
            windowId
          );
          tabsOpened += result.tabs.length;
          opened.push(...result.tabs);
        } catch (error) {
          tabsFailed += batch.length;
          warnings.push(
            `Could not open ${batch.length} tab(s) for ${label}: ${messageOf(
              error
            )}`
          );
        }
      }
      return opened;
    };

    const valid = (urls: string[], label: string): string[] => {
      const accepted: string[] = [];
      for (const url of urls) {
        const normalized = httpUrl(url);
        if (normalized) {
          accepted.push(normalized);
        } else {
          tabsFailed += 1;
          warnings.push(
            `Skipped non-http(s) URL "${url}" in ${label}.`
          );
        }
      }
      return accepted;
    };

    const loose = valid(template.looseUrls, `template "${template.name}"`);
    if (loose.length > 0) {
      await openUrls(loose, `template "${template.name}"`);
    }

    for (const folder of template.folders) {
      const urls = valid(
        folder.urls,
        `folder "${folder.label}" of template "${template.name}"`
      );
      if (urls.length === 0) continue;
      const opened = await openUrls(
        urls,
        `folder "${folder.label}" of template "${template.name}"`
      );
      if (opened.length === 0) continue;
      try {
        const result = await this.#hub.createFolder(
          {
            label: folder.label,
            tabIds: opened.map((tab) => tab.id),
            space: space.id,
            collapsed: false,
          },
          windowId
        );
        if (result.created) foldersCreated += 1;
      } catch (error) {
        warnings.push(
          `Could not create folder "${folder.label}": ${messageOf(error)}`
        );
      }
    }

    return {
      template: template.name,
      space,
      tabsOpened,
      foldersCreated,
      tabsFailed,
      warnings,
    };
  }

  #read(): TemplatesFile {
    const file = this.path;
    if (!existsSync(file)) return { version: 1, templates: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileTextBounded(file, MAX_FILE_BYTES));
    } catch (error) {
      throw new Error(
        `Could not parse ${file}: ${messageOf(error)}. Fix or delete the file.`
      );
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as TemplatesFile).templates)
    ) {
      throw new Error(
        `Could not read ${file}: expected { "version": 1, "templates": [] }. Fix or delete the file.`
      );
    }
    const { templates, skipped } = sanitizeTemplates(
      (parsed as TemplatesFile).templates
    );
    if (skipped > 0 && !this.#warnedInvalid) {
      this.#warnedInvalid = true;
      console.error(
        `zen-mcp: ignored ${skipped} invalid template ` +
          `${skipped === 1 ? "entry" : "entries"} in ${file}.`
      );
    }
    return { version: 1, templates };
  }

  #commit(mutate: (file: TemplatesFile) => void): void {
    const file = this.#read();
    mutate(file);
    this.#write(file);
  }

  #write(file: TemplatesFile): void {
    const text = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
      throw new Error(
        `The templates file would exceed ${MAX_FILE_BYTES} bytes. Delete old ` +
          "templates before saving a new one."
      );
    }
    atomicWritePrivate(this.path, text);
  }
}

/** Desired name, then " 2", " 3", ... until it is free. */
function uniqueSpaceName(desired: string, taken: Set<string>): string {
  const base = desired || "Space";
  if (!taken.has(base.toLowerCase())) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function validateName(name: string): string {
  const display = name.trim();
  if (!display) throw new Error("Template name cannot be empty.");
  if (display.length > MAX_NAME_LENGTH) {
    throw new Error(
      `Template name must be ${MAX_NAME_LENGTH} characters or fewer.`
    );
  }
  return display;
}

/** Trim and accept only http(s) URLs. */
function httpUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? value
      : null;
  } catch {
    return null;
  }
}

function cloneTemplate(value: SpaceTemplate): SpaceTemplate {
  return {
    ...value,
    folders: value.folders.map((folder) => ({
      label: folder.label,
      urls: [...folder.urls],
    })),
    looseUrls: [...value.looseUrls],
  };
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps the string but rejects empty or oversized URLs for storage. */
function boundUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
  return trimmed;
}

function sanitizeUrls(value: unknown, limit: number): string[] {
  if (!Array.isArray(value) || limit <= 0) return [];
  const urls: string[] = [];
  for (const entry of value.slice(0, limit)) {
    const url = boundUrl(entry);
    if (url) urls.push(url);
  }
  return urls;
}

function sanitizeUserTemplate(value: unknown): SpaceTemplate | null {
  if (!isRecord(value)) return null;
  const name = boundedText(value.name, MAX_NAME_LENGTH);
  if (!name) return null;
  if (
    BUILTIN_TEMPLATES.some(
      (entry) => entry.name.toLowerCase() === name.toLowerCase()
    )
  ) {
    return null;
  }
  let budget = MAX_URLS_PER_TEMPLATE;
  const folders: SpaceTemplateFolder[] = [];
  const rawFolders = Array.isArray(value.folders) ? value.folders : [];
  for (const rawFolder of rawFolders.slice(0, MAX_FOLDERS_PER_TEMPLATE)) {
    if (budget <= 0 || !isRecord(rawFolder)) continue;
    const urls = sanitizeUrls(rawFolder.urls, budget);
    budget -= urls.length;
    folders.push({
      label: boundedText(rawFolder.label, MAX_NAME_LENGTH) || "Folder",
      urls,
    });
  }
  const createdAt = boundedText(value.createdAt, MAX_CREATED_AT_LENGTH);
  return {
    name,
    label: boundedText(value.label, MAX_NAME_LENGTH) || name,
    description: boundedText(value.description, MAX_DESCRIPTION_LENGTH),
    icon: boundedText(value.icon, MAX_ICON_LENGTH) || null,
    builtIn: false,
    ...(createdAt ? { createdAt } : {}),
    folders,
    looseUrls: sanitizeUrls(value.looseUrls, budget),
  };
}

function sanitizeTemplates(value: unknown[]): {
  templates: SpaceTemplate[];
  skipped: number;
} {
  const templates: SpaceTemplate[] = [];
  let skipped = 0;
  for (const entry of value) {
    if (templates.length >= MAX_USER_TEMPLATES) {
      skipped += 1;
      continue;
    }
    const template = sanitizeUserTemplate(entry);
    if (!template) {
      skipped += 1;
      continue;
    }
    templates.push(template);
  }
  return { templates, skipped };
}

function findUserTemplate(
  file: TemplatesFile,
  name: string
): SpaceTemplate | undefined {
  const key = name.trim().toLowerCase();
  return file.templates.find(
    (entry) => entry.name.toLowerCase() === key
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
