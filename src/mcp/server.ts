import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeRequestError } from "../bridge/host.js";
import type { ZenMcpConfig } from "../config.js";
import { BRAND, SERVER_NAME, SERVER_VERSION } from "../shared/brand.js";
import type {
  ActivityTone,
  UiOption,
} from "../shared/protocol.js";
import type { ZenRuntime } from "../zen/runtime.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const SERVER_INSTRUCTIONS = `${BRAND} drives the user's Zen Browser from outside the page. Zen spaces are workspaces: tabs can live in a space the user is not looking at, and switching is instant for them.

Background research is the default workflow. Never take over the user's screen:
1. Look first with zen_status, zen_spaces_list, and zen_tabs_list.
2. zen_space_create with a short, descriptive name. It does not switch spaces by default.
3. zen_tabs_open with space=<id or name> and background=true (the default). Open at most 30 URLs per call and split longer lists. Group related tabs with zen_folder_create or by passing folderId.
4. Read with zen_read_page({ tabId }). Reads never select a tab, switch spaces, or focus the window. If a tab is still loading, the read fails with a clear error; wait a moment and retry.
5. Summarize in the conversation, then zen_notify with space=<space> so one click or swipe takes the user to the results.

When a decision is needed, use zen_ask. Options appear as a compact card inside Zen and the user answers without leaving the page. waitSeconds controls how long the tool blocks; if the result is "pending" or "deferred", the question stays open in Zen and zen_answers later shows the reply. Ask in small batches, prefer concrete options, and set allowFreeform when the answer may not be in the list.

Rules of thumb:
- Prefer spaces and background tabs over hijacking the user's active tab.
- Tab ids are stable only while the tab is open; re-list instead of guessing or reusing old ids.
- Delete a space only when the user asks, or when it was a temporary job space you created and they are done with it.
- When Zen is not reachable, call zen_launch once. If that fails, report the error and suggest the user run \`zen-mcp doctor\`.
- Keep the user informed with zen_notify for long background jobs instead of waiting silently.`;

