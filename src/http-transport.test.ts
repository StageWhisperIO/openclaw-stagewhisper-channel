import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createHttpTransport, type HttpTransport } from "./http-transport.js";
import { isLoopbackCallbackUrl } from "./core.js";
import { ReplyStreams } from "./reply-streams.js";

const VALID_TOKEN = "test-token-32-chars-min-length__";
const CALLBACK_TOKEN = "callback-token-32-chars-aaaaaaaa";
const CALLBACK_BASE_URL = "http://127.0.0.1:65535";
const TASK_ID_A = "11111111-1111-1111-1111-111111111111";
const TASK_ID_B = "22222222-2222-2222-2222-222222222222";
const TASK_ID_C = "33333333-3333-3333-3333-333333333333";
const TASK_ID_D = "44444444-4444-4444-4444-444444444444";
const TASK_ID_E = "55555555-5555-5555-5555-555555555555";
const TASK_ID_F = "66666666-6666-6666-6666-666666666666";
const TASK_ID_G = "77777777-7777-7777-7777-777777777777";
const TASK_ID_H = "88888888-8888-8888-8888-888888888888";
const TASK_ID_I = "99999999-9999-9999-9999-999999999999";
const TASK_ID_J = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TASK_ID_K = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TASK_ID_L = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TASK_ID_M = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const TASK_ID_N = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const TASK_ID_O = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const TASK_ID_P = "12345678-1234-1234-1234-123456789012";
const TASK_ID_TYPING = "abcdef01-2345-6789-abcd-ef0123456789";
const TASK_ID_MULTI = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";

const SESSION_ID_A = "session-a";
const SESSION_ID_B = "session-b";

type MockSubagent = {
  run: ReturnType<typeof vi.fn>;
  waitForRun: ReturnType<typeof vi.fn>;
  getSessionMessages: ReturnType<typeof vi.fn>;
};

type MockApi = OpenClawPluginApi & {
  __subagent: MockSubagent;
  __logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
};

function makeApi(): MockApi {
  const subagent: MockSubagent = {
    run: vi.fn().mockResolvedValue({ runId: "run-abc" }),
    waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    logger,
    runtime: { subagent },
    pluginConfig: {},
    config: {},
    __subagent: subagent,
    __logger: logger,
  } as unknown as MockApi;
}

function parseBody(body: string): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

type FetchCall = {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
  redirect: RequestRedirect | undefined;
};

