import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BridgeRequestError } from "../../src/bridge/host.js";
import type { ZenMcpConfig } from "../../src/config.js";
import { isPortOpen, waitForProcessExit } from "../../src/zen/launcher.js";
import { MarionetteClient } from "../../src/zen/marionette.js";
import { ZenAccessError, ZenRuntime } from "../../src/zen/runtime.js";
import type { UpdateInfo } from "../../src/zen/updates.js";
import { e2eEnabled, removeTestProfile, testConfig, testProfilePath } from "./helpers.js";

const BRIDGE_SCRIPT = join(process.cwd(), "dist", "bridge.js");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls the Zen MCP shadow UI through the runtime's own Marionette session. */
async function pollUi(
  runtime: ZenRuntime,
  selector: string,
  body: string,
  timeoutMs = 20_000
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = { ok: false, why: "not polled" };
  while (Date.now() < deadline) {
    try {
      last = await runtime.marionette.executeChrome(`
        const win = Services.wm.getMostRecentWindow("navigator:browser");
        const host = win.document.getElementById("zen-mcp-host");
        if (!host) return { ok: false, why: "no host" };
        const card = host.shadowRoot.querySelector(${JSON.stringify(selector)});
        if (!card) return { ok: false, why: "no card" };
        ${body}
      `);
    } catch (error) {
      last = { ok: false, why: String((error as Error)?.message ?? error) };
    }
    if (last?.ok) return last;
    await sleep(150);
  }
  return last;
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 10_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

async function startRuntime(
  overrides: Partial<ZenMcpConfig> = {},
  options: {
    checkUpdate?: () => Promise<UpdateInfo>;
    installUpdate?: () => Promise<{ ok: boolean; message?: string }>;
  } = {}
): Promise<ZenRuntime> {
  const runtime = new ZenRuntime({
    config: {
      ...testConfig(),
      requireConsent: true,
      consentTimeoutSeconds: 60,
      ...overrides,
    },
    bridgeScriptPath: BRIDGE_SCRIPT,
    ...options,
  });
  await runtime.start();
  return runtime;
}

/** Never leaves a rejected connect unhandled while the test drives the UI. */
function attemptConnect(runtime: ZenRuntime) {
  return runtime.connect({ allowLaunch: true }).then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );
}

