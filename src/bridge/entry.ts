import { BRIDGE_PROTOCOL_VERSION } from "../shared/brand.js";
import type {
  BridgeToServer,
  ServerToBridge,
  UiQuestion,
} from "../shared/protocol.js";
import { createOps } from "./ops.js";
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
  win.__zenMcpWindowId ??= `win-${crypto.randomUUID().slice(0, 8)}`;
  const windowId = win.__zenMcpWindowId;

  let socket: WebSocket | null = null;
  let destroyed = false;
  let retryMs = 400;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const ui = new ZenMcpUi(win.document);
  const ops = createOps(win, windowId);

  const send = (message: BridgeToServer): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };

  const sendHello = () => {
    send({
      type: "hello",
      protocol: BRIDGE_PROTOCOL_VERSION,
      token: config.token,
      bridgeVersion: config.bridgeVersion,
      windowId,
      focused: win.document.hasFocus(),
      appVersion: String(Services.appinfo.version),
      platform: String(Services.appinfo.OS),
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

  const handleMessage = async (message: ServerToBridge) => {
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
      case "ui.activity":
        ui.showActivity(message.activity, {
          action: async (action) => {
            if (action.kind !== "space") {
              return { ok: false, error: `Unsupported action: ${action.kind}` };
            }
            try {
              await ops.dispatch("spaces.switch", { space: action.target });
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
      sendHello();
    };

    ws.onmessage = (event: MessageEvent) => {
      let message: ServerToBridge;
      try {
        message = JSON.parse(String(event.data)) as ServerToBridge;
      } catch {
        return;
      }
      void handleMessage(message);
    };

    ws.onclose = () => {
      if (socket === ws) socket = null;
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
