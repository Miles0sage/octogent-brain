// Adapted from Hosico02/agent-self-iteration (reviewer.md final-line JSON
// contract) + Tenormusica2024/review-fix-pipeline (/go-robust score rubric).
// The gate-trust-numbers rule mirrors BriefingDeck's loop.py (commit e38faa8 at
// /root/briefingdeck/briefingdeck/agents/loop.py): a textual "pass" verdict
// MUST be overridden when the reviewer's own numeric scores fall below the
// configured thresholds. Reviewers rubber-stamp; numbers don't.
// Reference: Anthropic harness post 2026-03-24 (reviewer-as-judge anti-pattern).

export type ReviewerVerdict = {
  verdict: "pass" | "fail";
  improvements_exhausted: boolean;
  issues: string[];
  scores: {
    groundedness: number;
    specificity: number;
  };
};

export type GateConfig = {
  groundednessThreshold: number;
  specificityThreshold: number;
};

export type GateDecision = {
  passes: boolean;
  reason: string;
};

export const DEFAULT_GATE_CONFIG: GateConfig = {
  groundednessThreshold: 0.85,
  specificityThreshold: 0.85,
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const isUnitInterval = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

const narrowVerdict = (raw: unknown): ReviewerVerdict | null => {
  if (!isPlainObject(raw)) return null;
  const { verdict, improvements_exhausted, issues, scores } = raw;
  if (verdict !== "pass" && verdict !== "fail") return null;
  if (typeof improvements_exhausted !== "boolean") return null;
  if (!isStringArray(issues)) return null;
  if (!isPlainObject(scores)) return null;
  const { groundedness, specificity } = scores;
  if (!isUnitInterval(groundedness) || !isUnitInterval(specificity)) return null;
  return {
    verdict,
    improvements_exhausted,
    issues,
    scores: { groundedness, specificity },
  };
};

// Scan for balanced top-level JSON objects in the raw string. We collect every
// candidate and return them in document order so the caller can prefer the
// last one — older Claude versions sometimes leak chain-of-thought scratch
// JSON earlier in the stream, and the contract is "final line wins".
const extractJsonObjects = (raw: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(raw.slice(start, i + 1));
        start = -1;
      } else if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }
  return out;
};

export const parseReviewerVerdict = (raw: string): ReviewerVerdict | null => {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const candidates = extractJsonObjects(raw);
  for (let i = candidates.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidates[i]!);
    } catch {
      continue;
    }
    const narrowed = narrowVerdict(parsed);
    if (narrowed) return narrowed;
  }
  return null;
};

export const evaluateVerdict = (
  verdict: ReviewerVerdict,
  config: GateConfig,
): GateDecision => {
  if (verdict.verdict === "fail") {
    return {
      passes: false,
      reason: `reviewer returned fail with ${verdict.issues.length} issue(s)`,
    };
  }
  const { groundedness, specificity } = verdict.scores;
  if (groundedness < config.groundednessThreshold) {
    return {
      passes: false,
      reason: `gate-trust-numbers: reviewer claimed pass but groundedness=${groundedness} < threshold=${config.groundednessThreshold}`,
    };
  }
  if (specificity < config.specificityThreshold) {
    return {
      passes: false,
      reason: `gate-trust-numbers: reviewer claimed pass but specificity=${specificity} < threshold=${config.specificityThreshold}`,
    };
  }
  return { passes: true, reason: "pass: thresholds met" };
};
