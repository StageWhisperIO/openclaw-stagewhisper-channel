import http from "node:http";
import { Buffer } from "node:buffer";
import type { AddressInfo } from "node:net";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { validateHttpTaskRequest, MAX_BODY_BYTES, type HttpTaskRequest } from "./core.js";
import { ReplyStreams } from "./reply-streams.js";
import {
  createIngressGuards,
  withIngressAdmission,
  type IngressGuards,
} from "./ingress-guards.js";
import { readWebhookBodyOrReject } from "openclaw/plugin-sdk/webhook-ingress";
import { createReplyTaskRunner } from "./http-transport-reply-task.js";
import { createEventStreamHandler, EVENTS_PATH } from "./http-transport-event-stream.js";
import {
  guardRequest,
  jsonResponse,
  writeResponse,
  type NormalizedRequest,
  type NormalizedResponse,
} from "./http-transport-protocol.js";

const IDEMPOTENCY_MAX_SIZE = 1024;
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const INCOMING_PATH = "/v1/incoming";
const PING_PATH = "/v1/ping";

export type HttpTransportOptions = {
  api: OpenClawPluginApi;
  host?: string;
  port?: number;
  token: string;
  callbackFetch?: typeof fetch;
  replyStreams?: ReplyStreams;
  ingressGuards?: IngressGuards;
};

export type HttpTransport = {
  start(): Promise<void>;
  stop(): Promise<void>;
  address(): AddressInfo | null;
  handleSyntheticRequest(input: SyntheticRequest): Promise<SyntheticResponse>;
  whenChatTaskSettled(taskId: string): Promise<void> | undefined;
};

export type SyntheticRequest = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  remoteAddress?: string;
  body?: string | null;
};

export type SyntheticResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

type IdempotencyEntry = {
  status: number;
  body: string;
  expiresAt: number;
};

