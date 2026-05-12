// release-gate.ts — runs the seeded real-PR smoke (via the bun script
// scripts/smoke-real-pr.ts), reads the artifact directory it writes,
// evaluates the gate, prints the verdict, and exits non-zero on FAIL.
//
// Usage:
//   ARGUED_SMOKE_ARTIFACT_DIR=/tmp/argued-gate \
//   bun apps/argue-api/scripts/release-gate.ts
//
// CI usage (.github/workflows/release-gate.yml): same env var set to
// $RUNNER_TEMP/argued-gate, then upload that path as a workflow artifact.

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { evaluateReleaseGate, formatGateVerdict, type SmokeArtifact } from "../src/release-gate";

const ARTIFACT_DIR = process.env.ARGUED_SMOKE_ARTIFACT_DIR?.trim();
if (!ARTIFACT_DIR) {
  console.error("release-gate: ARGUED_SMOKE_ARTIFACT_DIR must be set");
  process.exit(2);
}

const SMOKE_SCRIPT = new URL("./smoke-real-pr.ts", import.meta.url).pathname;

function runSmoke(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath.endsWith("/bun") ? process.execPath : "bun", [
      SMOKE_SCRIPT,
    ], {
      stdio: "inherit",
      env: { ...process.env, ARGUED_SMOKE_ARTIFACT_DIR: ARTIFACT_DIR },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`smoke exited with code ${code}`));
    });
  });
}

async function main() {
  await runSmoke();
  const resultPath = join(ARTIFACT_DIR!, "result.json");
  const raw = await readFile(resultPath, "utf8");
  const artifact = JSON.parse(raw) as SmokeArtifact;
  const verdict = evaluateReleaseGate(artifact);
  console.log(formatGateVerdict(verdict));
  if (!verdict.pass) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
