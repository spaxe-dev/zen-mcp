import type { EvidenceMatchMethod } from "./evidence.js";
import type { PolicySnapshot } from "./policy.js";
import type { PageTargetSpec } from "./target.js";

export const BRIDGE_PATH = "/bridge";

export type AnswerStatus = "answered" | "deferred";
export type AskOutcomeStatus =
  | "answered"
  | "deferred"
  | "pending"
  | "unavailable";

export interface UiOption {
  label: string;
  value?: string;
  description?: string;
}

export interface UiQuestion {
  id: string;
  question: string;
  context?: string;
  options: UiOption[];
  allowFreeform: boolean;
  multiSelect: boolean;
  createdAt: number;
}

export type ActivityTone = "info" | "success" | "warning";

export interface UiActivityAction {
  id: string;
  label: string;
  kind: "space" | "tab";
  target: string;
}

export interface UiActivity {
  id: string;
  title: string;
  detail?: string;
  tone: ActivityTone;
  actions: UiActivityAction[];
  autoHideMs: number;
}

/**
 * A persistent progress card shown while an agent works. Unlike activities it
 * stays until replaced or cleared and can expose a Stop button.
 */
export interface UiProgress {
  id: string;
  title: string;
  step?: string;
  detail?: string;
  /** Optional completion ratio between 0 and 1. */
  progress?: number;
  tone: ActivityTone;
  startedAt: number;
  stoppable: boolean;
  stopRequested?: boolean;
}

export interface UiAnswer {
  type: "ui.answer";
  id: string;
  status: AnswerStatus;
  answer?: string;
  selectedLabels?: string[];
  freeform?: boolean;
}

export interface UiActionEvent {
  type: "ui.action";
  activityId: string;
  actionId: string;
  ok: boolean;
  error?: string;
}

export interface UiStop {
  type: "ui.stop";
  progressId: string;
  ts: number;
}

/** Shown once per MCP session before any browser operation is allowed. */
export interface UiConsent {
  id: string;
  title: string;
  detail: string;
  allowLabel: string;
  denyLabel: string;
}

export type BannerState = "pending" | "active" | "paused";

/** How the browser banner presents an available release. */
export type UpdateNoticeState =
  | "prompt"
  | "icon"
  | "installing"
  | "installed"
  | "failed";

/**
 * An npm release newer than the running server. The banner prompts once for a
 * version, then keeps a small icon until the user installs or dismisses it.
 */
export interface UiUpdateNotice {
  state: UpdateNoticeState;
  currentVersion: string;
  latestVersion: string;
  /** Installer failure text, when state is "failed". */
  message?: string;
}

/** Persistent, compact status strip in the browser window. */
export interface UiBanner {
  state: BannerState;
  text: string;
  detail?: string;
  update?: UiUpdateNotice | null;
}

export interface UiUpdateAction {
  type: "ui.updateAction";
  action: "install" | "dismiss" | "expand";
  ts: number;
}

export interface UiConsentResult {
  type: "ui.consentResult";
  id: string;
  granted: boolean;
}

export interface UiBannerAction {
  type: "ui.bannerAction";
  action: "pause" | "resume";
  ts: number;
}

/**
 * The server opens every socket with a fresh, single-use challenge. A hostile
 * local listener that occupies the bridge address therefore learns nothing
 * reusable from the browser and cannot play the server back to it.
 */
export interface ServerAuthChallenge {
  type: "auth.challenge";
  nonce: string;
}

/** The bridge proves it holds the per-launch key without sending the key. */
export interface BridgeAuthResponse {
  type: "auth.response";
  nonce: string;
  proof: string;
}

/** The server proves the same key before the bridge sends a hello or command. */
export interface ServerAuthConfirm {
  type: "auth.confirm";
  nonce: string;
  proof: string;
}

export interface BridgeHello {
  type: "hello";
  protocol: number;
  bridgeVersion: string;
  windowId: string;
  focused: boolean;
  appVersion: string;
  platform: string;
}

export interface BridgePong {
  type: "bridge.pong";
  ts: number;
}

export interface BridgeFocus {
  type: "bridge.focus";
  focused: boolean;
  ts: number;
}

export interface BrowserEventMessage {
  type: "browser.event";
  event: BrowserEventPayload;
}

export type BridgeToServer =
  | BridgeAuthResponse
  | BridgeHello
  | BridgePong
  | BridgeFocus
  | BrowserEventMessage
  | UiAnswer
  | UiActionEvent
  | UiStop
  | UiConsentResult
  | UiBannerAction
  | UiUpdateAction
  | BridgeResponse
  | { type: "bridge.error"; message: string };

export interface ServerWelcome {
  type: "welcome";
  protocol: number;
  serverVersion: string;
}

export interface ServerPing {
  type: "server.ping";
  ts: number;
}

export interface AskUiMessage {
  type: "ui.ask";
  question: UiQuestion;
}

export interface CancelUiMessage {
  type: "ui.cancel";
  id: string;
}

export interface ActivityUiMessage {
  type: "ui.activity";
  activity: UiActivity;
}

