import type { BrowserEventPayload } from "../shared/protocol.js";
import { documentIdForTab } from "./tab-identity.js";

/**
 * Chrome-side observers for tab, navigation, document and dialog transitions.
 *
 * Every observation is attributed to the browser, never to the action that
 * caused it. Dialog observers read the chrome window type only: never the
 * prompt text, and they never dismiss or answer anything.
 */

type ChromeWindow = any;
type ChromeTab = any;

const STATE_START = 0x00000001;
const STATE_REDIRECTING = 0x00000002;
const STATE_STOP = 0x00000010;
const STATE_IS_DOCUMENT = 0x00020000;
const STATE_IS_WINDOW = 0x00080000;
const LOCATION_CHANGE_SAME_DOCUMENT = 0x00000001;

const DIALOG_LABELS: Record<string, string> = {
  "prompt:alert": "alert",
  "prompt:confirm": "confirm",
  "prompt:prompt": "prompt",
  "prompt:beforeunload": "beforeunload",
  "common-dialog": "common",
  printDialog: "print",
};

const MAX_DIALOG_TYPE = 60;

export interface BrowserEventObserver {
  destroy(): void;
}

function rawSpecOf(uri: unknown): string {
  try {
    const spec = (uri as { spec?: unknown } | null)?.spec;
    return typeof spec === "string" ? spec : "";
  } catch {
    return "";
  }
}

function specOf(uri: unknown): string {
  const spec = rawSpecOf(uri);
  return /^https?:\/\//i.test(spec) ? spec : "";
}

function isPrivateWindow(target: any): boolean {
  try {
    return Boolean(
      target?.document?.documentElement?.getAttribute("privatebrowsingmode")
    );
  } catch {
    return false;
  }
}

function titleOf(tab: ChromeTab): string {
  try {
    const label = tab?.label || tab?.linkedBrowser?.contentTitle;
    return typeof label === "string" ? label.slice(0, 300) : "";
  } catch {
    return "";
  }
}

