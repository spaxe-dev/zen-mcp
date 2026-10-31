import type { EvidenceMatchMethod } from "./evidence.js";

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

/** Persistent, compact status strip in the browser window. */
export interface UiBanner {
  state: BannerState;
  text: string;
  detail?: string;
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

export type BridgeToServer =
  | BridgeAuthResponse
  | BridgeHello
  | BridgePong
  | BridgeFocus
  | UiAnswer
  | UiActionEvent
  | UiStop
  | UiConsentResult
  | UiBannerAction
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
}

export interface BridgeResponse {
  type: "res";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message: string };
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
  | ShutdownMessage
  | BridgeRequest;

/* ------------------------------------------------------------------ *
 * Agent events, progress and watch mode
 * ------------------------------------------------------------------ */

export type AgentEventKind =
  | "stop"
  | "pause"
  | "resume"
  | "watch"
  | "question";

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
  | "outline";

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
}

export interface TabReadParams {
  tabId: string;
  maxChars?: number;
  format?: ReadFormat;
  selector?: string;
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

export interface DeleteSpaceResult {
  deleted: boolean;
  spaceId: string;
  spaceName: string;
  activeSpaceId: string | null;
}

export interface CloseTabsResult {
  closed: number;
  tabIds: string[];
}

export interface SelectTabResult {
  tab: TabInfo;
  activeSpaceId: string | null;
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