export interface ProgressUiMessage {
  type: "ui.progress";
  /** null hides the progress card. */
  progress: UiProgress | null;
}

export interface ConsentUiMessage {
  type: "ui.consent";
  consent: UiConsent;
}

export interface CancelConsentUiMessage {
  type: "ui.consentCancel";
  id: string;
}

export interface BannerUiMessage {
  type: "ui.banner";
  /** null hides the banner. */
  banner: UiBanner | null;
}

export interface ShutdownMessage {
  type: "shutdown";
  reason?: string;
}

export interface BridgeRequest {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
  /** Revision the server believes is current; the bridge rejects stale work. */
  policyRevision?: number;
  /** Canonical policy digest paired with `policyRevision`. */
  policyDigest?: string;
}

export interface PolicyUpdateMessage {
  type: "policy.update";
  policy: PolicySnapshot;
}

export interface BridgeResponse {
  type: "res";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code?: string;
    message: string;
    /** Bounded structured detail, such as ambiguous target candidates. */
    details?: Record<string, unknown>;
  };
}

export type ServerToBridge =
  | ServerAuthChallenge
  | ServerAuthConfirm
  | ServerWelcome
  | ServerPing
  | AskUiMessage
  | CancelUiMessage
  | ActivityUiMessage
  | ProgressUiMessage
  | ConsentUiMessage
  | CancelConsentUiMessage
  | BannerUiMessage
  | PolicyUpdateMessage
  | ShutdownMessage
  | BridgeRequest;

/* ------------------------------------------------------------------ *
 * Agent events, progress and watch mode
 * ------------------------------------------------------------------ */

export const BROWSER_EVENT_KINDS = [
  "tab",
  "navigation",
  "document",
  "dialog",
] as const;

export type BrowserEventKind = (typeof BROWSER_EVENT_KINDS)[number];

export const BROWSER_EVENT_PHASES = [
  "opened",
  "closed",
  "selected",
  "started",
  "committed",
  "completed",
  "failed",
  "redirect",
  "same_document",
  "replaced",
  "shown",
  "hidden",
] as const;

export type BrowserEventPhase = (typeof BROWSER_EVENT_PHASES)[number];

export const AGENT_EVENT_KINDS = [
  "stop",
  "pause",
  "resume",
  "watch",
  "question",
  ...BROWSER_EVENT_KINDS,
] as const;

export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

/**
 * One observation from the owned browser. Observed transitions are evidence
 * that something changed, never proof of what caused it.
 */
export interface AgentEvent {
  id: number;
  kind: AgentEventKind;
  at: number;
  title: string;
  detail?: string;
  windowId?: string;
  tabId?: string;
  watchId?: string;
  questionId?: string;
  phase?: BrowserEventPhase;
  url?: string;
  /** Best-effort document identity, comparable with a wait result. */
  documentId?: string;
  source?: "server" | "browser";
}

export interface EventsResult {
  events: AgentEvent[];
  /** Pass this back as `after` to collect only newer events. */
  cursor: number;
  /**
   * True when the user asked the agent to halt, either with Stop or with the
   * global Pause switch.
   */
  stopped: boolean;
  /** True while the global Pause switch is on. */
  paused: boolean;
  lastEventAt: number | null;
  /** Events that were evicted before this cursor could read them. */
  missed: number;
  /** Oldest event still buffered, or null when the buffer is empty. */
  oldestCursor: number | null;
  /** Total events evicted since the server started. */
  dropped: number;
  /** Browser observations dropped because their URL was not allowed. */
  filtered: number;
}

/** Sent by a bridge observer after `hello`; the host stamps window and time. */
export interface BrowserEventPayload {
  kind: BrowserEventKind;
  phase: BrowserEventPhase;
  tabId?: string;
  url?: string;
  title?: string;
  detail?: string;
  documentId?: string;
  /** Dialog class such as alert or confirm. Never dialog text. */
  label?: string;
}

export interface ProgressParams {
  title: string;
  step?: string;
  detail?: string;
  /** Completion ratio between 0 and 1. */
  progress?: number;
  tone?: ActivityTone;
  stoppable?: boolean;
  /** Hide the progress card instead of updating it. */
  done?: boolean;
}

export type WatchMode = "change" | "appear" | "disappear";

export interface WatchParams {
  /** Tab to watch. Defaults to the active tab. */
  tabId?: string;
  mode?: WatchMode;
  /** CSS selector for appear/disappear mode. */
  selector?: string;
  /** Only report a change when the page text now contains this phrase. */
  contains?: string;
  intervalSeconds?: number;
  maxMinutes?: number;
  label?: string;
  /** Show a card in Zen when the watch fires. Defaults to true. */
  notify?: boolean;
}

export interface WatchInfo {
  id: string;
  tabId: string;
  title: string;
  url: string;
  spaceId: string | null;
  mode: WatchMode;
  selector: string | null;
  contains: string | null;
  label: string;
  intervalSeconds: number;
  createdAt: number;
  expiresAt: number;
  lastCheckedAt: number | null;
  lastError: string | null;
  changes: number;
}

