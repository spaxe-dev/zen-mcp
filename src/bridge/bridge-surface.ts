/**
 * The public handle on `window.__zenMcpBridge`. It is deliberately small:
 * browser chrome can read it, so it must never carry the authentication key
 * or any other secret. `tokenId` is a non-secret digest used only to tell a
 * current bridge from one injected by an older server process.
 */
export interface BridgeSurface {
  version: string;
  tokenId: string;
  windowId: string;
  isConnected(): boolean;
  reconnect(): void;
  destroy(): void;
}

export function createBridgeSurface(input: BridgeSurface): BridgeSurface {
  return {
    version: input.version,
    tokenId: input.tokenId,
    windowId: input.windowId,
    isConnected: input.isConnected,
    reconnect: input.reconnect,
    destroy: input.destroy,
  };
}