describe(
  "Zen MCP security boundary",
  { skip: e2eEnabled() ? false : "set ZEN_MCP_E2E=1 to run" },
  () => {
    let runtime: ZenRuntime;
    let browserPid: number | null = null;

    before(async () => {
      runtime = await startRuntime();
    });

    after(async () => {
      await runtime?.shutdown().catch(() => undefined);
      await waitForProcessExit(browserPid, 20_000);
      removeTestProfile(testProfilePath());
    });

    it("approves in the browser and closes Marionette to everyone else", async () => {
      const pending = attemptConnect(runtime);

      const card = await pollUi(
        runtime,
        ".card.consent",
        `const title = card.querySelector(".consent-title")?.textContent || "";
         const detail = card.querySelector(".consent-detail")?.textContent || "";
         const allow = card.querySelector("button.allow");
         if (!allow) return { ok: false, why: "no allow button" };
         if (!detail.includes("separate agent profile")) {
           return { ok: false, why: "profile note: " + detail };
         }
         return { ok: true, title, detail };`
      );
      assert.equal(card.ok, true, `consent card: ${card.why}`);
      assert.match(card.title, /Let Zen MCP control Zen/);

      // The listener is already shut before the user decides, so no other
      // local process can slip a session in while the card is open.
      assert.equal(
        await isPortOpen(runtime.config.marionettePort, 1_000),
        false,
        "Marionette must stop listening before approval"
      );
      await assert.rejects(
        new MarionetteClient({
          port: runtime.config.marionettePort,
          connectTimeoutMs: 1_500,
        }).connect(),
        /Could not reach Marionette|Timed out connecting/
      );

      const banner = await pollUi(
        runtime,
        ".sk-banner",
        `const button = card.querySelector(".banner-button");
         return {
           ok: card.dataset.state === "pending",
           state: card.dataset.state,
           hidden: !!button?.hidden,
         };`
      );
      assert.equal(banner.ok, true, "the banner shows the pending approval");
      assert.equal(banner.hidden, true, "pause is hidden until approval");

      const clicked = await pollUi(
        runtime,
        ".card.consent",
        `card.querySelector("button.allow").click();
         return { ok: true };`,
        10_000
      );
      assert.equal(clicked.ok, true, `allow click: ${clicked.why}`);

      const connected = await pending;
      assert.equal(
        connected.ok,
        true,
        connected.ok ? "" : String((connected as any).error?.message)
      );
      assert.equal(connected.ok && connected.value.launched, true);

      const session = runtime.sessionInfo();
      browserPid = session.browserPid;
      assert.equal(session.consent, "granted");
      assert.equal(session.ownsBrowser, true);
      assert.equal(session.lockedDown, true);
      assert.equal(session.paused, false);
      assert.ok(browserPid, "the owned browser pid is recorded");
    });

    it("blocks every browser operation while paused and restores them", async () => {
      const clicked = await pollUi(
        runtime,
        ".sk-banner",
        `const button = card.querySelector(".banner-button");
         if (!button || button.hidden) return { ok: false, why: "no pause button" };
         if (button.textContent !== "Pause") {
           return { ok: false, why: "button: " + button.textContent };
         }
         button.click();
         return { ok: true };`
      );
      assert.equal(clicked.ok, true, `pause click: ${clicked.why}`);
      assert.equal(await waitFor(() => runtime.paused), true, "pause reached the server");

      await assert.rejects(
        runtime.hub.request("status", undefined),
        (error: unknown) =>
          error instanceof BridgeRequestError && error.code === "paused"
      );
      const events = await runtime.events({ waitSeconds: 0 });
      assert.equal(events.stopped, true);
      assert.equal(events.paused, true);
      const notified = await runtime.hub.notify({
        title: "paused",
        detail: "must not reach the browser",
      });
      assert.equal(notified.delivered, false);
      const asked = await runtime.ask("should not appear", [{ label: "No" }], {
        waitSeconds: 0,
      });
      assert.equal(asked.status, "unavailable");
      assert.equal(runtime.progress({ title: "paused", step: "x" }).delivered, false);

      const resume = await pollUi(
        runtime,
        ".sk-banner",
        `const button = card.querySelector(".banner-button");
         if (!button || button.hidden) return { ok: false, why: "no resume button" };
         if (button.textContent !== "Resume") {
           return { ok: false, why: "button: " + button.textContent };
         }
         button.click();
         return { ok: true };`
      );
      assert.equal(resume.ok, true, `resume click: ${resume.why}`);
      assert.equal(await waitFor(() => !runtime.paused), true, "resume reached the server");

      const status = await runtime.hub.status();
      assert.equal(status.appName, "Zen");
      const resumedEvents = await runtime.events({ waitSeconds: 0 });
      assert.equal(resumedEvents.paused, false);
      assert.equal(resumedEvents.stopped, false);
    });

    it("quits the browser it started when the server shuts down", async () => {
      const pid = runtime.sessionInfo().browserPid;
      assert.ok(pid, "browser pid is known");

      await runtime.shutdown();
      assert.equal(
        await waitForProcessExit(pid, 20_000),
        true,
        "the owned browser exits with the server"
      );
      assert.equal(runtime.sessionInfo().ownsBrowser, false);
    });
  }
);

describe(
  "Zen MCP consent denial",
  { skip: e2eEnabled() ? false : "set ZEN_MCP_E2E=1 to run" },
  () => {
    let runtime: ZenRuntime;

    before(async () => {
      runtime = await startRuntime();
    });

    after(async () => {
      await runtime?.shutdown().catch(() => undefined);
      removeTestProfile(testProfilePath());
    });

    it("closes the browser when the user declines access", async () => {
      const pending = attemptConnect(runtime);

      const card = await pollUi(
        runtime,
        ".card.consent",
        `const deny = card.querySelector("button.deny");
         if (!deny) return { ok: false, why: "no deny button" };
         return { ok: true };`
      );
      assert.equal(card.ok, true, `consent card: ${card.why}`);

      const pid = runtime.sessionInfo().browserPid;
      assert.ok(pid, "browser pid is known before the decision");

      const denied = await pollUi(
        runtime,
        ".card.consent",
        `card.querySelector("button.deny").click();
         return { ok: true };`,
        10_000
      );
      // Denying closes the browser, so the click can outrun the reply. The
      // denial result and the process exit below are the authoritative checks.
      assert.ok(
        denied.ok || /not connected|not reach/i.test(String(denied.why)),
        `deny click: ${denied.why}`
      );

      const result = await pending;
      assert.equal(result.ok, false);
      assert.ok(
        !result.ok && result.error instanceof ZenAccessError,
        "denial surfaces as ZenAccessError"
      );
      assert.match(String((result as any).error?.message), /declined/);
      assert.equal(
        await waitForProcessExit(pid, 20_000),
        true,
        "declining closes the browser Zen MCP started"
      );
    });
  }
);

