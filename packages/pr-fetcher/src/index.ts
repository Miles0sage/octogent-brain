import { Octokit } from "@octokit/rest";
import { parseUrl } from "./parse-url.js";
import { truncateDiff } from "./truncate.js";
import type { PRPayload } from "./types.js";

export { parseUrl, truncateDiff };
export type { PRPayload };

export async function fetchPR(url: string, token?: string): Promise<PRPayload> {
  const { owner, repo, number } = parseUrl(url);
  const octokit = new Octokit({ auth: token ?? process.env["GITHUB_TOKEN"] });
  const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
  const diffResp = await octokit.rest.pulls.get({
    owner, repo, pull_number: number,
    mediaType: { format: "diff" },
  });
  const checks = await octokit.rest.checks.listForRef({
    owner, repo, ref: pr.data.head.sha,
  });
  const conclusions = checks.data.check_runs.map((c) => c.conclusion);
  const ciStatus: PRPayload["ciStatus"] =
    conclusions.length === 0 ? "none"
    : conclusions.some((c) => c === "failure") ? "failure"
    : conclusions.every((c) => c === "success") ? "success"
    : "pending";
  return {
    url,
    sha: pr.data.head.sha,
    title: pr.data.title,
    description: pr.data.body ?? "",
    diff: diffResp.data as unknown as string,
    ciStatus,
  };
}