export interface SpaceInfo {
  id: string;
  name: string;
  icon: string | null;
  active: boolean;
  index: number;
  containerTabId: number;
  tabCount: number;
  pinnedCount: number;
  folderCount: number;
}

export interface Space {
  id: string;
  name: string;
  icon: string | null;
  active: boolean;
  index: number;
  containerTabId: number;
}

export interface FolderInfo {
  id: string;
  label: string;
  spaceId: string;
  collapsed: boolean;
  parentId: string | null;
  tabIds: string[];
  liveFolder: boolean;
}

export interface TabInfo {
  id: string;
  windowId: string;
  spaceId: string | null;
  spaceName: string | null;
  title: string;
  url: string;
  requestedUrl?: string;
  pinned: boolean;
  essential: boolean;
  active: boolean;
  audible: boolean;
  muted: boolean;
  loading: boolean;
  folderId: string | null;
  folderLabel: string | null;
  index: number;
  /** Epoch ms of the last focus, when Zen reports it. */
  lastAccessed?: number | null;
  /** Firefox container (userContextId), 0 when none. */
  containerId?: number | null;
  /** Tab participates in a Zen split view. */
  splitView?: boolean;
}

export interface HistoryEntry {
  title: string;
  url: string;
  lastVisited: string | null;
  visitCount: number;
  domain?: string;
}

export interface BookmarkEntry {
  title: string;
  url: string;
  dateAdded: string | null;
}

export interface BridgeStatus {
  appName: string;
  appVersion: string;
  buildId: string;
  platform: string;
  profile: string;
  windowId: string;
  focused: boolean;
  workspacesEnabled: boolean;
  activeSpaceId: string | null;
  activeTab: {
    id: string | null;
    title: string;
    url: string;
    spaceId: string | null;
    folderId: string | null;
  } | null;
  spaces: SpaceInfo[];
  tabCount: number;
  folderCount: number;
}

export interface OpenedTab extends TabInfo {
  requestedUrl: string;
}

export interface SpacesResult {
  activeSpaceId: string | null;
  spaces: SpaceInfo[];
  workspacesEnabled: boolean;
}

export interface TabsResult {
  windowId: string;
  activeSpaceId: string | null;
  total: number;
  tabs: TabInfo[];
}

export interface FoldersResult {
  folders: FolderInfo[];
}

export interface HistoryResult {
  entries: HistoryEntry[];
  /** Present when groupByDomain was requested. */
  groups?: HistoryGroup[];
}

export interface BookmarksResult {
  entries: BookmarkEntry[];
}

export interface CreateSpaceResult {
  created: boolean;
  space: Space;
  activeSpaceId: string | null;
  switched: boolean;
}

export interface OpenTabsResult {
  space: Space;
  tabs: OpenedTab[];
  background: boolean;
}

export interface CreateFolderResult {
  created: boolean;
  folder: FolderInfo;
}

export type ReadFormat =
  | "text"
  | "markdown"
  | "links"
  | "tables"
  | "metadata"
  | "outline"
  | "interactive"
  | "snapshot"
  | "semantic";

export interface PageLink {
  text: string;
  url: string;
}

export interface PageTable {
  caption: string | null;
  headers: string[];
  rows: string[][];
}

export interface PageHeading {
  level: number;
  text: string;
}

export type PageClassification =
  | "article"
  | "search-results"
  | "product"
  | "listing"
  | "dashboard"
  | "login"
  | "form"
  | "documentation"
  | "discussion"
  | "generic";

export type SemanticRegionRole =
  | "banner"
  | "navigation"
  | "main"
  | "complementary"
  | "contentinfo"
  | "search"
  | "form"
  | "article"
  | "section"
  | "dialog"
  | "table"
  | "list";

export type SemanticCollectionKind = "cards" | "results" | "links" | "items";

/**
 * One semantic landmark or repeated structure. `ref` is a stable handle to the
 * region anchor; controls found in the same read carry their own refs.
 *
 * Optional fields are omitted from a page read when they add no information:
 * `label` when it equals `heading`, counts when zero, and relation fields when
 * absent. `id` and `role` are always present.
 */
export interface SemanticRegion {
  id: string;
  role: SemanticRegionRole;
  /** Omitted when absent or identical to `heading`. */
  label?: string | null;
  /** Omitted with `label`. */
  labelSource?: "aria" | "html" | "heading" | "inferred";
  /** Omitted when the region has no heading. */
  heading?: string | null;
  /** Omitted for a top-level region. */
  parent?: string | null;
  /** Omitted when the anchor has no ref in this read. */
  ref?: string | null;
  /** Omitted when zero. */
  controls?: number;
  /** Omitted when zero. */
  links?: number;
  /** Omitted when zero or absent. */
  items?: number | null;
  itemKind?: SemanticCollectionKind | null;
}

export interface SemanticCollection {
  regionId: string;
  kind: SemanticCollectionKind;
  count: number;
  sample: Array<{ ref: string; label: string }>;
}

