import { randomBytes } from "node:crypto";
import {
  emitDiagnosticEvent, prepareNativeIngressTurnMedia, NativeIngressMediaRegistry,
  NativeLiveTurnRegistry,
  type NativeIngressPendingMedia, type DiagnosticScalar,
} from "@chatgpt-tela/core";
import { once } from "node:events";
import { remoteControlDiagnostics } from "./remote-control-diagnostics";
import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from "ws";
import {
  rewriteDefaultDesktopAppServerRequest,
  type DefaultDesktopResponsesRoute,
} from "./route";

// Match ws default maxPayload rather than impose a smaller limit on Native history replies.
// Both directions remain bounded; queued requests have their own smaller admission bound.
const MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const CLOSE_GRACE_MS = 250;
const CLOSE_HARD_LIMIT_MS = 2_000;

interface ConnectionState {
  readonly client: WebSocket;
  readonly upstream: WebSocket;
  queue: string[];
  queuedBytes: number;
  closed: boolean;
  onClosed?: () => void;
}

export interface DefaultDesktopAppServerProxy {
  readonly endpoint: string;
  readonly upstreamEndpoint: string;
  readonly activeConnectionCount: number;
  /** Ephemeral media is never authority until an exact current Native turn is proved. */
  readonly ingressMedia: NativeIngressMediaRegistry;
  /** Memory-only original turn/start engine receipts for bounded Legacy live-turn proof. */
  readonly liveTurnProof: NativeLiveTurnRegistry;
  close(): Promise<void>;
}

export type DefaultDesktopAppServerModelListAugmenter = (result: unknown) => unknown;

function jsonRpcIdKey(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0 && value.length <= 512) return `s:${value}`;
  if (typeof value === "number" && Number.isSafeInteger(value)) return `n:${value}`;
  return undefined;
}

function nativeLiveIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value) && !!value.trim();
}

function modelListRequestId(message: string): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(message) as unknown; } catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const item = parsed as Record<string, unknown>;
  return item.method === "model/list" ? jsonRpcIdKey(item.id) : undefined;
}

