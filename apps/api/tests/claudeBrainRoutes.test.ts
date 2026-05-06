import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleClaudeBrainDpoRecentRoute } from "../src/createApiServer/claudeBrainRoutes";

type ResponseLike = {
  status: number;
  body: string;
  headers: Record<string, string>;
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: string): void;
};

const buildResponse = (): ResponseLike => {
  return {
    status: 0,
    body: "",
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ?? "";
    },
  };
};

const buildRequest = (url: string) => {
  const response = buildResponse();
  return {
    request: { method: "GET" } as unknown as import("node:http").IncomingMessage,
    response: response as unknown as import("node:http").ServerResponse,
    responseStub: response,
    requestUrl: new URL(url),
    corsOrigin: null,
  };
};

describe("claude-brain dpo-recent route", () => {
  let prevRoot: string | undefined;
  let workDir: string;

  beforeEach(() => {
    prevRoot = process.env.CLAUDE_BRAIN_ROOT;
    workDir = mkdtempSync(join(tmpdir(), "octogent-cb-test-"));
    process.env.CLAUDE_BRAIN_ROOT = workDir;
  });

  afterEach(() => {
    if (prevRoot === undefined) {
      delete process.env.CLAUDE_BRAIN_ROOT;
    } else {
      process.env.CLAUDE_BRAIN_ROOT = prevRoot;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it("returns a note when dpo-pairs/ is missing", async () => {
    const ctx = buildRequest("http://x.test/api/claude-brain/dpo-recent");
    const handled = await handleClaudeBrainDpoRecentRoute(ctx, {} as never);
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as {
      files: unknown[];
      total_pairs: number;
      note?: string;
    };
    expect(body.files).toEqual([]);
    expect(body.total_pairs).toBe(0);
    expect(body.note).toBeDefined();
  });

  it("counts lines in recent jsonl files and ignores stale ones", async () => {
    const dpoDir = join(workDir, "dpo-pairs");
    mkdirSync(dpoDir, { recursive: true });
    const today = "2026-05-06.jsonl";
    writeFileSync(join(dpoDir, today), "a\nb\nc\n");
    // Stale file: backdate mtime to 30 days ago.
    const stalePath = join(dpoDir, "2026-04-01.jsonl");
    writeFileSync(stalePath, "x\ny\n");
    const staleTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // Use fs.utimesSync to backdate.
    const { utimesSync } = await import("node:fs");
    utimesSync(stalePath, staleTime, staleTime);

    const ctx = buildRequest("http://x.test/api/claude-brain/dpo-recent?days=7");
    const handled = await handleClaudeBrainDpoRecentRoute(ctx, {} as never);
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as {
      files: Array<{ date: string | null; line_count: number }>;
      total_pairs: number;
    };
    expect(body.files).toHaveLength(1);
    expect(body.files[0]?.date).toBe("2026-05-06");
    expect(body.files[0]?.line_count).toBe(3);
    expect(body.total_pairs).toBe(3);
  });
});
