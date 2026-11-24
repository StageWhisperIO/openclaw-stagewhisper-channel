import type http from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { type Drained, notifySubscriber, type ReplyStreams } from "./reply-streams.js";
import { guardRequest, jsonResponse, writeResponse, type NormalizedRequest } from "./http-transport-protocol.js";

export const EVENTS_PATH = "/v1/events";
const STREAM_HEARTBEAT_MS = 20_000;
const STREAM_STALL_LIMIT_MS = 30_000;

function formatDrainedEvents(drained: Drained): string[] {
  const chunks = drained.entries.map(
    (entry) => `id: ${entry.id}\ndata: ${entry.serializedPayload}\n\n`,
  );
  for (const payload of drained.transientPayloads) {
    chunks.push(`event: progress\ndata: ${payload}\n\n`);
  }
  return chunks;
}

export type EventStreamDeps = {
  api: OpenClawPluginApi;
  token: string;
  replyStreams: ReplyStreams;
};

export function createEventStreamHandler(deps: EventStreamDeps) {
  const { api, token, replyStreams } = deps;

  return async function handleEventStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    normalized: NormalizedRequest,
  ): Promise<void> {
    const denied = guardRequest(normalized, token, api.logger);
    if (denied) {
      writeResponse(res, denied);
      return;
    }

    const query = new URL(normalized.url, "http://127.0.0.1").searchParams;
    const sessionId = (query.get("session_id") ?? "").trim();
    if (!sessionId) {
      writeResponse(res, jsonResponse(400, { error: "session_id_required" }));
      return;
    }

    const headerCursor = req.headers["last-event-id"];
    const lastEventId = (
      (typeof headerCursor === "string" ? headerCursor : headerCursor?.[0]) ??
      query.get("last_event_id") ??
      ""
    ).trim();

    const subscriber = replyStreams.subscribe(sessionId, lastEventId || null);
    if (!subscriber) {
      writeResponse(res, jsonResponse(429, { error: "too_many_streams" }));
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    await new Promise<void>((resolve) => {
      let settled = false;
      let draining: Promise<void> | null = null;
      const pendingChunks = [": open\n\n"];

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        replyStreams.unsubscribe(subscriber);
        subscriber.notify = null;
        res.end();
        resolve();
      };

      const awaitDrain = (): Promise<void> =>
        new Promise<void>((drained) => {
          const stall = setTimeout(() => {
            api.logger.warn(`[stagewhisper-http] stream for ${sessionId} stalled; disconnecting`);
            finish();
            drained();
          }, STREAM_STALL_LIMIT_MS);
          res.once("drain", () => {
            clearTimeout(stall);
            drained();
          });
        });

      const flush = (): void => {
        if (settled || draining) return;
        while (!settled && !draining) {
          if (pendingChunks.length === 0) {
            const drained = replyStreams.drain(subscriber);
            pendingChunks.push(...formatDrainedEvents(drained));
            if (pendingChunks.length === 0) return;
          }
          const chunk = pendingChunks.shift();
          if (chunk === undefined || res.write(chunk)) continue;
          draining = awaitDrain().finally(() => {
            draining = null;
            if (!settled) flush();
          });
        }
      };

      const heartbeat = setInterval(() => {
        if (settled) return;
        pendingChunks.push(": keep-alive\n\n");
        flush();
      }, STREAM_HEARTBEAT_MS);

      subscriber.notify = () => notifySubscriber(subscriber, flush, finish);
      req.on("close", finish);
      req.on("error", finish);
      res.on("error", finish);
      flush();
    });
  };
}