function augmentModelListResponse(
  message: string,
  pending: Set<string>,
  augmenter: DefaultDesktopAppServerModelListAugmenter | undefined,
): string {
  if (!augmenter || pending.size === 0) return message;
  let parsed: unknown;
  try { parsed = JSON.parse(message) as unknown; } catch { return message; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return message;
  const item = parsed as Record<string, unknown>;
  const key = jsonRpcIdKey(item.id);
  if (!key || !pending.has(key)) return message;
  pending.delete(key);
  if (!("result" in item) || item.error !== undefined) return message;
  try {
    return JSON.stringify({ ...item, result: augmenter(item.result) });
  } catch {
    // A browser-catalog mismatch must never take Native Codex models away from the Desktop. The
    // original app-server response remains valid authority; this merely omits optional Tela rows.
    return message;
  }
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
  readonly augmentModelList?: DefaultDesktopAppServerModelListAugmenter;
  /** Diagnostic-only owner intent; never authorizes transport or process actions. */
  readonly shutdownRequested?: () => boolean;
  /** Structural fixture sink; never receives message bodies or native identifiers. */
  readonly onDiagnostic?: (stage: string, fields: Readonly<Record<string, DiagnosticScalar>>) => void;
}): Promise<DefaultDesktopAppServerProxy> {
  const upstreamEndpoint = loopbackWebSocket(input.upstreamEndpoint);
  const connections = new Set<ConnectionState>();
  const ingressMedia = new NativeIngressMediaRegistry();
  const liveTurnProof = new NativeLiveTurnRegistry();
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
    const pendingModelLists = new Set<string>();
    const pendingMedia = new Map<string, {
      readonly media: NativeIngressPendingMedia;
      readonly generation: number;
    }>();
    const pendingLiveTurns = new Map<string, {
      readonly threadId: string;
      readonly generation: number;
    }>();
    // An original turn/start ACK has no independent thread ID in the public
    // response. Reusing a completed JSON-RPC id on this same socket would
    // allow a delayed old reply to masquerade as another thread's ACK.
    // Never recycle turn-authority correlation keys during one connection.
    const seenLiveRpcIds = new Set<string>();
    const finishedLiveTurns = new Set<string>();
    const startedLiveTurns = new Map<string, string>();
    let liveReceiptsDisabled = false;
    const pendingCatalog = new Map<string, number>();
    const pendingHistory = new Map<string, { began: number; fingerprint: string }>();
    const connectionFingerprint = randomBytes(12).toString("hex");
    let clientKind = "uninitialized_client";
    let diagnosticCount = 0;
    let clientReceivedCount = 0, clientReceivedBytes = 0;
    let upstreamReceivedCount = 0, upstreamReceivedBytes = 0;
    let clientWrittenCount = 0, clientWrittenBytes = 0;
    let transportFailureRecorded = false;
    const diagnostic = (stage: string, fields: Readonly<Record<string, DiagnosticScalar>> = {}) => {
      // Bounded per-connection logging, no timer/watcher; never change transport behavior.
      if (++diagnosticCount > 64 && stage !== "desktop_catalog_connection_closed" && stage !== "desktop_transport_failed" && stage !== "desktop_transport_closed"
        && stage !== "desktop_remote_control_status" && stage !== "desktop_remote_control_failed") return;
      try {
        const structural = { connection_fingerprint: connectionFingerprint, kind: clientKind, ...fields };
        if (input.onDiagnostic) input.onDiagnostic(stage, structural);
        else emitDiagnosticEvent("chatgpt_tela_codex", stage, structural);
      } catch { /* A failed optional sink cannot block Native traffic. */ }
    };
    // Remote has its own small transition budget so earlier history traffic cannot hide its failure.
    const remote = remoteControlDiagnostics(fields => diagnostic(
      fields.status === "errored" || fields.status === "rpc_error" ? "desktop_remote_control_failed" : "desktop_remote_control_status", fields));
    const transportFailure = (direction: "client_to_server" | "server_to_client", category: string, closeCode: number) => {
      if (state.closed || closing || transportFailureRecorded) return;
      transportFailureRecorded = true;
      let shutdownRequested = false;
      try { shutdownRequested = input.shutdownRequested?.() === true; } catch { /* Observation only. */ }
      const requestedClose = category === "peer_closed" && shutdownRequested;
      diagnostic(requestedClose ? "desktop_transport_closed" : "desktop_transport_failed", {
        kind: direction, reason_class: category, close_code: closeCode,
        shutdown_intent_observed: Boolean(input.shutdownRequested), shutdown_requested: shutdownRequested,
        client_ready_state: client.readyState, upstream_ready_state: upstream.readyState,
        pending_catalog_count: pendingCatalog.size, pending_history_count: pendingHistory.size,
        limit_bytes: MAX_MESSAGE_BYTES, client_received_count: clientReceivedCount,
        client_received_bytes: clientReceivedBytes, upstream_received_count: upstreamReceivedCount,
        upstream_received_bytes: upstreamReceivedBytes });
    };
    const observeError = (error: Error, direction: "client_to_server" | "server_to_client") => {
      const code = (error as Error & { code?: string }).code;
      transportFailure(direction, code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" ? "message_limit"
        : code === "WS_ERR_INVALID_UTF8" ? "invalid_text" : "transport_error", 1011);
    };
    state.onClosed = () => {
      diagnostic("desktop_catalog_connection_closed", { pending_count: pendingCatalog.size, count: diagnosticCount, status: "closed",
        pending_history_count: pendingHistory.size, client_received_count: clientReceivedCount,
        client_received_bytes: clientReceivedBytes, upstream_received_count: upstreamReceivedCount,
        upstream_received_bytes: upstreamReceivedBytes, client_written_count: clientWrittenCount,
        client_written_bytes: clientWrittenBytes, delivery: "socket_write_only" });
      pendingCatalog.clear(); pendingModelLists.clear(); pendingHistory.clear();
      remote.close();
      pendingMedia.clear();
      pendingLiveTurns.clear(); seenLiveRpcIds.clear();
      finishedLiveTurns.clear(); startedLiveTurns.clear();
      liveTurnProof.retireOwner(state);
    };
    let permissionProfiles = false;
    connections.add(state);

    const closeBoth = (code: number, reason: string) => {
      if (state.closed) return;
      state.closed = true;
      state.onClosed?.();
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
      let message = textMessage(data, isBinary);
      upstreamReceivedCount++;
      if (message !== undefined) upstreamReceivedBytes += textBytes(message);
      if (message === undefined) {
        transportFailure("server_to_client", isBinary ? "unsupported_binary" : "message_limit", isBinary ? 1003 : 1009);
        closeBoth(isBinary ? 1003 : 1009, isBinary ? "text JSON required" : "message too large");
        return;
      }
      // Bind exactly one public turn/start submission to the app-server's
      // acknowledged turn identity. No bytes enter normal diagnostics or a file.
      try {
        const parsed = JSON.parse(message);
        remote.response(parsed);
        const key = jsonRpcIdKey(parsed?.id);
        if (key) {
          const pendingLive = pendingLiveTurns.get(key);
          if (pendingLive) {
            pendingLiveTurns.delete(key);
            const turn = parsed?.result?.turn;
            // The public turn/start reply contains a turn.id/status, not a
            // thread id. Bind it to the original request via this socket and
            // JSON-RPC id; reject an optional contradictory thread id.
            if (!liveReceiptsDisabled && parsed.error === undefined
              && typeof turn?.id === "string" && turn.status === "inProgress"
              && (turn.threadId === undefined || turn.threadId === pendingLive.threadId)
              && !finishedLiveTurns.has(JSON.stringify([pendingLive.threadId, turn.id]))
              && (!startedLiveTurns.has(pendingLive.threadId)
                || startedLiveTurns.get(pendingLive.threadId) === turn.id)) {
              if (!liveTurnProof.accept(pendingLive.threadId, turn.id, state,
                pendingLive.generation)) {
                diagnostic("desktop_native_live_turn_rejected", { reason_class: "receipt_unavailable" });
              }
            } else if (parsed.error === undefined) {
              diagnostic("desktop_native_live_turn_rejected", { reason_class: "ambiguous_or_late_receipt" });
            }
          }
          const pending = pendingMedia.get(key);
          if (pending) {
            pendingMedia.delete(key);
            if (parsed.error === undefined && parsed.result?.turn?.id) {
              ingressMedia.accept(pending.media, parsed.result.turn.id,
                parsed.result.turn.threadId, pending.generation);
              diagnostic("desktop_native_media_owner_accepted", {
                reference_count: pending.media.assets.length,
                unavailable_count: pending.media.unavailable,
              });
            }
          }
        }
        if (parsed?.method === "turn/started"
          && nativeLiveIdentity(parsed.params?.threadId)
          && nativeLiveIdentity(parsed.params?.turn?.id)) {
          const threadId = parsed.params.threadId;
          const turnId = parsed.params.turn.id;
          if (!startedLiveTurns.has(threadId) && startedLiveTurns.size >= 128) {
            liveReceiptsDisabled = true;
            pendingLiveTurns.clear();
            liveTurnProof.retireOwner(state);
            diagnostic("desktop_native_live_turn_rejected", { reason_class: "notification_capacity" });
          } else {
            startedLiveTurns.set(threadId, turnId);
          }
          const existing = liveTurnProof.current(threadId);
          if (existing && existing.turnId !== turnId) liveTurnProof.retireThread(threadId);
        }
        if ((parsed?.method === "item/started" || parsed?.method === "item/completed")
          && nativeLiveIdentity(parsed.params?.threadId) && nativeLiveIdentity(parsed.params?.turnId)) {
          liveTurnProof.observeInput(parsed.params.threadId, parsed.params.turnId, state, parsed.params.item);
        }
        if (parsed?.method === "turn/completed"
          && nativeLiveIdentity(parsed.params?.threadId)
          && nativeLiveIdentity(parsed.params?.turn?.id)) {
          ingressMedia.retire(parsed.params.threadId, parsed.params.turn.id);
          const marker = JSON.stringify([parsed.params.threadId, parsed.params.turn.id]);
          if (finishedLiveTurns.size < 128) finishedLiveTurns.add(marker);
          else { liveReceiptsDisabled = true; pendingLiveTurns.clear(); }
          liveTurnProof.retire(parsed.params.threadId, parsed.params.turn.id);
        }
        if (parsed?.method === "thread/closed" && nativeLiveIdentity(parsed.params?.threadId)) {
          ingressMedia.retireThread(parsed.params.threadId);
          liveTurnProof.retireThread(parsed.params.threadId);
        }
        if (parsed?.method === "thread/status/changed"
          && nativeLiveIdentity(parsed.params?.threadId)
          && parsed.params?.status?.type !== undefined
          && parsed.params.status.type !== "active") {
          liveTurnProof.retireThread(parsed.params.threadId);
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          // Upstream transport still owns parsing unrelated JSON payloads.
        } else {
          transportFailure("server_to_client", "native_media_owner_unproven", 1008);
          closeBoth(1008, "Native media owner cannot be established");
          return;
        }
      }
      message = augmentModelListResponse(message, pendingModelLists, input.augmentModelList);
      let catalogKey: string | undefined;
      let catalogFields: Record<string, DiagnosticScalar> = {};
      let historyFields: Record<string, DiagnosticScalar> | undefined;
      // Only explicit history reads are inspected. No notification/body/identity logging.
      if (pendingHistory.size) {
        try {
          const value = JSON.parse(message), key = jsonRpcIdKey(value?.id);
          const history = key ? pendingHistory.get(key) : undefined;
          if (key && history) {
            pendingHistory.delete(key);
            historyFields = { operation_fingerprint: history.fingerprint, method_class: "history_read",
              duration_ms: Math.max(0, Math.round(performance.now() - history.began)),
              received_bytes: textBytes(message),
              count: Array.isArray(value.result?.thread?.turns) ? value.result.thread.turns.length : 0,
              parsed: value.result?.thread !== undefined,
              status: value.error !== undefined ? "rpc_error" : value.result?.thread ? "valid" : "invalid",
              delivery: "socket_write_only" };
            diagnostic("desktop_history_response", historyFields);
          }
        } catch { /* Diagnostics cannot change unrelated traffic. */ }
      }
      if (pendingCatalog.size) {
        try {
          const value = JSON.parse(message);
          const key = jsonRpcIdKey(value?.id);
          if (key && pendingCatalog.has(key)) {
            catalogKey = key;
            const began = pendingCatalog.get(key)!; pendingCatalog.delete(key);
            const rows = Array.isArray(value.result?.data) ? value.result.data : undefined;
            const web = rows?.filter((row: any) => typeof row?.model === "string" && row.model.startsWith("chatgpt-tela-web/")) ?? [];
            catalogFields = { duration_ms: Math.max(0, Math.round(performance.now() - began)),
              count: rows?.length ?? 0, web_model_count: web.length,
              hidden_web_model_count: web.filter((row: any) => row.hidden === true).length,
              native_model_count: rows ? rows.length - web.length : 0,
              status: value.error !== undefined ? "rpc_error" : rows ? "valid" : "invalid" };
            diagnostic("desktop_catalog_response", catalogFields);
          }
        } catch { /* Unrelated bytes remain unchanged. */ }
      }
      if (client.readyState === WebSocket.OPEN) {
        const bytes = textBytes(message);
        client.send(message, error => {
          if (error) transportFailure("server_to_client", "socket_write", 1011);
          else { clientWrittenCount++; clientWrittenBytes += bytes; }
          if (historyFields) diagnostic(error ? "desktop_history_delivery_failed" : "desktop_history_delivery_complete", historyFields);
          if (catalogKey) diagnostic(error ? "desktop_catalog_delivery_failed" : "desktop_catalog_delivery_complete", catalogFields);
        });
      } else {
        if (historyFields) diagnostic("desktop_history_delivery_failed", { ...historyFields, status: "client_closed" });
        if (catalogKey) diagnostic("desktop_catalog_delivery_failed", { ...catalogFields, status: "client_closed" });
      }
    });
    upstream.once("error", error => {
      observeError(error, "server_to_client");
      closeBoth(1011, "upstream app-server connection failed");
    });
    upstream.once("close", (code, reason) => {
      if (code !== 1000 && code !== 1001) transportFailure("server_to_client", "peer_closed", code);
      if (!state.closed) closeBoth(code || 1000, reason.toString("utf8") || "upstream closed");
    });

    client.on("message", (data, isBinary) => {
      const message = textMessage(data, isBinary);
      clientReceivedCount++;
      if (message !== undefined) clientReceivedBytes += textBytes(message);
      if (message === undefined) {
        transportFailure("client_to_server", isBinary ? "unsupported_binary" : "message_limit", isBinary ? 1003 : 1009);
        closeBoth(isBinary ? 1003 : 1009, isBinary ? "text JSON required" : "message too large");
        return;
      }
      let routed: string;
      try {
        let handshake: any;
        try { handshake = JSON.parse(message); } catch { /* Preserve unrelated upstream bytes. */ }
        remote.request(handshake);
        if (handshake?.method === "initialize") {
          permissionProfiles = handshake.params?.capabilities?.experimentalApi === true;
          clientKind = handshake.params?.clientInfo?.name === "chatgpt-tela" ? "tela_client" : "external_client";
          diagnostic("desktop_catalog_client_initialized");
        }
        if (handshake?.method === "thread/read") {
          const key = jsonRpcIdKey(handshake.id);
          if (key && pendingHistory.has(key)) {
            pendingHistory.delete(key);
            diagnostic("desktop_history_tracking_ambiguous", { method_class: "history_read" });
          } else if (key && pendingHistory.size < 128) {
            const fingerprint = randomBytes(12).toString("hex");
            pendingHistory.set(key, { began: performance.now(), fingerprint });
            diagnostic("desktop_history_request", { operation_fingerprint: fingerprint, method_class: "history_read",
              include_turns: handshake.params?.includeTurns === true, queued: upstream.readyState !== WebSocket.OPEN });
          } else diagnostic("desktop_history_tracking_saturated", { pending_count: pendingHistory.size });
        }
        if (handshake?.method === "turn/start") {
          const key = jsonRpcIdKey(handshake.id);
          const threadId = handshake.params?.threadId;
          if (nativeLiveIdentity(threadId)) {
            // Starting a new Native turn on this exact thread invalidates an
            // older live Web owner even before the new RPC is acknowledged.
            liveTurnProof.retireThread(threadId);
          }
          if (!liveReceiptsDisabled && key && nativeLiveIdentity(threadId)) {
            if (pendingLiveTurns.has(key)) {
              // An ambiguous RPC id must not authorize a later answer. Do
              // not modify normal Native traffic on this optional proof path.
              liveReceiptsDisabled = true;
              pendingLiveTurns.clear();
              liveTurnProof.retireOwner(state);
              diagnostic("desktop_native_live_turn_rejected", { reason_class: "ambiguous_request" });
            } else if (seenLiveRpcIds.has(key)) {
              // Preserve existing valid turns; only this new request loses
              // optional Legacy live proof. No old delayed ACK can bind it.
              diagnostic("desktop_native_live_turn_rejected", { reason_class: "reused_request_id" });
            } else if (pendingLiveTurns.size >= 64 || seenLiveRpcIds.size >= 512) {
              liveReceiptsDisabled = true;
              pendingLiveTurns.clear();
              liveTurnProof.retireOwner(state);
              diagnostic("desktop_native_live_turn_rejected", { reason_class: "request_capacity" });
            } else {
              seenLiveRpcIds.add(key);
              pendingLiveTurns.set(key, {
                threadId, generation: liveTurnProof.generation,
              });
            }
          }
          const media = prepareNativeIngressTurnMedia(handshake.params);
          if (media) {
            const key = jsonRpcIdKey(handshake.id);
            if (!key || pendingMedia.has(key) || pendingMedia.size >= 8) {
              throw new Error("Native image ingress cannot bind one exact request");
            }
            pendingMedia.set(key, { media, generation: ingressMedia.generation });
          }
        }
        routed = rewriteDefaultDesktopAppServerRequest(message, input.route, { permissionProfiles });
      }
      catch {
        transportFailure("client_to_server", "invalid_routed_request", 1008);
        closeBoth(1008, "invalid routed app-server request");
        return;
      }
      const modelListId = modelListRequestId(message);
      if (modelListId) {
        if (input.augmentModelList && pendingModelLists.size < 128) pendingModelLists.add(modelListId);
        if (pendingCatalog.size < 128) {
          pendingCatalog.set(modelListId, performance.now());
          const value = JSON.parse(message);
          diagnostic("desktop_catalog_request", { include_hidden: value.params?.includeHidden === true, queued: upstream.readyState !== WebSocket.OPEN });
        } else diagnostic("desktop_catalog_tracking_saturated", { pending_count: pendingCatalog.size });
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(routed);
        return;
      }
      const bytes = textBytes(routed);
      if (state.queuedBytes + bytes > MAX_QUEUED_BYTES) {
        transportFailure("client_to_server", "startup_queue_limit", 1009);
        closeBoth(1009, "startup queue exceeded limit");
        return;
      }
      state.queue.push(routed);
      state.queuedBytes += bytes;
    });
    client.once("error", error => {
      observeError(error, "client_to_server");
      closeBoth(1011, "Desktop app-server client failed");
    });
    client.once("close", code => {
      if (code !== 1000 && code !== 1001) transportFailure("client_to_server", "peer_closed", code);
      closeBoth(1000, "Desktop app-server client closed");
    });
  });

  let stopped = false;
  return Object.freeze({
    endpoint: `ws://127.0.0.1:${address.port}/`,
    upstreamEndpoint,
    get activeConnectionCount() { return connections.size; },
    ingressMedia,
    liveTurnProof,
    async close() {
      if (stopped) return;
      stopped = true;
      closing = true;
      ingressMedia.clear();
      liveTurnProof.clear();
      const closingConnections = [...connections];
      const ignoreShutdownError = () => {};
      for (const state of closingConnections) {
        state.closed = true;
        state.onClosed?.();
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