/** One heading in document order; the level is the h1-h6 number. */
export interface SemanticHeading {
  level: number;
  text: string;
  ref: string | null;
}

export interface SemanticDialog {
  ref: string;
  label: string;
  modal: boolean;
}

export interface SemanticCoverage {
  complete: boolean;
  nodes: number;
  regions: number;
  regionsTruncated: boolean;
  controls: number;
  links: number;
  headings: number;
  tables: number;
  images: number;
  missingAlt: number;
  shadowRoots: number;
}

/**
 * A compact, deterministic model of the page. Labels are observed attributes
 * or inferred from structure; the classification is a heuristic, not a fact.
 */
export interface SemanticPage {
  classification: PageClassification;
  confidence: number;
  signals: string[];
  primaryRegion: string | null;
  regions: SemanticRegion[];
  headings: SemanticHeading[];
  collections: SemanticCollection[];
  dialogs: SemanticDialog[];
  coverage: SemanticCoverage;
  limitations: string[];
}

/**
 * One control found by an interactive or snapshot read. `ref` is a short
 * server-assigned handle used by `zen_click` and `zen_type`; it is replaced by
 * the next interactive or snapshot read of that document, or by a navigation.
 */
export interface PageElement {
  ref: string;
  tag: string;
  role: string;
  type: string | null;
  label: string;
  /**
   * Current value for legacy interactive reads, omitted for sensitive fields
   * and file inputs. Omitted entirely in snapshot and semantic reads.
   */
  value?: string | null;
  placeholder: string | null;
  href: string | null;
  disabled: boolean;
  checked: boolean | null;
  readOnly: boolean;
  /**
   * True when the field is classified sensitive (password, payment, one-time
   * code, telephone, email, account-like fields). Values are omitted.
   */
  sensitive: boolean;
  editable: boolean;
  /** Snapshot only: whether a non-empty value exists, without the value. */
  valuePresent?: boolean;
  /** Snapshot only: the autocomplete attribute, lowercased. */
  autocomplete?: string | null;
  /** Snapshot only: selected state for options and selectable controls. */
  selected?: boolean | null;
  /** Snapshot only: form id or name that owns the control. */
  form?: string | null;
  /** Set for controls inside a frame; the path used to reach that frame. */
  framePath?: number[];
  /** URL of the frame that owns this control. */
  frameUrl?: string | null;
}

/** One child frame reachable from a tab's top-level document. */
export interface PageFrame {
  /** Child indexes from the top document, e.g. [0, 1]. */
  path: number[];
  url: string;
  name: string;
}

export interface PageMetadata {
  title: string;
  description: string | null;
  canonical: string | null;
  lang: string | null;
  author: string | null;
  published: string | null;
  siteName: string | null;
  image: string | null;
  og: Record<string, string>;
  twitter: Record<string, string>;
}

export interface PageReadResult {
  title: string;
  url: string;
  selectedText: string;
  text: string;
  truncated: boolean;
  length: number;
  /** Character offset that was applied to the text or markdown stream. */
  offset: number;
  /** Next offset to request, or null when this stream is exhausted. */
  nextOffset: number | null;
  /** Set when the read ignored an option, such as offset on a structured format. */
  limitation?: string;
  description: string | null;
  /** Defaults to "text" when the bridge does not report a format. */
  format?: ReadFormat;
  /** MIME type reported by the browser, useful for PDF detection. */
  contentType?: string | null;
  /** CSS selector the read was scoped to, when one was given. */
  selector?: string | null;
  markdown?: string;
  links?: PageLink[];
  tables?: PageTable[];
  metadata?: PageMetadata;
  outline?: PageHeading[];
  /** Present for interactive, snapshot and semantic reads, in document order. */
  elements?: PageElement[];
  /** Present for semantic reads: landmarks, classification and relationships. */
  semantic?: SemanticPage;
  /** True when the control scan hit its element cap. */
  elementsTruncated?: boolean;
  /** Opaque id for the snapshot that produced these refs. */
  snapshotId?: string;
  /** Controls found before the output cap was applied. */
  elementsTotal?: number;
  /** True when the snapshot saw every frame it set out to scan. */
  snapshotComplete?: boolean;
  /** True when the text preview hit the snapshot cap. */
  textTruncated?: boolean;
  /** True when the snapshot outline hit its heading cap. */
  outlineTruncated?: boolean;
  /** True when every relevant frame was listed and scanned. */
  framesComplete?: boolean;
  /** Explicit reasons a snapshot is partial or truncated, at most five. */
  limitations?: string[];
  /** Echo of the frame this read targeted, when it was not the top document. */
  framePath?: number[];
  /** Child frames reachable from the read target, flattened depth-first. */
  frames?: PageFrame[];
}

export type EvidenceErrorCode =
  | "PAGE_NOT_FOUND"
  | "PAGE_STILL_LOADING"
  | "QUOTE_NOT_FOUND"
  | "AMBIGUOUS_MATCH"
  | "LOW_MATCH_CONFIDENCE"
  | "HIGHLIGHT_FAILED"
  | "PRIVILEGED_PAGE"
  | "ACTOR_UNAVAILABLE"
  | "UNSUPPORTED_PAGE";