export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  const { api } = options;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8765;
  const token = options.token;
  const callbackFetch = options.callbackFetch ?? fetch;

  if (!token || token.length < 16) {
    throw new Error("http-transport: token must be at least 16 characters");
  }

  const idempotency = new Map<string, IdempotencyEntry>();
  const inflight = new Set<string>();
  const chatTasks = new Map<string, Promise<void>>();
  const pendingPreludes = new Map<string, string>();
  const replyStreams = options.replyStreams ?? new ReplyStreams();
  const ingressGuards = options.ingressGuards ?? createIngressGuards({ logger: api.logger });

  function rememberResult(taskId: string, status: number, body: string): void {
    idempotency.set(taskId, {
      status,
      body,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    });
    while (idempotency.size > IDEMPOTENCY_MAX_SIZE) {
      const oldestKey = idempotency.keys().next().value;
      if (oldestKey === undefined) break;
      idempotency.delete(oldestKey);
    }
  }

  function evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of idempotency) {
      if (entry.expiresAt <= now) idempotency.delete(key);
    }
  }

  function consumePrelude(sessionId: string): string | undefined {
    const prelude = pendingPreludes.get(sessionId);
    if (prelude !== undefined) pendingPreludes.delete(sessionId);
    return prelude;
  }

  const { runReplyTaskAsync } = createReplyTaskRunner({
    api,
    callbackFetch,
    replyStreams,
    consumePrelude,
    releaseInflight: (taskId) => inflight.delete(taskId),
  });

  const handleEventStream = createEventStreamHandler({ api, token, replyStreams });

  function trackChatTask(taskId: string, task: Promise<void>): void {
    chatTasks.set(taskId, task);
    void task.finally(() => {
      if (chatTasks.get(taskId) === task) {
        chatTasks.delete(taskId);
      }
    });
  }

  async function handleChatMessageRequest(
    taskReq: HttpTaskRequest,
  ): Promise<NormalizedResponse> {
    const ackBody = JSON.stringify({ status: "accepted", task_id: taskReq.task_id });
    const response: NormalizedResponse = {
      status: 202,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(ackBody)),
      },
      body: ackBody,
    };

    rememberResult(taskReq.task_id, response.status, response.body);
    trackChatTask(taskReq.task_id, runReplyTaskAsync(taskReq, "chat"));

    return response;
  }

  async function handleTranscriptChunkRequest(
    taskReq: HttpTaskRequest,
  ): Promise<NormalizedResponse> {
    if (taskReq.payload.is_final !== true) {
      const response = jsonResponse(202, {
        status: "accepted",
        task_id: taskReq.task_id,
        dispatched: false,
      });
      rememberResult(taskReq.task_id, response.status, response.body);
      inflight.delete(taskReq.task_id);
      return response;
    }

    const ackBody = JSON.stringify({ status: "accepted", task_id: taskReq.task_id });
    const response: NormalizedResponse = {
      status: 202,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(ackBody)),
      },
      body: ackBody,
    };

    rememberResult(taskReq.task_id, response.status, response.body);
    trackChatTask(taskReq.task_id, runReplyTaskAsync(taskReq, "reasoning"));

    return response;
  }

  function handleSystemPreludeRequest(
    taskReq: HttpTaskRequest,
  ): NormalizedResponse {
    pendingPreludes.set(taskReq.session_id, taskReq.payload.text);
    const response = jsonResponse(202, {
      status: "accepted",
      task_id: taskReq.task_id,
    });
    rememberResult(taskReq.task_id, response.status, response.body);
    inflight.delete(taskReq.task_id);
    return response;
  }

  async function dispatchRoute(req: NormalizedRequest): Promise<NormalizedResponse> {
    const denied = guardRequest(req, token, api.logger);
    if (denied) return denied;

    if (req.method === "GET" && req.url.split("?")[0] === EVENTS_PATH) {
      return jsonResponse(400, { error: "streaming_not_supported_here" });
    }

    if (req.method === "POST" && req.url === PING_PATH) {
      return jsonResponse(200, { ok: true });
    }

    if (req.method === "POST" && req.url === INCOMING_PATH) {
      let parsed: unknown;
      try {
        parsed = req.body.length === 0 ? {} : JSON.parse(req.body);
      } catch (err) {
        return jsonResponse(400, {
          error: `invalid_json: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const validation = validateHttpTaskRequest(parsed);
      if (!validation.ok) {
        return jsonResponse(400, { error: validation.error });
      }
      const taskReq = validation.req;

      evictExpired();
      const cached = idempotency.get(taskReq.task_id);
      if (cached && cached.expiresAt > Date.now()) {
        return {
          status: cached.status,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(cached.body)),
            "X-Idempotent-Replay": "true",
          },
          body: cached.body,
        };
      }
      if (inflight.has(taskReq.task_id)) {
        return jsonResponse(503, { error: "task_in_flight" });
      }

      inflight.add(taskReq.task_id);
      if (taskReq.reason === "chat_message") {
        return handleChatMessageRequest(taskReq);
      }
      if (taskReq.reason === "system_prelude") {
        return handleSystemPreludeRequest(taskReq);
      }
      return handleTranscriptChunkRequest(taskReq);
    }

    return jsonResponse(404, { error: "not_found" });
  }

  async function handleRealRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "";
    const url = req.url ?? "";
    const authHeader = req.headers["authorization"];
    const authorization = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const hostHeader = req.headers["host"];
    const hostValue = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    const remoteAddress = req.socket.remoteAddress;
    const ingressKey = remoteAddress ?? "unknown";

    if (method === "GET" && url.split("?")[0] === EVENTS_PATH) {
      await handleEventStream(req, res, {
        method,
        url,
        authorization,
        host: hostValue,
        remoteAddress,
        body: "",
      });
      return;
    }

    await withIngressAdmission(
      ingressGuards,
      ingressKey,
      res,
      (status, reason) => writeResponse(res, jsonResponse(status, { error: reason })),
      async () => {
        let body = "";
        if (method === "POST") {
          const read = await readWebhookBodyOrReject({
            req,
            res,
            maxBytes: MAX_BODY_BYTES,
            profile: "pre-auth",
          });
          if (!read.ok) return;
          body = read.value;
        }

        const result = await dispatchRoute({
          method,
          url,
          authorization,
          host: hostValue,
          remoteAddress,
          body,
        });
        writeResponse(res, result);
      },
    );
  }

  let server: http.Server | null = null;

  return {
    async start(): Promise<void> {
      if (server) return;
      const srv = http.createServer((req, res) => {
        handleRealRequest(req, res).catch((err) => {
          api.logger.error(`[stagewhisper-http] unhandled error: ${err}`);
          if (!res.headersSent) {
            try {
              writeResponse(res, jsonResponse(500, { error: "internal_error" }));
            } catch {}
          }
        });
      });
      server = srv;
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          srv.off("listening", onListening);
          reject(err);
        };
        const onListening = (): void => {
          srv.off("error", onError);
          resolve();
        };
        srv.once("error", onError);
        srv.once("listening", onListening);
        srv.listen(port, host);
      });
      const addr = srv.address();
      api.logger.info(
        `[stagewhisper-http] listening on http://${host}:${
          typeof addr === "object" && addr ? addr.port : port
        }`,
      );
    },

    async stop(): Promise<void> {
      const srv = server;
      if (!srv) return;
      server = null;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections?.();
      });
      const pending = Array.from(chatTasks.values());
      if (pending.length > 0) {
        await Promise.allSettled(pending);
      }
      idempotency.clear();
      inflight.clear();
      chatTasks.clear();
      pendingPreludes.clear();
      ingressGuards.reset();
      api.logger.info("[stagewhisper-http] stopped");
    },

    address(): AddressInfo | null {
      const addr = server?.address();
      if (typeof addr === "object" && addr !== null) return addr;
      return null;
    },

    async handleSyntheticRequest(input: SyntheticRequest): Promise<SyntheticResponse> {
      const headers = input.headers ?? {};
      const authorization =
        headers["Authorization"] ?? headers["authorization"] ?? undefined;
      const hostValue = headers["Host"] ?? headers["host"] ?? "127.0.0.1";
      const remoteAddress = input.remoteAddress ?? "127.0.0.1";
      const body = input.body ?? "";
      return dispatchRoute({
        method: input.method,
        url: input.url,
        authorization,
        host: hostValue,
        remoteAddress,
        body,
      });
    },

    whenChatTaskSettled(taskId: string): Promise<void> | undefined {
      return chatTasks.get(taskId);
    },
  };
}
