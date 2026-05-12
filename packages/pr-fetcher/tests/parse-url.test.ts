import { describe, it, expect } from "vitest";
import { parseUrl } from "../src/parse-url";

describe("parseUrl", () => {
  it("extracts owner/repo/number from canonical URL", () => {
    expect(parseUrl("https://github.com/anthropics/foo/pull/421"))
      .toEqual({ owner: "anthropics", repo: "foo", number: 421 });
  });
  it("rejects non-PR URLs", () => {
    expect(() => parseUrl("https://github.com/anthropics/foo/issues/1"))
      .toThrow(/not a pull request URL/);
  });
  it("rejects non-github URLs", () => {
    expect(() => parseUrl("https://gitlab.com/x/y/-/merge_requests/1"))
      .toThrow(/github.com/);
  });
});