export function observeBrowserEvents(
  win: ChromeWindow,
  tabIdFor: (tab: ChromeTab) => string,
  emit: (event: BrowserEventPayload) => void
): BrowserEventObserver {
  const gBrowser = win?.gBrowser;
  if (!gBrowser || typeof gBrowser.addTabsProgressListener !== "function") {
    return { destroy: () => undefined };
  }

  let stopped = false;
  const send = (event: BrowserEventPayload): void => {
    if (!stopped) emit(event);
  };

  const cleanups: Array<() => void> = [];
  const dialogLabels = new WeakMap<object, string>();
  const dialogWindows = new WeakSet<object>();
  /** Last real identity per tab; a closing tab has no browsing context left. */
  const tabIdentities = new WeakMap<
    object,
    { url: string; title: string; documentId: string }
  >();

  const tabFor = (browser: unknown): ChromeTab | null => {
    try {
      const tab = gBrowser.getTabForBrowser?.(browser);
      if (!tab || tab.linkedBrowser !== browser) return null;
      return tab;
    } catch {
      return null;
    }
  };

  const identityOf = (tab: ChromeTab): {
    url: string;
    title: string;
    documentId: string;
  } => {
    const cached = tabIdentities.get(tab);
    const raw = rawSpecOf(tab?.linkedBrowser?.currentURI);
    const merged = {
      // An empty raw spec means the document is already gone (close), so the
      // last real identity is replayed. A non-http spec means the new URL is
      // unreportable and must not fall back to the previous page.
      url: raw ? specOf(raw) : cached?.url ?? "",
      title: titleOf(tab) || cached?.title || "",
      documentId: documentIdForTab(tab) || cached?.documentId || "",
    };
    tabIdentities.set(tab, merged);
    return merged;
  };

  const emitTab = (
    tab: ChromeTab,
    phase: BrowserEventPayload["phase"]
  ): void => {
    if (!tab) return;
    send({ kind: "tab", phase, tabId: tabIdFor(tab), ...identityOf(tab) });
  };

  const onTabOpen = (event: any): void => {
    emitTab(event?.target, "opened");
  };
  const onTabClose = (event: any): void => {
    emitTab(event?.target, "closed");
  };
  const onTabSelect = (event: any): void => {
    emitTab(event?.target, "selected");
  };

  const tabContainer = gBrowser.tabContainer;
  if (tabContainer && typeof tabContainer.addEventListener === "function") {
    tabContainer.addEventListener("TabOpen", onTabOpen);
    tabContainer.addEventListener("TabClose", onTabClose);
    tabContainer.addEventListener("TabSelect", onTabSelect);
    cleanups.push(() => {
      tabContainer.removeEventListener("TabOpen", onTabOpen);
      tabContainer.removeEventListener("TabClose", onTabClose);
      tabContainer.removeEventListener("TabSelect", onTabSelect);
    });
  }

  const onLocationChange = (
    browser: unknown,
    webProgress: any,
    _request: unknown,
    uri: unknown,
    flags: unknown
  ): void => {
    // The same listener fires for every subframe; only the top document is a
    // navigation of the tab.
    if (webProgress?.isTopLevel !== true) return;
    const tab = tabFor(browser);
    if (!tab) return;
    const sameDocument =
      (Number(flags) & LOCATION_CHANGE_SAME_DOCUMENT) !== 0;
    const identity = identityOf(tab);
    const base = {
      tabId: tabIdFor(tab),
      url: specOf(uri) || identity.url,
      title: identity.title,
      documentId: identity.documentId,
    };
    if (sameDocument) {
      send({ kind: "navigation", phase: "same_document", ...base });
      return;
    }
    send({ kind: "navigation", phase: "committed", ...base });
    send({ kind: "document", phase: "replaced", ...base });
  };

  const bindingCancelled = (status: unknown): boolean => {
    const code = Number(status);
    // NS_BINDING_ABORTED and NS_BINDING_CANCELLED_OLD_LOAD: a superseded or
    // cancelled load, not a failed navigation.
    return code === 0x804b0002 || code === 0x804b0004;
  };

  const onStateChange = (
    browser: unknown,
    webProgress: any,
    _request: unknown,
    stateFlags: unknown,
    status: unknown
  ): void => {
    const flags = Number(stateFlags);
    if (!Number.isFinite(flags) || webProgress?.isTopLevel !== true) return;
    if (
      (flags & STATE_IS_DOCUMENT) === 0 ||
      (flags & STATE_IS_WINDOW) === 0
    ) {
      return;
    }
    const tab = tabFor(browser);
    if (!tab) return;
    const base = { tabId: tabIdFor(tab), ...identityOf(tab) };
    if ((flags & STATE_REDIRECTING) !== 0) {
      send({ kind: "navigation", phase: "redirect", ...base });
      return;
    }
    if ((flags & STATE_START) !== 0) {
      send({ kind: "navigation", phase: "started", ...base });
      return;
    }
    if ((flags & STATE_STOP) !== 0) {
      if (bindingCancelled(status)) return;
      let ok = false;
      try {
        ok = Components.isSuccessCode(status) === true;
      } catch {
        ok = Number(status) === 0;
      }
      send({
        kind: "navigation",
        phase: ok ? "completed" : "failed",
        ...base,
        ...(ok ? {} : { detail: "The navigation did not finish" }),
      });
    }
  };

  const progressListener = {
    onLocationChange,
    onStateChange,
  };
  gBrowser.addTabsProgressListener(progressListener);
  cleanups.push(() => {
    try {
      gBrowser.removeTabsProgressListener?.(progressListener);
    } catch {
      // The window may already be gone.
    }
  });

  const windowTypeOf = (subject: any): string => {
    try {
      const doc = subject?.document;
      // Content cannot own a chrome document; refusing other schemes stops a
      // page from spoofing a dialog label through windowtype.
      if (!String(doc?.documentURI || "").startsWith("chrome://")) return "";
      const type = doc?.documentElement?.getAttribute("windowtype");
      return typeof type === "string" ? type.slice(0, MAX_DIALOG_TYPE) : "";
    } catch {
      return "";
    }
  };

  const trackDialogWindow = (subject: any): void => {
    if (!subject || typeof subject !== "object") return;
    // A private window's dialogs stay private, even when a normal window
    // opened it.
    if (isPrivateWindow(subject)) return;
    // Dialogs are app-global; only the window that opened one reports it.
    try {
      if (subject.opener !== win) return;
    } catch {
      return;
    }
    const inspect = (): void => {
      const type = windowTypeOf(subject);
      const label = DIALOG_LABELS[type];
      if (!label || dialogWindows.has(subject)) return;
      dialogWindows.add(subject);
      dialogLabels.set(subject, label);
      send({ kind: "dialog", phase: "shown", label });
    };
    inspect();
    if (dialogLabels.has(subject) || dialogWindows.has(subject)) return;
    try {
      subject.addEventListener?.("load", inspect, { once: true });
    } catch {
      // A window that cannot be inspected is ignored.
    }
  };

  // Content alerts and confirms are tab-modal: they are not new windows, so
  // they are observed on the chrome window instead.
  const onWillOpenModal = (): void => {
    send({ kind: "dialog", phase: "shown", label: "tab-modal" });
  };
  const onModalClosed = (): void => {
    send({ kind: "dialog", phase: "hidden", label: "tab-modal" });
  };
  try {
    win.addEventListener("DOMWillOpenModalDialog", onWillOpenModal, true);
    win.addEventListener("DOMModalDialogClosed", onModalClosed, true);
    cleanups.push(() => {
      try {
        win.removeEventListener("DOMWillOpenModalDialog", onWillOpenModal, true);
      } catch {
        // The window may already be gone.
      }
      try {
        win.removeEventListener("DOMModalDialogClosed", onModalClosed, true);
      } catch {
        // The window may already be gone.
      }
    });
  } catch {
    // Dialog observation is optional.
  }

  const observer = {
    observe(subject: unknown, topic: unknown): void {
      if (topic === "domwindowopened") {
        trackDialogWindow(subject);
        return;
      }
      if (topic === "domwindowclosed") {
        if (!subject || typeof subject !== "object") return;
        const label = dialogLabels.get(subject as object);
        if (!label) return;
        dialogLabels.delete(subject as object);
        send({ kind: "dialog", phase: "hidden", label });
      }
    },
  };

  try {
    Services.obs.addObserver(observer, "domwindowopened");
    Services.obs.addObserver(observer, "domwindowclosed");
    cleanups.push(() => {
      for (const topic of ["domwindowopened", "domwindowclosed"]) {
        try {
          Services.obs.removeObserver(observer, topic);
        } catch {
          // Observers are best effort once the window is going away.
        }
      }
    });
  } catch {
    // Dialog observation is optional; tab and navigation observation remain.
  }

  return {
    destroy: () => {
      stopped = true;
      while (cleanups.length) {
        const cleanup = cleanups.pop();
        try {
          cleanup?.();
        } catch {
          // Keep tearing down the rest.
        }
      }
    },
  };
}
