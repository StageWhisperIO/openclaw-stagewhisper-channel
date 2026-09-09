import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createHttpTransport, type HttpTransport } from "./http-transport.js";
import { ReplyStreams } from "./reply-streams.js";

const VALID_TOKEN = "test-token-32-chars-min-length__";
const SESSION_ID = "session-stream";
const TASK_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeApi(replyText: string, taskId: string): OpenClawPluginApi {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      subagent: {
        run: vi.fn().mockResolvedValue({ runId: "run-abc" }),
        waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
        getSessionMessages: vi.fn().mockResolvedValue({
          messages: [
            { role: "user", content: `hi\n\nStageWhisper task: ${taskId}` },
            { role: "assistant", content: replyText },
          ],
        }),
      },
    },
    pluginConfig: {},
    config: {},
  } as unknown as OpenClawPluginApi;
}

let transport: HttpTransport | null = null;

afterEach(async () => {
  await transport?.stop();
  transport = null;
});

async function startTransport(
  api: OpenClawPluginApi,
  replyStreams?: ReplyStreams,
): Promise<string> {
  const t = createHttpTransport({
    api,
    host: "127.0.0.1",
    port: 0,
    token: VALID_TOKEN,
    ...(replyStreams ? { replyStreams } : {}),
  });
  await t.start();
  transport = t;
  const address = t.address();
  if (!address) throw new Error("transport has no address");
  return `http://127.0.0.1:${address.port}`;
}

async function readFirstFrame(
  body: ReadableStream<Uint8Array>,
  timeoutMs = 5000,
  accept: (frame: string) => boolean = () => true,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (buffer.includes("\n\n")) {
        const boundary = buffer.indexOf("\n\n");
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.trim() && !frame.trimStart().startsWith(":") && accept(frame)) return frame;
      }
    }
  } finally {
    void reader.cancel();
  }
  throw new Error(`no frame received; buffer was ${JSON.stringify(buffer)}`);
}

