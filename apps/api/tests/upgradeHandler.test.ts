import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createUpgradeHandler } from "../src/createApiServer/upgradeHandler";

type RuntimeLike = {
  handleUpgrade: (request: IncomingMessage, socket: Socket, head: Buffer) => boolean;
};

describe("createUpgradeHandler", () => {
  let prevApiKey: string | undefined;
  let prevAllowRemote: string | undefined;

  beforeEach(() => {
    prevApiKey = process.env.OCTOGENT_API_KEY;
    prevAllowRemote = process.env.OCTOGENT_ALLOW_REMOTE_ACCESS;
  });

  afterEach(() => {
    if (prevApiKey === undefined) {
      delete process.env.OCTOGENT_API_KEY;
    } else {
      process.env.OCTOGENT_API_KEY = prevApiKey;
    }

    if (prevAllowRemote === undefined) {
      delete process.env.OCTOGENT_ALLOW_REMOTE_ACCESS;
    } else {
      process.env.OCTOGENT_ALLOW_REMOTE_ACCESS = prevAllowRemote;
    }
  });

  it("destroys socket when runtime upgrade handling throws", () => {
    const runtime: RuntimeLike = {
      handleUpgrade: () => {
        throw new Error("boom");
      },
    };
    const handler = createUpgradeHandler({
      runtime: runtime as never,
      allowRemoteAccess: true,
    });
    const socket = {
      destroy: vi.fn(),
    } as unknown as Socket;

    expect(() =>
      handler(
        {
          headers: {
            host: "127.0.0.1:8787",
            origin: "http://127.0.0.1:5173",
          },
          socket: { remoteAddress: "127.0.0.1" },
        } as IncomingMessage,
        socket,
        Buffer.alloc(0),
      ),
    ).not.toThrow();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it("refuses websocket upgrade when API key is set but no token is presented", () => {
    process.env.OCTOGENT_API_KEY = "test-secret-12345";
    const runtime: RuntimeLike = {
      handleUpgrade: vi.fn(() => true),
    };
    const handler = createUpgradeHandler({
      runtime: runtime as never,
      allowRemoteAccess: true,
    });
    const socket = {
      destroy: vi.fn(),
    } as unknown as Socket;

    handler(
      {
        url: "/api/terminals/tentacle-main/ws",
        headers: {
          host: "dashboard.example.com:8787",
          origin: "https://dashboard.example.com",
        },
        socket: { remoteAddress: "203.0.113.10" },
      } as IncomingMessage,
      socket,
      Buffer.alloc(0),
    );

    expect(runtime.handleUpgrade).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it("accepts websocket upgrade when query token matches the API key", () => {
    process.env.OCTOGENT_API_KEY = "test-secret-12345";
    const runtime: RuntimeLike = {
      handleUpgrade: vi.fn(() => true),
    };
    const handler = createUpgradeHandler({
      runtime: runtime as never,
      allowRemoteAccess: true,
    });
    const socket = {
      destroy: vi.fn(),
    } as unknown as Socket;

    handler(
      {
        url: "/api/terminals/tentacle-main/ws?octogent_token=test-secret-12345",
        headers: {
          host: "dashboard.example.com:8787",
          origin: "https://dashboard.example.com",
        },
        socket: { remoteAddress: "203.0.113.10" },
      } as IncomingMessage,
      socket,
      Buffer.alloc(0),
    );

    expect(runtime.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(socket.destroy).not.toHaveBeenCalled();
  });
});
