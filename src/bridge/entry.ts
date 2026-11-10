import { BRIDGE_PROTOCOL_VERSION } from "../shared/brand.js";
import {
  AUTH_TIMEOUT_MS,
  clientAuthMessage,
  serverAuthMessage,
} from "../shared/bridge-auth.js";
import type {
  BridgeToServer,
  ServerToBridge,
  UiQuestion,
} from "../shared/protocol.js";
import { createOps } from "./ops.js";
import {
  EvidenceRecordStore,
  cacheEvidenceRequest,
  revealEvidence,
} from "./evidence-reveal.js";
import { PendingStopStore, deliverStop } from "./pending-stop.js";
import { ZenMcpUi } from "./ui.js";

/**
 * Browser-chrome bridge. The MCP server loads this bundle into every Zen
 * window and hands it a WebSocket URL and token through
 * `window.__zenMcpConfig`.
 *
 * Everything here runs with the browser's system principal. Keep the surface
 * small: only the operations exposed by `ops.ts` and the UI are reachable from
 * the socket.
 */

(() => {
  const win = window as unknown as Window & typeof globalThis;
  const injectedConfig = win.__zenMcpConfig;
  delete win.__zenMcpConfig;
  if (!injectedConfig) {
    return;
  }
  const config = injectedConfig;

  win.__zenMcpBridge?.destroy();
  // Injection skips private windows, and this second check makes sure an
  // older bridge cannot stay alive there either.
  try {
    if (win.document?.documentElement?.getAttribute("privatebrowsingmode")) {
      return;
    }
  } catch {
    // If privacy cannot be determined, fall through and let the host filter.
  }
  win.__zenMcpWindowId ??= `win-${crypto.randomUUID().slice(0, 8)}`;
  const windowId = win.__zenMcpWindowId;

  let socket: WebSocket | null = null;
  let destroyed = false;
  let retryMs = 400;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let authenticated = false;
  let clientNonce = "";
  let authTimer: ReturnType<typeof setTimeout> | null = null;
  // A Stop press that could not be sent while the socket was down or before
  // the handshake finished. It is retried once the connection is usable.
  const pendingStop = new PendingStopStore();

  const send = (message: BridgeToServer): boolean => {
    // The host closes a connection on anything but auth before the handshake,
    // so a message is only delivered when the socket is open and authenticated.
    if (!authenticated || !socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };

  const clearAuthTimer = (): void => {
    if (authTimer) clearTimeout(authTimer);
    authTimer = null;
  };

  const toBase64Url = (bytes: Uint8Array): string => {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  const randomNonce = (): string => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return toBase64Url(bytes);
  };

  let hmacKey: Promise<CryptoKey> | null = null;
  const hmacProof = async (message: string): Promise<string> => {
    hmacKey ??= crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(config.token),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      await hmacKey,
      new TextEncoder().encode(message)
    );
    return toBase64Url(new Uint8Array(signature));
  };

  const secureEqual = (left: string, right: string): boolean => {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
      difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
  };

  const ui = new ZenMcpUi(win.document, {
    onStop: (progressId) =>
      deliverStop(pendingStop, progressId, (stop) =>
        send({
          type: "ui.stop",
          progressId: stop.progressId,
          ts: stop.ts,
        })
      ),
    onConsent: (id, granted) =>
      send({ type: "ui.consentResult", id, granted }),
    onBannerAction: (action) =>
      send({ type: "ui.bannerAction", action, ts: Date.now() }),
    onUpdateAction: (action) =>
      send({ type: "ui.updateAction", action, ts: Date.now() }),
  });
  const ops = createOps(win, windowId);
  // Last successful evidence request per tab, so "Show source" can re-run the
  // fixed highlight pipeline after the original overlay expired.
  const evidenceRecords = new EvidenceRecordStore();

  const sendHello = () => {
    send({
      type: "hello",
      protocol: BRIDGE_PROTOCOL_VERSION,
      bridgeVersion: config.bridgeVersion,
      windowId,
      focused: win.document.hasFocus(),
      appVersion: String(Services.appinfo.version),
      platform: String(Services.appinfo.OS),
    });
  };

  /**
   * Retries a Stop press that was made while the socket was down or still
   * authenticating. The queued timestamp is kept from the original press; the
   * host stamps the event. The entry stays queued until the host echoes
   * `stopRequested` or the progress card is replaced or cleared.
   */
  const flushPendingStop = () => {
    const pending = pendingStop.peek();
    if (!pending) return;
    send({
      type: "ui.stop",
      progressId: pending.progressId,
      ts: pending.ts,
    });
  };

  const scheduleReconnect = () => {
    if (destroyed || retryTimer) return;
    const delay = Math.min(retryMs, 15_000);
    retryMs = Math.min(Math.round(retryMs * 1.7), 15_000);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay + Math.random() * 250);
  };

  const handleAsk = (question: UiQuestion) => {
    ui.showQuestion(question, {
      send: (answer) =>
        send({
          type: "ui.answer",
          id: question.id,
          status: answer.status,
          answer: answer.answer,
          selectedLabels: answer.selectedLabels,
          freeform: answer.freeform,
        }),
    });
  };

  const respondToChallenge = async (nonce: unknown, ws: WebSocket) => {
    if (typeof nonce !== "string" || !nonce || nonce.length > 512) {
      destroy();
      return;
    }
    if (socket !== ws || destroyed) return;
    let proof: string;
    try {
      proof = await hmacProof(clientAuthMessage(nonce));
    } catch {
      destroy();
      return;
    }
    if (socket !== ws || destroyed) return;
    try {
      ws.send(
        JSON.stringify({ type: "auth.response", nonce: clientNonce, proof })
      );
    } catch {
      destroy();
    }
  };

  const verifyServerProof = async (
    confirm: Extract<ServerToBridge, { type: "auth.confirm" }>,
    ws: WebSocket
  ) => {
    if (
      !clientNonce ||
      typeof confirm.nonce !== "string" ||
      confirm.nonce !== clientNonce
    ) {
      destroy();
      return;
    }
    let expected: string;
    try {
      expected = await hmacProof(serverAuthMessage(clientNonce));
    } catch {
      destroy();
      return;
    }
    if (!secureEqual(String(confirm.proof ?? ""), expected)) {
      destroy();
      return;
    }
    if (socket !== ws || destroyed) return;
    authenticated = true;
    clearAuthTimer();
    sendHello();
    flushPendingStop();
  };

  const handleMessage = async (message: ServerToBridge, ws: WebSocket) => {
    if (!authenticated) {
      // Until the server proves it knows the key, only the handshake is
      // accepted. Anything else is a listener that took over the address.
      if (message.type === "auth.challenge") {
        await respondToChallenge(message.nonce, ws);
        return;
      }
      if (message.type === "auth.confirm") {
        await verifyServerProof(message, ws);
        return;
      }
      destroy();
      return;
    }
    switch (message.type) {
      case "welcome":
        return;
      case "server.ping":
        send({ type: "bridge.pong", ts: Date.now() });
        return;
      case "ui.ask":
        handleAsk(message.question);
        return;
      case "ui.cancel":
        ui.cancelQuestion(message.id);
        return;
      case "ui.progress": {
        ui.showProgress(message.progress);
        // The host echo confirms the Stop, the card was cleared, or a newer
        // card replaced the one the queued press belongs to.
        if (!message.progress || message.progress.stopRequested) {
          pendingStop.clear();
        } else {
          pendingStop.clearIfProgressMoved(message.progress.id);
        }
        return;
      }
      case "ui.consent":
        ui.showConsent(message.consent);
        return;
      case "ui.consentCancel":
        ui.cancelConsent(message.id);
        return;
      case "ui.banner":
        ui.showBanner(message.banner);
        return;
      case "ui.activity":
        ui.showActivity(message.activity, {
          action: async (action) => {
            try {
              if (action.kind === "space") {
                await ops.dispatch("spaces.switch", { space: action.target });
              } else if (action.kind === "tab") {
                // The action carries only a tab id. Selection is verified and
                // then a cached evidence request, if any, is replayed through
                // the fixed pipeline. Failures surface on the card.
                await revealEvidence(
                  (method, params) => ops.dispatch(method, params),
                  evidenceRecords,
                  action.target
                );
              } else {
                return {
                  ok: false,
                  error: `Unsupported action: ${action.kind}`,
                };
              }
              send({
                type: "ui.action",
                activityId: message.activity.id,
                actionId: action.id,
                ok: true,
              });
              return { ok: true };
            } catch (error) {
              const detail = String((error as Error)?.message ?? error);
              send({
                type: "ui.action",
                activityId: message.activity.id,
                actionId: action.id,
                ok: false,
                error: detail,
              });
              return { ok: false, error: detail };
            }
          },
        });
        return;
      case "shutdown":
        destroy();
        return;
      case "req": {
        try {
          const result = await ops.dispatch(message.method, message.params);
          if (message.method === "tabs.evidence") {
            const params = message.params as { tabId?: unknown } | undefined;
            cacheEvidenceRequest(
              evidenceRecords,
              params?.tabId,
              message.params,
              result
            );
          }
          send({
            type: "res",
            id: message.id,
            ok: true,
            result,
          });
        } catch (error) {
          const err = error as Error & { code?: string };
          send({
            type: "res",
            id: message.id,
            ok: false,
            error: {
              code: err.code ?? "bridge_error",
              message: String(err.message ?? err),
            },
          });
        }
        return;
      }
      default:
        return;
    }
  };

  function connect(): void {
    if (destroyed) return;
    authenticated = false;
    clientNonce = "";
    clearAuthTimer();
    let ws: WebSocket;
    try {
      ws = new WebSocket(config.url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      retryMs = 400;
      clientNonce = randomNonce();
      clearAuthTimer();
      authTimer = setTimeout(() => {
        authTimer = null;
        if (!authenticated) destroy();
      }, AUTH_TIMEOUT_MS);
    };

    ws.onmessage = (event: MessageEvent) => {
      let message: ServerToBridge;
      try {
        message = JSON.parse(String(event.data)) as ServerToBridge;
      } catch {
        return;
      }
      void handleMessage(message, ws);
    };

    ws.onclose = () => {
      if (socket === ws) {
        socket = null;
        authenticated = false;
        clearAuthTimer();
      }
      scheduleReconnect();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // The close handler schedules the reconnect.
      }
    };
  }

  const onFocus = () => {
    send({ type: "bridge.focus", focused: true, ts: Date.now() });
  };
  const onBlur = () => {
    send({ type: "bridge.focus", focused: false, ts: Date.now() });
  };
  win.addEventListener("focus", onFocus);
  win.addEventListener("blur", onBlur);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    authenticated = false;
    clientNonce = "";
    clearAuthTimer();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    win.removeEventListener("focus", onFocus);
    win.removeEventListener("blur", onBlur);
    const current = socket;
    socket = null;
    if (current) {
      try {
        current.close();
      } catch {
        // Already closed.
      }
    }
    ui.destroy();
    pendingStop.clear();
    if (win.__zenMcpBridge?.windowId === windowId) {
      delete win.__zenMcpBridge;
    }
  }

  win.__zenMcpBridge = {
    version: config.bridgeVersion,
    token: config.token,
    windowId,
    isConnected: () => socket?.readyState === WebSocket.OPEN,
    reconnect: () => {
      if (socket?.readyState === WebSocket.OPEN) return;
      socket?.close();
      socket = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      retryMs = 400;
      connect();
    },
    destroy,
  };

  win.addEventListener("unload", destroy, { once: true });
  connect();
})();
