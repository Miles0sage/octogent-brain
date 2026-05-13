// diff-strategy.ts — per-CLI diff payload selection (Amendment A1, 2026-05-13).
//
// Before this amendment the spec hard-capped diffs at 2k tokens (8000 chars)
// before they ever reached a dispatcher. NotebookLM review of the locked
// plan flagged that as the rubber-stamp footgun: truncated context →
// generic "looks good" verdicts → viral loop dies. The fix is per-CLI:
// long-context CLIs see the full diff, short-context CLIs see a structural
// summary that preserves hunk headers + first N lines per hunk so the
// reviewer can still cite diff_lines without hallucinating.
//
// Oracle prior lookup is unaffected — it runs on full diff regardless of
// which CLIs are dispatched.

import type { CliName } from "./argue";

const FULL_DIFF_CLIS: ReadonlySet<CliName> = new Set(["claude-code", "codex"]);

const SUMMARY_CHAR_BUDGET = Number(
  process.env.ARGUED_DIFF_SUMMARY_CHARS ?? "12000"
);
const HUNK_BODY_LINE_KEEP = Number(
  process.env.ARGUED_DIFF_HUNK_BODY_KEEP ?? "12"
);

export function prepareCliDiff(cli: CliName, fullDiff: string): string {
  if (FULL_DIFF_CLIS.has(cli)) return fullDiff;
  return summarizeDiff(fullDiff, SUMMARY_CHAR_BUDGET);
}

interface HunkBlock {
  fileHeader: string[];
  hunkHeader: string;
  body: string[];
}

function parseHunks(diff: string): HunkBlock[] {
  const lines = diff.split("\n");
  const blocks: HunkBlock[] = [];
  let currentFileHeader: string[] = [];
  let currentHunk: HunkBlock | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (currentHunk) blocks.push(currentHunk);
      currentHunk = null;
      currentFileHeader = [line];
      continue;
    }
    if (
      currentHunk == null &&
      (line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("new file") ||
        line.startsWith("deleted file") ||
        line.startsWith("similarity index") ||
        line.startsWith("rename "))
    ) {
      currentFileHeader.push(line);
      continue;
    }
    if (line.startsWith("@@")) {
      if (currentHunk) blocks.push(currentHunk);
      currentHunk = {
        fileHeader: currentFileHeader,
        hunkHeader: line,
        body: [],
      };
      currentFileHeader = [];
      continue;
    }
    if (currentHunk) {
      currentHunk.body.push(line);
    }
  }
  if (currentHunk) blocks.push(currentHunk);
  return blocks;
}

function renderBlock(block: HunkBlock, bodyKeep: number): string {
  const head = block.fileHeader.join("\n");
  const headPrefix = head.length > 0 ? `${head}\n` : "";
  const trimmedBody = block.body.slice(0, bodyKeep);
  const elided = block.body.length - trimmedBody.length;
  const marker =
    elided > 0
      ? `\n[hunk continues — ${elided} line${elided === 1 ? "" : "s"} elided]`
      : "";
  return `${headPrefix}${block.hunkHeader}\n${trimmedBody.join("\n")}${marker}`;
}

export function summarizeDiff(diff: string, charBudget: number): string {
  if (diff.length <= charBudget) return diff;

  const blocks = parseHunks(diff);
  if (blocks.length === 0) {
    return `${diff.slice(0, charBudget)}\n[diff truncated at ${charBudget} chars — could not parse hunks]`;
  }

  const rendered: string[] = [];
  let used = 0;
  let skippedBlocks = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;
    const text = renderBlock(block, HUNK_BODY_LINE_KEEP);
    if (used + text.length > charBudget && rendered.length > 0) {
      skippedBlocks = blocks.length - i;
      break;
    }
    rendered.push(text);
    used += text.length + 1;
  }

  const tail =
    skippedBlocks > 0
      ? `\n\n[${skippedBlocks} additional hunk${skippedBlocks === 1 ? "" : "s"} elided to fit summary budget]`
      : "";

  return `${rendered.join("\n\n")}${tail}`;
}
