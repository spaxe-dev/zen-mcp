import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BrowserLifecycle, type LaunchIdentity } from "../../src/zen/lifecycle.js";
import {
  StaticProcessProbe,
  type ProcessIdentity,
} from "../../src/zen/process-identity.js";

function identity(pid: number, token = `start-${pid}`): ProcessIdentity {
  return { pid, startToken: token, source: "test" };
}

function launch(
  browser: ProcessIdentity | undefined,
  launched: ProcessIdentity | undefined
): LaunchIdentity {
  return {
    launchedPid: launched?.pid ?? 10,
    browserPid: browser?.pid ?? 11,
    profile: "test-profile",
    launchedAt: 1000,
    launchedIdentity: launched,
    browserIdentity: browser,
  };
}

describe("process identity", () => {
  it("accepts the same PID and start token and rejects PID reuse", async () => {
    const probe = new StaticProcessProbe();
    const old = identity(42, "old");
    probe.set(42, { status: "alive", identity: old });
    assert.equal((await probe.verify(old)).status, "alive");

    probe.set(42, { status: "alive", identity: identity(42, "new") });
    assert.equal((await probe.verify(old)).status, "exited");
  });

  it("distinguishes missing processes from unknown probes", async () => {
    const probe = new StaticProcessProbe();
    assert.equal((await probe.probe(91)).status, "exited");
    probe.set(92, { status: "unknown", reason: "probe unavailable" });
    assert.equal((await probe.probe(92)).status, "unknown");
  });
});

describe("browser lifecycle", () => {
  it("does not allow a relaunch while the previous browser is alive", async () => {
    const probe = new StaticProcessProbe();
    const browser = identity(20);
    const launched = identity(21);
    probe.set(20, { status: "alive", identity: browser });
    probe.set(21, { status: "alive", identity: launched });
    const lifecycle = new BrowserLifecycle(probe);
    lifecycle.markConnected();

    const record = await lifecycle.markLost(launch(browser, launched), "socket closed");

    assert.equal(record.state, "lost_process_alive");
    assert.equal(lifecycle.decision(false).allowed, false);
    assert.equal(lifecycle.decision(true).allowed, false);
    assert.equal(lifecycle.info().processAlive, "alive");
  });

  it("fails closed when the browser start identity is unknown", async () => {
    const probe = new StaticProcessProbe();
    const lifecycle = new BrowserLifecycle(probe);
    lifecycle.markConnected();

    const record = await lifecycle.markLost(launch(undefined, identity(21)), "socket closed");

    assert.equal(record.state, "lost_process_unknown");
    assert.equal(lifecycle.decision(true).allowed, false);
    assert.equal(lifecycle.info().processAlive, "unknown");
  });

  it("allows only explicit recovery after a confirmed exit", async () => {
    const probe = new StaticProcessProbe();
    const browser = identity(30);
    const launched = identity(31);
    probe.set(30, { status: "exited" });
    probe.set(31, { status: "exited" });
    const lifecycle = new BrowserLifecycle(probe);
    lifecycle.markConnected();

    const record = await lifecycle.markLost(launch(browser, launched), "socket closed");

    assert.equal(record.state, "confirmed_exited");
    assert.equal(lifecycle.decision(false).allowed, false);
    assert.equal(lifecycle.decision(true).allowed, true);
    lifecycle.markRelaunching();
    assert.equal(lifecycle.state, "relaunch_in_progress");
    lifecycle.markConnected();
    assert.equal(lifecycle.state, "owned_connected");
    assert.equal(lifecycle.decision(false).allowed, true);
  });

  it("detects PID reuse as the old process being gone", async () => {
    const probe = new StaticProcessProbe();
    const browser = identity(40, "old");
    const launched = identity(41, "old-launch");
    probe.set(40, { status: "alive", identity: identity(40, "new") });
    probe.set(41, { status: "exited" });
    const lifecycle = new BrowserLifecycle(probe);
    lifecycle.markConnected();
    await lifecycle.markLost(launch(browser, launched), "socket closed");

    await lifecycle.refresh();

    assert.equal(lifecycle.state, "confirmed_exited");
  });

  it("records a failed relaunch without discarding the previous recovery record", async () => {
    const probe = new StaticProcessProbe();
    const browser = identity(50);
    const launched = identity(51);
    probe.set(50, { status: "exited" });
    probe.set(51, { status: "exited" });
    const lifecycle = new BrowserLifecycle(probe);
    lifecycle.markConnected();
    await lifecycle.markLost(launch(browser, launched), "socket closed");
    lifecycle.markRelaunching();
    lifecycle.markRelaunchFailed(new Error("nonce mismatch"));

    assert.equal(lifecycle.state, "recovery_failed");
    assert.equal(lifecycle.decision(true).allowed, true);
    assert.equal(lifecycle.info().lastError, "nonce mismatch");
  });
});