describe("event stream endpoint", () => {
  it("refuses a stream request without a bearer", async () => {
    const base = await startTransport(makeApi("hi", TASK_ID));
    const res = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`);
    expect(res.status).toBe(401);
    await res.text();
  });

  it("refuses a stream request with the wrong bearer", async () => {
    const base = await startTransport(makeApi("hi", TASK_ID));
    const res = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: "Bearer not-the-token-at-all-nope__" },
    });
    expect(res.status).toBe(401);
    await res.text();
  });

  it("refuses a stream request with a disallowed host", async () => {
    const base = await startTransport(makeApi("hi", TASK_ID));
    const target = new URL(`${base}/v1/events?session_id=${SESSION_ID}`);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.get({
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          Host: "attacker.example",
        },
      });
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
    });
    expect(status).toBe(403);
  });

  it("refuses a stream request without a session", async () => {
    const base = await startTransport(makeApi("hi", TASK_ID));
    const res = await fetch(`${base}/v1/events`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(400);
    await res.text();
  });

  it("announces the stream before any reply arrives", async () => {
    const base = await startTransport(makeApi("hi", TASK_ID));

    const stream = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(stream.status).toBe(200);

    const reader = stream.body!.getReader();
    const { value } = await reader.read();
    void reader.cancel();

    expect(new TextDecoder().decode(value).startsWith(":")).toBe(true);
  });

  it("delivers a reply to a client that supplied no callback", async () => {
    const api = makeApi("delivered over the open stream", TASK_ID);
    const base = await startTransport(api);

    const stream = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    const accepted = await fetch(`${base}/v1/incoming`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        reason: "chat_message",
        occurred_at: "2026-01-01T00:00:00Z",
        payload: { text: "are you there", user_message_id: "umid-1" },
      }),
    });
    expect(accepted.status).toBe(202);

    const frame = await readFirstFrame(stream.body!, 5000, (candidate) =>
      candidate.includes('"status":"message"'),
    );
    expect(frame).toContain("delivered over the open stream");
    expect(frame).toContain("data: ");
  });

  it("turns an oversized stream reply into a bounded error", async () => {
    const api = makeApi("x".repeat(1024), TASK_ID);
    const replyStreams = new ReplyStreams({
      backlogBytesPerSession: 256,
      maxEventBytes: 256,
    });
    const base = await startTransport(api, replyStreams);
    const stream = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    await fetch(`${base}/v1/incoming`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        reason: "chat_message",
        occurred_at: "2026-01-01T00:00:00Z",
        payload: { text: "give me a long answer", user_message_id: "umid-large" },
      }),
    });

    const frame = await readFirstFrame(stream.body!, 5000, (candidate) =>
      candidate.includes("reply_too_large"),
    );
    expect(frame).toContain('"status":"errored"');
  });

  it("delivers a no-callback transcript reply to an open stream", async () => {
    const api = makeApi("reasoning over the stream", TASK_ID);
    const base = await startTransport(api);

    const stream = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(stream.status).toBe(200);

    const accepted = await fetch(`${base}/v1/incoming`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        reason: "transcript_chunk",
        occurred_at: "2026-01-01T00:00:00Z",
        payload: { text: "they pushed back on price", is_final: true },
      }),
    });
    expect(accepted.status).toBe(202);

    const frame = await readFirstFrame(stream.body!, 5000, (candidate) =>
      candidate.includes('"status":"message"'),
    );
    expect(frame).toContain("reasoning over the stream");
  });

  it("retains a no-callback transcript reply until a disconnected client returns", async () => {
    const api = makeApi("reasoning retained while disconnected", TASK_ID);
    const base = await startTransport(api);

    const accepted = await fetch(`${base}/v1/incoming`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        reason: "transcript_chunk",
        occurred_at: "2026-01-01T00:00:00Z",
        payload: { text: "they pushed back on price", is_final: true },
      }),
    });
    expect(accepted.status).toBe(202);
    await transport!.whenChatTaskSettled(TASK_ID);

    const stream = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    const frame = await readFirstFrame(stream.body!, 5000, (candidate) =>
      candidate.includes('"status":"message"'),
    );

    expect(frame).toContain("reasoning retained while disconnected");
  });

  it("keeps a callback-selected request off the stream even when a listener is open and the request is retried", async () => {
    const callbackCalls: string[] = [];
    const callbackFetch = (async (url: string | URL) => {
      callbackCalls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const api = makeApi("only once please", TASK_ID);
    const replyStreams = new ReplyStreams();
    const t = createHttpTransport({
      api,
      host: "127.0.0.1",
      port: 0,
      token: VALID_TOKEN,
      callbackFetch,
      replyStreams,
    });
    await t.start();
    transport = t;
    const base = `http://127.0.0.1:${t.address()!.port}`;

    const stream = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(stream.status).toBe(200);

    const send = (): Promise<Response> =>
      fetch(`${base}/v1/incoming`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          task_id: TASK_ID,
          session_id: SESSION_ID,
          reason: "chat_message",
          occurred_at: "2026-01-01T00:00:00Z",
          payload: { text: "hello", user_message_id: "umid-retry" },
          callback: { url: "http://127.0.0.1:65535", token: "callback-token-32-chars-aaaaaaaa" },
        }),
      });

    await send();
    await t.whenChatTaskSettled(TASK_ID);

    expect(callbackCalls.length).toBeGreaterThan(0);
    expect(replyStreams.retained(SESSION_ID)).toEqual([]);
    const firstAttemptCallCount = callbackCalls.length;

    await send();
    await t.whenChatTaskSettled(TASK_ID);

    expect(callbackCalls).toHaveLength(firstAttemptCallCount);
    expect(replyStreams.retained(SESSION_ID)).toEqual([]);
    await stream.body?.cancel();
  });

  it("replays a reply that arrived while nobody was listening", async () => {
    const replyStreams = new ReplyStreams();
    const base = await startTransport(makeApi("hi", TASK_ID), replyStreams);

    replyStreams.captureDurable(SESSION_ID, {
      task_id: TASK_ID,
      text: "missed while away",
    });

    const stream = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    const frame = await readFirstFrame(stream.body!);
    expect(frame).toContain("missed while away");
  });

  it("never shows one session the replies of another", async () => {
    const replyStreams = new ReplyStreams();
    const base = await startTransport(makeApi("hi", TASK_ID), replyStreams);

    const stream = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    replyStreams.captureDurable("other-session", { task_id: TASK_ID, text: "not for you" });
    replyStreams.captureDurable(SESSION_ID, { task_id: TASK_ID, text: "for you" });

    const frame = await readFirstFrame(stream.body!);
    expect(frame).toContain("for you");
    expect(frame).not.toContain("not for you");
  });

  it("refuses a stream once the subscriber budget is spent", async () => {
    const replyStreams = new ReplyStreams({ maxSubscribersTotal: 1 });
    const base = await startTransport(makeApi("hi", TASK_ID), replyStreams);

    const first = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${base}/v1/events?session_id=other`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(second.status).toBe(429);
    await second.text();
  });

  it("frees the subscriber slot when a client disconnects", async () => {
    const replyStreams = new ReplyStreams();
    const base = await startTransport(makeApi("hi", TASK_ID), replyStreams);

    const controller = new AbortController();
    await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(replyStreams.hasListener(SESSION_ID)).toBe(true));
    controller.abort();
    await vi.waitFor(() => expect(replyStreams.hasListener(SESSION_ID)).toBe(false));
  });
});