describe(
  "Zen MCP consent timeout",
  { skip: e2eEnabled() ? false : "set ZEN_MCP_E2E=1 to run" },
  () => {
    let runtime: ZenRuntime;

    before(async () => {
      runtime = await startRuntime({ consentTimeoutSeconds: 1 });
    });

    after(async () => {
      await runtime?.shutdown().catch(() => undefined);
      removeTestProfile(testProfilePath());
    });

    it("keeps the card and lets a later tool call wait again", async () => {
      const first = await attemptConnect(runtime);
      assert.equal(first.ok, false);
      assert.ok(
        !first.ok && first.error instanceof ZenAccessError,
        "a timeout surfaces as ZenAccessError"
      );
      assert.match(String((first as any).error?.message), /waiting for approval/);

      const still = await pollUi(
        runtime,
        ".card.consent",
        `const title = card.querySelector(".consent-title")?.textContent || "";
         return { ok: true, title };`,
        5_000
      );
      assert.equal(still.ok, true, "the card stays open after the timeout");
      assert.match(still.title, /Let Zen MCP control Zen/);

      const pending = attemptConnect(runtime);
      const clicked = await pollUi(
        runtime,
        ".card.consent",
        `card.querySelector("button.allow").click();
         return { ok: true };`,
        10_000
      );
      assert.equal(clicked.ok, true, `allow click: ${clicked.why}`);

      const second = await pending;
      assert.equal(
        second.ok,
        true,
        second.ok ? "" : String((second as any).error?.message)
      );
      assert.equal(runtime.sessionInfo().consent, "granted");
    });
  }
);

