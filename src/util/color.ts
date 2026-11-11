const enabled = (() => {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") return true;
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
})();

const wrap = (open: string, close = "\u001b[0m") => (s: string | number) =>
  enabled ? `${open}${s}${close}` : String(s);

export const color = {
  enabled,
  bold: wrap("\u001b[1m"),
  dim: wrap("\u001b[2m"),
  red: wrap("\u001b[31m"),
  green: wrap("\u001b[32m"),
  yellow: wrap("\u001b[33m"),
  blue: wrap("\u001b[34m"),
  magenta: wrap("\u001b[35m"),
  cyan: wrap("\u001b[36m"),
  gray: wrap("\u001b[90m"),
};

/** Visible width, ignoring ANSI escapes, so columns line up when colour is on. */
export function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}

export function padEndVisible(s: string, width: number): string {
  const pad = width - visibleWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}