function makeRecordingFetch(
  responder?: (call: FetchCall) => { status?: number } | void,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorization = headers["Authorization"] ?? headers["authorization"] ?? null;
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    const call: FetchCall = { url, authorization, body, redirect: init?.redirect };
    calls.push(call);
    const reply = responder?.(call) ?? {};
    const status = reply.status ?? 200;
    return new Response(JSON.stringify({ ok: status < 400 }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

function makeTransport(
  api: MockApi = makeApi(),
  opts?: { callbackFetch?: typeof fetch },
): { transport: HttpTransport; api: MockApi } {
  const transport = createHttpTransport({
    api,
    host: "127.0.0.1",
    port: 0,
    token: VALID_TOKEN,
    callbackFetch: opts?.callbackFetch,
  });
  return { transport, api };
}

function chatMessageBody(opts: {
  taskId: string;
  sessionId: string;
  text?: string;
  userMessageId?: string;
  callbackUrl?: string;
  callbackToken?: string;
}): string {
  return JSON.stringify({
    task_id: opts.taskId,
    session_id: opts.sessionId,
    reason: "chat_message",
    occurred_at: "2026-05-23T14:32:11.123Z",
    payload: {
      text: opts.text ?? "hi there",
      user_message_id: opts.userMessageId ?? `umsg-${opts.taskId}`,
    },
    ...(opts.callbackUrl
      ? {
          callback: {
            url: opts.callbackUrl,
            token: opts.callbackToken ?? CALLBACK_TOKEN,
          },
        }
      : {}),
  });
}

function transcriptChunkBody(opts: {
  taskId: string;
  sessionId: string;
  text?: string;
  isFinal?: boolean;
  callbackUrl?: string;
  callbackToken?: string;
}): string {
  return JSON.stringify({
    task_id: opts.taskId,
    session_id: opts.sessionId,
    reason: "transcript_chunk",
    payload: {
      text: opts.text ?? "Hello agent",
      is_final: opts.isFinal ?? true,
    },
    ...(opts.callbackUrl
      ? {
          callback: {
            url: opts.callbackUrl,
            token: opts.callbackToken ?? CALLBACK_TOKEN,
          },
        }
      : {}),
  });
}

function systemPreludeBody(opts: {
  taskId: string;
  sessionId: string;
  text: string;
}): string {
  return JSON.stringify({
    task_id: opts.taskId,
    session_id: opts.sessionId,
    reason: "system_prelude",
    payload: { text: opts.text },
  });
}

describe("createHttpTransport", () => {
  let api: MockApi;
  let transport: HttpTransport;

  beforeEach(() => {
    ({ transport, api } = makeTransport());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("ping", () => {
    it("returns 200 on valid bearer token", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/ping",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(res.status).toBe(200);
      expect(parseBody(res.body)).toEqual({ ok: true });
    });

    it("returns 401 with bad bearer token", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/ping",
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 with no Authorization header", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/ping",
      });
      expect(res.status).toBe(401);
    });

    it("rejects token of correct value but wrong length without leaking via timing", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/ping",
        headers: { Authorization: `Bearer ${VALID_TOKEN.slice(0, 5)}` },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("final transcript requests", () => {
    it("accepts a final transcript immediately and completes its reply asynchronously", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: JSON.stringify({
          task_id: TASK_ID_A,
          session_id: SESSION_ID_A,
          reason: "transcript_chunk",
          occurred_at: "2026-05-23T14:32:11.123Z",
          payload: {
            text: "Hello agent",
            ts_start_ms: 12345,
            ts_end_ms: 12678,
            is_final: true,
          },
        }),
      });

      expect(res.status).toBe(202);
      expect(parseBody(res.body)).toMatchObject({
        status: "accepted",
        task_id: TASK_ID_A,
      });
      await transport.whenChatTaskSettled(TASK_ID_A);
      expect(api.__subagent.run).toHaveBeenCalledTimes(1);
      const call = api.__subagent.run.mock.calls[0][0];
      expect(call.idempotencyKey).toBe(`sw-http-task-${TASK_ID_A}`);
      expect(call.message).toContain("Hello agent");
      expect(call.message).toContain(`StageWhisper task: ${TASK_ID_A}`);
      expect(call.sessionKey).toContain(`sw:${SESSION_ID_A}:reasoning`);
    });

    it("does not POST a callback for transcript_chunk", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const { transport: t } = makeTransport(makeApi(), { callbackFetch: fetchImpl });

      const res = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: transcriptChunkBody({
          taskId: TASK_ID_B,
          sessionId: SESSION_ID_A,
          text: "transcript bit",
          isFinal: true,
        }),
      });
      expect(res.status).toBe(202);
      await t.whenChatTaskSettled(TASK_ID_B);
      expect(calls).toHaveLength(0);
    });

    it("returns 202 and does NOT dispatch when is_final=false (partials dropped)", async () => {
      const localApi = makeApi();
      const { transport: t } = makeTransport(localApi);
      const res = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: transcriptChunkBody({
          taskId: TASK_ID_C,
          sessionId: SESSION_ID_A,
          text: "partial chunk",
          isFinal: false,
        }),
      });
      expect(res.status).toBe(202);
      expect(parseBody(res.body)).toMatchObject({
        status: "accepted",
        task_id: TASK_ID_C,
        dispatched: false,
      });
      expect(localApi.__subagent.run).not.toHaveBeenCalled();
    });

    it("returns 202 and does NOT dispatch when is_final is missing", async () => {
      const localApi = makeApi();
      const { transport: t } = makeTransport(localApi);
      const res = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: JSON.stringify({
          task_id: TASK_ID_D,
          session_id: SESSION_ID_A,
          reason: "transcript_chunk",
          payload: { text: "missing flag" },
        }),
      });
      expect(res.status).toBe(202);
      expect(localApi.__subagent.run).not.toHaveBeenCalled();
    });

    it("rejects bad bearer token without invoking the agent", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: "Bearer wrong-token" },
        body: transcriptChunkBody({
          taskId: TASK_ID_E,
          sessionId: SESSION_ID_A,
        }),
      });
      expect(res.status).toBe(401);
      expect(api.__subagent.run).not.toHaveBeenCalled();
    });

    it("returns 400 on schema mismatch (missing text)", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: JSON.stringify({
          task_id: TASK_ID_F,
          session_id: SESSION_ID_A,
          reason: "transcript_chunk",
          payload: {},
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when task_id does not match UUID regex", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: JSON.stringify({
          task_id: "not-a-uuid",
          session_id: SESSION_ID_A,
          reason: "transcript_chunk",
          payload: { text: "hi", is_final: true },
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 on invalid JSON body", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: "this is not json",
      });
      expect(res.status).toBe(400);
    });

    it("is idempotent on duplicate task_id (cached body, no second dispatch)", async () => {
      const first = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: transcriptChunkBody({
          taskId: TASK_ID_G,
          sessionId: SESSION_ID_A,
          text: "once",
          isFinal: true,
        }),
      });
      expect(first.status).toBe(202);

      const second = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: transcriptChunkBody({
          taskId: TASK_ID_G,
          sessionId: SESSION_ID_A,
          text: "twice",
          isFinal: true,
        }),
      });

      expect(second.status).toBe(202);
      expect(parseBody(second.body)).toMatchObject({
        status: "accepted",
        task_id: TASK_ID_G,
      });
      expect(second.headers["X-Idempotent-Replay"]).toBe("true");
      expect(api.__subagent.run).toHaveBeenCalledTimes(1);
    });

    it("returns 403 on non-loopback remote address", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/ping",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        remoteAddress: "10.0.0.5",
      });
      expect(res.status).toBe(403);
    });

    it("returns 403 on disallowed Host header", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/ping",
        headers: { Authorization: `Bearer ${VALID_TOKEN}`, Host: "evil.example.com" },
      });
      expect(res.status).toBe(403);
    });

    it("accepts Host header 'localhost:1234'", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/ping",
        headers: { Authorization: `Bearer ${VALID_TOKEN}`, Host: "localhost:1234" },
      });
      expect(res.status).toBe(200);
    });

    it("returns 404 on unknown route", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/unknown",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(res.status).toBe(404);
    });

    it("captures an errored reply if final transcript dispatch fails after acceptance", async () => {
      const failingApi = makeApi();
      failingApi.__subagent.run.mockRejectedValue(new Error("agent down"));
      const replyStreams = new ReplyStreams();
      const t = createHttpTransport({
        api: failingApi,
        host: "127.0.0.1",
        port: 0,
        token: VALID_TOKEN,
        replyStreams,
      });
      const res = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: transcriptChunkBody({
          taskId: TASK_ID_H,
          sessionId: SESSION_ID_A,
          text: "boom",
          isFinal: true,
        }),
      });
      expect(res.status).toBe(202);
      await t.whenChatTaskSettled(TASK_ID_H);
      expect(replyStreams.retained(SESSION_ID_A)[0]?.payload).toMatchObject({
        task_id: TASK_ID_H,
        status: "errored",
        error_code: "execution_error",
      });
    });
  });

  describe("transcript_chunk (async + callback)", () => {
    it("streams the reasoning reply back to the callback as an append-only message", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      const taskId = "10000000-aaaa-bbbb-cccc-000000000001";
      localApi.__subagent.getSessionMessages.mockResolvedValue({
        messages: [
          { role: "user", content: `Hello agent\n\nStageWhisper task: ${taskId}` },
          { role: "assistant", content: "Watch the pricing objection." },
        ],
      });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      const res = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: transcriptChunkBody({
          taskId,
          sessionId: SESSION_ID_A,
          text: "Hello agent",
          isFinal: true,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });

      expect(res.status).toBe(202);
      expect(parseBody(res.body)).toEqual({ status: "accepted", task_id: taskId });

      await t.whenChatTaskSettled(taskId);

      const runCall = localApi.__subagent.run.mock.calls[0][0];
      expect(runCall.sessionKey).toContain(`sw:${SESSION_ID_A}:reasoning`);
      expect(localApi.__subagent.waitForRun).toHaveBeenCalledTimes(1);
      const messageCalls = calls.filter((c) => c.body.status === "message");
      expect(messageCalls).toHaveLength(1);
      expect(messageCalls[0].url).toBe(`${CALLBACK_BASE_URL}/tasks/${taskId}`);
      expect(messageCalls[0].body).toMatchObject({
        task_id: taskId,
        session_id: SESSION_ID_A,
        status: "message",
        reply_text: "Watch the pricing objection.",
      });
      expect(typeof messageCalls[0].body.message_id).toBe("string");
    });

    it("does not post a terminal callback when the reasoning run produces no reply", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      const taskId = "10000000-aaaa-bbbb-cccc-000000000002";
      localApi.__subagent.getSessionMessages.mockResolvedValue({ messages: [] });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: transcriptChunkBody({
          taskId,
          sessionId: SESSION_ID_A,
          text: "nothing actionable",
          isFinal: true,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });

      await t.whenChatTaskSettled(taskId);

      expect(calls.filter((c) => c.body.status === "message")).toHaveLength(0);
      expect(calls.filter((c) => c.body.status === "errored")).toHaveLength(0);
    });

    it("POSTs an errored callback when the reasoning run fails", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      const taskId = "10000000-aaaa-bbbb-cccc-000000000003";
      localApi.__subagent.waitForRun.mockResolvedValue({
        status: "error",
        error: "agent exploded",
      });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: transcriptChunkBody({
          taskId,
          sessionId: SESSION_ID_A,
          text: "boom",
          isFinal: true,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });

      await t.whenChatTaskSettled(taskId);

      const errored = calls.filter((c) => c.body.status === "errored");
      expect(errored).toHaveLength(1);
      expect(errored[0].body).toMatchObject({
        task_id: taskId,
        status: "errored",
        error_code: "agent_error",
      });
    });

    it("posts a terminal agent_timeout callback when the run times out", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      const taskId = "10000000-aaaa-bbbb-cccc-00000000000a";
      localApi.__subagent.waitForRun.mockResolvedValue({ status: "timeout" });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: transcriptChunkBody({
          taskId,
          sessionId: SESSION_ID_A,
          text: "long running",
          isFinal: true,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });

      await t.whenChatTaskSettled(taskId);

      const errored = calls.filter((c) => c.body.status === "errored");
      expect(errored).toHaveLength(1);
      expect(errored[0].body).toMatchObject({
        task_id: taskId,
        status: "errored",
        error_code: "agent_timeout",
      });

      const waitArgs = localApi.__subagent.waitForRun.mock.calls[0][0];
      expect(typeof waitArgs.timeoutMs).toBe("number");
      expect(Number.isFinite(waitArgs.timeoutMs)).toBe(true);
      expect(waitArgs.timeoutMs).toBeGreaterThan(0);
    });

    it("runs a final transcript through reply capture when no callback is provided", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      const taskId = "10000000-aaaa-bbbb-cccc-000000000004";
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      const res = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: transcriptChunkBody({
          taskId,
          sessionId: SESSION_ID_A,
          text: "one-way",
          isFinal: true,
        }),
      });

      expect(res.status).toBe(202);
      expect(parseBody(res.body)).toMatchObject({
        status: "accepted",
        task_id: taskId,
      });
      await t.whenChatTaskSettled(taskId);
      expect(calls).toHaveLength(0);
      expect(localApi.__subagent.run).toHaveBeenCalledTimes(1);
    });
  });

  describe("chat_message (async + callback)", () => {
    it("returns 202 immediately and POSTs callback to {url}/tasks/{task_id} after run", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      localApi.__subagent.getSessionMessages.mockResolvedValue({
        messages: [
          {
            role: "user",
            content: `hi there\n\n[StageWhisper chat: umsg-001]`,
          },
          { role: "assistant", content: "Hello, friend." },
        ],
      });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      const res = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId: TASK_ID_I,
          sessionId: SESSION_ID_A,
          userMessageId: "umsg-001",
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });

      expect(res.status).toBe(202);
      expect(parseBody(res.body)).toEqual({ status: "accepted", task_id: TASK_ID_I });
      expect(res.body).not.toContain("reply_text");

      await t.whenChatTaskSettled(TASK_ID_I);

      expect(localApi.__subagent.run).toHaveBeenCalledTimes(1);
      const runCall = localApi.__subagent.run.mock.calls[0][0];
      expect(runCall.sessionKey).toContain(`sw:${SESSION_ID_A}:chat`);

      expect(localApi.__subagent.waitForRun).toHaveBeenCalledTimes(1);
      const messageCalls = calls.filter((c) => c.body.status === "message");
      expect(messageCalls).toHaveLength(1);
      expect(messageCalls[0].url).toBe(`${CALLBACK_BASE_URL}/tasks/${TASK_ID_I}`);
      expect(messageCalls[0].body).toMatchObject({
        task_id: TASK_ID_I,
        session_id: SESSION_ID_A,
        user_message_id: "umsg-001",
        status: "message",
        reply_text: "Hello, friend.",
      });
    });

    it("emits a typing indicator while the run is in flight", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      localApi.__subagent.getSessionMessages.mockResolvedValue({
        messages: [
          { role: "user", content: `hi\n\n[StageWhisper chat: umsg-typing]` },
          { role: "assistant", content: "working on it" },
        ],
      });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId: TASK_ID_TYPING,
          sessionId: SESSION_ID_A,
          userMessageId: "umsg-typing",
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });

      await t.whenChatTaskSettled(TASK_ID_TYPING);

      const typing = calls.filter((c) => c.body.status === "typing");
      expect(typing).toHaveLength(1);
      expect(typing[0].body).toMatchObject({
        task_id: TASK_ID_TYPING,
        session_id: SESSION_ID_A,
        status: "typing",
      });
    });

    it("streams multiple assistant messages as separate append-only messages", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      localApi.__subagent.getSessionMessages.mockResolvedValue({
        messages: [
          { role: "user", content: `go\n\n[StageWhisper chat: umsg-multi]` },
          { role: "assistant", content: "Step one done." },
          { role: "assistant", content: "Step two done." },
        ],
      });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId: TASK_ID_MULTI,
          sessionId: SESSION_ID_A,
          userMessageId: "umsg-multi",
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });

      await t.whenChatTaskSettled(TASK_ID_MULTI);

      const messageCalls = calls.filter((c) => c.body.status === "message");
      expect(messageCalls).toHaveLength(2);
      expect(messageCalls.map((c) => c.body.reply_text)).toEqual([
        "Step one done.",
        "Step two done.",
      ]);
      const ids = new Set(messageCalls.map((c) => c.body.message_id));
      expect(ids.size).toBe(2);
    });

    it("forwards each finalized assistant message exactly once when a transcript-update event drives the flush", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      const taskId = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
      localApi.__subagent.getSessionMessages.mockResolvedValue({
        messages: [
          { role: "user", content: `go\n\n[StageWhisper chat: umsg-evt]` },
          { role: "assistant", content: "first finalized reply" },
          { role: "assistant", content: "second finalized reply" },
        ],
      });

      let emitTranscript:
        | ((u: { sessionKey?: string; message?: unknown }) => void)
        | null = null;
      (localApi.runtime as unknown as { events: unknown }).events = {
        onSessionTranscriptUpdate: (
          listener: (u: { sessionKey?: string; message?: unknown }) => void,
        ) => {
          emitTranscript = listener;
          return () => {
            emitTranscript = null;
          };
        },
      };
      localApi.__subagent.waitForRun.mockImplementation(async () => {
        emitTranscript?.({ message: { role: "assistant" } });
        return { status: "ok" };
      });

      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId,
          sessionId: SESSION_ID_A,
          userMessageId: "umsg-evt",
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });

      await t.whenChatTaskSettled(taskId);

      const messageCalls = calls.filter((c) => c.body.status === "message");
      expect(messageCalls.map((c) => c.body.reply_text)).toEqual([
        "first finalized reply",
        "second finalized reply",
      ]);
      const ids = new Set(messageCalls.map((c) => c.body.message_id));
      expect(ids.size).toBe(2);
    });

    it("does not invent a terminal error when a chat run settles without a reply", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      const taskId = "2b3c4d5e-6f7a-8b9c-0d1e-2f3a4b5c6d7e";
      localApi.__subagent.getSessionMessages.mockResolvedValue({
        messages: [
          { role: "user", content: `go\n\n[StageWhisper chat: umsg-noreply]` },
        ],
      });

      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId,
          sessionId: SESSION_ID_A,
          userMessageId: "umsg-noreply",
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });

      await t.whenChatTaskSettled(taskId);

      expect(calls.filter((c) => c.body.status === "message")).toHaveLength(0);
      expect(calls.filter((c) => c.body.status === "errored")).toHaveLength(0);
    });

    it("does not re-forward an assistant message whose content changes after it was first forwarded", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      const taskId = "3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f";
      localApi.__subagent.getSessionMessages
        .mockResolvedValueOnce({
          messages: [
            { role: "user", content: `go\n\n[StageWhisper chat: umsg-grow]` },
            { role: "assistant", content: "Hel" },
          ],
        })
        .mockResolvedValue({
          messages: [
            { role: "user", content: `go\n\n[StageWhisper chat: umsg-grow]` },
            { role: "assistant", content: "Hello world" },
          ],
        });

      let emitTranscript:
        | ((u: { sessionKey?: string; message?: unknown }) => void)
        | null = null;
      (localApi.runtime as unknown as { events: unknown }).events = {
        onSessionTranscriptUpdate: (
          listener: (u: { sessionKey?: string; message?: unknown }) => void,
        ) => {
          emitTranscript = listener;
          return () => {
            emitTranscript = null;
          };
        },
      };
      localApi.__subagent.waitForRun.mockImplementation(async () => {
        emitTranscript?.({ message: { role: "assistant" } });
        return { status: "ok" };
      });

      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId,
          sessionId: SESSION_ID_A,
          userMessageId: "umsg-grow",
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });

      await t.whenChatTaskSettled(taskId);

      const messageCalls = calls.filter((c) => c.body.status === "message");
      expect(messageCalls).toHaveLength(1);
      expect(messageCalls[0].body.message_id).toBe(`${taskId}:msg:0`);
      expect(calls.filter((c) => c.body.status === "errored")).toHaveLength(0);
    });

    it("callback POST includes the bearer token from request body", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      localApi.__subagent.getSessionMessages.mockResolvedValue({
        messages: [
          { role: "user", content: `[StageWhisper chat: umsg-${TASK_ID_J}]` },
          { role: "assistant", content: "yo" },
        ],
      });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId: TASK_ID_J,
          sessionId: SESSION_ID_A,
          callbackUrl: CALLBACK_BASE_URL,
          callbackToken: CALLBACK_TOKEN,
        }),
      });

      await t.whenChatTaskSettled(TASK_ID_J);

      expect(calls.length).toBeGreaterThanOrEqual(1);
      for (const call of calls) {
        expect(call.authorization).toBe(`Bearer ${CALLBACK_TOKEN}`);
        expect(call.url).toBe(`${CALLBACK_BASE_URL}/tasks/${TASK_ID_J}`);
      }
      const messageCalls = calls.filter((c) => c.body.status === "message");
      expect(messageCalls).toHaveLength(1);
      expect(messageCalls[0].body.reply_text).toBe("yo");
    });

    it("callback POST failure does not crash the listener (logs and moves on)", async () => {
      const { fetchImpl, calls } = makeRecordingFetch(() => ({ status: 500 }));
      const localApi = makeApi();
      localApi.__subagent.getSessionMessages.mockResolvedValue({
        messages: [
          { role: "user", content: `[StageWhisper chat: umsg-${TASK_ID_K}]` },
          { role: "assistant", content: "ok" },
        ],
      });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      const res = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId: TASK_ID_K,
          sessionId: SESSION_ID_A,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });
      expect(res.status).toBe(202);

      await expect(t.whenChatTaskSettled(TASK_ID_K)).resolves.toBeUndefined();

      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(localApi.__logger.error).toHaveBeenCalled();
      expect(calls.filter((call) => call.body["status"] === "typing")).toHaveLength(1);
      expect(calls.every((call) => call.redirect === "manual")).toBe(true);

      const ping = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/ping",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(ping.status).toBe(200);
    });

    it("retries callback POST once on transient network error", async () => {
      let messageAttempts = 0;
      const fetchImpl: typeof fetch = async (_input, init) => {
        let body: Record<string, unknown> = {};
        if (typeof init?.body === "string") {
          try {
            body = JSON.parse(init.body) as Record<string, unknown>;
          } catch {
            body = {};
          }
        }
        if (body.status === "message") {
          messageAttempts += 1;
          if (messageAttempts === 1) throw new Error("ECONNREFUSED");
        }
        return new Response("{}", { status: 200 });
      };
      const localApi = makeApi();
      localApi.__subagent.getSessionMessages.mockResolvedValue({
        messages: [
          { role: "user", content: `[StageWhisper chat: umsg-${TASK_ID_L}]` },
          { role: "assistant", content: "ok" },
        ],
      });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId: TASK_ID_L,
          sessionId: SESSION_ID_A,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });
      await t.whenChatTaskSettled(TASK_ID_L);

      expect(messageAttempts).toBe(2);
      expect(localApi.__logger.error).not.toHaveBeenCalled();
    });

    it("rejects non-loopback callback URL as 400", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId: TASK_ID_M,
          sessionId: SESSION_ID_A,
          callbackUrl: "http://evil.example.com",
        }),
      });
      expect(res.status).toBe(400);
      expect(api.__subagent.run).not.toHaveBeenCalled();
    });

    it("rejects callback URL with a path component as 400", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId: TASK_ID_N,
          sessionId: SESSION_ID_A,
          callbackUrl: "http://127.0.0.1:65535/reply",
        }),
      });
      expect(res.status).toBe(400);
      expect(api.__subagent.run).not.toHaveBeenCalled();
    });

    it("accepts chat_message without callback so the reply can go to an open stream", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId: TASK_ID_O,
          sessionId: SESSION_ID_A,
        }),
      });
      expect(res.status).toBe(202);
      await transport.whenChatTaskSettled(TASK_ID_O);
      expect(api.__subagent.run).toHaveBeenCalled();
    });

    it("rejects callback token shorter than 16 chars", async () => {
      const res = await transport.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId: TASK_ID_P,
          sessionId: SESSION_ID_A,
          callbackUrl: CALLBACK_BASE_URL,
          callbackToken: "tooShort",
        }),
      });
      expect(res.status).toBe(400);
      expect(api.__subagent.run).not.toHaveBeenCalled();
    });

    it("posts errored callback when agent run fails", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      localApi.__subagent.waitForRun.mockResolvedValue({
        status: "error",
        error: "agent exploded",
      });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      const taskId = "00000000-aaaa-bbbb-cccc-000000000001";
      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId,
          sessionId: SESSION_ID_A,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });

      await t.whenChatTaskSettled(taskId);
      const errored = calls.filter((c) => c.body.status === "errored");
      expect(errored).toHaveLength(1);
      expect(errored[0].url).toBe(`${CALLBACK_BASE_URL}/tasks/${taskId}`);
      expect(errored[0].body).toMatchObject({
        task_id: taskId,
        status: "errored",
        error_code: "agent_error",
      });
      expect(errored[0].body).not.toHaveProperty("reply_text");
    });

    it("does not forward a stale assistant reply or invent an error when no task marker matches", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      const taskId = "00000000-aaaa-bbbb-cccc-000000000099";
      localApi.__subagent.getSessionMessages.mockResolvedValue({
        messages: [
          { role: "user", content: "stale earlier turn" },
          { role: "assistant", content: "stale earlier assistant reply" },
        ],
      });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId,
          sessionId: SESSION_ID_A,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });

      await t.whenChatTaskSettled(taskId);

      expect(calls.filter((c) => c.body.status === "message")).toHaveLength(0);
      expect(calls.filter((c) => c.body.status === "errored")).toHaveLength(0);
    });

    it("posts errored callback when subagent.run throws", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      localApi.__subagent.run.mockRejectedValue(new Error("boom"));
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      const taskId = "00000000-aaaa-bbbb-cccc-000000000002";
      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId,
          sessionId: SESSION_ID_A,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });

      await t.whenChatTaskSettled(taskId);
      const errored = calls.filter((c) => c.body.status === "errored");
      expect(errored).toHaveLength(1);
      expect(errored[0].url).toBe(`${CALLBACK_BASE_URL}/tasks/${taskId}`);
      expect(errored[0].body).toMatchObject({
        task_id: taskId,
        status: "errored",
        error_code: "execution_error",
      });
    });

    it("an idempotent chat retry does not repeat a callback after the first delivery", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      const taskId = "00000000-aaaa-bbbb-cccc-000000000007";
      localApi.__subagent.getSessionMessages.mockResolvedValue({
        messages: [
          { role: "user", content: `[StageWhisper chat: umsg-${taskId}]` },
          { role: "assistant", content: "the real reply" },
        ],
      });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      const first = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId,
          sessionId: SESSION_ID_A,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });
      expect(first.status).toBe(202);
      await t.whenChatTaskSettled(taskId);
      const firstMessages = calls.filter((c) => c.body.status === "message");
      expect(firstMessages).toHaveLength(1);
      expect(firstMessages[0].body).toMatchObject({
        task_id: taskId,
        status: "message",
        reply_text: "the real reply",
      });

      const replay = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId,
          sessionId: SESSION_ID_A,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });
      expect(replay.status).toBe(202);
      expect(replay.headers["X-Idempotent-Replay"]).toBe("true");

      await t.whenChatTaskSettled(taskId);

      expect(localApi.__subagent.run).toHaveBeenCalledTimes(1);
      const allMessages = calls.filter((c) => c.body.status === "message");
      expect(allMessages).toHaveLength(1);
    });

    it("an idempotent chat retry does not repeat any callback from a multi-message reply", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      const taskId = "00000000-aaaa-bbbb-cccc-000000000008";
      localApi.__subagent.getSessionMessages.mockResolvedValue({
        messages: [
          { role: "user", content: `[StageWhisper chat: umsg-${taskId}]` },
          { role: "assistant", content: "first reply" },
          { role: "assistant", content: "second reply" },
        ],
      });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      const first = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId,
          sessionId: SESSION_ID_A,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });
      expect(first.status).toBe(202);
      await t.whenChatTaskSettled(taskId);
      const firstMessages = calls.filter((c) => c.body.status === "message");
      expect(firstMessages.map((c) => c.body.reply_text)).toEqual([
        "first reply",
        "second reply",
      ]);

      const replay = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId,
          sessionId: SESSION_ID_A,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });
      expect(replay.status).toBe(202);
      expect(replay.headers["X-Idempotent-Replay"]).toBe("true");
      await t.whenChatTaskSettled(taskId);

      expect(localApi.__subagent.run).toHaveBeenCalledTimes(1);
      const allMessages = calls.filter((c) => c.body.status === "message");
      expect(allMessages.map((c) => c.body.reply_text)).toEqual([
        "first reply",
        "second reply",
      ]);
    });

    it("idempotent chat_message returns cached 202 + does NOT re-dispatch subagent", async () => {
      const { fetchImpl } = makeRecordingFetch();
      const localApi = makeApi();
      const taskId = "00000000-aaaa-bbbb-cccc-000000000003";
      localApi.__subagent.getSessionMessages.mockResolvedValue({
        messages: [
          { role: "user", content: `[StageWhisper chat: umsg-${taskId}]` },
          { role: "assistant", content: "first reply" },
        ],
      });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });
      const first = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId,
          sessionId: SESSION_ID_A,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });
      expect(first.status).toBe(202);

      await t.whenChatTaskSettled(taskId);

      const second = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId,
          sessionId: SESSION_ID_A,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });
      expect(second.status).toBe(202);
      expect(second.headers["X-Idempotent-Replay"]).toBe("true");
      expect(localApi.__subagent.run).toHaveBeenCalledTimes(1);
    });
  });

  describe("system_prelude", () => {
    it("stashes prelude and returns 202 without dispatching", async () => {
      const localApi = makeApi();
      const { transport: t } = makeTransport(localApi);

      const res = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: systemPreludeBody({
          taskId: "00000000-aaaa-bbbb-cccc-000000000010",
          sessionId: SESSION_ID_A,
          text: "user is a senior engineer in a 1:1",
        }),
      });

      expect(res.status).toBe(202);
      expect(parseBody(res.body)).toMatchObject({
        status: "accepted",
        task_id: "00000000-aaaa-bbbb-cccc-000000000010",
      });
      expect(localApi.__subagent.run).not.toHaveBeenCalled();
    });

    it("prepends [Context: ...] to next chat_message and clears stash", async () => {
      const { fetchImpl, calls } = makeRecordingFetch();
      const localApi = makeApi();
      const chatTaskOneId = "00000000-aaaa-bbbb-cccc-000000000021";
      const chatTaskTwoId = "00000000-aaaa-bbbb-cccc-000000000022";
      localApi.__subagent.getSessionMessages.mockImplementation(async () => ({
        messages: [
          { role: "user", content: `[StageWhisper chat: umsg-${chatTaskOneId}]` },
          { role: "assistant", content: "noted" },
          { role: "user", content: `[StageWhisper chat: umsg-${chatTaskTwoId}]` },
          { role: "assistant", content: "follow-up noted" },
        ],
      }));
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: systemPreludeBody({
          taskId: "00000000-aaaa-bbbb-cccc-000000000020",
          sessionId: SESSION_ID_A,
          text: "user is a senior engineer",
        }),
      });

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId: chatTaskOneId,
          sessionId: SESSION_ID_A,
          text: "what should I ask?",
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });
      await t.whenChatTaskSettled(chatTaskOneId);

      expect(localApi.__subagent.run).toHaveBeenCalledTimes(1);
      const firstCall = localApi.__subagent.run.mock.calls[0][0];
      expect(firstCall.message).toContain("[Context: user is a senior engineer]");
      expect(firstCall.message).toContain("what should I ask?");

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId: chatTaskTwoId,
          sessionId: SESSION_ID_A,
          text: "follow up?",
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });
      await t.whenChatTaskSettled(chatTaskTwoId);

      expect(localApi.__subagent.run).toHaveBeenCalledTimes(2);
      const secondCall = localApi.__subagent.run.mock.calls[1][0];
      expect(secondCall.message).not.toContain("[Context:");
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    it("prepends [Context: ...] to next final transcript_chunk and clears stash", async () => {
      const localApi = makeApi();
      const { transport: t } = makeTransport(localApi);

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: systemPreludeBody({
          taskId: "00000000-aaaa-bbbb-cccc-000000000030",
          sessionId: SESSION_ID_B,
          text: "live call with prospect",
        }),
      });

      const transcriptTask = "00000000-aaaa-bbbb-cccc-000000000031";
      const res = await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: transcriptChunkBody({
          taskId: transcriptTask,
          sessionId: SESSION_ID_B,
          text: "We need pricing details.",
          isFinal: true,
        }),
      });
      expect(res.status).toBe(202);
      await t.whenChatTaskSettled(transcriptTask);
      expect(localApi.__subagent.run).toHaveBeenCalledTimes(1);
      const firstCall = localApi.__subagent.run.mock.calls[0][0];
      expect(firstCall.message).toContain("[Context: live call with prospect]");
      expect(firstCall.message).toContain("We need pricing details.");

      const transcriptTaskTwo = "00000000-aaaa-bbbb-cccc-000000000032";
      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: transcriptChunkBody({
          taskId: transcriptTaskTwo,
          sessionId: SESSION_ID_B,
          text: "Another sentence.",
          isFinal: true,
        }),
      });
      expect(localApi.__subagent.run).toHaveBeenCalledTimes(2);
      const secondCall = localApi.__subagent.run.mock.calls[1][0];
      expect(secondCall.message).not.toContain("[Context:");
    });

    it("partial transcript_chunk does NOT consume the prelude stash", async () => {
      const localApi = makeApi();
      const { transport: t } = makeTransport(localApi);

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: systemPreludeBody({
          taskId: "00000000-aaaa-bbbb-cccc-000000000040",
          sessionId: SESSION_ID_A,
          text: "prelude text",
        }),
      });

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: transcriptChunkBody({
          taskId: "00000000-aaaa-bbbb-cccc-000000000041",
          sessionId: SESSION_ID_A,
          text: "partial",
          isFinal: false,
        }),
      });
      expect(localApi.__subagent.run).not.toHaveBeenCalled();

      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: transcriptChunkBody({
          taskId: "00000000-aaaa-bbbb-cccc-000000000042",
          sessionId: SESSION_ID_A,
          text: "final transcript",
          isFinal: true,
        }),
      });
      expect(localApi.__subagent.run).toHaveBeenCalledTimes(1);
      const call = localApi.__subagent.run.mock.calls[0][0];
      expect(call.message).toContain("[Context: prelude text]");
    });
  });

  describe("chat_id split routing", () => {
    it("uses sw:{sid}:reasoning sessionKey for transcript_chunk", async () => {
      const localApi = makeApi();
      const { transport: t } = makeTransport(localApi);
      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: transcriptChunkBody({
          taskId: "00000000-aaaa-bbbb-cccc-000000000050",
          sessionId: SESSION_ID_A,
          isFinal: true,
        }),
      });
      const runCall = localApi.__subagent.run.mock.calls[0][0];
      expect(runCall.sessionKey).toContain(`sw:${SESSION_ID_A}:reasoning`);
    });

    it("uses sw:{sid}:chat sessionKey for chat_message", async () => {
      const { fetchImpl } = makeRecordingFetch();
      const localApi = makeApi();
      const taskId = "00000000-aaaa-bbbb-cccc-000000000060";
      localApi.__subagent.getSessionMessages.mockResolvedValue({
        messages: [
          { role: "user", content: `[StageWhisper chat: umsg-${taskId}]` },
          { role: "assistant", content: "hi" },
        ],
      });
      const { transport: t } = makeTransport(localApi, { callbackFetch: fetchImpl });
      await t.handleSyntheticRequest({
        method: "POST",
        url: "/v1/incoming",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: chatMessageBody({
          taskId,
          sessionId: SESSION_ID_A,
          callbackUrl: CALLBACK_BASE_URL,
        }),
      });
      await t.whenChatTaskSettled(taskId);
      const runCall = localApi.__subagent.run.mock.calls[0][0];
      expect(runCall.sessionKey).toContain(`sw:${SESSION_ID_A}:chat`);
    });
  });

  describe("constructor validation", () => {
    it("throws if token is too short", () => {
      expect(() =>
        createHttpTransport({
          api: makeApi(),
          host: "127.0.0.1",
          port: 0,
          token: "short",
        }),
      ).toThrow();
    });

    it("throws if token is empty", () => {
      expect(() =>
        createHttpTransport({
          api: makeApi(),
          host: "127.0.0.1",
          port: 0,
          token: "",
        }),
      ).toThrow();
    });
  });

  describe("isLoopbackCallbackUrl", () => {
    it("accepts loopback base URLs", () => {
      expect(isLoopbackCallbackUrl("http://127.0.0.1:65535")).toBe(true);
      expect(isLoopbackCallbackUrl("http://localhost:8080")).toBe(true);
      expect(isLoopbackCallbackUrl("http://127.0.0.1")).toBe(true);
      expect(isLoopbackCallbackUrl("http://localhost")).toBe(true);
      expect(isLoopbackCallbackUrl("http://127.0.0.1:65535/")).toBe(true);
      expect(isLoopbackCallbackUrl("https://127.0.0.1:65535")).toBe(true);
    });

    it("rejects URLs with a path component", () => {
      expect(isLoopbackCallbackUrl("http://127.0.0.1:65535/reply")).toBe(false);
      expect(isLoopbackCallbackUrl("http://localhost:8080/callback")).toBe(false);
      expect(isLoopbackCallbackUrl("http://127.0.0.1/tasks/abc")).toBe(false);
    });

    it("rejects non-loopback hosts", () => {
      expect(isLoopbackCallbackUrl("http://evil.example.com")).toBe(false);
      expect(isLoopbackCallbackUrl("http://10.0.0.5:65535")).toBe(false);
    });
  });
});
