import { z } from "zod";
import {
  AGENT_EVENT_KINDS,
  BROWSER_EVENT_PHASES,
  WAIT_CONDITIONS,
  WAIT_ELEMENT_STATES,
  WAIT_UNTIL,
} from "../shared/protocol.js";
import { PAGE_CLASSIFICATIONS } from "../shared/semantic.js";

/**
 * Output schemas for every registered tool. `guarded` returns the handler
 * value as `structuredContent`, so each shape below describes that value.
 *
 * Shapes stay deliberately permissive: browser payloads use loose objects so a
 * newer bridge can add fields, and only fields the handlers always set are
 * required. Nothing here is strict, so unknown keys never fail a call.
 */

const activityToneSchema = z.enum(["info", "success", "warning"]);

const answerStatusSchema = z.enum([
  "answered",
  "deferred",
  "pending",
  "unavailable",
]);

const readFormatSchema = z.enum([
  "text",
  "markdown",
  "links",
  "tables",
  "metadata",
  "outline",
  "interactive",
  "snapshot",
  "semantic",
]);

const classificationSchema = z.enum(PAGE_CLASSIFICATIONS);

const semanticRegionSchema = z.looseObject({
  id: z.string(),
  role: z.string(),
  label: z.string().nullable().optional(),
  labelSource: z
    .enum(["aria", "html", "heading", "inferred"])
    .optional(),
  heading: z.string().nullable().optional(),
  parent: z.string().nullable().optional(),
  ref: z.string().nullable().optional(),
  controls: z.number().optional(),
  links: z.number().optional(),
  items: z.number().nullable().optional(),
  itemKind: z.enum(["cards", "results", "links", "items"]).optional(),
});

const semanticPageSchema = z.looseObject({
  classification: classificationSchema,
  confidence: z.number(),
  signals: z.array(z.string()),
  primaryRegion: z.string().nullable(),
  regions: z.array(semanticRegionSchema),
  headings: z.array(
    z.looseObject({
      level: z.number(),
      text: z.string(),
      ref: z.string().nullable(),
    })
  ),
  collections: z.array(
    z.looseObject({
      regionId: z.string(),
      kind: z.string(),
      count: z.number(),
      sample: z.array(z.looseObject({ ref: z.string(), label: z.string() })),
    })
  ),
  dialogs: z.array(
    z.looseObject({
      ref: z.string(),
      label: z.string(),
      modal: z.boolean(),
    })
  ),
  coverage: z.looseObject({
    complete: z.boolean(),
    nodes: z.number(),
    regions: z.number(),
    regionsTruncated: z.boolean(),
    controls: z.number(),
    links: z.number(),
    headings: z.number(),
    tables: z.number(),
    images: z.number(),
    missingAlt: z.number(),
    shadowRoots: z.number(),
  }),
  limitations: z.array(z.string()),
});

const uiOptionSchema = z.looseObject({
  label: z.string(),
  value: z.string().optional(),
  description: z.string().optional(),
});

const uiQuestionSchema = z.looseObject({
  id: z.string(),
  question: z.string(),
  context: z.string().optional(),
  options: z.array(uiOptionSchema),
  allowFreeform: z.boolean(),
  multiSelect: z.boolean(),
  createdAt: z.number(),
});

/** Shared by both answer lists, so the definition serializes once. */
const answerRecordSchema = z
  .looseObject({
    question: uiQuestionSchema,
    status: answerStatusSchema,
    askedAt: z.number(),
    answeredAt: z.number().optional(),
    answer: z.string().optional(),
    selectedLabels: z.array(z.string()).optional(),
    freeform: z.boolean().optional(),
  })
  .meta({ id: "answerRecord" });

const sessionInfoSchema = z.looseObject({
  ownsBrowser: z.boolean(),
  browserPid: z.number().nullable(),
  profile: z.string().nullable(),
  launchedAt: z.number().nullable(),
  lockedDown: z.boolean(),
  paused: z.boolean(),
  consent: z.enum(["none", "pending", "granted", "denied"]),
});

const injectionSummarySchema = z.looseObject({
  windows: z.number(),
  injected: z.number(),
  reused: z.number(),
  reconnected: z.number(),
  pending: z.number(),
  errors: z.array(z.string()),
});

const spaceInfoSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  active: z.boolean(),
  index: z.number(),
  containerTabId: z.number(),
  tabCount: z.number(),
  pinnedCount: z.number(),
  folderCount: z.number(),
});

const spaceSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  active: z.boolean(),
  index: z.number(),
  containerTabId: z.number(),
});

const tabSchema = z.looseObject({
  id: z.string(),
  windowId: z.string(),
  spaceId: z.string().nullable(),
  spaceName: z.string().nullable(),
  title: z.string(),
  url: z.string(),
  requestedUrl: z.string().optional(),
  pinned: z.boolean(),
  essential: z.boolean(),
  active: z.boolean(),
  audible: z.boolean(),
  muted: z.boolean(),
  loading: z.boolean(),
  folderId: z.string().nullable(),
  folderLabel: z.string().nullable(),
  index: z.number(),
  lastAccessed: z.number().nullable().optional(),
  containerId: z.number().nullable().optional(),
  splitView: z.boolean().optional(),
});

/** The identity of a freshly opened tab; full state belongs to zen_tabs_list. */
const openedTabSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  spaceId: z.string().nullable(),
  pinned: z.boolean(),
  folderId: z.string().nullable(),
  requestedUrl: z.string().optional(),
});

const folderInfoSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  spaceId: z.string(),
  collapsed: z.boolean(),
  parentId: z.string().nullable(),
  tabIds: z.array(z.string()),
  liveFolder: z.boolean(),
});

const containerInfoSchema = z.looseObject({
  userContextId: z.number(),
  name: z.string(),
  icon: z.string(),
  color: z.string(),
  public: z.boolean(),
});

const historyEntrySchema = z.looseObject({
  title: z.string(),
  url: z.string(),
  lastVisited: z.string().nullable(),
  visitCount: z.number(),
  domain: z.string().optional(),
});

const pageLinkSchema = z.looseObject({
  text: z.string(),
  url: z.string(),
});

const pageTableSchema = z.looseObject({
  caption: z.string().nullable(),
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});

const pageHeadingSchema = z.looseObject({
  level: z.number(),
  text: z.string(),
});

const pageMetadataSchema = z.looseObject({
  title: z.string(),
  description: z.string().nullable(),
  canonical: z.string().nullable(),
  lang: z.string().nullable(),
  published: z.string().nullable(),
  siteName: z.string().nullable(),
});

const pageElementSchema = z.looseObject({
  ref: z.string(),
  tag: z.string(),
  role: z.string(),
  type: z.string().nullable(),
  label: z.string(),
  value: z.string().nullable().optional(),
  sensitive: z.boolean(),
  editable: z.boolean(),
  valuePresent: z.boolean().optional(),
  autocomplete: z.string().nullable().optional(),
  selected: z.boolean().nullable().optional(),
  form: z.string().nullable().optional(),
  framePath: z.array(z.number()).optional(),
});

const pageFrameSchema = z.looseObject({
  path: z.array(z.number()),
  url: z.string(),
  name: z.string(),
});

/**
 * The resolved control an action landed on. Fields are declared optional: the
 * node is re-read after input, and a replaced or detached control can come
 * back partially described.
 */
const pageActionTargetSchema = z
  .looseObject({
    tag: z.string(),
    role: z.string(),
    label: z.string(),
    type: z.string().nullable(),
    sensitive: z.boolean(),
  })
  .partial();

/** Bounded control descriptors inside a delta, from src/shared/delta.ts. */
const actionControlBriefSchema = z
  .looseObject({
    role: z.string(),
    name: z.string(),
    type: z.string().nullable(),
  })
  .partial();

/**
 * Observed structural changes after an action, from PageActionDelta. The
 * declarations stay optional: an observation is advisory, and a probe failure
 * or replaced document can return a reduced delta.
 */
const pageActionDeltaSchema = z
  .looseObject({
    addedControls: z.array(actionControlBriefSchema),
    removedControls: z.array(actionControlBriefSchema),
    changedControls: z.array(
      z
        .looseObject({
          role: z.string(),
          name: z.string(),
          type: z.string().nullable(),
          changes: z.array(z.string()),
        })
        .partial()
    ),
    addedHeadings: z.array(z.string()),
    removedHeadings: z.array(z.string()),
    addedAlerts: z.array(z.string()),
    removedAlerts: z.array(z.string()),
    textChanged: z.boolean(),
    textLengthDelta: z.number(),
    readyState: z.string(),
    limitation: z.string().optional(),
  })
  .partial();

