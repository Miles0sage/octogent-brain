const MAX_CHARS = 8000;
const MARKER = "\n\n[diff continues - truncated at 2k tokens]";

export function truncateDiff(diff: string): string {
  if (diff.length <= MAX_CHARS) return diff;
  return diff.slice(0, MAX_CHARS - MARKER.length) + MARKER;
}
