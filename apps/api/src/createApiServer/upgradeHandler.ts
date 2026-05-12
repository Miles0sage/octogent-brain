import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import {
  checkAuthorizedWsUpgrade,
  isAllowedHostHeader,
  isAllowedOriginHeader,
  readHeaderValue,
} from "./security";

type TerminalRuntime = ReturnType<typeof import("../terminalRuntime").createTerminalRuntime>;

type CreateUpgradeHandlerOptions = {
  runtime: TerminalRuntime;
  allowRemoteAccess: boolean;
};

export const createUpgradeHandler = ({
  runtime,
  allowRemoteAccess,
}: CreateUpgradeHandlerOptions) => {
  return (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const originHeader = readHeaderValue(request.headers.origin);
    const hostHeader = readHeaderValue(request.headers.host);
    if (!isAllowedHostHeader(hostHeader, allowRemoteAccess)) {
      socket.destroy();
      return;
    }

    if (!isAllowedOriginHeader(originHeader, allowRemoteAccess)) {
      socket.destroy();
      return;
    }

    // L3 audit r3 H1 (2026-05-12): WS-upgrade gate is stricter than
    // the HTTP gate. Even when OCTOGENT_ALLOW_REMOTE_ACCESS=1 lets the
    // dashboard reach the API without a key over HTTP, WS upgrades
    // from non-loopback addresses still require OCTOGENT_API_KEY.
    // Rationale: WS opens a persistent bidirectional channel into a
    // spawned PTY; anonymous remote access there is far higher impact
    // than a one-shot HTTP call.
    const auth = checkAuthorizedWsUpgrade(request);
    if (!auth.ok) {
      socket.destroy();
      return;
    }

    try {
      if (!runtime.handleUpgrade(request, socket, head)) {
        socket.destroy();
      }
    } catch {
      socket.destroy();
    }
  };
};