/** Same advisory rule: a probe failure reports a reduced effect. */
const pageActionEffectSchema = z
  .looseObject({
    changed: z.boolean(),
    urlChanged: z.boolean(),
    titleChanged: z.boolean(),
    domChanged: z.boolean(),
    valueChanged: z.boolean(),
    waitedMs: z.number(),
    probeFailed: z.boolean().optional(),
    navigation: z.boolean().optional(),
    documentReplaced: z.boolean().optional(),
    readyState: z.string().optional(),
    attribution: z.literal("observed_after_action_not_proven").optional(),
    delta: pageActionDeltaSchema.optional(),
  })
  .partial();

/** Structured failure returned beside the legacy text block on isError. */
export const toolErrorSchema = z
  .looseObject({
    code: z.string(),
    message: z.string(),
    category: z.enum([
      "not_found",
      "stale_reference",
      "document_changed",
      "ambiguous",
      "not_actionable",
      "invalid_target",
      "unsupported",
      "permission",
      "browser",
      "action_failed",
      "internal",
    ]),
    retryable: z.boolean(),
    stateChanged: z.boolean().nullable(),
    recovery: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .partial();

const clickOutputSchema = z
  .looseObject({
    clicked: z.boolean().optional(),
    tabId: z.string().optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    target: pageActionTargetSchema.optional(),
    effect: pageActionEffectSchema.optional(),
    framePath: z.array(z.number()).optional(),
    frameUrl: z.string().nullable().optional(),
    error: toolErrorSchema.optional(),
  })
  .refine(
    (value) =>
      value.error !== undefined ||
      (value.clicked !== undefined &&
        value.tabId !== undefined &&
        value.url !== undefined &&
        value.title !== undefined &&
        value.target !== undefined),
    { message: "A click result needs either an error or the success fields." }
  );

const typeOutputSchema = z
  .looseObject({
    typed: z.number().optional(),
    cleared: z.boolean().optional(),
    tabId: z.string().optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    target: pageActionTargetSchema.optional(),
    effect: pageActionEffectSchema.optional(),
    framePath: z.array(z.number()).optional(),
    frameUrl: z.string().nullable().optional(),
    observed: z
      .looseObject({
        compared: z.boolean(),
        matchesInput: z.boolean().nullable(),
        sensitive: z.boolean(),
      })
      .optional(),
    error: toolErrorSchema.optional(),
  })
  .refine(
    (value) =>
      value.error !== undefined ||
      (value.typed !== undefined &&
        value.tabId !== undefined &&
        value.url !== undefined &&
        value.title !== undefined &&
        value.target !== undefined),
    { message: "A type result needs either an error or the success fields." }
  );

const waitForShape = {
  matched: z.boolean(),
  waitedMs: z.number(),
  condition: z.enum(WAIT_CONDITIONS),
  until: z.enum(WAIT_UNTIL),
  query: z.string(),
  tabId: z.string(),
  url: z.string(),
  title: z.string(),
  framePath: z.array(z.number()).optional(),
  frameUrl: z.string().nullable().optional(),
  state: z.enum(WAIT_ELEMENT_STATES).optional(),
  documentId: z.string().optional(),
  newTabId: z.string().optional(),
  limitation: z.string().optional(),
};

const pageReadShape = {
  title: z.string(),
  url: z.string(),
  selectedText: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  length: z.number(),
  offset: z.number(),
  nextOffset: z.number().nullable(),
  limitation: z.string().optional(),
  description: z.string().nullable(),
  format: readFormatSchema.optional(),
  contentType: z.string().nullable().optional(),
  selector: z.string().nullable().optional(),
  markdown: z.string().optional(),
  links: z.array(pageLinkSchema).optional(),
  tables: z.array(pageTableSchema).optional(),
  metadata: pageMetadataSchema.optional(),
  outline: z.array(pageHeadingSchema).optional(),
  semantic: semanticPageSchema.optional(),
  elements: z.array(pageElementSchema).optional(),
  elementsTruncated: z.boolean().optional(),
  snapshotId: z.string().optional(),
  elementsTotal: z.number().optional(),
  snapshotComplete: z.boolean().optional(),
  textTruncated: z.boolean().optional(),
  outlineTruncated: z.boolean().optional(),
  framesComplete: z.boolean().optional(),
  limitations: z.array(z.string()).optional(),
  framePath: z.array(z.number()).optional(),
  frames: z.array(pageFrameSchema).optional(),
};

const pageReadSchema = z.looseObject(pageReadShape);

/**
 * Batch reads return the same page object, but repeating the full interactive
 * and metadata schemas once per entry dominates the tool definition. Keep the
 * stable page envelope here; extra fields remain valid because the object is
 * loose.
 */
const pageReadSummarySchema = z.looseObject({
  title: z.string(),
  url: z.string(),
  text: z.string().optional(),
  markdown: z.string().optional(),
  format: readFormatSchema.optional(),
  truncated: z.boolean().optional(),
  length: z.number().optional(),
  offset: z.number().optional(),
  nextOffset: z.number().nullable().optional(),
  limitation: z.string().optional(),
});

const evidenceFailureSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
});

