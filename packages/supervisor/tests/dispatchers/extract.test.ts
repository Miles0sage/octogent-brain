import { describe, it, expect } from "vitest";
import { extractJsonVerdict } from "../../src/dispatchers/extract";

describe("extractJsonVerdict", () => {
  it("parses raw single-line JSON", () => {
    const out = `{"decision":"REJECT","issues":[{"severity":"high","message":"x","diff_lines":[1,5]}],"reasoning":"r"}`;
    const r = extractJsonVerdict(out);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.decision).toBe("REJECT");
  });
  it("strips markdown fence", () => {
    const out =
      "Sure! Here's the verdict:\n\n```json\n{\"decision\":\"APPROVE\",\"issues\":[{\"severity\":\"info\",\"message\":\"ok\",\"darwin_pattern_id\":\"errcls_a\"}],\"reasoning\":\"verified\"}\n```\n\nLet me know if you need more.";
    const r = extractJsonVerdict(out);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.decision).toBe("APPROVE");
  });
  it("rejects empty output", () => {
    expect(extractJsonVerdict("").ok).toBe(false);
  });
  it("rejects invalid JSON", () => {
    expect(extractJsonVerdict("not json").ok).toBe(false);
  });
  it("rejects invalid decision", () => {
    const r = extractJsonVerdict(`{"decision":"MAYBE","issues":[],"reasoning":""}`);
    expect(r.ok).toBe(false);
  });
});
