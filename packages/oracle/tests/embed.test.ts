import { describe, it, expect } from "vitest";
import { l2Normalize } from "../src/normalize.js";

describe("l2Normalize", () => {
  it("normalizes a 3d vector to unit length", () => {
    const v = l2Normalize([3, 0, 4]);
    expect(v[0]).toBeCloseTo(0.6, 5);
    expect(v[2]).toBeCloseTo(0.8, 5);
    const mag = Math.hypot(...v);
    expect(mag).toBeCloseTo(1, 5);
  });
});
