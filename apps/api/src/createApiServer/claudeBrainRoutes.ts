import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { ApiRouteHandler } from "./routeHelpers";
import { writeJson, writeMethodNotAllowed } from "./routeHelpers";

// Claude-brain integration paths. Allow override via env var so the fork
// works on hosts that don't follow the /root/claude-brain layout. Read at
// call time so tests can override per-case.
const claudeBrainRoot = () => process.env.CLAUDE_BRAIN_ROOT?.trim() || "/root/claude-brain";
const claudeUserRoot = () => process.env.CLAUDE_USER_ROOT?.trim() || "/root/.claude";

const TRACKED_DAEMONS: ReadonlyArray<{ name: string; kind: "timer" | "service" }> = [
  { name: "skill-evolve.timer", kind: "timer" },
  { name: "skill-evolve.service", kind: "service" },
  { name: "dpo-harvester.timer", kind: "timer" },
  { name: "dpo-harvester.service", kind: "service" },
  { name: "infra-context-dump.timer", kind: "timer" },
];

const SYSTEMCTL_TIMEOUT_MS = 1500;

// systemctl emits human-formatted timestamps like "Wed 2026-05-06 07:00:01 CEST".
// Node's Date.parse cannot handle weekday-prefixed strings or non-RFC TZ abbreviations
// (CEST, CET, PST, ...). GNU `date -d` is the canonical resolver — it consults the
// host's tzdata. We delegate to it and emit the result in UTC ISO-8601.
const parseSystemdTime = (value: string | undefined): string | null => {
  if (!value || value === "n/a" || value === "0") {
    return null;
  }
  const result = spawnSync("date", ["-d", value, "-u", "+%s"], {
    encoding: "utf8",
    timeout: SYSTEMCTL_TIMEOUT_MS,
  });
  const stdout = (result.stdout ?? "").trim();
  if (result.status !== 0 || !/^\d+$/.test(stdout)) {
    return null;
  }
  return new Date(Number.parseInt(stdout, 10) * 1000).toISOString();
};

type SystemctlShowResult = {
  active: boolean;
  exists: boolean;
  properties: Record<string, string>;
};

const runSystemctlShow = (unit: string): SystemctlShowResult => {
  // is-active first — short-circuit if unit doesn't exist.
  const isActiveResult = spawnSync("systemctl", ["is-active", unit], {
    encoding: "utf8",
    timeout: SYSTEMCTL_TIMEOUT_MS,
  });
  const isActiveStdout = (isActiveResult.stdout ?? "").trim();
  // Codes: 0 active, 3 inactive/failed; non-existent units emit "inactive" or "unknown".
  // The "exists" heuristic: status from `systemctl show` returns LoadState=loaded.
  const showResult = spawnSync(
    "systemctl",
    [
      "show",
      unit,
      "--property=LoadState,LastTriggerUSec,NextElapseUSecRealtime,ExecMainStatus,Result,ActiveEnterTimestamp,ExecMainExitTimestamp",
    ],
    { encoding: "utf8", timeout: SYSTEMCTL_TIMEOUT_MS },
  );
  const properties: Record<string, string> = {};
  for (const line of (showResult.stdout ?? "").split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    properties[key] = value;
  }
  const loadState = properties.LoadState ?? "";
  const exists = loadState === "loaded";
  return {
    active: isActiveStdout === "active",
    exists,
    properties,
  };
};

type DaemonStatus = {
  name: string;
  kind: "timer" | "service";
  active: boolean;
  last_trigger_iso?: string | null;
  next_trigger_iso?: string | null;
  last_run_iso?: string | null;
  result?: string;
};

