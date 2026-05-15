export interface ParsedPR { owner: string; repo: string; number: number; }

const PR_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

export function parseUrl(input: string): ParsedPR {
  if (!input.startsWith("https://github.com/")) {
    throw new Error(`URL must be github.com, got: ${input}`);
  }
  const m = PR_RE.exec(input);
  if (!m) throw new Error(`not a pull request URL: ${input}`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}
