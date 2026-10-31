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
  kind: "space";
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

export interface BridgeHello {
  type: "hello";
  protocol: number;
  token: string;
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
  | BridgeHello
  | BridgePong
  | BridgeFocus
  | UiAnswer
  | UiActionEvent
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
  | ServerWelcome
  | ServerPing
  | AskUiMessage
  | CancelUiMessage
  | ActivityUiMessage
  | ShutdownMessage
  | BridgeRequest;

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
}

export interface HistoryEntry {
  title: string;
  url: string;
  lastVisited: string | null;
  visitCount: number;
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

export interface PageReadResult {
  title: string;
  url: string;
  selectedText: string;
  text: string;
  truncated: boolean;
  length: number;
  description: string | null;
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
}

export interface CloseTabsParams {
  tabIds: string[];
}

export interface SelectTabParams {
  tabId: string;
  /** Also focus the Zen window. Defaults to false. */
  focusWindow?: boolean;
}

export interface TabReadParams {
  tabId: string;
  maxChars?: number;
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
  "tabs.read": { params: TabReadParams; result: PageReadResult };
  "folders.list": { params: undefined; result: FoldersResult };
  "folders.create": { params: CreateFolderParams; result: CreateFolderResult };
  "folders.addTabs": {
    params: AddTabsToFolderParams;
    result: AddTabsToFolderResult;
  };
  "history.search": { params: HistorySearchParams; result: HistoryResult };
  "bookmarks.search": { params: BookmarksSearchParams; result: BookmarksResult };
}

export type BridgeMethod = keyof BridgeMethodMap;
