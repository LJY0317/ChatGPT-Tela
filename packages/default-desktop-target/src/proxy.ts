import { once } from "node:events";
import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from "ws";
import {
  rewriteDefaultDesktopAppServerRequest,
  type DefaultDesktopResponsesRoute,
} from "./route";

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const CLOSE_GRACE_MS = 250;
const CLOSE_HARD_LIMIT_MS = 2_000;

interface ConnectionState {
  readonly client: WebSocket;
  readonly upstream: WebSocket;
  queue: string[];
  queuedBytes: number;
  closed: boolean;
}

export interface DefaultDesktopAppServerProxy {
  readonly endpoint: string;
  readonly upstreamEndpoint: string;
  readonly activeConnectionCount: number;
  close(): Promise<void>;
}

function loopbackWebSocket(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("default Desktop app-server proxy upstream must use loopback ws://");
  }
  if (!url.port || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("default Desktop app-server proxy upstream must be a plain loopback WebSocket endpoint");
  }
  url.pathname = "/";
  return url.href;
}

function textBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function textMessage(data: RawData, isBinary: boolean): string | undefined {
  if (isBinary) return undefined;
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : Buffer.from(data);
  if (buffer.byteLength > MAX_MESSAGE_BYTES) return undefined;
  return buffer.toString("utf8");
}

function protocols(header: string | undefined): readonly string[] {
  if (!header) return Object.freeze([]);
  const result = header.split(",").map(value => value.trim()).filter(Boolean);
  if (result.some(value => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value))) {
    throw new Error("default Desktop app-server proxy received an invalid WebSocket subprotocol");
  }
  return Object.freeze(result);
}

export async function startDefaultDesktopAppServerProxy(input: {
  readonly upstreamEndpoint: string;
  readonly route: DefaultDesktopResponsesRoute;
}): Promise<DefaultDesktopAppServerProxy> {
  const upstreamEndpoint = loopbackWebSocket(input.upstreamEndpoint);
  const connections = new Set<ConnectionState>();
  let closing = false;
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: MAX_MESSAGE_BYTES,
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    throw new Error("default Desktop app-server proxy did not bind a TCP address");
  }

  server.on("connection", (client, request) => {
    if (closing) {
      client.close(1012, "Tela proxy is stopping");
      return;
    }
    let requestedProtocols: readonly string[];
    try { requestedProtocols = protocols(request.headers["sec-websocket-protocol"]); }
    catch {
      client.close(1002, "invalid WebSocket subprotocol");
      return;
    }
    const upstream = requestedProtocols.length > 0
      ? new WebSocket(upstreamEndpoint, [...requestedProtocols], { maxPayload: MAX_MESSAGE_BYTES })
      : new WebSocket(upstreamEndpoint, { maxPayload: MAX_MESSAGE_BYTES });
    const state: ConnectionState = {
      client,
      upstream,
      queue: [],
      queuedBytes: 0,
      closed: false,
    };
    connections.add(state);

    const closeBoth = (code: number, reason: string) => {
      if (state.closed) return;
      state.closed = true;
      connections.delete(state);
      if (client.readyState < WebSocket.CLOSING) client.close(code, reason);
      if (upstream.readyState < WebSocket.CLOSING) upstream.close(code, reason);
    };

    upstream.once("open", () => {
      if (state.closed) return;
      if (client.protocol && upstream.protocol !== client.protocol) {
        closeBoth(1002, "upstream selected a different WebSocket subprotocol");
        return;
      }
      for (const queued of state.queue) upstream.send(queued);
      state.queue = [];
      state.queuedBytes = 0;
    });
    upstream.on("message", (data, isBinary) => {
      const message = textMessage(data, isBinary);
      if (message === undefined) {
        closeBoth(isBinary ? 1003 : 1009, isBinary ? "text JSON required" : "message too large");
        return;
      }
      if (client.readyState === WebSocket.OPEN) client.send(message);
    });
    upstream.once("error", () => closeBoth(1011, "upstream app-server connection failed"));
    upstream.once("close", (code, reason) => {
      if (!state.closed) closeBoth(code || 1000, reason.toString("utf8") || "upstream closed");
    });

    client.on("message", (data, isBinary) => {
      const message = textMessage(data, isBinary);
      if (message === undefined) {
        closeBoth(isBinary ? 1003 : 1009, isBinary ? "text JSON required" : "message too large");
        return;
      }
      let routed: string;
      try { routed = rewriteDefaultDesktopAppServerRequest(message, input.route); }
      catch {
        closeBoth(1008, "invalid routed app-server request");
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(routed);
        return;
      }
      const bytes = textBytes(routed);
      if (state.queuedBytes + bytes > MAX_QUEUED_BYTES) {
        closeBoth(1009, "startup queue exceeded limit");
        return;
      }
      state.queue.push(routed);
      state.queuedBytes += bytes;
    });
    client.once("error", () => closeBoth(1011, "Desktop app-server client failed"));
    client.once("close", () => closeBoth(1000, "Desktop app-server client closed"));
  });

  let stopped = false;
  return Object.freeze({
    endpoint: `ws://127.0.0.1:${address.port}/`,
    upstreamEndpoint,
    get activeConnectionCount() { return connections.size; },
    async close() {
      if (stopped) return;
      stopped = true;
      closing = true;
      const closingConnections = [...connections];
      const ignoreShutdownError = () => {};
      for (const state of closingConnections) {
        state.closed = true;
        connections.delete(state);
        // `terminate()` may emit more than one error while a WebSocket is still connecting or
        // completing its close handshake. During owned shutdown those errors are expected and
        // must not become an unhandled EventEmitter error after the normal one-shot listener ran.
        state.client.on("error", ignoreShutdownError);
        state.upstream.on("error", ignoreShutdownError);
        if (state.client.readyState < WebSocket.CLOSING) state.client.close(1001, "Tela proxy stopping");
        if (state.upstream.readyState < WebSocket.CLOSING) state.upstream.close(1001, "Tela proxy stopping");
      }
      const terminateOwnedSockets = () => {
        for (const state of closingConnections) {
          try {
            if (state.client.readyState !== WebSocket.CLOSED) state.client.terminate();
          } catch {
            // Best-effort bounded cleanup of an owned proxy socket.
          }
          try {
            if (state.upstream.readyState !== WebSocket.CLOSED) state.upstream.terminate();
          } catch {
            // Best-effort bounded cleanup of an owned proxy socket.
          }
        }
      };
      let closeCompleted = false;
      let closeError: Error | undefined;
      const closePromise = new Promise<void>(resolvePromise => {
        server.close(error => {
          closeCompleted = true;
          if (error) closeError = error;
          resolvePromise();
        });
      });
      const graceTimer = setTimeout(terminateOwnedSockets, CLOSE_GRACE_MS);
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      const hardLimit = new Promise<void>(resolvePromise => {
        hardTimer = setTimeout(() => {
          terminateOwnedSockets();
          resolvePromise();
        }, CLOSE_HARD_LIMIT_MS);
      });
      await Promise.race([closePromise, hardLimit]);
      clearTimeout(graceTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (!closeCompleted) {
        terminateOwnedSockets();
        await Promise.race([
          closePromise,
          new Promise<void>(resolvePromise => setTimeout(resolvePromise, CLOSE_GRACE_MS)),
        ]);
      }
      if (closeError) throw closeError;
    },
  });
}