export function createZenMcpServer(
  runtime: ZenRuntime,
  config: ZenMcpConfig
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  /* ------------------------------------------------------------------ *
   * Browser and launch
   * ------------------------------------------------------------------ */

  server.registerTool(
    "zen_status",
    {
      title: "Zen status",
      description:
        "Report whether Zen Browser is connected, the app version, the active space and tab, and every space with tab and folder counts. Use this first to orient yourself.",
      inputSchema: {
        windowId: z
          .string()
          .optional()
          .describe("Target a specific Zen window by id. Defaults to the focused window."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ windowId }) =>
      run(async () => {
        const status = await runtime.status(windowId);
        return {
          ...status,
          bridge: {
            port: runtime.hub.port,
            connections: runtime.hub.connectionCount,
            windows: runtime.hub.connectedWindows(),
          },
        };
      })
  );

  server.registerTool(
    "zen_launch",
    {
      title: "Launch Zen with agent access",
      description:
        "Start Zen through Zen MCP so the agent bridge can attach, or reconnect if it is already running. Use when another tool reports that Zen is not reachable.",
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    () =>
      run(async () => {
        const connection = await runtime.connect({ allowLaunch: true });
        const status = await runtime.status();
        return {
          launched: connection.launched,
          injection: connection.injection,
          windowId: status.windowId,
          appVersion: status.appVersion,
          spaces: status.spaces.length,
          activeSpaceId: status.activeSpaceId,
          message: connection.launched
            ? "Zen started with agent access."
            : "Zen is running and the bridge is attached.",
        };
      })
  );

  /* ------------------------------------------------------------------ *
   * Spaces
   * ------------------------------------------------------------------ */

  server.registerTool(
    "zen_spaces_list",
    {
      title: "List Zen spaces",
      description:
        "List every Zen space (workspace) with its id, name, icon, and tab, pinned, and folder counts. Space ids and names are accepted wherever a tool takes a space.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(() => runtime.request("spaces.list", undefined))
  );

  server.registerTool(
    "zen_space_create",
    {
      title: "Create a Zen space",
      description:
        "Create a new space. It does not switch to it by default, so the user stays on their current page; open tabs into it with zen_tabs_open. Use switchTo only when the user explicitly asks to go there.",
      inputSchema: {
        name: z.string().min(1).max(64).describe("Space name, short and descriptive."),
        icon: z
          .string()
          .optional()
          .describe("Optional icon string, usually a single emoji such as \"🐙\"."),
        containerTabId: z
          .number()
          .int()
          .optional()
          .describe("Optional Firefox container id to isolate this space."),
        switchTo: z
          .boolean()
          .optional()
          .describe("Switch to the new space after creating it. Defaults to false."),
      },
      annotations: { readOnlyHint: false },
    },
    ({ name, icon, containerTabId, switchTo }) =>
      run(async () => {
        await runtime.connect();
        return runtime.hub.createSpace({ name, icon, containerTabId, switchTo });
      })
  );

  server.registerTool(
    "zen_space_switch",
    {
      title: "Switch Zen space",
      description:
        "Switch the browser to an existing space by id or name. This changes what the user is looking at, so only do it when they ask or after telling them.",
      inputSchema: {
        space: z.string().min(1).describe("Space id or name."),
      },
      annotations: { readOnlyHint: false },
    },
    ({ space }) =>
      run(async () => {
        await runtime.connect();
        return runtime.hub.switchSpace({ space });
      })
  );

  server.registerTool(
    "zen_space_delete",
    {
      title: "Delete a Zen space",
      description:
        "Delete a space and the tabs it holds. Destructive: only use it for a space the agent created for a finished job, or when the user explicitly asks.",
      inputSchema: {
        space: z.string().min(1).describe("Space id or name."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ space }) =>
      run(async () => {
        await runtime.connect();
        return runtime.hub.deleteSpace({ space });
      })
  );

  /* ------------------------------------------------------------------ *
   * Tabs
   * ------------------------------------------------------------------ */

  server.registerTool(
    "zen_tabs_list",
    {
      title: "List Zen tabs",
      description:
        "List open tabs across all spaces, including tabs in inactive spaces. Filter by space, title or URL substring, or pinned/foldered tabs. Tab ids in the result are required by the other tab tools and stay valid while the tab is open.",
      inputSchema: {
        space: z
          .string()
          .optional()
          .describe("Only tabs in this space, by id or name."),
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring matched against title and URL."),
        pinnedOnly: z
          .boolean()
          .optional()
          .describe("Only tabs that are pinned or inside a folder."),
        limit: z.number().int().min(1).max(2000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ space, query, pinnedOnly, limit }) =>
      run(() => runtime.hub.listTabs({ space, query, pinnedOnly, limit }))
  );

  server.registerTool(
    "zen_tabs_open",
    {
      title: "Open tabs in a space",
      description:
        "Open up to 30 URLs in a space without changing what the user is looking at (background defaults to true). This is the workhorse for background research: create a space, open the results there, then read them with zen_read_page. Split longer lists across calls. Optionally put the new tabs into an existing folder.",
      inputSchema: {
        urls: z
          .array(z.string().min(1))
          .min(1)
          .max(30)
          .describe("HTTP(S) or about: URLs. At most 30 per call."),
        space: z
          .string()
          .optional()
          .describe("Space id or name. Defaults to the active space."),
        background: z
          .boolean()
          .optional()
          .describe("Do not select the new tabs. Defaults to true."),
        switchTo: z
          .boolean()
          .optional()
          .describe("Switch to the target space after opening. Defaults to false."),
        folderId: z
          .string()
          .optional()
          .describe("Put the new tabs into this folder (same space required)."),
      },
      annotations: { readOnlyHint: false },
    },
    ({ urls, space, background, switchTo, folderId }) =>
      run(async () => {
        await runtime.connect();
        return runtime.hub.openTabs({
          urls,
          space,
          background: background !== false,
          switchTo,
          folderId,
        });
      })
  );

  server.registerTool(
    "zen_tabs_close",
    {
      title: "Close tabs",
      description:
        "Close one or more tabs by id. Closing tabs is destructive to the user's session; only close tabs the agent opened, or tabs the user explicitly named.",
      inputSchema: {
        tabIds: z.array(z.string().min(1)).min(1).describe("Tab ids from zen_tabs_list."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ tabIds }) =>
      run(async () => {
        await runtime.connect();
        return runtime.hub.closeTabs({ tabIds });
      })
  );

  server.registerTool(
    "zen_tab_select",
    {
      title: "Select a tab",
      description:
        "Bring a tab into view, switching space and possibly focusing the Zen window. This takes over the user's screen; prefer zen_read_page for reading in the background.",
      inputSchema: {
        tabId: z.string().min(1).describe("Tab id from zen_tabs_list."),
        focusWindow: z
          .boolean()
          .optional()
          .describe("Also raise the Zen window. Defaults to false."),
      },
      annotations: { readOnlyHint: false },
    },
    ({ tabId, focusWindow }) =>
      run(async () => {
        await runtime.connect();
        return runtime.hub.selectTab({ tabId, focusWindow });
      })
  );

  /* ------------------------------------------------------------------ *
   * Folders
   * ------------------------------------------------------------------ */

  server.registerTool(
    "zen_folders_list",
    {
      title: "List Zen folders",
      description:
        "List tab folders in the window with their space, label, collapsed state, and tab ids.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(() => runtime.hub.listFolders())
  );

  server.registerTool(
    "zen_folder_create",
    {
      title: "Create a folder",
      description:
        "Create a Zen folder around existing tabs, optionally collapsed. Useful for grouping a batch of research tabs inside a space. Tabs must be in one space and cannot already belong to a folder or split view.",
      inputSchema: {
        label: z.string().min(1).describe("Folder label."),
        tabIds: z
          .array(z.string().min(1))
          .optional()
          .describe("Tabs to move into the folder."),
        space: z
          .string()
          .optional()
          .describe("Space id or name. Defaults to the tabs' space or the active space."),
        collapsed: z.boolean().optional().describe("Create the folder collapsed."),
      },
      annotations: { readOnlyHint: false },
    },
    ({ label, tabIds, space, collapsed }) =>
      run(async () => {
        await runtime.connect();
        return runtime.hub.createFolder({ label, tabIds, space, collapsed });
      })
  );

  server.registerTool(
    "zen_folder_add_tabs",
    {
      title: "Add tabs to a folder",
      description:
        "Move existing tabs into an existing folder. The tabs must be in the folder's space and not already grouped.",
      inputSchema: {
        folderId: z.string().min(1).describe("Folder id from zen_folders_list."),
        tabIds: z.array(z.string().min(1)).min(1).describe("Tab ids to move."),
      },
      annotations: { readOnlyHint: false },
    },
    ({ folderId, tabIds }) =>
      run(async () => {
        await runtime.connect();
        return runtime.hub.addTabsToFolder({ folderId, tabIds });
      })
  );

  /* ------------------------------------------------------------------ *
   * History and bookmarks
   * ------------------------------------------------------------------ */

  server.registerTool(
    "zen_history_search",
    {
      title: "Search history",
      description:
        "Search the user's browsing history by title or URL, most recent first. Use this to find pages the user already visited instead of guessing URLs.",
      inputSchema: {
        query: z.string().optional().describe("Substring of the title or URL. Empty lists recent pages."),
        sinceDays: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Only visits within this many days."),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, sinceDays, limit }) =>
      run(async () => {
        await runtime.connect();
        return runtime.hub.searchHistory({ query, sinceDays, limit });
      })
  );

  server.registerTool(
    "zen_bookmarks_search",
    {
      title: "Search bookmarks",
      description:
        "Search bookmarks by title or URL, newest first. Useful for the user's saved dashboards, repositories, and docs.",
      inputSchema: {
        query: z.string().optional().describe("Substring of the title or URL."),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit }) =>
      run(async () => {
        await runtime.connect();
        return runtime.hub.searchBookmarks({ query, limit });
      })
  );

  /* ------------------------------------------------------------------ *
   * Page reading
   * ------------------------------------------------------------------ */

  server.registerTool(
    "zen_read_page",
    {
      title: "Read a page",
      description:
        "Extract readable text, title, URL, description, and any selected text from a tab, including tabs in spaces the user is not looking at. Reading never selects the tab, switches space, or focuses the window. With no tabId it reads the active page. Large pages are truncated at maxChars.",
      inputSchema: {
        tabId: z
          .string()
          .optional()
          .describe("Tab id from zen_tabs_list. Defaults to the active tab."),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(60000)
          .optional()
          .describe("Maximum characters of page text to return. Defaults to 24000."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ tabId, maxChars }) =>
      run(() => runtime.readPage({ tabId, maxChars }))
  );

  /* ------------------------------------------------------------------ *
   * In-browser conversation
   * ------------------------------------------------------------------ */

  server.registerTool(
    "zen_ask",
    {
      title: "Ask the user in Zen",
      description:
        "Show a compact question card in the corner of the browser with optional multiple-choice answers and a freeform field. The tool waits up to waitSeconds for an answer. status \"pending\" or \"deferred\" means the card stays open in Zen; use zen_answers to collect it later. Keep the question short, put detail in context, and use 2-5 concrete options.",
      inputSchema: {
        question: z.string().min(1).max(500).describe("The question, one or two sentences."),
        options: z
          .array(
            z.object({
              label: z.string().min(1).max(120).describe("Option text."),
              description: z.string().max(300).optional().describe("Optional helper text."),
              value: z
                .string()
                .max(500)
                .optional()
                .describe("Value sent back instead of the label."),
            })
          )
          .max(6)
          .optional()
          .describe("Answer choices. Omit for a freeform-only question."),
        context: z
          .string()
          .max(600)
          .optional()
          .describe("Short background shown above the question."),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .optional()
          .describe(
            `How long to wait for an answer. Defaults to ${config.askTimeoutSeconds}s; 0 returns immediately.`
          ),
        allowFreeform: z
          .boolean()
          .optional()
          .describe("Let the user type an answer. Defaults to true."),
        multiSelect: z
          .boolean()
          .optional()
          .describe("Allow selecting several options. Defaults to false."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    ({ question, options, context, waitSeconds, allowFreeform, multiSelect }) =>
      run(() =>
        runtime.ask(question, (options ?? []) as UiOption[], {
          context,
          waitSeconds: waitSeconds ?? config.askTimeoutSeconds,
          allowFreeform,
          multiSelect,
        })
      )
  );

  server.registerTool(
    "zen_answers",
    {
      title: "Collect in-browser answers",
      description:
        "List questions still open in Zen and recently answered ones. Use after zen_ask returned pending or deferred, or to collect a late reply without blocking.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(async () => runtime.answers())
  );

  server.registerTool(
    "zen_notify",
    {
      title: "Show a status card in Zen",
      description:
        "Show a small activity card in the corner of the browser. With a space it includes an action button that takes the user straight to that space, which is how a finished background job is handed over.",
      inputSchema: {
        title: z.string().min(1).max(160).describe("Short headline."),
        detail: z.string().max(600).optional().describe("One or two lines of detail."),
        tone: z
          .enum(["info", "success", "warning"])
          .optional()
          .describe("Visual tone. Defaults to info."),
        space: z
          .string()
          .optional()
          .describe("Space id or name for the action button."),
        actionLabel: z
          .string()
          .max(60)
          .optional()
          .describe("Button text, for example \"Open PR space\"."),
        autoHideMs: z
          .number()
          .int()
          .min(0)
          .max(120000)
          .optional()
          .describe("Hide after this long. Defaults to 12000; 0 keeps it until dismissed."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    ({ title, detail, tone, space, actionLabel, autoHideMs }) =>
      run(async () =>
        runtime.notify({
          title,
          detail,
          tone: tone as ActivityTone | undefined,
          action: space ? { label: actionLabel ?? "Open space", space } : undefined,
          autoHideMs,
        })
      )
  );

  return server;
}

async function run(handler: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await handler();
    return {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: describeError(error) }],
      isError: true,
    };
  }
}

function describeError(error: unknown): string {
  if (error instanceof BridgeRequestError) {
    return `${error.message} (${error.code})`;
  }
  const message = String((error as Error)?.message ?? error);
  const name = (error as Error)?.name;
  return name && name !== "Error" ? `${name}: ${message}` : message;
}
