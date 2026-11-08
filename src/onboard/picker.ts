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

/**
 * Returns the slice of `total` lines to draw. The window only moves when the
 * cursor would leave it, so short moves do not make the list jump around.
 */
export function scrollWindow(
  total: number,
  cursor: number,
  height: number,
  start = 0
): { start: number; end: number } {
  const size = Math.max(1, Math.min(height, total));
  const limit = Math.max(0, total - size);
  let next = Math.max(0, Math.min(start, limit));
  if (cursor < next) next = cursor;
  if (cursor >= next + size) next = cursor - size + 1;
  next = Math.max(0, Math.min(next, limit));
  return { start: next, end: Math.min(total, next + size) };
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

type BodyEntry =
  | { kind: "header"; text: string }
  | { kind: "blank" }
  | { kind: "option"; rowIndex: number };

/** Section labels scroll with the rows so the pane itself never moves. */
function buildBodyEntries(rows: SelectOption[]): BodyEntry[] {
  const entries: BodyEntry[] = [];
  rows.forEach((row, index) => {
    if (index === 0) {
      entries.push({ kind: "header", text: "POPULAR" });
    } else if (row.other) {
      entries.push({ kind: "blank" });
      entries.push({ kind: "header", text: "OTHER" });
    } else if (rows[index - 1]?.popular && !row.popular) {
      entries.push({ kind: "blank" });
      entries.push({ kind: "header", text: "MORE CLIENTS" });
    }
    entries.push({ kind: "option", rowIndex: index });
  });
  return entries;
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
  const terminalRows = output.rows ?? 24;
  const width = Math.max(44, Math.min(columns - 4, 64));
  const showDetail = columns >= 72;
  const detailLimit = Math.max(18, columns - 40);
  const rule = theme.dim("─".repeat(width));
  const headerHeight = 4;
  const footerHeight = rows.some((row) => row.detected) ? 3 : 4;
  const bodyHeight = Math.max(3, terminalRows - headerHeight - footerHeight);
  const body = buildBodyEntries(rows);
  let scrollStart = 0;
  let pageSize = bodyHeight;

  const paintRow = (
    row: SelectOption,
    index: number,
    final: boolean
  ): string => {
    const marker = final ? " " : index === cursor ? theme.cyan("❯") : " ";
    const box = row.selected ? theme.green("[●]") : theme.dim("[ ]");
    const padding = row.label.padEnd(20);
    const label = index === cursor && !final ? theme.bold(padding) : padding;
    const tagName = row.detected ? "detected" : row.popular ? "popular" : "";
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
    return `  ${marker} ${box} ${label} ${tag} ${theme.dim(detail)}`.trimEnd();
  };

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

    const scrolling = body.length > bodyHeight;
    const visible = scrolling ? Math.max(1, bodyHeight - 2) : bodyHeight;
    pageSize = visible;
    const cursorLine = body.findIndex(
      (entry) => entry.kind === "option" && entry.rowIndex === cursor
    );
    const window = scrollWindow(body.length, cursorLine, visible, scrollStart);
    scrollStart = window.start;

    if (scrolling) {
      lines.push(
        window.start > 0 ? `  ${theme.dim(`↑ ${window.start} more`)}` : ""
      );
    }
    for (let index = window.start; index < window.end; index += 1) {
      const entry = body[index];
      if (entry.kind === "option") {
        lines.push(paintRow(rows[entry.rowIndex], entry.rowIndex, final));
      } else if (entry.kind === "header") {
        lines.push(`  ${theme.dim(entry.text)}`);
      } else {
        lines.push("");
      }
    }
    if (scrolling) {
      const below = body.length - window.end;
      lines.push(below > 0 ? `  ${theme.dim(`↓ ${below} more`)}` : "");
    }

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
        case "pageup":
          cursor = moveCursor(rows, cursor, -pageSize);
          break;
        case "pagedown":
          cursor = moveCursor(rows, cursor, pageSize);
          break;
        case "home":
          cursor = 0;
          break;
        case "end":
          cursor = rows.length - 1;
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
