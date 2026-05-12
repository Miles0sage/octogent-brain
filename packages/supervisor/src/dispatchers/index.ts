import type { CliName, ArgueInput, RawVerdict } from "../argue";
import { dispatchAider } from "./aider";
import { dispatchClaudeCode } from "./claude-code";
import { dispatchCodex } from "./codex";
import { dispatchGeminiCli } from "./gemini-cli";

export async function dispatchAll(cli: CliName, input: ArgueInput): Promise<RawVerdict> {
  switch (cli) {
    case "aider": return dispatchAider(input);
    case "claude-code": return dispatchClaudeCode(input);
    case "codex": return dispatchCodex(input);
    case "gemini-cli": return dispatchGeminiCli(input);
  }
}

export { buildArguePrompt } from "./prompt";
export { extractJsonVerdict } from "./extract";
export { runProcess } from "./spawn-helper";
