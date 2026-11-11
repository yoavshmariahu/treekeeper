/** Kilobytes (as reported by `du -sk`) to a short human string. */
export function formatKb(kb: number): string {
  if (!Number.isFinite(kb) || kb < 0) return "?";
  if (kb >= 1024 * 1024) return `${(kb / (1024 * 1024)).toFixed(1)}G`;
  if (kb >= 1024) return `${Math.round(kb / 1024)}M`;
  return `${Math.round(kb)}K`;
}

export function formatBytes(bytes: number): string {
  return formatKb(bytes / 1024);
}
