import { existsSync } from "node:fs";
import { Command, InvalidArgumentError } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  configFilePath,
  loadConfig,
  saveConfig,
  type SidekickConfig,
} from "./config.js";
import { createSidekickServer } from "./mcp/server.js";
import { BRAND, SERVER_VERSION } from "./shared/brand.js";
import { createLogger } from "./utils/logger.js";
import { runDoctor, type DoctorReport } from "./zen/doctor.js";
import { findZenExecutable } from "./zen/launcher.js";
import { ZenRuntime } from "./zen/runtime.js";

const logger = createLogger("cli");
const CONFIG_KEYS = [
  "zenPath",
  "profilePath",
  "autoLaunch",
  "launchTimeoutMs",
  "askTimeoutSeconds",
  "marionettePort",
] as const;

type ConfigKey = (typeof CONFIG_KEYS)[number];

const program = new Command();

program
  .name("zen-sidekick")
  .description(
    `${BRAND}: an agent harness for Zen Browser. Spaces, background research ` +
      "tabs, page reads, and in-browser questions over MCP."
  )
  .version(SERVER_VERSION);

program
  .command("serve")
  .description("Run the MCP server over stdio (the default command).")
  .action(() => serve());

program
  .command("launch")
  .description("Start Zen with agent access and verify the bridge attaches.")
  .action(() => launch());

program
  .command("status")
  .description("Print the current Zen window, spaces, and tabs as JSON.")
  .action(() => status());

program
  .command("doctor")
  .description("Check the Zen install, config, Marionette, and bridge.")
  .action(() => doctor());

program
  .command("setup")
  .description("Detect Zen, write a config file, and print an MCP client snippet.")
  .option("--zen-path <path>", "Path to the Zen executable.")
  .option("--profile <path>", "Run Zen with a dedicated profile directory.")
  .option("--no-auto-launch", "Never launch Zen automatically from a tool call.")
  .option(
    "--ask-timeout <seconds>",
    "Default wait for in-browser answers.",
    (value: string) => parseInteger(value, "ask timeout")
  )
  .option(
    "--marionette-port <port>",
    "Marionette port. Zen currently always uses 2828.",
    (value: string) => parseInteger(value, "marionette port")
  )
  .option("--skip-doctor", "Write the config without running diagnostics.")
  .action((options) => setup(options));

const configCommand = program
  .command("config")
  .description("Show or change the saved configuration.");

configCommand
  .command("show")
  .description("Print the config file path and resolved values.")
  .action(() => configShow());

configCommand
  .command("set")
  .description(`Set one key: ${CONFIG_KEYS.join(", ")}.`)
  .argument("<key>", "Config key.")
  .argument("<value>", "New value. Use an empty string to clear a path.")
  .action((key: string, value: string) => configSet(key, value));

program.action(() => serve());

await program.parseAsync(process.argv);

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

async function serve(): Promise<void> {
  const config = loadConfig();
  const runtime = new ZenRuntime({ config });
  const server = createSidekickServer(runtime, config);
  const transport = new StdioServerTransport();

  let stopping = false;
  const stop = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info(`stopping (${reason})`);
    await runtime.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  transport.onclose = () => void stop("stdio closed");

  await server.connect(transport);
  logger.info(`${BRAND} ${SERVER_VERSION} ready on stdio`);
}

