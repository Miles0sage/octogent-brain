import { describe, it, expect } from "vitest";
import { truncateDiff } from "../src/truncate";

describe("truncateDiff", () => {
  it("returns input unchanged if under 2k tokens", () => {
    const small = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n";
    expect(truncateDiff(small)).toBe(small);
  });
  it("truncates and appends marker if over 2k tokens", () => {
    const huge = "x".repeat(10_000);
    const out = truncateDiff(huge);
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toMatch(/\[diff continues - truncated at 2k tokens\]$/);
  });
});