export interface EvidenceFailure {
  code: EvidenceErrorCode;
  message: string;
}

export interface EvidenceShowParams {
  tabId: string;
  quote: string;
  context?: string;
  minConfidence?: number;
  highlightMs?: number;
  scroll?: boolean;
}

/** Result of locating and marking a quote inside one tab. */
export interface EvidenceOpResult {
  ok: boolean;
  tabId: string | null;
  url: string;
  title: string;
  /** The quote as it originally appeared in the source text. */
  matchedQuote?: string;
  matchMethod?: EvidenceMatchMethod;
  confidence?: number;
  occurrences?: number;
  scrolled?: boolean;
  highlighted?: boolean;
  /** True only for a visible highlight backed by exact or normalized text. */
  verified?: boolean;
  limitation?: string;
  error?: EvidenceFailure;
}

export interface EvidenceClearParams {
  tabId: string;
}

export interface EvidenceClearResult {
  tabId: string;
  removed: number;
}

/** The MCP-facing result, including how the tab was obtained. */
export interface EvidenceShowResult extends EvidenceOpResult {
  tabReused: boolean;
  /** True when the tool brought the source tab to the front. */
  focused: boolean;
  sourceUrl: string;
  claim?: string;
}

export interface EvidenceClearOutcome {
  cleared: boolean;
  tabId: string | null;
  removed: number;
  error?: EvidenceFailure;
}

export interface EvidenceCitation {
  url: string;
  quote: string;
  claim?: string;
  context?: string;
  sourceTitle?: string;
  tabId?: string;
}

export interface EvidenceBatchOptions {
  citations: EvidenceCitation[];
  focus?: boolean;
  minConfidence?: number;
  highlightMs?: number;
  concurrency?: number;
}

export interface EvidenceBatchResult {
  ok: boolean;
  total: number;
  matched: number;
  /** Citations with a visible, non-fuzzy highlight. */
  verified: number;
  failed: number;
  /** Unique tabs opened for citations that had no existing tab. */
  openedTabs: number;
  /** Unique existing tabs reused for citations. */
  reusedTabs: number;
  focused: boolean;
  results: EvidenceShowResult[];
  limitation?: string;
  error?: EvidenceFailure;
}

export interface TextMatch {
  /** Raw page text offsets. */
  start: number;
  end: number;
  /** The matched page text. */
  text: string;
  /** Whitespace-collapsed excerpt with surrounding context. */
  excerpt: string;
}

export interface TextSearchParams {
  tabId: string;
  query: string;
  caseSensitive?: boolean;
  maxMatches?: number;
  contextChars?: number;
}

export interface TextSearchResult {
  ok: boolean;
  tabId: string;
  url: string;
  title: string;
  query: string;
  matches: TextMatch[];
  totalMatches: number;
  /** True when the page or the result list was cut short. */
  truncated: boolean;
  limitation?: string;
  error?: EvidenceFailure;
}

export interface SearchTabsParams {
  query: string;
  space?: string;
  tabIds?: string[];
  maxTabs?: number;
  maxMatchesPerTab?: number;
  contextChars?: number;
  caseSensitive?: boolean;
}

export interface SearchTabsEntry {
  tabId: string;
  ok: boolean;
  url: string;
  title: string;
  matches: TextMatch[];
  totalMatches: number;
  truncated: boolean;
  limitation?: string;
  error?: EvidenceFailure;
}

export interface SearchTabsResult {
  query: string;
  tabsSearched: number;
  tabsMatched: number;
  totalMatches: number;
  /** Tabs skipped because they do not expose readable http(s) text. */
  skipped: number;
  truncated: boolean;
  results: SearchTabsEntry[];
}

export interface BatchReadParams {
  tabIds: string[];
  maxChars?: number;
  format?: ReadFormat;
  selector?: string;
}

export interface BatchReadEntry {
  tabId: string;
  ok: boolean;
  title?: string;
  url?: string;
  page?: PageReadResult;
  error?: string;
}

export interface BatchReadResult {
  pages: BatchReadEntry[];
}

export interface BridgeStatusPayload {
  status: BridgeStatus;
}

export interface AskResult {
  status: AskOutcomeStatus;
  questionId: string;
  answer?: string;
  selectedLabels?: string[];
  freeform?: boolean;
  waitedSeconds?: number;
  message?: string;
}

export interface AnswerInboxEntry {
  question: UiQuestion;
  status: AskOutcomeStatus;
  askedAt: number;
  answeredAt?: number;
  answer?: string;
  selectedLabels?: string[];
  freeform?: boolean;
}

export interface AnswersResult {
  pending: AnswerInboxEntry[];
  answered: AnswerInboxEntry[];
}

/* ------------------------------------------------------------------ *
 * Bridge operations
 * ------------------------------------------------------------------ */

export interface CreateSpaceParams {
  name: string;
  icon?: string;
  containerTabId?: number;
  switchTo?: boolean;
}

export interface SwitchSpaceParams {
  space: string;
}