async function launch(): Promise<void> {
  const config = loadConfig();
  const runtime = new ZenRuntime({ config });
  try {
    await runtime.start();
    const connection = await runtime.connect({ allowLaunch: true });
    const status = await runtime.hub.status();
    console.log(
      `${status.appName} ${status.appVersion} is running with agent access.`
    );
    console.log(
      connection.launched
        ? "Zen was launched by Zen Sidekick."
        : "Zen was already running and accepted a Marionette session."
    );
    console.log(
      `Bridge attached to ${runtime.hub.connectionCount} window(s) for this check. ` +
        "It disconnects when this command exits; the MCP server attaches again on demand."
    );
    console.log(
      `${status.spaces.length} space(s), ${status.tabCount} tab(s), ` +
        `${status.folderCount} folder(s).`
    );
  } catch (error) {
    console.error(`Launch failed: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await runtime.shutdown().catch(() => undefined);
  }
}

async function status(): Promise<void> {
  const config = loadConfig();
  const runtime = new ZenRuntime({ config });
  try {
    await runtime.start();
    await runtime.connect({ allowLaunch: false });
    const status = await runtime.hub.status();
    console.log(
      JSON.stringify(
        {
          ...status,
          bridge: {
            port: runtime.hub.port,
            connections: runtime.hub.connectionCount,
            windows: runtime.hub.connectedWindows(),
          },
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(`Status failed: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await runtime.shutdown().catch(() => undefined);
  }
}

async function doctor(): Promise<void> {
  const report = await runDoctor(loadConfig());
  printReport(report);
  if (!report.ok) process.exitCode = 1;
}

async function setup(options: {
  zenPath?: string;
  profile?: string;
  autoLaunch?: boolean;
  askTimeout?: number;
  marionettePort?: number;
  skipDoctor?: boolean;
}): Promise<void> {
  const updates: Partial<SidekickConfig> = {};
  if (options.zenPath) updates.zenPath = options.zenPath;
  if (options.profile) updates.profilePath = options.profile;
  if (options.autoLaunch === false) updates.autoLaunch = false;
  if (options.askTimeout !== undefined) {
    updates.askTimeoutSeconds = options.askTimeout;
  }
  if (options.marionettePort !== undefined) {
    updates.marionettePort = options.marionettePort;
  }

  const firstTime = !existsSync(configFilePath());
  if (!updates.zenPath && !loadConfig().zenPath) {
    try {
      updates.zenPath = findZenExecutable(loadConfig());
    } catch {
      // Doctor explains what to do when detection fails.
    }
  }

  if (firstTime || Object.keys(updates).length) {
    const path = saveConfig(updates);
    console.log(`Saved config: ${path}`);
  } else {
    console.log(`Config already exists: ${configFilePath()}`);
  }

  if (!options.skipDoctor) {
    console.log("");
    printReport(await runDoctor(loadConfig()));
  }

  console.log("");
  console.log("MCP client configuration:");
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          "zen-sidekick": {
            command: "zen-sidekick",
            args: ["serve"],
          },
        },
      },
      null,
      2
    )
  );
  console.log(
    "\nIf Zen Sidekick is not on your PATH, point command at the absolute path " +
      "of dist/cli.js and keep args as [\"serve\"]."
  );
}

function configShow(): void {
  console.log(configFilePath());
  console.log(JSON.stringify(loadConfig(), null, 2));
}

function configSet(key: string, rawValue: string): void {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    console.error(`Unknown key "${key}". Valid keys: ${CONFIG_KEYS.join(", ")}.`);
    process.exitCode = 1;
    return;
  }
  const name = key as ConfigKey;
  const value = rawValue.trim();
  let parsed: string | number | boolean | undefined;

  const numberValue = (): number | null => {
    try {
      return parseInteger(value, name);
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = 1;
      return null;
    }
  };

  switch (name) {
    case "zenPath":
    case "profilePath":
      parsed = value || undefined;
      break;
    case "autoLaunch":
      if (!/^(true|false|1|0|yes|no)$/i.test(value)) {
        console.error("autoLaunch expects true or false.");
        process.exitCode = 1;
        return;
      }
      parsed = /^(true|1|yes)$/i.test(value);
      break;
    case "launchTimeoutMs":
    case "askTimeoutSeconds":
    case "marionettePort": {
      const number = numberValue();
      if (number === null) return;
      parsed = number;
      break;
    }
  }

  const path = saveConfig({ [name]: parsed } as Partial<SidekickConfig>);
  console.log(`Saved ${name} = ${JSON.stringify(parsed)} in ${path}`);
}

function printReport(report: DoctorReport): void {
  for (const check of report.checks) {
    const mark =
      check.status === "ok" ? "[ ok ]" : check.status === "warn" ? "[warn]" : "[FAIL]";
    console.log(`${mark} ${check.name}: ${check.detail}`);
    if (check.hint) console.log(`       ${check.hint}`);
  }
  console.log("");
  console.log(
    report.ready
      ? "Ready: the agent can drive this Zen window right now."
      : report.ok
        ? "Installed: Zen is not attached yet. Launch it with `zen-sidekick launch` or the zen_launch tool."
        : "Not ready: fix the failed checks above."
  );
}

function parseInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new InvalidArgumentError(`${label} must be a whole number`);
  }
  return Number(value);
}
