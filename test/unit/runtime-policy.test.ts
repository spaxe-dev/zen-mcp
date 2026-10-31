import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { ZenRuntime } from "../../src/zen/runtime.js";

let closedPort = 0;

before(async () => {
  closedPort = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
});

let runtime: ZenRuntime | null = null;

after(async () => {
  await runtime?.shutdown().catch(() => undefined);
});

describe("read-only runtime", () => {
  it("does not auto-launch a browser when read-only is set", async () => {
    runtime = new ZenRuntime({
      config: {
        ...DEFAULT_CONFIG,
        readOnly: true,
        autoLaunch: true,
        auditLog: false,
        marionettePort: closedPort,
      },
    });

    await assert.rejects(() => runtime!.connect(), /Zen is not running/i);
  });
});
