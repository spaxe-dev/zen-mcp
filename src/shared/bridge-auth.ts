/**
 * Shared constants for the bridge handshake. The server and the browser sign
 * differently prefixed messages with the same per-launch key, so a proof made
 * for one side can never be replayed as the other.
 */

export const CLIENT_AUTH_LABEL = "zen-mcp-client-auth-v1:";
export const SERVER_AUTH_LABEL = "zen-mcp-server-auth-v1:";
export const AUTH_NONCE_BYTES = 32;
export const AUTH_TIMEOUT_MS = 10_000;
export const AUTH_FAILED_CLOSE_CODE = 4003;
export const AUTH_TIMEOUT_CLOSE_CODE = 4008;
export const AUTH_REQUIRED_CLOSE_CODE = 4009;

export function clientAuthMessage(serverNonce: string): string {
  return CLIENT_AUTH_LABEL + serverNonce;
}

export function serverAuthMessage(clientNonce: string): string {
  return SERVER_AUTH_LABEL + clientNonce;
}