export interface SpaceTargetParams {
  space?: string;
}

export interface TabsListParams {
  /** Restrict to one space by id or name. */
  space?: string;
  /** Case-insensitive substring matched against title and URL. */
  query?: string;
  /** Only tabs that are pinned or in a folder. */
  pinnedOnly?: boolean;
  limit?: number;
}

export interface OpenTabsParams {
  urls: string[];
  /** Space id or name. Defaults to the active space. */
  space?: string;
  /** Open without selecting any tab. Defaults to true. */
  background?: boolean;
  /** Switch to the target space after opening. Defaults to false. */
  switchTo?: boolean;
  /** Optional folder id to place the new tabs in. */
  folderId?: string;
  /** Firefox container id or container name. */
  container?: string | number;
}

export interface ContainerInfo {
  userContextId: number;
  name: string;
  icon: string;
  color: string;
  /** False for the built-in "No container" identity. */
  public: boolean;
}

export interface ContainersResult {
  containers: ContainerInfo[];
}

export interface CloseTabsParams {
  tabIds: string[];
}

export interface SelectTabParams {
  tabId: string;
  /** Also focus the Zen window. Defaults to false. */
  focusWindow?: boolean;
}

export interface PinTabsParams {
  tabIds: string[];
  pinned: boolean;
}

export interface PinTabsResult {
  tabIds: string[];
  changed: number;
}

export interface EssentialsParams {
  tabIds: string[];
}

export interface EssentialsResult {
  tabIds: string[];
  changed: number;
  /** Tabs whose previous space and pinned state were confirmed. */
  restored?: number;
  /** Present when Zen refused or did not confirm a state restoration. */
  limitation?: string;
}

export interface TabReadParams {
  tabId: string;
  maxChars?: number;
  /** Character offset into the text or markdown stream. */
  offset?: number;
  format?: ReadFormat;
  selector?: string;
  /** Snapshot control cap, 1-200. Defaults to 100. Ignored by other formats. */
  maxElements?: number;
  /** Child-frame indexes to read instead of the top document. */
  framePath?: number[];
  /** Host-enforced allowlist; frames outside it are hidden and refused. */
  allowedDomains?: string[];
}

/** Target of a page action. Legacy ref/selector or one additive target. */
export interface PageActionTarget {
  /**
   * Ref from an interactive read, such as "e12". A frame ref carries its path,
   * such as "f0-e3" or "f0.1-e2".
   */
  ref?: string;
  /** CSS selector, evaluated in the top document's light DOM. */
  selector?: string;
  /** Semantic target. Cannot be combined with ref or selector. */
  target?: PageTargetSpec;
}

export interface ClickElementParams extends PageActionTarget {
  tabId: string;
  /** Host-enforced allowlist, used to reject a link before it is clicked. */
  allowedDomains?: string[];
}

export interface TypeTextParams extends PageActionTarget {
  tabId: string;
  text: string;
  /** Replace the current value before typing. Defaults to false. */
  clear?: boolean;
  allowedDomains?: string[];
}

export interface PageActionTargetInfo {
  tag: string;
  role: string;
  label: string;
  type: string | null;
  sensitive: boolean;
}

export interface ClickElementResult {
  clicked: boolean;
  tabId: string;
  url: string;
  title: string;
  target: PageActionTargetInfo;
  /** Set when the click happened inside a frame. */
  framePath?: number[];
  /** Current URL of the frame that was acted on. */
  frameUrl?: string | null;
  limitation?: string;
  /** What changed in the page after the action, when it could be observed. */
  effect?: PageActionEffect;
}

export interface TypeObservation {
  /** False for sensitive fields, stale nodes, or unreadable controls. */
  compared: boolean;
  /** Whether the field value matched the typed text. Null when not compared. */
  matchesInput: boolean | null;
  sensitive: boolean;
}

export interface TypeTextResult {
  /** Number of characters sent, never the text itself. */
  typed: number;
  cleared: boolean;
  tabId: string;
  url: string;
  title: string;
  target: PageActionTargetInfo;
  /** Set when the field was inside a frame. */
  framePath?: number[];
  /** Current URL of the frame that was acted on. */
  frameUrl?: string | null;
  limitation?: string;
  /** Internal comparison; never includes the value or its length. */
  observed?: TypeObservation;
  /** What changed in the page after the action, when it could be observed. */
  effect?: PageActionEffect;
}

export const WAIT_CONDITIONS = [
  "selector",
  "text",
  "urlContains",
  "titleContains",
  "document",
  "newTab",
  "tabClosed",
  "dialog",
] as const;
export type WaitCondition = (typeof WAIT_CONDITIONS)[number];

export const WAIT_UNTIL = ["present", "absent"] as const;
export type WaitUntil = (typeof WAIT_UNTIL)[number];

/** Selector state; `until: absent` means the state does not hold. */
export const WAIT_ELEMENT_STATES = ["present", "visible", "enabled"] as const;
export type WaitElementState = (typeof WAIT_ELEMENT_STATES)[number];

