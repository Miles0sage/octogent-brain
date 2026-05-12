import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess as defaultRunProcess } from "./spawn-helper";
import { buildArguePrompt } from "./prompt";
import { extractJsonVerdict } from "./extract";
import {
  buildParseFailureVerdict,
  buildSuccessfulVerdict,
  buildTransportFailureVerdict,
  describeProcessFailure,
} from "./result";
import { classifyCodexFailure, describeClassification, withRetry } from "./retry-policy";
import { withTempWorkspace } from "./temp-workspace";
import type { ArgueInput, RawVerdict } from "../argue";
import type { SpawnResult, SpawnOpts } from "./spawn-helper";

const CODEX_BIN = process.env.CODEX_BIN ?? "/usr/bin/codex";
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS ?? "180000");
const CODEX_MAX_ATTEMPTS = Number(process.env.CODEX_MAX_ATTEMPTS ?? "3");
const CODEX_RETRY_BUDGET_MS = Number(process.env.CODEX_RETRY_BUDGET_MS ?? "30000");

type Runner = (cmd: string, args: string[], opts?: SpawnOpts) => Promise<SpawnResult>;

export async function dispatchCodex(
  input: ArgueInput,
  runner: Runner = defaultRunProcess
): Promise<RawVerdict> {
  const prompt = buildArguePrompt(input);

  return withTempWorkspace("argued-codex", async (cwd) => {
    const outputPath = join(cwd, "last-message.txt");
    const { result, attempts, classification } = await withRetry(
      () =>
        runner(
          CODEX_BIN,
          [
            "exec",
            "--color",
            "never",
            "--cd",
            cwd,
            "-s",
            "read-only",
            "--skip-git-repo-check",
            "--output-last-message",
            outputPath,
            prompt,
          ],
          { cwd, timeoutMs: CODEX_TIMEOUT_MS }
        ),
      {
        classify: classifyCodexFailure,
        maxAttempts: CODEX_MAX_ATTEMPTS,
        budgetMs: CODEX_RETRY_BUDGET_MS,
      }
    );

    if (result.timedOut || result.exitCode !== 0) {
      const baseDetail = describeProcessFailure("codex transport failed", result);
      const enriched = classification
        ? `${baseDetail} | ${describeClassification(classification)} | attempts=${attempts}`
        : `${baseDetail} | attempts=${attempts}`;
      return buildTransportFailureVerdict("codex", enriched, result.durationMs);
    }

    const fileOutput = await readFile(outputPath, "utf8").catch(() => "");
    const extracted = extractJsonVerdict(fileOutput || result.stdout);
    if (!extracted.ok) {
      return buildParseFailureVerdict(
        "codex",
        `codex parse failed: ${extracted.error}`,
        result.durationMs
      );
    }

    return buildSuccessfulVerdict("codex", extracted.verdict, result.durationMs);
  });
}
