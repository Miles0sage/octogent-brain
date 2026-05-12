// CMA (Composable Managed Agents) rubric portability layer.
//
// Adopts the Anthropic outcome-grader schema reverse-engineered from
// `CMA_verify_with_outcome_grader.ipynb` in `anthropics/claude-cookbooks`
// (cookbook PR #599, 2026-05-06). The contract is: Anthropic publishes a
// rubric, our supervisor runs it across Claude + Codex + Gemini, votes,
// surfaces disagreement. We adopt their schema — we do not extend it
// without a major-version bump.
//
// Pure types + bounded validators + a tail-JSON parser that mirrors the
// `parseReviewerVerdict` pattern in `orchestrator/verdict-gate.ts` so the
// adapter layer in `@octogent/supervisor` can reuse the same bouncer
// discipline for vendor-supplied grades.

export type CmaRubricCriterion = {
  name: string;
  description: string;
  weight: number; // [0, 1]
};

export type CmaRubric = {
  rubric_id: string;
  rubric_version: string;
  criteria: ReadonlyArray<CmaRubricCriterion>;
  passing_threshold: number; // [0, 1]
};

export type CmaGradeResult = {
  criterion_scores: Record<string, number>;
  weighted_average: number; // [0, 1]
  passed: boolean;
  rationale: string;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isUnitInterval = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

const isCmaRubricCriterion = (v: unknown): v is CmaRubricCriterion => {
  if (!isPlainObject(v)) return false;
  if (!isNonEmptyString(v.name)) return false;
  if (typeof v.description !== "string") return false;
  if (!isUnitInterval(v.weight)) return false;
  return true;
};

export const isCmaRubric = (value: unknown): value is CmaRubric => {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.rubric_id)) return false;
  if (!isNonEmptyString(value.rubric_version)) return false;
  if (!Array.isArray(value.criteria) || value.criteria.length === 0) return false;
  for (const c of value.criteria) {
    if (!isCmaRubricCriterion(c)) return false;
  }
  if (!isUnitInterval(value.passing_threshold)) return false;
  return true;
};

const isNumericScoreRecord = (v: unknown): v is Record<string, number> => {
  if (!isPlainObject(v)) return false;
  for (const key of Object.keys(v)) {
    const n = v[key];
    if (!isUnitInterval(n)) return false;
  }
  return true;
};

export const isCmaGradeResult = (value: unknown): value is CmaGradeResult => {
  if (!isPlainObject(value)) return false;
  if (!isNumericScoreRecord(value.criterion_scores)) return false;
  if (!isUnitInterval(value.weighted_average)) return false;
  if (typeof value.passed !== "boolean") return false;
  if (typeof value.rationale !== "string") return false;
  return true;
};

// Scan for balanced top-level JSON objects. Identical walker discipline
// to `extractJsonObjects` in verdict-gate.ts — kept inline rather than
// imported to keep the cma-rubric module self-contained for downstream
// consumers that pull only this file.
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

// Tail-JSON parser. Mirrors parseReviewerVerdict: walks every balanced
// JSON candidate, returns the LAST one that passes isCmaGradeResult.
// Older Claude builds leak chain-of-thought scratch JSON earlier in the
// stream and the contract is "final line wins".
export const parseCmaGradeFromText = (raw: string): CmaGradeResult | null => {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const candidates = extractJsonObjects(raw);
  for (let i = candidates.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidates[i]!);
    } catch {
      continue;
    }
    if (isCmaGradeResult(parsed)) return parsed;
  }
  return null;
};
