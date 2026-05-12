import type { Prior as OraclePrior } from "../../../packages/oracle/src/index.js";
import type { Db } from "./db";

type VerdictDecision =
  | "APPROVE"
  | "REJECT"
  | "GATE_FAILED"
  | "PARSE_FAILED"
  | "TRANSPORT_FAILED";

interface ArgumentRow {
  id: string;
  pr_url: string;
  pr_sha: string;
  diff_truncated: string;
  pr_title: string | null;
  pr_description: string | null;
  ci_status: string | null;
  darwin_priors_json: string | null;
  status: "queued" | "running" | "done" | "error";
  error_message: string | null;
  created_at: number;
  completed_at: number | null;
}

interface VerdictRow {
  cli: string;
  decision: VerdictDecision;
  issues_json: string;
  reasoning: string | null;
  cost_usd: number;
  duration_ms: number;
  gate_pass: 0 | 1;
}

export interface StoredVerdict {
  cli: string;
  costUsd: number;
  decision: VerdictDecision;
  durationMs: number;
  gatePass: boolean;
  issues: Array<Record<string, unknown>>;
  reasoning: string;
}

export interface ArgumentResult {
  completedAt: number | null;
  createdAt: number;
  darwinPriors: OraclePrior[];
  diff: string;
  errorMessage: string | null;
  id: string;
  prDescription: string;
  prSha: string;
  prTitle: string;
  prUrl: string;
  status: "queued" | "running" | "done" | "error";
  summary: {
    approvals: number;
    consensus: "APPROVE" | "REJECT" | "SPLIT" | "INCOMPLETE" | null;
    gateFailed: number;
    parseFailed: number;
    rejects: number;
    totalCostUsd: number;
    totalDurationMs: number;
    totalVerdicts: number;
    transportFailed: number;
    validVerdicts: number;
  };
  verdicts: StoredVerdict[];
  ciStatus: string;
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const htmlHeaders = { "content-type": "text/html; charset=utf-8" };

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const formatUnixTime = (value: number | null): string =>
  value == null ? "pending" : new Date(value * 1000).toISOString().replace(".000Z", "Z");

const summarizeVerdicts = (verdicts: StoredVerdict[]) => {
  const approvals = verdicts.filter((v) => v.decision === "APPROVE").length;
  const rejects = verdicts.filter((v) => v.decision === "REJECT").length;
  const gateFailed = verdicts.filter((v) => v.decision === "GATE_FAILED").length;
  const parseFailed = verdicts.filter((v) => v.decision === "PARSE_FAILED").length;
  const transportFailed = verdicts.filter((v) => v.decision === "TRANSPORT_FAILED").length;
  const validVerdicts = approvals + rejects;
  const totalCostUsd = verdicts.reduce((sum, verdict) => sum + verdict.costUsd, 0);
  const totalDurationMs = verdicts.reduce((sum, verdict) => sum + verdict.durationMs, 0);

  let consensus: ArgumentResult["summary"]["consensus"] = null;
  if (verdicts.length > 0) {
    if (
      verdicts.length < 4 ||
      gateFailed > 0 ||
      parseFailed > 0 ||
      transportFailed > 0
    ) {
      consensus = "INCOMPLETE";
    } else {
      const first = verdicts[0]?.decision ?? null;
      consensus = verdicts.every((verdict) => verdict.decision === first) && first
        ? (first as "APPROVE" | "REJECT")
        : "SPLIT";
    }
  }

  return {
    approvals,
    consensus,
    gateFailed,
    parseFailed,
    rejects,
    totalCostUsd,
    totalDurationMs,
    totalVerdicts: verdicts.length,
    transportFailed,
    validVerdicts,
  };
};

const matchArgumentId = (pathname: string, prefix: string): string | null => {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}/([a-z0-9]{12})$`).exec(pathname);
  return match?.[1] ?? null;
};

export function getArgumentIdFromApiPath(pathname: string): string | null {
  return matchArgumentId(pathname, "/api/arguments");
}

export function getArgumentIdFromViewPath(pathname: string): string | null {
  return matchArgumentId(pathname, "/v");
}

export function loadArgumentResult(db: Db, id: string): ArgumentResult | null {
  const row =
    (db
      .query(
        `SELECT
           id,
           pr_url,
           pr_sha,
           diff_truncated,
           pr_title,
           pr_description,
           ci_status,
           darwin_priors_json,
           status,
           error_message,
           created_at,
           completed_at
         FROM arguments
         WHERE id = ?`
      )
      .get(id) as ArgumentRow | null) ?? null;
  if (!row) return null;

  const verdictRows = db
    .query(
      `SELECT cli, decision, issues_json, reasoning, cost_usd, duration_ms, gate_pass
       FROM verdicts
       WHERE argument_id = ?
       ORDER BY cli ASC`
    )
    .all(id) as VerdictRow[];

  const verdicts: StoredVerdict[] = verdictRows.map((verdict) => ({
    cli: verdict.cli,
    costUsd: Number(verdict.cost_usd),
    decision: verdict.decision,
    durationMs: Number(verdict.duration_ms),
    gatePass: verdict.gate_pass === 1,
    issues: JSON.parse(verdict.issues_json) as Array<Record<string, unknown>>,
    reasoning: verdict.reasoning ?? "",
  }));

  const darwinPriors =
    row.darwin_priors_json && row.darwin_priors_json.trim().length > 0
      ? (JSON.parse(row.darwin_priors_json) as OraclePrior[])
      : [];

  return {
    completedAt: row.completed_at,
    createdAt: row.created_at,
    darwinPriors,
    diff: row.diff_truncated,
    errorMessage: row.error_message,
    id: row.id,
    prDescription: row.pr_description ?? "",
    prSha: row.pr_sha,
    prTitle: row.pr_title ?? "(fetch pending)",
    prUrl: row.pr_url,
    status: row.status,
    summary: summarizeVerdicts(verdicts),
    verdicts,
    ciStatus: row.ci_status ?? "none",
  };
}

export function handleArgumentJsonGet(req: Request, db: Db): Response | null {
  const id = getArgumentIdFromApiPath(new URL(req.url).pathname);
  if (!id) return null;

  const result = loadArgumentResult(db, id);
  if (!result) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: jsonHeaders,
    });
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: jsonHeaders,
  });
}

const renderIssues = (issues: Array<Record<string, unknown>>): string => {
  if (issues.length === 0) return "<li>No issues recorded.</li>";
  return issues
    .map((issue) => {
      const severity = escapeHtml(String(issue["severity"] ?? "info"));
      const message = escapeHtml(String(issue["message"] ?? ""));
      const diffLines = Array.isArray(issue["diff_lines"])
        ? ` lines ${escapeHtml(JSON.stringify(issue["diff_lines"]))}`
        : "";
      const darwinPattern =
        typeof issue["darwin_pattern_id"] === "string"
          ? ` darwin:${escapeHtml(String(issue["darwin_pattern_id"]))}`
          : "";
      return `<li><strong>${severity}</strong> ${message}${diffLines}${darwinPattern}</li>`;
    })
    .join("");
};

function verdictClass(decision: VerdictDecision): string {
  switch (decision) {
    case "APPROVE":
      return "approve";
    case "REJECT":
      return "reject";
    case "GATE_FAILED":
      return "gate";
    case "PARSE_FAILED":
      return "parse";
    case "TRANSPORT_FAILED":
      return "transport";
  }
}

const renderVerdictCards = (result: ArgumentResult): string =>
  result.verdicts.length === 0
    ? `<article class="card muted"><h3>No verdicts yet</h3><p>The pipeline has not written any CLI outputs yet.</p></article>`
    : result.verdicts
        .map((verdict) => `<article class="card verdict ${verdictClass(verdict.decision)}">
  <header>
    <div>
      <p class="eyebrow">${escapeHtml(verdict.cli)}</p>
      <h3>${escapeHtml(verdict.decision)}</h3>
    </div>
    <p class="meta">${verdict.durationMs}ms · $${verdict.costUsd.toFixed(2)}</p>
  </header>
  <p>${escapeHtml(verdict.reasoning || "No reasoning provided.")}</p>
  <ul>${renderIssues(verdict.issues)}</ul>
</article>`)
        .join("");

const renderPriorCards = (result: ArgumentResult): string =>
  result.darwinPriors.length === 0
    ? `<article class="card muted"><h3>No priors attached</h3><p>The run continued without a Darwin prior.</p></article>`
    : result.darwinPriors
        .map(
          (prior) => `<article class="card prior">
  <p class="eyebrow">${escapeHtml(prior.cluster_id)}</p>
  <h3>${escapeHtml(prior.description)}</h3>
  <p class="meta">${prior.n_observations} observations · distance ${
    typeof prior.distance === "number" ? prior.distance.toFixed(4) : "n/a"
  }</p>
</article>`
        )
        .join("");

export function renderArgumentPage(result: ArgumentResult): string {
  const pending = result.status === "queued" || result.status === "running";
  const consensus =
    result.summary.consensus == null
      ? "pending"
      : result.summary.consensus === "SPLIT"
        ? "split"
        : result.summary.consensus.toLowerCase();
  const pageTitle =
    result.prTitle && result.prTitle !== "(fetch pending)"
      ? `${result.prTitle} · argued.dev`
      : `Argument ${result.id} · argued.dev`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(pageTitle)}</title>
    ${pending ? '<meta http-equiv="refresh" content="2">' : ""}
    <style>
      :root {
        --bg: #fbf4ea;
        --ink: #1f1712;
        --muted: #705c51;
        --panel: rgba(255, 250, 245, 0.84);
        --line: rgba(42, 28, 18, 0.14);
        --approve: #2f7d48;
        --reject: #a52a1f;
        --gate: #8f5d0a;
        --parse: #8c4b94;
        --transport: #0c5f73;
        --shadow: 0 24px 60px rgba(82, 48, 28, 0.16);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top, rgba(255, 170, 109, 0.28), transparent 36%),
          linear-gradient(180deg, #fff6eb 0%, #fde3d1 38%, #f8efe7 100%);
      }
      main { max-width: 1120px; margin: 0 auto; padding: 48px 24px 80px; }
      .hero, .section, .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(12px);
      }
      .hero { padding: 28px; margin-bottom: 24px; }
      .section { padding: 24px; margin-top: 24px; }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 16px;
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 16px;
      }
      .card { padding: 18px; }
      h1, h2, h3, p { margin-top: 0; }
      h1 { font-size: clamp(2rem, 5vw, 3.4rem); line-height: 0.96; margin-bottom: 12px; }
      h2 { font-size: 1.2rem; margin-bottom: 16px; }
      h3 { font-size: 1.05rem; margin-bottom: 10px; }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.16em;
        font-size: 0.7rem;
        color: var(--muted);
        margin-bottom: 10px;
      }
      .lede { max-width: 72ch; color: var(--muted); font-size: 1rem; }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        border-radius: 999px;
        background: rgba(255,255,255,0.7);
        border: 1px solid var(--line);
        font-size: 0.84rem;
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }
      .stat {
        padding: 16px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.55);
      }
      .stat strong { display: block; font-size: 1.6rem; margin-bottom: 4px; }
      .meta { color: var(--muted); font-size: 0.88rem; }
      .approve h3 { color: var(--approve); }
      .reject h3 { color: var(--reject); }
      .gate h3 { color: var(--gate); }
      .parse h3 { color: var(--parse); }
      .transport h3 { color: var(--transport); }
      .muted { color: var(--muted); }
      code, pre {
        font-family: "SFMono-Regular", "SF Mono", "Cascadia Code", "JetBrains Mono", monospace;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        padding: 18px;
        background: rgba(34, 27, 21, 0.95);
        color: #f8efe7;
        border-radius: 18px;
        overflow: auto;
      }
      a { color: inherit; }
      ul { padding-left: 18px; margin-bottom: 0; }
      header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
      @media (max-width: 640px) {
        main { padding: 32px 16px 56px; }
        .hero, .section { padding: 20px; }
        header { flex-direction: column; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p class="eyebrow">Four agents argued. One was lying.</p>
        <h1>${escapeHtml(result.prTitle)}</h1>
        <p class="lede">${escapeHtml(result.prDescription || "No pull request description was available.")}</p>
        <p class="status">Status ${escapeHtml(result.status)} · consensus ${escapeHtml(String(consensus))}</p>
      </section>

      <section class="section">
        <div class="grid">
          <div class="stat"><strong>${result.summary.totalVerdicts}/4</strong><span class="meta">verdicts persisted</span></div>
          <div class="stat"><strong>${result.summary.validVerdicts}</strong><span class="meta">valid verdicts</span></div>
          <div class="stat"><strong>${result.summary.approvals}</strong><span class="meta">approvals</span></div>
          <div class="stat"><strong>${result.summary.rejects}</strong><span class="meta">rejects</span></div>
          <div class="stat"><strong>${result.summary.gateFailed}</strong><span class="meta">rubber-stamps blocked</span></div>
        </div>
        <div class="grid" style="margin-top:16px">
          <div class="stat"><strong>${result.summary.parseFailed}</strong><span class="meta">parse failures</span></div>
          <div class="stat"><strong>${result.summary.transportFailed}</strong><span class="meta">transport failures</span></div>
          <div class="stat"><strong>${escapeHtml(result.ciStatus)}</strong><span class="meta">CI status</span></div>
          <div class="stat"><strong>${result.summary.totalDurationMs}ms</strong><span class="meta">aggregate CLI time</span></div>
          <div class="stat"><strong>$${result.summary.totalCostUsd.toFixed(2)}</strong><span class="meta">recorded CLI cost</span></div>
        </div>
        <p class="meta" style="margin-top:16px">
          Created ${escapeHtml(formatUnixTime(result.createdAt))} · Completed ${escapeHtml(formatUnixTime(result.completedAt))}
        </p>
        <p class="meta">
          PR <a href="${escapeHtml(result.prUrl)}">${escapeHtml(result.prUrl)}</a> · SHA <code>${escapeHtml(result.prSha || "pending")}</code> · JSON <a href="/api/arguments/${escapeHtml(result.id)}">/api/arguments/${escapeHtml(result.id)}</a>
        </p>
        ${
          result.errorMessage
            ? `<p class="meta" style="color: var(--reject)">Last error: ${escapeHtml(result.errorMessage)}</p>`
            : ""
        }
      </section>

      <section class="section">
        <h2>Verdicts</h2>
        <div class="cards">${renderVerdictCards(result)}</div>
      </section>

      <section class="section">
        <h2>Darwin priors</h2>
        <div class="cards">${renderPriorCards(result)}</div>
      </section>

      <section class="section">
        <h2>Diff excerpt</h2>
        <pre>${escapeHtml(result.diff || "Diff fetch pending.")}</pre>
      </section>
    </main>
  </body>
</html>`;
}

export function handleArgumentPageGet(req: Request, db: Db): Response | null {
  const id = getArgumentIdFromViewPath(new URL(req.url).pathname);
  if (!id) return null;

  const result = loadArgumentResult(db, id);
  if (!result) {
    return new Response("<h1>not found</h1>", {
      status: 404,
      headers: htmlHeaders,
    });
  }

  return new Response(renderArgumentPage(result), {
    status: 200,
    headers: htmlHeaders,
  });
}