describe(
  "Zen MCP update bar",
  { skip: e2eEnabled() ? false : "set ZEN_MCP_E2E=1 to run" },
  () => {
    let runtime: ZenRuntime;
    let stateDir: string;
    let statePath: string;
    let installResult: { ok: boolean; message?: string } = { ok: true };

    before(async () => {
      const base = process.platform === "win32" ? "D:\\tmp" : tmpdir();
      mkdirSync(base, { recursive: true });
      stateDir = mkdtempSync(join(base, "zen-mcp-update-e2e-"));
      statePath = join(stateDir, "update.json");
      runtime = await startRuntime(
        { requireConsent: false },
        {
          checkUpdate: async () => ({
            packageName: "@spaxe-dev/zen-mcp",
            currentVersion: "0.4.0",
            latestVersion: "0.6.0",
            updateAvailable: true,
            checkedAt: Date.now(),
            registry: "https://registry.npmjs.org/test",
          }),
          installUpdate: async () => installResult,
        }
      );
      await runtime.connect({ allowLaunch: true });
    });

    after(async () => {
      await runtime?.shutdown().catch(() => undefined);
      removeTestProfile(testProfilePath());
      if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    });

    it("prompts once, collapses to an icon, and installs from the bar", async () => {
      await runtime.checkForUpdates({ statePath });
      assert.equal(runtime.hub.updateNotice?.state, "prompt");

      const prompt = await pollUi(
        runtime,
        ".sk-banner",
        `const update = card.querySelector(".banner-update");
         const row = card.querySelector(".banner-update-prompt");
         const label = card.querySelector(".update-label");
         const apply = card.querySelector(".update-apply");
         const dismiss = card.querySelector(".banner-dismiss");
         return {
           ok: !update.hidden && !row.hidden && !apply.hidden && !dismiss.hidden &&
             label.textContent === "v0.6.0" && apply.textContent === "Update",
           why: "label=" + label.textContent + " apply=" + apply.textContent,
         };`
      );
      assert.equal(prompt.ok, true, `prompt: ${prompt.why}`);
      assert.equal(
        JSON.parse(readFileSync(statePath, "utf8")).promptedVersion,
        "0.6.0"
      );

      const dismissed = await pollUi(
        runtime,
        ".sk-banner",
        `card.querySelector(".banner-dismiss").click();
         return { ok: true };`
      );
      assert.equal(dismissed.ok, true);
      assert.equal(
        await waitFor(() => runtime.hub.updateNotice?.state === "icon"),
        true,
        "dismiss collapses the prompt to an icon"
      );
      const icon = await pollUi(
        runtime,
        ".sk-banner",
        `const icon = card.querySelector(".banner-update-icon");
         const row = card.querySelector(".banner-update-prompt");
         return { ok: !icon.hidden && row.hidden, why: "icon hidden or row shown" };`
      );
      assert.equal(icon.ok, true, icon.why);

      const expanded = await pollUi(
        runtime,
        ".sk-banner",
        `const icon = card.querySelector(".banner-update-icon");
         if (!icon || icon.hidden) return { ok: false, why: "no icon" };
         icon.click();
         return { ok: true };`
      );
      assert.equal(expanded.ok, true);
      assert.equal(
        await waitFor(() => runtime.hub.updateNotice?.state === "prompt"),
        true,
        "the icon reopens the prompt"
      );

      const clicked = await pollUi(
        runtime,
        ".sk-banner",
        `const apply = card.querySelector(".update-apply");
         if (!apply || apply.hidden) return { ok: false, why: "no update button" };
         apply.click();
         return { ok: true };`
      );
      assert.equal(clicked.ok, true);
      assert.equal(
        await waitFor(() => runtime.hub.updateNotice?.state === "installed", 10_000),
        true,
        "the installer result reaches the bar"
      );
      const installed = await pollUi(
        runtime,
        ".sk-banner",
        `const label = card.querySelector(".update-label");
         const apply = card.querySelector(".update-apply");
         return {
           ok: label.textContent === "Updated. Restart client." && apply.hidden,
           why: "label=" + label.textContent,
         };`
      );
      assert.equal(installed.ok, true, installed.why);

      const cleared = await pollUi(
        runtime,
        ".sk-banner",
        `card.querySelector(".banner-dismiss").click();
         return { ok: true };`
      );
      assert.equal(cleared.ok, true);
      assert.equal(
        await waitFor(() => runtime.hub.updateNotice === null),
        true,
        "dismissing the installed notice clears it"
      );
      const hidden = await pollUi(
        runtime,
        ".sk-banner",
        `const update = card.querySelector(".banner-update");
         return { ok: update.hidden, why: "update row still visible" };`
      );
      assert.equal(hidden.ok, true, hidden.why);

      await runtime.checkForUpdates({ statePath });
      assert.equal(
        runtime.hub.updateNotice?.state,
        "icon",
        "the release was prompted before, so only the icon returns"
      );
    });

    it("surfaces an installer failure and offers a retry", async () => {
      installResult = { ok: false, message: "registry unavailable" };
      runtime.hub.setUpdateNotice({
        state: "prompt",
        currentVersion: "0.4.0",
        latestVersion: "0.7.0",
      });
      const clicked = await pollUi(
        runtime,
        ".sk-banner",
        `const apply = card.querySelector(".update-apply");
         if (!apply || apply.hidden) return { ok: false, why: "no update button" };
         apply.click();
         return { ok: true };`
      );
      assert.equal(clicked.ok, true);
      assert.equal(
        await waitFor(() => runtime.hub.updateNotice?.state === "failed", 10_000),
        true,
        "the failure reaches the bar"
      );
      const failed = await pollUi(
        runtime,
        ".sk-banner",
        `const label = card.querySelector(".update-label");
         const apply = card.querySelector(".update-apply");
         return {
           ok: label.textContent === "Update failed" &&
             !apply.hidden && apply.textContent === "Retry" &&
             label.title.includes("registry unavailable"),
           why: "label=" + label.textContent + " apply=" + apply.textContent +
             " title=" + label.title,
         };`
      );
      assert.equal(failed.ok, true, failed.why);

      const dismissed = await pollUi(
        runtime,
        ".sk-banner",
        `card.querySelector(".banner-dismiss").click();
         return { ok: true };`
      );
      assert.equal(dismissed.ok, true);
      assert.equal(
        await waitFor(() => runtime.hub.updateNotice?.state === "icon"),
        true,
        "a failure collapses to the icon too"
      );
    });
  }
);
