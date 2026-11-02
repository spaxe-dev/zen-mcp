import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import type { ClientEntry } from "./clients.js";
import { createTheme } from "./theme.js";

export interface SelectOption {
  id: string;
  label: string;
  detail: string;
  detected: boolean;
  popular: boolean;
  other?: boolean;
  selected: boolean;
}

export interface PickerResult {
  selected: string[];
  other: boolean;
}

export class SelectionCancelled extends Error {}

const OTHER_ID = "other";

/**
 * Builds the picker rows. Only clients found on this machine are preselected;
 * when nothing is found, nothing is checked.
 */
export function buildOptions(clients: ClientEntry[]): SelectOption[] {
  return [
    ...clients.map((client) => ({
      id: client.id,
      label: client.label,
      detail: client.detail,
      detected: client.detected,
      popular: client.popular,
      selected: client.detected,
    })),
    {
      id: OTHER_ID,
      label: "Other MCP client",
      detail: "Print a setup prompt for any agent",
      detected: false,
      popular: false,
      other: true,
      selected: false,
    },
  ];
}

/** Moves the cursor by one row and wraps around the list. */
export function moveCursor(options: SelectOption[], cursor: number, delta: number): number {
  const size = options.length;
  return (((cursor + delta) % size) + size) % size;
}

/** Selects or clears every client row; the Other row keeps its state. */
export function toggleAll(options: SelectOption[], selected: boolean): SelectOption[] {
  return options.map((option) =>
    option.other ? option : { ...option, selected }
  );
}

export function pickerResult(options: SelectOption[]): PickerResult {
  return {
    selected: options
      .filter((option) => !option.other && option.selected)
      .map((option) => option.id),
    other: options.some((option) => option.other && option.selected),
  };
}

/**
 * Renders a dependency-free multi-select in the terminal. Arrow keys move,
 * space toggles, `a` toggles every client, enter confirms and ctrl+c cancels.
 */
export async function pickClients(
  options: SelectOption[],
  streams: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream } = {}
): Promise<PickerResult> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) {
    throw new Error("the client picker needs an interactive terminal");
  }

  const rows = [...options];
  let cursor = 0;
  let painted = 0;
  const theme = createTheme(output);
  const columns = output.columns ?? 80;
  const width = Math.max(44, Math.min(columns - 4, 64));
  const showDetail = columns >= 72;
  const detailLimit = Math.max(18, columns - 40);
  const rule = theme.dim("─".repeat(width));

  const paint = (final = false): void => {
    const lines: string[] = [];
    const count = rows.filter((row) => !row.other && row.selected).length;
    const otherSelected = rows.some((row) => row.other && row.selected);

    lines.push(
      `  ${theme.cyan("◆")} ${theme.bold("ZEN MCP")} ${theme.dim("onboard")}`
    );
    lines.push(`  ${rule}`);
    lines.push(`  ${theme.dim("Connect Zen to the agents you use.")}`);
    lines.push("");

    rows.forEach((row, index) => {
      const previous = rows[index - 1];
      if (index === 0) {
        lines.push(`  ${theme.dim("POPULAR")}`);
      } else if (row.other) {
        lines.push("");
        lines.push(`  ${theme.dim("OTHER")}`);
      } else if (previous?.popular && !row.popular) {
        lines.push("");
        lines.push(`  ${theme.dim("MORE CLIENTS")}`);
      }

      const marker = final ? " " : index === cursor ? theme.cyan("❯") : " ";
      const box = row.selected ? theme.green("[●]") : theme.dim("[ ]");
      const padding = row.label.padEnd(20);
      const label = index === cursor && !final ? theme.bold(padding) : padding;
      const tagName = row.detected
        ? "detected"
        : row.popular
          ? "popular"
          : "";
      const tag = tagName
        ? row.detected
          ? theme.green(tagName.padEnd(10))
          : theme.dim(tagName.padEnd(10))
        : " ".repeat(10);
      const detail = !showDetail
        ? ""
        : row.detail.length > detailLimit
          ? `${row.detail.slice(0, detailLimit - 1).trimEnd()}…`
          : row.detail;
      lines.push(
        `  ${marker} ${box} ${label} ${tag} ${theme.dim(detail)}`.trimEnd()
      );
    });

    lines.push("");
    if (!rows.some((row) => row.detected)) {
      lines.push(
        `  ${theme.yellow("No clients detected.")} ${theme.dim(
          "Select one below, or choose Other."
        )}`
      );
    }
    const selection =
      count > 0
        ? theme.green(`${count} selected${otherSelected ? " + other" : ""}`)
        : otherSelected
          ? theme.green("other client")
          : theme.dim("nothing selected");
    lines.push(`  ${selection}`);
    lines.push(
      final
        ? `  ${theme.dim("Selection confirmed.")}`
        : `  ${theme.dim(
            "↑↓ move  ·  space toggle  ·  a all  ·  enter confirm  ·  esc cancel"
          )}`
    );

    if (painted > 0) {
      output.write(`\x1b[${painted}A`);
      output.write("\x1b[0J");
    }
    output.write(`${lines.join("\n")}\n`);
    painted = lines.length;
  };

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write("\x1b[?25l");
  paint();

  return await new Promise<PickerResult>((resolve, reject) => {
    const cleanup = (): void => {
      input.off("keypress", onKey);
      input.setRawMode(false);
      input.pause();
      output.write("\x1b[?25h");
    };

    const finish = (result: PickerResult): void => {
      cleanup();
      paint(true);
      resolve(result);
    };

    const onKey = (_str: string | undefined, key: Key): void => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        output.write("\n");
        reject(new SelectionCancelled("cancelled"));
        return;
      }
      if (key.name === "escape") {
        cleanup();
        output.write("\n");
        reject(new SelectionCancelled("cancelled"));
        return;
      }
      switch (key.name) {
        case "up":
          cursor = moveCursor(rows, cursor, -1);
          break;
        case "down":
          cursor = moveCursor(rows, cursor, 1);
          break;
        case "space":
        case "spacebar":
          rows[cursor] = { ...rows[cursor], selected: !rows[cursor].selected };
          break;
        case "a":
          if (!key.ctrl && !key.meta) {
            const everySelected = rows
              .filter((row) => !row.other)
              .every((row) => row.selected);
            rows.splice(0, rows.length, ...toggleAll(rows, !everySelected));
          }
          break;
        case "return":
        case "enter":
          finish(pickerResult(rows));
          return;
        default:
          break;
      }
      paint();
    };

    input.on("keypress", onKey);
  });
}