const buildDaemonStatus = (
  unit: { name: string; kind: "timer" | "service" },
): DaemonStatus | null => {
  const result = runSystemctlShow(unit.name);
  if (!result.exists) {
    return null;
  }
  if (unit.kind === "timer") {
    return {
      name: unit.name,
      kind: "timer",
      active: result.active,
      last_trigger_iso: parseSystemdTime(result.properties.LastTriggerUSec),
      next_trigger_iso: parseSystemdTime(result.properties.NextElapseUSecRealtime),
    };
  }
  // Service.
  const lastRun =
    parseSystemdTime(result.properties.ExecMainExitTimestamp) ??
    parseSystemdTime(result.properties.ActiveEnterTimestamp);
  return {
    name: unit.name,
    kind: "service",
    active: result.active,
    last_run_iso: lastRun,
    result: result.properties.Result || (result.active ? "running" : "inactive"),
  };
};

export const handleClaudeBrainDaemonsRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
) => {
  if (requestUrl.pathname !== "/api/claude-brain/daemons") {
    return false;
  }
  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }
  const daemons: DaemonStatus[] = [];
  for (const unit of TRACKED_DAEMONS) {
    try {
      const status = buildDaemonStatus(unit);
      if (status) {
        daemons.push(status);
      }
    } catch {
      // If systemctl is unavailable on this host, fall through to empty list.
    }
  }
  const payload: {
    daemons: DaemonStatus[];
    checked_at: string;
    note?: string;
  } = {
    daemons,
    checked_at: new Date().toISOString(),
  };
  if (daemons.length === 0) {
    payload.note = "No tracked claude-brain systemd units found on this host.";
  }
  writeJson(response, 200, payload, corsOrigin);
  return true;
};

// --- DPO recent ----------------------------------------------------------

const FILENAME_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})/;

const countLines = (path: string): number => {
  try {
    const contents = readFileSync(path, "utf8");
    if (contents.length === 0) return 0;
    let count = 0;
    for (let i = 0; i < contents.length; i++) {
      if (contents.charCodeAt(i) === 10) count++;
    }
    // Files typically end with a newline. If they don't, count the trailing line.
    if (contents.charCodeAt(contents.length - 1) !== 10) count++;
    return count;
  } catch {
    return 0;
  }
};

export const handleClaudeBrainDpoRecentRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
) => {
  if (requestUrl.pathname !== "/api/claude-brain/dpo-recent") {
    return false;
  }
  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }
  const daysParam = requestUrl.searchParams.get("days");
  const parsedDays = daysParam ? Number.parseInt(daysParam, 10) : 7;
  const days = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 7;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const dpoDir = join(claudeBrainRoot(), "dpo-pairs");

  if (!existsSync(dpoDir)) {
    writeJson(
      response,
      200,
      {
        files: [],
        total_pairs: 0,
        days,
        note: `dpo-pairs directory not found at ${dpoDir}`,
      },
      corsOrigin,
    );
    return true;
  }

  const files: Array<{
    date: string | null;
    path: string;
    line_count: number;
    size_bytes: number;
    modified_iso: string;
  }> = [];
  let totalPairs = 0;

  try {
    for (const entry of readdirSync(dpoDir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const fullPath = join(dpoDir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < cutoffMs) continue;
      const dateMatch = entry.match(FILENAME_DATE_PATTERN);
      const lines = countLines(fullPath);
      totalPairs += lines;
      files.push({
        date: dateMatch ? (dateMatch[1] ?? null) : null,
        path: fullPath,
        line_count: lines,
        size_bytes: stat.size,
        modified_iso: new Date(stat.mtimeMs).toISOString(),
      });
    }
  } catch {
    // ignore — return what we have.
  }

  files.sort((a, b) => (b.modified_iso > a.modified_iso ? 1 : -1));

  writeJson(response, 200, { files, total_pairs: totalPairs, days }, corsOrigin);
  return true;
};

// --- Memory --------------------------------------------------------------

type MemoryScope = {
  name: string;
  file_count: number;
  total_lines: number;
  last_modified_iso: string | null;
};

type ProjectMemory = {
  project_path: string;
  line_count: number;
  last_modified_iso: string;
};