const textMatchSchema = z.looseObject({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  excerpt: z.string(),
});

const evidenceOpShape = {
  ok: z.boolean(),
  tabId: z.string().nullable(),
  url: z.string(),
  title: z.string(),
  matchedQuote: z.string().optional(),
  matchMethod: z.string().optional(),
  confidence: z.number().optional(),
  occurrences: z.number().optional(),
  scrolled: z.boolean().optional(),
  highlighted: z.boolean().optional(),
  verified: z.boolean().optional(),
  limitation: z.string().optional(),
  error: evidenceFailureSchema.optional(),
};

const evidenceShowSchema = z.looseObject({
  ...evidenceOpShape,
  tabReused: z.boolean(),
  focused: z.boolean(),
  sourceUrl: z.string(),
  claim: z.string().optional(),
});

const evidenceShowShape = {
  ...evidenceOpShape,
  tabReused: z.boolean(),
  focused: z.boolean(),
  sourceUrl: z.string(),
  claim: z.string().optional(),
};

const textSearchShape = {
  ok: z.boolean(),
  tabId: z.string(),
  url: z.string(),
  title: z.string(),
  query: z.string(),
  matches: z.array(textMatchSchema),
  totalMatches: z.number(),
  truncated: z.boolean(),
  limitation: z.string().optional(),
  error: evidenceFailureSchema.optional(),
};

const textSearchSchema = z.looseObject(textSearchShape);

const searchTabsEntrySchema = z.looseObject({
  tabId: z.string(),
  ok: z.boolean(),
  url: z.string(),
  title: z.string(),
  matches: z.array(textMatchSchema),
  totalMatches: z.number(),
  truncated: z.boolean(),
  limitation: z.string().optional(),
  error: evidenceFailureSchema.optional(),
});

const watchInfoShape = {
  id: z.string(),
  tabId: z.string(),
  title: z.string(),
  url: z.string(),
  spaceId: z.string().nullable(),
  mode: z.enum(["change", "appear", "disappear"]),
  selector: z.string().nullable(),
  contains: z.string().nullable(),
  label: z.string(),
  intervalSeconds: z.number(),
  createdAt: z.number(),
  expiresAt: z.number(),
  lastCheckedAt: z.number().nullable(),
  lastError: z.string().nullable(),
  changes: z.number(),
};

const watchInfoSchema = z.looseObject(watchInfoShape);

const sessionSummarySchema = z.looseObject({
  name: z.string(),
  createdAt: z.string(),
  spaceCount: z.number(),
  tabCount: z.number(),
  essentialCount: z.number(),
});

const spaceTemplateShape = {
  name: z.string(),
  label: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  builtIn: z.boolean(),
  createdAt: z.string().optional(),
  folders: z.array(
    z.looseObject({
      label: z.string(),
      urls: z.array(z.string()),
    })
  ),
  looseUrls: z.array(z.string()),
};

const spaceTemplateSchema = z.looseObject(spaceTemplateShape);

