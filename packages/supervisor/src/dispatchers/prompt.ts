import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArgueInput, CliName } from "../argue";
import { prepareCliDiff } from "../diff-strategy";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_PROMPTS_DIR = join(PACKAGE_ROOT, "prompts");

const promptCache = new Map<string, string>();

function readPrompt(relPath: string): string {
  const cached = promptCache.get(relPath);
  if (cached != null) return cached;
  const base = process.env.ARGUED_PROMPTS_DIR?.trim() || DEFAULT_PROMPTS_DIR;
  const fullPath = join(base, relPath);
  const text = readFileSync(fullPath, "utf8");
  promptCache.set(relPath, text);
  return text;
}

export function clearPromptCache(): void {
  promptCache.clear();
}

function renderPriorsBlock(input: ArgueInput): string {
  if (input.darwin_priors.length === 0) {
    return "  (no similar past failures above similarity threshold)";
  }
  return input.darwin_priors
    .map(
      (p) => `  - ${p.cluster_id}: ${p.description} (seen ${p.n_observations}× before)`
    )
    .join("\n");
}

function fillBaseTemplate(input: ArgueInput): string {
  return readPrompt("_base.md")
    .replaceAll("{{description}}", input.description || "(none)")
    .replaceAll("{{ciStatus}}", input.ciStatus)
    .replaceAll("{{priorsBlock}}", renderPriorsBlock(input))
    .replaceAll("{{diff}}", input.diff);
}

export function buildArguePrompt(input: ArgueInput, cli?: CliName): string {
  const dispatchInput: ArgueInput = cli
    ? { ...input, diff: prepareCliDiff(cli, input.diff) }
    : input;
  const base = fillBaseTemplate(dispatchInput);
  if (!cli) return base;
  const cliStrengths = readPrompt(`${cli}/reviewer.md`);
  return `${cliStrengths}\n\n---\n\n${base}`;
}
