export interface Theme {
  color: boolean;
  unicode: boolean;
  bold(text: string): string;
  dim(text: string): string;
  cyan(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
}

/** ANSI styling that turns itself off for pipes, NO_COLOR and dumb terminals. */
export function createTheme(output: NodeJS.WriteStream): Theme {
  const color =
    Boolean(output.isTTY) &&
    !process.env.NO_COLOR &&
    process.env.TERM !== "dumb";
  const wrap = (code: string) => (text: string) =>
    color ? `\x1b[${code}m${text}\x1b[0m` : text;

  return {
    color,
    unicode: Boolean(output.isTTY),
    bold: wrap("1"),
    dim: wrap("2"),
    cyan: wrap("36"),
    green: wrap("32"),
    yellow: wrap("33"),
    red: wrap("31"),
  };
}
