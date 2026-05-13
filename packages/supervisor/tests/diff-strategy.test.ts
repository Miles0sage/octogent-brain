import { describe, expect, it } from "vitest";
import { prepareCliDiff, summarizeDiff } from "../src/diff-strategy";

const SAMPLE_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 1111..2222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,5 +10,8 @@ export function loginHandler(req: Req) {
 const token = req.headers.get("authorization");
-if (!token) return res.status(401);
+if (!token) {
+  log.warn("missing token", { ip: req.ip });
+  return res.status(401);
+}
 return verify(token);
diff --git a/src/db.ts b/src/db.ts
index 3333..4444 100644
--- a/src/db.ts
+++ b/src/db.ts
@@ -50,3 +50,5 @@ export function query(sql: string) {
 if (!conn) throw new Error("no conn");
+const start = Date.now();
 return conn.execute(sql);
+log.info("query ms", { ms: Date.now() - start });
`;

describe("prepareCliDiff", () => {
  const long = `${SAMPLE_DIFF}\n`.repeat(200);

  it("returns full diff for codex (long-context CLI)", () => {
    const out = prepareCliDiff("codex", long);
    expect(out).toBe(long);
  });

  it("returns full diff for claude-code (long-context CLI)", () => {
    const out = prepareCliDiff("claude-code", long);
    expect(out).toBe(long);
  });

  it("returns summary for aider (budget-sensitive CLI)", () => {
    const out = prepareCliDiff("aider", long);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain("@@ -");
    expect(out).toContain("diff --git");
  });

  it("returns summary for gemini-cli (budget-sensitive CLI)", () => {
    const out = prepareCliDiff("gemini-cli", long);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain("@@ -");
  });
});

describe("summarizeDiff", () => {
  it("passes through when diff fits the budget", () => {
    expect(summarizeDiff(SAMPLE_DIFF, 10_000)).toBe(SAMPLE_DIFF);
  });

  it("preserves diff --git + hunk headers when trimming", () => {
    const hugeBody = Array.from({ length: 100 }, (_, i) => ` line ${i}`).join("\n");
    const big = `diff --git a/x.ts b/x.ts
index aaaa..bbbb 100644
--- a/x.ts
+++ b/x.ts
@@ -1,100 +1,100 @@
${hugeBody}
`;
    const out = summarizeDiff(big, 500);
    expect(out).toContain("diff --git a/x.ts b/x.ts");
    expect(out).toContain("@@ -1,100 +1,100 @@");
    expect(out).toMatch(/\[hunk continues — \d+ lines? elided\]/);
  });

  it("emits an additional-hunks marker when later hunks exceed budget", () => {
    const hunk = (i: number) => `diff --git a/file${i}.ts b/file${i}.ts
index aaaa..bbbb 100644
--- a/file${i}.ts
+++ b/file${i}.ts
@@ -1,3 +1,3 @@
-old line
+new line
 trailing context
`;
    const many = Array.from({ length: 30 }, (_, i) => hunk(i)).join("\n");
    const out = summarizeDiff(many, 800);
    expect(out).toMatch(/\[\d+ additional hunks? elided to fit summary budget\]/);
  });

  it("falls through to char-truncate when input has no parseable hunks", () => {
    const garbage = "no hunks here, just text".repeat(200);
    const out = summarizeDiff(garbage, 100);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toContain("[diff truncated at 100 chars — could not parse hunks]");
  });
});