export interface WaitForParams {
  tabId: string;
  selector?: string;
  state?: WaitElementState;
  text?: string;
  urlContains?: string;
  titleContains?: string;
  /** Wait until the document identity differs from documentId or the first probe. */
  documentChanged?: boolean;
  documentId?: string;
  /** Wait until a tab opens after the wait starts. */
  newTab?: boolean;
  /** Wait until the given tab closes. */
  tabClosed?: boolean;
  /** Wait until a browser dialog appears after the wait starts. */
  dialog?: boolean;
  until?: WaitUntil;
  timeoutMs?: number;
  pollMs?: number;
  framePath?: number[];
  allowedDomains?: string[];
}

export interface WaitForResult {
  matched: boolean;
  waitedMs: number;
  condition: WaitCondition;
  until: WaitUntil;
  /** The selector or text that was waited for. */
  query: string;
  tabId: string;
  /** Top-level tab URL at the end of the wait. */
  url: string;
  title: string;
  framePath?: number[];
  /** URL of the frame whose document was probed, when framePath was used. */
  frameUrl?: string | null;
  /** Selector state that was requested. */
  state?: WaitElementState;
  /** Document identity observed at the end of the wait. */
  documentId?: string;
  /** Tab that opened for a newTab wait. */
  newTabId?: string;
  limitation?: string;
}

/** A bounded control shown in an action delta. */
export interface ActionControlBrief {
  role: string;
  name: string;
  type: string | null;
}

export interface ActionControlChange extends ActionControlBrief {
  /** Which state fields changed, such as visible or checked. */
  changes: string[];
}

/**
 * Bounded structural changes observed after an action. Attribution is always
 * "observed_after_action_not_proven"; a change near the action is not proof
 * that the action caused it.
 */
export interface PageActionDelta {
  addedControls: ActionControlBrief[];
  removedControls: ActionControlBrief[];
  changedControls: ActionControlChange[];
  addedHeadings: string[];
  removedHeadings: string[];
  addedAlerts: string[];
  removedAlerts: string[];
  textChanged: boolean;
  textLengthDelta: number;
  readyState: string;
  /** Set when comparison across documents would be misleading. */
  limitation?: string;
}

/** What changed in the page after a click or type, as observed by a probe. */
export interface PageActionEffect {
  changed: boolean;
  urlChanged: boolean;
  titleChanged: boolean;
  domChanged: boolean;
  valueChanged: boolean;
  waitedMs: number;
  /** True when a signature could not be captured before or after the action. */
  probeFailed?: boolean;
  navigation?: boolean;
  documentReplaced?: boolean;
  readyState?: string;
  attribution?: "observed_after_action_not_proven";
  delta?: PageActionDelta;
}

export interface GlanceParams {
  /** URL to preview. Ignored when tabId is given. */
  url?: string;
  /** Preview an existing tab's URL instead of a new URL. */
  tabId?: string;
  /** Firefox container id or container name for a new URL. */
  container?: string | number;
  width?: number;
  height?: number;
  /** Host allowlist enforced by the bridge before the preview loads. */
  allowedDomains?: string[];
}

export interface GlanceResult {
  opened: boolean;
  url: string;
  mode: "glance" | "none";
  message?: string;
}

export interface SplitParams {
  tabIds: string[];
  gridType?: "grid" | "hsep" | "vsep";
  /** Show the split immediately. Defaults to true. */
  activate?: boolean;
}

export interface SplitResult {
  split: boolean;
  tabIds: string[];
  gridType: string;
}

export interface UnsplitParams {
  tabId?: string;
}

export interface UnsplitResult {
  unsplit: boolean;
  tabIds: string[];
  /** Newly appeared synthetic tabs that the bridge closed. */
  closedResidue?: number;
  /** Present when residue could not be closed safely or cleanup was unconfirmed. */
  limitation?: string;
}

export interface CreateFolderParams {
  label: string;
  tabIds?: string[];
  space?: string;
  collapsed?: boolean;
}

export interface AddTabsToFolderParams {
  folderId: string;
  tabIds: string[];
}

export interface HistorySearchParams {
  query?: string;
  limit?: number;
  /** Only entries visited within this many days. */
  sinceDays?: number;
  /** Restrict to one domain, for example "github.com". */
  domain?: string;
  /** Group entries by domain in the result. */
  groupByDomain?: boolean;
}

export interface HistoryGroup {
  domain: string;
  entries: HistoryEntry[];
}

export interface RecentlyClosedEntry {
  title: string;
  url: string;
  /** ISO timestamp when the tab was closed, when available. */
  closedAt: string | null;
}

export interface RecentlyClosedResult {
  entries: RecentlyClosedEntry[];
}

export interface ClipboardWriteParams {
  text: string;
}

export interface ClipboardWriteResult {
  written: boolean;
  length: number;
}

export interface BookmarksSearchParams {
  query?: string;
  limit?: number;
}

export interface SwitchSpaceResult {
  space: Space;
  activeSpaceId: string | null;
}