export const TOOL_OUTPUT_SCHEMAS = {
  /* Browser and launch */
  zen_status: {
    appName: z.string(),
    appVersion: z.string(),
    buildId: z.string().optional(),
    platform: z.string(),
    profile: z.string(),
    windowId: z.string(),
    focused: z.boolean(),
    workspacesEnabled: z.boolean(),
    activeSpaceId: z.string().nullable(),
    activeTab: z
      .looseObject({
        id: z.string().nullable(),
        title: z.string(),
        url: z.string(),
        spaceId: z.string().nullable(),
        folderId: z.string().nullable(),
      })
      .nullable(),
    spaces: z.array(spaceInfoSchema),
    tabCount: z.number(),
    folderCount: z.number(),
    bridge: z.looseObject({
      port: z.number(),
      connections: z.number(),
      windows: z.array(
        z.looseObject({
          windowId: z.string(),
          focused: z.boolean(),
          appVersion: z.string(),
          platform: z.string(),
        })
      ),
    }),
  },
  zen_launch: {
    launched: z.boolean(),
    injection: injectionSummarySchema,
    windowId: z.string(),
    appVersion: z.string(),
    spaces: z.number(),
    activeSpaceId: z.string().nullable(),
    session: sessionInfoSchema,
    message: z.string(),
  },

  /* Spaces */
  zen_spaces_list: {
    activeSpaceId: z.string().nullable(),
    spaces: z.array(spaceInfoSchema),
    workspacesEnabled: z.boolean(),
  },
  zen_space_create: {
    created: z.boolean(),
    space: spaceSchema,
    activeSpaceId: z.string().nullable(),
    switched: z.boolean(),
  },
  zen_space_switch: {
    space: spaceSchema,
    activeSpaceId: z.string().nullable(),
  },
  zen_space_delete: {
    deleted: z.boolean(),
    spaceId: z.string(),
    spaceName: z.string(),
    activeSpaceId: z.string().nullable(),
  },

  /* Tabs */
  zen_tabs_list: {
    windowId: z.string(),
    activeSpaceId: z.string().nullable(),
    total: z.number(),
    tabs: z.array(tabSchema),
  },
  zen_tabs_open: {
    space: spaceSchema,
    tabs: z.array(openedTabSchema),
    background: z.boolean(),
  },
  zen_tabs_close: {
    closed: z.number(),
    tabIds: z.array(z.string()),
  },
  zen_tab_select: {
    tab: tabSchema,
    activeSpaceId: z.string().nullable(),
    windowFocused: z.boolean().optional(),
  },
  zen_glance: {
    opened: z.boolean(),
    url: z.string(),
    mode: z.enum(["glance", "none"]),
    message: z.string().optional(),
  },
  zen_split_view: {
    split: z.boolean(),
    tabIds: z.array(z.string()),
    gridType: z.string(),
  },
  zen_split_close: {
    unsplit: z.boolean(),
    tabIds: z.array(z.string()),
    closedResidue: z.number().optional(),
    limitation: z.string().optional(),
  },
  zen_pin_tabs: {
    tabIds: z.array(z.string()),
    changed: z.number(),
  },
  zen_essentials: {
    tabIds: z.array(z.string()),
    changed: z.number(),
    restored: z.number().optional(),
    limitation: z.string().optional(),
  },
  zen_containers_list: {
    containers: z.array(containerInfoSchema),
  },

  /* Folders */
  zen_folders_list: {
    folders: z.array(folderInfoSchema),
  },
  zen_folder_create: {
    created: z.boolean(),
    folder: folderInfoSchema,
  },
  zen_folder_add_tabs: {
    folder: folderInfoSchema,
    added: z.number(),
  },

  /* History and bookmarks */
  zen_history_search: {
    entries: z.array(historyEntrySchema),
    groups: z
      .array(
        z.looseObject({
          domain: z.string(),
          entries: z.array(historyEntrySchema),
        })
      )
      .optional(),
  },
  zen_history_recently_closed: {
    entries: z.array(
      z.looseObject({
        title: z.string(),
        url: z.string(),
        closedAt: z.string().nullable(),
      })
    ),
  },
  zen_bookmarks_search: {
    entries: z.array(
      z.looseObject({
        title: z.string(),
        url: z.string(),
        dateAdded: z.string().nullable(),
      })
    ),
  },

  /* Page reading */
  zen_read_page: pageReadShape,
  zen_read_pages: {
    pages: z.array(
      z.looseObject({
        tabId: z.string(),
        ok: z.boolean(),
        title: z.string().optional(),
        url: z.string().optional(),
        page: pageReadSummarySchema.optional(),
        error: z.string().optional(),
      })
    ),
  },
  zen_find_text: textSearchShape,
  zen_wait_for: waitForShape,
  zen_click: clickOutputSchema,
  zen_type: typeOutputSchema,
  zen_search_tabs: {
    query: z.string(),
    tabsSearched: z.number(),
    tabsMatched: z.number(),
    totalMatches: z.number(),
    skipped: z.number(),
    truncated: z.boolean(),
    results: z.array(searchTabsEntrySchema),
  },

  /* Evidence mode */
  zen_show_evidence: evidenceShowShape,
  zen_show_evidence_batch: {
    ok: z.boolean(),
    total: z.number(),
    matched: z.number(),
    verified: z.number(),
    failed: z.number(),
    openedTabs: z.number(),
    reusedTabs: z.number(),
    focused: z.boolean(),
    results: z.array(evidenceShowSchema),
    limitation: z.string().optional(),
    error: evidenceFailureSchema.optional(),
  },
  zen_clear_evidence: {
    cleared: z.boolean(),
    tabId: z.string().nullable(),
    removed: z.number(),
    error: evidenceFailureSchema.optional(),
  },

  /* Tab audit, grouping and clipboard */
  zen_tabs_audit: {
    totals: z.looseObject({
      tabs: z.number(),
      spaces: z.number(),
      folders: z.number(),
      pinned: z.number(),
      essentials: z.number(),
      grouped: z.number(),
      loading: z.number(),
      duplicates: z.number(),
      stale: z.number(),
    }),
    bySpace: z.array(
      z.looseObject({
        spaceId: z.string().nullable(),
        spaceName: z.string(),
        tabs: z.number(),
        pinned: z.number(),
        folders: z.number(),
        stale: z.number(),
      })
    ),
    duplicates: z.array(
      z.looseObject({
        url: z.string(),
        title: z.string(),
        tabIds: z.array(z.string()),
        spaces: z.array(z.string()),
      })
    ),
    staleTabs: z.array(
      z.looseObject({
        tabId: z.string(),
        title: z.string(),
        url: z.string(),
        spaceName: z.string().nullable(),
        lastAccessed: z.number().nullable(),
        ageDays: z.number().nullable(),
      })
    ),
    domains: z.array(
      z.looseObject({
        domain: z.string(),
        count: z.number(),
        tabIds: z.array(z.string()),
      })
    ),
  },
  zen_tabs_group: {
    spaceId: z.string(),
    planned: z.number(),
    created: z.array(
      z.looseObject({
        folderId: z.string(),
        label: z.string(),
        tabs: z.number(),
      })
    ),
    groupedTabs: z.number(),
  },
  zen_clipboard_write: {
    written: z.boolean(),
    length: z.number(),
  },

  /* Agent coordination: progress, events, watches */
  zen_progress: {
    delivered: z.boolean(),
    windowId: z.string().optional(),
    progress: z
      .looseObject({
        id: z.string(),
        title: z.string(),
        step: z.string().optional(),
        detail: z.string().optional(),
        progress: z.number().optional(),
        tone: activityToneSchema,
        startedAt: z.number(),
        stoppable: z.boolean(),
        stopRequested: z.boolean().optional(),
      })
      .nullable(),
  },
  zen_events: {
    events: z.array(
      z.looseObject({
        id: z.number(),
        kind: z.enum(AGENT_EVENT_KINDS),
        at: z.number(),
        title: z.string(),
        detail: z.string().optional(),
        windowId: z.string().optional(),
        tabId: z.string().optional(),
        watchId: z.string().optional(),
        questionId: z.string().optional(),
        phase: z.enum(BROWSER_EVENT_PHASES).optional(),
        url: z.string().optional(),
        documentId: z.string().optional(),
        source: z.enum(["server", "browser"]).optional(),
      })
    ),
    cursor: z.number(),
    stopped: z.boolean(),
    paused: z.boolean(),
    lastEventAt: z.number().nullable(),
    missed: z.number(),
    oldestCursor: z.number().nullable(),
    dropped: z.number(),
    filtered: z.number(),
  },
  zen_watch_add: watchInfoShape,
  zen_watch_list: {
    watches: z.array(watchInfoSchema),
    minIntervalSeconds: z.number(),
  },
  zen_watch_remove: {
    watchId: z.string(),
    removed: z.boolean(),
  },

  /* Policy and audit */
  zen_config: {
    server: z.string(),
    version: z.string(),
    readOnly: z.boolean(),
    allowedDomains: z.array(z.string()),
    auditLog: z.boolean(),
    auditPath: z.string(),
    dataDir: z.string(),
    profileMode: z.enum(["custom", "default", "dedicated"]),
    profilePath: z.string().nullable(),
    requireConsent: z.boolean(),
    session: sessionInfoSchema,
    ownership: z.string(),
    autoLaunch: z.boolean(),
    autoAttachWindows: z.boolean(),
    toolSurface: z.string().optional(),
    exposedToolCount: z.number().optional(),
    availableToolCount: z.number().optional(),
    askTimeoutSeconds: z.number(),
    consentTimeoutSeconds: z.number(),
    watchMinIntervalSeconds: z.number(),
    sessions: z.number(),
    userTemplates: z.number(),
  },
  zen_audit_tail: {
    path: z.string(),
    entries: z.array(
      z.looseObject({
        at: z.string(),
        tool: z.string(),
        ok: z.boolean().optional(),
        executed: z.boolean().optional(),
        durationMs: z.number().optional(),
        citationsVerified: z.number().optional(),
        citationsFailed: z.number().optional(),
        outcome: z.enum(["success", "partial", "failed"]).optional(),
        args: z.unknown().optional(),
        error: z
          .looseObject({
            code: z.string().optional(),
            message: z.string(),
          })
          .optional(),
        urls: z.array(z.string()).optional(),
      })
    ),
  },

  /* In-browser conversation */
  zen_ask: {
    status: answerStatusSchema,
    questionId: z.string(),
    answer: z.string().optional(),
    selectedLabels: z.array(z.string()).optional(),
    freeform: z.boolean().optional(),
    waitedSeconds: z.number().optional(),
    message: z.string().optional(),
  },
  zen_answers: {
    pending: z.array(answerRecordSchema),
    answered: z.array(answerRecordSchema),
  },
  zen_notify: {
    delivered: z.boolean(),
    windowId: z.string().optional(),
  },

  /* Capability discovery */
  zen_tools_search: {
    query: z.string(),
    category: z.string().nullable(),
    total: z.number(),
    tools: z.array(
      z.looseObject({
        name: z.string(),
        summary: z.string(),
        category: z.string(),
        surfaces: z.array(z.string()),
        exposed: z.boolean(),
        mutating: z.boolean(),
      })
    ),
    tool: z
      .looseObject({
        name: z.string(),
        summary: z.string(),
        category: z.string(),
        surfaces: z.array(z.string()),
        exposed: z.boolean(),
        mutating: z.boolean(),
        description: z.string().optional(),
        inputSchema: z.unknown().optional(),
      })
      .optional(),
  },

  /* Session snapshots */
  zen_session_save: {
    name: z.string(),
    createdAt: z.string(),
    spaces: z.number(),
    tabs: z.number(),
    essentials: z.number(),
    path: z.string(),
  },
  zen_session_list: {
    sessions: z.array(sessionSummarySchema),
    path: z.string(),
  },
  zen_session_restore: {
    name: z.string(),
    spacesCreated: z.number(),
    spacesReused: z.number(),
    tabsOpened: z.number(),
    tabsSkipped: z.number(),
    foldersCreated: z.number(),
    essentialsAdded: z.number(),
    warnings: z.array(z.string()),
  },
  zen_session_delete: {
    name: z.string(),
    deleted: z.boolean(),
  },

  /* Space templates */
  zen_space_templates: {
    templates: z
      .array(
        z.looseObject({
          name: z.string(),
          label: z.string(),
          description: z.string(),
          icon: z.string().nullable(),
          builtIn: z.boolean(),
          folders: z.number(),
          tabs: z.number(),
        })
      )
      .optional(),
    template: spaceTemplateSchema.optional(),
    path: z.string(),
  },
  zen_template_apply: {
    template: z.string(),
    space: spaceSchema,
    tabsOpened: z.number(),
    foldersCreated: z.number(),
    tabsFailed: z.number(),
    warnings: z.array(z.string()),
  },
  zen_template_save: spaceTemplateShape,
  zen_template_delete: {
    name: z.string(),
    deleted: z.boolean(),
  },
} satisfies Record<string, z.ZodRawShape | z.ZodType>;
