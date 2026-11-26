/**
 * Globals available to scripts running in Firefox/Zen browser chrome. The
 * bridge bundle is loaded into a browser window with `loadSubScript`, so these
 * resolve against the window's privileged global.
 */
declare const Services: any;
declare const Components: any;
declare const ChromeUtils: any;
/** Firefox's container identity service, exposed on some chrome windows. */
declare const ContextualIdentityService: any;

interface Window {
  gBrowser?: any;
  gBrowserInit?: any;
  gZenWorkspaces?: any;
  gZenFolders?: any;
  gZenStartup?: any;
  gZenUIManager?: any;
  PlacesUtils?: any;
  __zenMcpConfig?: {
    url: string;
    token: string;
    tokenId: string;
    bridgeVersion: string;
    serverVersion: string;
    policy?: import("../shared/policy.js").PolicySnapshot;
    policyPath?: string;
  };
  __zenMcpWindowId?: string;
  __zenMcpBridge?: {
    version: string;
    /** Non-secret digest of the session token, never the token itself. */
    tokenId: string;
    windowId: string;
    isConnected(): boolean;
    reconnect(): void;
    destroy(): void;
  };
}