export type SpaceDeleteOutcome =
  | "completed"
  | "absent_after_timeout"
  | "pending_unknown"
  | "unknown"
  | "not_found"
  | "failed_before_commit";

export interface DeleteSpaceVerification {
  checkedAt: string;
  present: boolean | null;
  method: "spaces.list";
}

export interface DeleteSpaceResult {
  /** False when the outcome is pending or unknown. */
  ok?: boolean;
  /** True only when this request delivered a deletion confirmation. */
  deleted: boolean;
  spaceId: string;
  spaceName: string;
  activeSpaceId: string | null;

  outcome: SpaceDeleteOutcome;
  /** Delivered response, lost confirmation, or not applicable. */
  confirmation: "delivered" | "lost" | "not_applicable";
  verifiedAfterTimeout?: boolean;
  verification?: DeleteSpaceVerification;
}

export interface CloseTabsResult {
  closed: number;
  tabIds: string[];
}

export interface SelectTabResult {
  tab: TabInfo;
  activeSpaceId: string | null;
  /**
   * Observed window focus after `focusWindow: true`. Omitted when focus was
   * not requested or could not be observed.
   */
  windowFocused?: boolean;
}

export interface AddTabsToFolderResult {
  folder: FolderInfo;
  added: number;
}

export interface BridgeMethodMap {
  status: { params: undefined; result: BridgeStatus };
  "spaces.list": { params: undefined; result: SpacesResult };
  "spaces.create": { params: CreateSpaceParams; result: CreateSpaceResult };
  "spaces.switch": { params: SwitchSpaceParams; result: SwitchSpaceResult };
  "spaces.delete": { params: SpaceTargetParams; result: DeleteSpaceResult };
  "tabs.list": { params: TabsListParams | undefined; result: TabsResult };
  "tabs.open": { params: OpenTabsParams; result: OpenTabsResult };
  "tabs.close": { params: CloseTabsParams; result: CloseTabsResult };
  "tabs.select": { params: SelectTabParams; result: SelectTabResult };
  "tabs.pin": { params: PinTabsParams; result: PinTabsResult };
  "tabs.read": { params: TabReadParams; result: PageReadResult };
  "tabs.click": { params: ClickElementParams; result: ClickElementResult };
  "tabs.type": { params: TypeTextParams; result: TypeTextResult };
  "tabs.waitFor": { params: WaitForParams; result: WaitForResult };
  "tabs.evidence": {
    params: EvidenceShowParams;
    result: EvidenceOpResult;
  };
  "tabs.findText": {
    params: TextSearchParams;
    result: TextSearchResult;
  };
  "tabs.evidenceClear": {
    params: EvidenceClearParams;
    result: EvidenceClearResult;
  };
  "folders.list": { params: undefined; result: FoldersResult };
  "folders.create": { params: CreateFolderParams; result: CreateFolderResult };
  "folders.addTabs": {
    params: AddTabsToFolderParams;
    result: AddTabsToFolderResult;
  };
  "essentials.add": { params: EssentialsParams; result: EssentialsResult };
  "essentials.remove": { params: EssentialsParams; result: EssentialsResult };
  "containers.list": { params: undefined; result: ContainersResult };
  "glance.open": { params: GlanceParams; result: GlanceResult };
  "split.open": { params: SplitParams; result: SplitResult };
  "split.close": { params: UnsplitParams; result: UnsplitResult };
  "history.search": { params: HistorySearchParams; result: HistoryResult };
  "history.recentlyClosed": {
    params: undefined;
    result: RecentlyClosedResult;
  };
  "bookmarks.search": { params: BookmarksSearchParams; result: BookmarksResult };
  "clipboard.write": {
    params: ClipboardWriteParams;
    result: ClipboardWriteResult;
  };
}

export type BridgeMethod = keyof BridgeMethodMap;

/**
 * Every bridge operation the dispatcher accepts, in one runtime list. The
 * policy registry and the coverage tests enumerate this; the type below makes
 * a new `BridgeMethodMap` entry fail to compile until it is listed here.
 */
export const BRIDGE_METHODS = [
  "status",
  "spaces.list",
  "spaces.create",
  "spaces.switch",
  "spaces.delete",
  "tabs.list",
  "tabs.open",
  "tabs.close",
  "tabs.select",
  "tabs.pin",
  "tabs.read",
  "tabs.click",
  "tabs.type",
  "tabs.waitFor",
  "tabs.evidence",
  "tabs.evidenceClear",
  "tabs.findText",
  "folders.list",
  "folders.create",
  "folders.addTabs",
  "essentials.add",
  "essentials.remove",
  "containers.list",
  "glance.open",
  "split.open",
  "split.close",
  "history.search",
  "history.recentlyClosed",
  "bookmarks.search",
  "clipboard.write",
] as const satisfies readonly BridgeMethod[];

type MissingBridgeMethod = Exclude<
  BridgeMethod,
  (typeof BRIDGE_METHODS)[number]
>;
const BRIDGE_METHODS_EXHAUSTIVE: Record<MissingBridgeMethod, never> = {};
void BRIDGE_METHODS_EXHAUSTIVE;