const collectMarkdownStats = (
  dir: string,
): { file_count: number; total_lines: number; last_modified: number | null } => {
  let fileCount = 0;
  let totalLines = 0;
  let lastModified: number | null = null;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "archive") continue;
        // Don't recurse arbitrarily deep — agent-memory is flat per-scope.
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      const fullPath = join(dir, entry.name);
      try {
        const stat = statSync(fullPath);
        fileCount++;
        totalLines += countLines(fullPath);
        if (lastModified === null || stat.mtimeMs > lastModified) {
          lastModified = stat.mtimeMs;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // dir may not exist — return zero stats.
  }
  return { file_count: fileCount, total_lines: totalLines, last_modified: lastModified };
};

export const handleClaudeBrainMemoryRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
) => {
  if (requestUrl.pathname !== "/api/claude-brain/memory") {
    return false;
  }
  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const agentMemoryDir = join(claudeUserRoot(), "agent-memory");
  const scopes: MemoryScope[] = [];
  let agentMemoryNote: string | undefined;
  if (existsSync(agentMemoryDir)) {
    try {
      for (const entry of readdirSync(agentMemoryDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "archive") continue;
        const stats = collectMarkdownStats(join(agentMemoryDir, entry.name));
        scopes.push({
          name: entry.name,
          file_count: stats.file_count,
          total_lines: stats.total_lines,
          last_modified_iso: stats.last_modified
            ? new Date(stats.last_modified).toISOString()
            : null,
        });
      }
    } catch {
      agentMemoryNote = `Failed to walk ${agentMemoryDir}.`;
    }
  } else {
    agentMemoryNote = `agent-memory directory not found at ${agentMemoryDir}`;
  }
  scopes.sort((a, b) => a.name.localeCompare(b.name));

  // Walk per-project MEMORY.md files.
  const projectsDir = join(claudeUserRoot(), "projects");
  const projectMemories: ProjectMemory[] = [];
  let projectMemoryNote: string | undefined;
  if (existsSync(projectsDir)) {
    try {
      for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const memoryPath = join(projectsDir, entry.name, "memory", "MEMORY.md");
        if (!existsSync(memoryPath)) continue;
        try {
          const stat = statSync(memoryPath);
          projectMemories.push({
            project_path: memoryPath,
            line_count: countLines(memoryPath),
            last_modified_iso: new Date(stat.mtimeMs).toISOString(),
          });
        } catch {
          // skip
        }
      }
    } catch {
      projectMemoryNote = `Failed to walk ${projectsDir}.`;
    }
  } else {
    projectMemoryNote = `projects directory not found at ${projectsDir}`;
  }
  projectMemories.sort((a, b) =>
    b.last_modified_iso.localeCompare(a.last_modified_iso),
  );

  const payload: {
    scopes: MemoryScope[];
    project_memories: ProjectMemory[];
    note?: string;
  } = {
    scopes,
    project_memories: projectMemories,
  };
  const notes = [agentMemoryNote, projectMemoryNote].filter(Boolean) as string[];
  if (notes.length > 0) {
    payload.note = notes.join(" | ");
  }
  writeJson(response, 200, payload, corsOrigin);
  return true;
};

// --- Agent teams ---------------------------------------------------------
//
// Anthropic's experimental "agent-teams" primitive (Claude Code v2.1.32+, gated
// behind CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1) persists state under
// `~/.claude/teams/<team>/inboxes/<teammate>.json` (mailbox) and
// `~/.claude/tasks/<session-id>/{.highwatermark,.lock}` (task-claim state).
//
// Sources:
//   https://code.claude.com/docs/en/agent-teams  (fetched 2026-05-11)
//   https://code.claude.com/docs/en/hooks         §TeammateIdle / TaskCreated / TaskCompleted
//
// This route surfaces both as a single read-only snapshot for the dashboard.

