import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import { BridgeHub } from "../../src/bridge/host.js";
import {
  AUTH_FAILED_CLOSE_CODE,
  AUTH_REQUIRED_CLOSE_CODE,
  CLIENT_AUTH_LABEL,
  SERVER_AUTH_LABEL,
  clientAuthMessage,
  serverAuthMessage,
} from "../../src/shared/bridge-auth.js";
import { BRIDGE_PATH } from "../../src/shared/protocol.js";
import { nullLogger } from "../../src/utils/logger.js";
import type { MarionetteClient } from "../../src/zen/marionette.js";

const BRIDGE_SCRIPT = join(process.cwd(), "dist", "bridge.js");

/**
 * The host challenges as soon as the socket opens, so the listener must exist
 * before the open event and buffer anything that arrives early.
 */
async function connect(
  port: number
): Promise<{ ws: WebSocket; next(): Promise<any> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_PATH}`);
  const queue: any[] = [];
  const waiters: Array<(message: any) => void> = [];
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return {
    ws,
    next: () => {
      const buffered = queue.shift();
      if (buffered) return Promise.resolve(buffered);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

describe("bridge handshake", () => {
  let hub: BridgeHub;
  let port = 0;

  before(async () => {
    hub = new BridgeHub({
      marionette: {} as MarionetteClient,
      bridgeScriptPath: BRIDGE_SCRIPT,
      logger: nullLogger,
    });
    await hub.start();
    port = hub.port;
  });

  after(async () => {
    await hub.stop();
  });

  it("opens with a fresh challenge and never a shared secret", async () => {
    const first = await connect(port);
    const firstChallenge = await first.next();
    first.ws.close();
    const second = await connect(port);
    const secondChallenge = await second.next();
    second.ws.close();

    assert.equal(firstChallenge.type, "auth.challenge");
    assert.equal(typeof firstChallenge.nonce, "string");
    assert.ok(firstChallenge.nonce.length >= 32);
    assert.equal(secondChallenge.type, "auth.challenge");
    assert.notEqual(firstChallenge.nonce, secondChallenge.nonce);
    assert.equal("token" in firstChallenge, false);
    assert.equal("proof" in firstChallenge, false);
  });

  it("refuses commands sent before authentication", async () => {
    const client = await connect(port);
    await client.next();
    const closed = nextClose(client.ws);
    client.ws.send(JSON.stringify({ type: "req", id: "r-1", method: "status" }));
    const result = await closed;
    assert.equal(result.code, AUTH_REQUIRED_CLOSE_CODE);
  });

  it("refuses a hello before authentication", async () => {
    const client = await connect(port);
    await client.next();
    const closed = nextClose(client.ws);
    client.ws.send(
      JSON.stringify({
        type: "hello",
        protocol: 2,
        bridgeVersion: "test",
        windowId: "win-test",
        focused: false,
        appVersion: "test",
        platform: "test",
      })
    );
    const result = await closed;
    assert.equal(result.code, AUTH_REQUIRED_CLOSE_CODE);
  });

  it("closes the socket on a wrong proof instead of registering it", async () => {
    const client = await connect(port);
    await client.next();
    const closed = nextClose(client.ws);
    client.ws.send(
      JSON.stringify({
        type: "auth.response",
        nonce: "client-nonce",
        proof: "not-the-key",
      })
    );
    const result = await closed;
    assert.equal(result.code, AUTH_FAILED_CLOSE_CODE);
    assert.equal(hub.connectionCount, 0);
  });
});

describe("bridge auth labels", () => {
  it("keeps client and server proofs in separate domains", () => {
    assert.notEqual(CLIENT_AUTH_LABEL, SERVER_AUTH_LABEL);
    assert.equal(clientAuthMessage("abc"), `${CLIENT_AUTH_LABEL}abc`);
    assert.equal(serverAuthMessage("abc"), `${SERVER_AUTH_LABEL}abc`);
    assert.notEqual(clientAuthMessage("abc"), serverAuthMessage("abc"));
  });
});
