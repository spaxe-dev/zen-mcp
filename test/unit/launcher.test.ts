import assert from "node:assert/strict";
import net from "node:net";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  buildLaunchArgs,
  launchZen,
  resolvedProfilePath,
} from "../../src/zen/launcher.js";

const dataDir = join("D:", "zen-mcp-data");

describe("launcher profile selection", () => {
  it("uses a dedicated agent profile by default", () => {
    assert.equal(
      resolvedProfilePath({ dataDir }),
      join(dataDir, "agent-profile")
    );
  });

  it("resolves an explicit profile path", () => {
    assert.equal(
      resolvedProfilePath({ dataDir, profilePath: "relative-profile" }),
      resolve("relative-profile")
    );
  });

  it("uses the normal profile only when opted in", () => {
    assert.equal(resolvedProfilePath({ dataDir, useDefaultProfile: true }), null);
  });

  it("lets an explicit profile win over the normal-profile option", () => {
    assert.equal(
      resolvedProfilePath({
        dataDir,
        profilePath: "agent",
        useDefaultProfile: true,
      }),
      resolve("agent")
    );
  });
});

describe("launcher arguments", () => {
  it("puts the profile and configured flags after -marionette", () => {
    const { args, profile } = buildLaunchArgs({
      dataDir,
      launchArgs: ["--no-remote"],
    });
    assert.equal(profile, join(dataDir, "agent-profile"));
    assert.deepEqual(args, [
      "-marionette",
      "-no-remote",
      "-profile",
      join(dataDir, "agent-profile"),
      "--no-remote",
    ]);
  });

  it("appends per-call arguments last", () => {
    const { args } = buildLaunchArgs(
      { dataDir, launchArgs: ["--no-remote"] },
      ["--headless", "--new-instance"]
    );
    assert.deepEqual(args.slice(-2), ["--headless", "--new-instance"]);
  });

  it("does not pass a profile for the normal profile", () => {
    const { args, profile } = buildLaunchArgs({
      dataDir,
      useDefaultProfile: true,
    });
    assert.equal(profile, null);
    assert.deepEqual(args, ["-marionette", "-no-remote"]);
  });
});

describe("launcher ownership guard", () => {
  it("refuses to launch when Marionette is already open", async () => {
    const server = net.createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      await assert.rejects(
        launchZen({
          config: {
            zenPath: process.execPath,
            profilePath: join(dataDir, "agent-profile"),
            useDefaultProfile: false,
            dataDir,
            launchTimeoutMs: 1_000,
            marionettePort: address.port,
            launchArgs: [],
          },
          wait: false,
        }),
        /Marionette is already listening/
      );
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