type AgentTeamMessage = {
  from: string;
  text: string;
  summary?: string;
  timestamp: string;
  read: boolean;
};

type AgentTeamInbox = {
  teammate: string;
  message_count: number;
  unread_count: number;
  last_timestamp_iso: string | null;
  path: string;
};

type AgentTeamSummary = {
  name: string;
  inboxes: AgentTeamInbox[];
  total_messages: number;
  total_unread: number;
  last_activity_iso: string | null;
};

type AgentTaskSnapshot = {
  session_id: string;
  size_bytes: number;
  modified_iso: string;
  has_lock: boolean;
  highwatermark: string | null;
};

type AgentTeamsPayload = {
  teams: AgentTeamSummary[];
  tasks: AgentTaskSnapshot[];
  source_paths: { teams_dir: string; tasks_dir: string };
  checked_at: string;
  note?: string;
};

const isAgentTeamMessage = (value: unknown): value is AgentTeamMessage => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.from === "string" &&
    typeof record.text === "string" &&
    typeof record.timestamp === "string" &&
    typeof record.read === "boolean"
  );
};

const readInboxMessages = (path: string): AgentTeamMessage[] => {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAgentTeamMessage);
  } catch {
    return [];
  }
};

const summarizeInbox = (teamDir: string, inboxFile: string): AgentTeamInbox => {
  const inboxPath = join(teamDir, "inboxes", inboxFile);
  const messages = readInboxMessages(inboxPath);
  const teammate = inboxFile.endsWith(".json") ? inboxFile.slice(0, -5) : inboxFile;
  let lastTimestamp: string | null = null;
  let unread = 0;
  for (const message of messages) {
    if (!message.read) unread += 1;
    if (!lastTimestamp || message.timestamp > lastTimestamp) {
      lastTimestamp = message.timestamp;
    }
  }
  return {
    teammate,
    message_count: messages.length,
    unread_count: unread,
    last_timestamp_iso: lastTimestamp,
    path: inboxPath,
  };
};

const summarizeTeam = (teamsDir: string, teamName: string): AgentTeamSummary => {
  const teamDir = join(teamsDir, teamName);
  const inboxesDir = join(teamDir, "inboxes");
  const inboxes: AgentTeamInbox[] = [];
  if (existsSync(inboxesDir)) {
    try {
      for (const entry of readdirSync(inboxesDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(".json")) continue;
        inboxes.push(summarizeInbox(teamDir, entry.name));
      }
    } catch {
      // ignore — return partial.
    }
  }
  let totalMessages = 0;
  let totalUnread = 0;
  let lastActivity: string | null = null;
  for (const inbox of inboxes) {
    totalMessages += inbox.message_count;
    totalUnread += inbox.unread_count;
    if (inbox.last_timestamp_iso && (!lastActivity || inbox.last_timestamp_iso > lastActivity)) {
      lastActivity = inbox.last_timestamp_iso;
    }
  }
  inboxes.sort((a, b) => a.teammate.localeCompare(b.teammate));
  return {
    name: teamName,
    inboxes,
    total_messages: totalMessages,
    total_unread: totalUnread,
    last_activity_iso: lastActivity,
  };
};

const readHighwatermark = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
};

const collectAgentTasks = (tasksDir: string): AgentTaskSnapshot[] => {
  const tasks: AgentTaskSnapshot[] = [];
  if (!existsSync(tasksDir)) return tasks;
  try {
    for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessionDir = join(tasksDir, entry.name);
      try {
        const stat = statSync(sessionDir);
        const highwatermarkPath = join(sessionDir, ".highwatermark");
        const lockPath = join(sessionDir, ".lock");
        tasks.push({
          session_id: entry.name,
          size_bytes: stat.size,
          modified_iso: new Date(stat.mtimeMs).toISOString(),
          has_lock: existsSync(lockPath),
          highwatermark: existsSync(highwatermarkPath)
            ? readHighwatermark(highwatermarkPath)
            : null,
        });
      } catch {
        // skip
      }
    }
  } catch {
    // ignore — return partial.
  }
  tasks.sort((a, b) => (b.modified_iso > a.modified_iso ? 1 : -1));
  return tasks;
};

export const handleClaudeBrainAgentTeamsRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
) => {
  if (requestUrl.pathname !== "/api/claude-brain/agent-teams") {
    return false;
  }
  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const teamsDir = join(claudeUserRoot(), "teams");
  const tasksDir = join(claudeUserRoot(), "tasks");
  const teams: AgentTeamSummary[] = [];
  const notes: string[] = [];

  if (existsSync(teamsDir)) {
    try {
      for (const entry of readdirSync(teamsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        teams.push(summarizeTeam(teamsDir, entry.name));
      }
    } catch {
      notes.push(`Failed to walk ${teamsDir}.`);
    }
  } else {
    notes.push(`teams directory not found at ${teamsDir}`);
  }
  teams.sort((a, b) => a.name.localeCompare(b.name));

  const tasks = collectAgentTasks(tasksDir);
  if (!existsSync(tasksDir)) {
    notes.push(`tasks directory not found at ${tasksDir}`);
  }

  const payload: AgentTeamsPayload = {
    teams,
    tasks,
    source_paths: { teams_dir: teamsDir, tasks_dir: tasksDir },
    checked_at: new Date().toISOString(),
  };
  if (notes.length > 0) {
    payload.note = notes.join(" | ");
  }

  writeJson(response, 200, payload, corsOrigin);
  return true;
};

// --- Review-gate playground ---------------------------------------------
//
// Exposes the @octogent/core verdict-gate + review-fix-loop logic over HTTP
// so the dashboard's nav-14 "Verify Loop" panel can demonstrate the
// reviewer rubber-stamp catch + loop-decision logic on real fixtures
// without spawning a live `claude -p` subprocess (no API spend, repeatable).
//
// GET  /api/claude-brain/review-fixtures        — list shipped reviewer fixtures.
// GET  /api/claude-brain/review-fixtures/:name  — full fixture detail.
// POST /api/claude-brain/review-gate            — run a raw reviewer output
//                                                  through parse + gate + loop.

import {
  DEFAULT_GATE_CONFIG,
  DEFAULT_REVIEW_FIX_LOOP_CONFIG,
  decideNext,
  evaluateVerdict,
  parseReviewerVerdict,
  type LoopIteration,
  type ReviewerVerdict,
} from "@octogent/core";
import { readJsonBodyOrWriteError } from "./routeHelpers";

const fixturesRoot = (): string =>
  process.env.OCTOGENT_FIXTURES_ROOT?.trim() || "/root/octogent/fixtures/reviews";

type ReviewFixture = {
  name: string;
  label: string;
  description: string;
  raw_reviewer_output: string;
  prior_iterations: Array<{ verdict_label: string; gate_passed: boolean }>;
  expected_outcome: {
    parsed_verdict: boolean;
    gate_passes: boolean;
    loop_action: string;
  };
};

const isReviewFixture = (value: unknown): value is ReviewFixture => {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.name === "string" &&
    typeof r.label === "string" &&
    typeof r.description === "string" &&
    typeof r.raw_reviewer_output === "string" &&
    Array.isArray(r.prior_iterations) &&
    typeof r.expected_outcome === "object" &&
    r.expected_outcome !== null
  );
};

const loadFixtureFiles = (): ReviewFixture[] => {
  const root = fixturesRoot();
  if (!existsSync(root)) return [];
  const out: ReviewFixture[] = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(root, entry.name), "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (isReviewFixture(parsed)) {
          out.push(parsed);
        }
      } catch {
        // skip malformed fixture
      }
    }
  } catch {
    // root not readable
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
};

export const handleClaudeBrainReviewFixturesListRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
) => {
  if (requestUrl.pathname !== "/api/claude-brain/review-fixtures") {
    return false;
  }
  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }
  const fixtures = loadFixtureFiles();
  const root = fixturesRoot();
  const payload: {
    fixtures: Array<{ name: string; label: string; description: string }>;
    source_path: string;
    note?: string;
  } = {
    fixtures: fixtures.map((f) => ({
      name: f.name,
      label: f.label,
      description: f.description,
    })),
    source_path: root,
  };
  if (fixtures.length === 0) {
    payload.note = `No fixtures found at ${root}`;
  }
  writeJson(response, 200, payload, corsOrigin);
  return true;
};

export const handleClaudeBrainReviewFixtureItemRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
) => {
  const match = requestUrl.pathname.match(
    /^\/api\/claude-brain\/review-fixtures\/([A-Za-z0-9_-]+)$/,
  );
  if (!match) return false;
  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }
  const name = match[1] ?? "";
  const fixtures = loadFixtureFiles();
  const fixture = fixtures.find((f) => f.name === name);
  if (!fixture) {
    writeJson(
      response,
      404,
      { error: "fixture not found", name },
      corsOrigin,
    );
    return true;
  }
  writeJson(response, 200, fixture, corsOrigin);
  return true;
};

type ReviewGateRequest = {
  raw_reviewer_output?: unknown;
  prior_iterations?: unknown;
};

type PriorIterationInput = {
  verdict_label: string;
  verdict: ReviewerVerdict;
  gate_passed: boolean;
};

const isPriorIterationInput = (value: unknown): value is PriorIterationInput => {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.verdict_label !== "string") return false;
  if (typeof r.gate_passed !== "boolean") return false;
  if (typeof r.verdict !== "object" || r.verdict === null) return false;
  const v = r.verdict as Record<string, unknown>;
  if (v.verdict !== "pass" && v.verdict !== "fail") return false;
  return true;
};

export const handleClaudeBrainReviewGateRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
) => {
  if (requestUrl.pathname !== "/api/claude-brain/review-gate") {
    return false;
  }
  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }
  const bodyResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!bodyResult.ok) return true;
  const body = bodyResult.payload as ReviewGateRequest | null;
  const raw = body && typeof body.raw_reviewer_output === "string"
    ? body.raw_reviewer_output
    : "";
  const priorInput = Array.isArray(body?.prior_iterations)
    ? body.prior_iterations
    : [];

  const verdict = parseReviewerVerdict(raw);
  const gate = verdict ? evaluateVerdict(verdict, DEFAULT_GATE_CONFIG) : null;

  const priorIterations: LoopIteration[] = [];
  for (let idx = 0; idx < priorInput.length; idx += 1) {
    const entry = priorInput[idx];
    if (isPriorIterationInput(entry)) {
      priorIterations.push({
        iter: idx + 1,
        verdict: entry.verdict,
        gatePassed: entry.gate_passed,
      });
    }
  }

  const currentGatePassed = gate?.passes ?? false;
  const iterationsForLoop: LoopIteration[] = verdict
    ? [
        ...priorIterations,
        {
          iter: priorIterations.length + 1,
          verdict,
          gatePassed: currentGatePassed,
        },
      ]
    : priorIterations;

  const loopDecision = decideNext(iterationsForLoop, DEFAULT_REVIEW_FIX_LOOP_CONFIG);

  writeJson(
    response,
    200,
    {
      parsed_verdict: verdict,
      gate_decision: gate,
      loop_decision: loopDecision,
      iterations_considered: iterationsForLoop.length,
      gate_config: DEFAULT_GATE_CONFIG,
      loop_config: DEFAULT_REVIEW_FIX_LOOP_CONFIG,
    },
    corsOrigin,
  );
  return true;
};

// Suppress unused-import lints; basename is exported for tests of helpers if added later.
void basename;
