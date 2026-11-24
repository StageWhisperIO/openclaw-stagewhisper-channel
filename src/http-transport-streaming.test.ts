import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createHttpTransport, type HttpTransport } from "./http-transport.js";

const VALID_TOKEN = "test-token-32-chars-min-length__";
const SESSION_ID = "session-stream-frames";
const TASK_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef";
const RUN_ID = "run-abc";

type AgentStreamEvent = { runId: string; stream: string; data: Record<string, unknown> };

function makeApi(options: {
  emitEvents?: (emit: (evt: AgentStreamEvent) => void) => void;
  waitResult?: { status: "ok" | "error" | "timeout"; error?: string };
}): OpenClawPluginApi {
  const listeners = new Set<(evt: AgentStreamEvent) => void>();
  const emit = (evt: AgentStreamEvent): void => {
    for (const listener of listeners) listener(evt);
  };

  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      subagent: {
        run: vi.fn().mockResolvedValue({ runId: RUN_ID }),
        waitForRun: vi.fn().mockImplementation(async () => {
          options.emitEvents?.(emit);
          return options.waitResult ?? { status: "ok" };
        }),
        getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
      },
      events: {
        onSessionTranscriptUpdate: () => () => {},
        onAgentEvent: (listener: (evt: AgentStreamEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
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

async function startTransport(api: OpenClawPluginApi): Promise<string> {
  const t = createHttpTransport({ api, host: "127.0.0.1", port: 0, token: VALID_TOKEN });
  await t.start();
  transport = t;
  const address = t.address();
  if (!address) throw new Error("transport has no address");
  return `http://127.0.0.1:${address.port}`;
}

async function readFramesUntil(
  body: ReadableStream<Uint8Array>,
  stop: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const collected: Record<string, unknown>[] = [];
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
        const dataLine = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        const payload = JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>;
        collected.push(payload);
        if (stop(payload)) return collected;
      }
    }
  } finally {
    void reader.cancel();
  }
  throw new Error(
    `stop condition never satisfied; collected ${JSON.stringify(collected)}`,
  );
}

type IdentifiedFrame = { id: string | null; payload: Record<string, unknown> };

async function readIdentifiedFramesUntil(
  body: ReadableStream<Uint8Array>,
  stop: (frame: IdentifiedFrame) => boolean,
  timeoutMs = 5000,
): Promise<IdentifiedFrame[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const collected: IdentifiedFrame[] = [];
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
        const lines = frame.split("\n");
        const dataLine = lines.find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        const idLine = lines.find((line) => line.startsWith("id: "));
        const identified: IdentifiedFrame = {
          id: idLine ? idLine.slice("id: ".length) : null,
          payload: JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>,
        };
        collected.push(identified);
        if (stop(identified)) return collected;
      }
    }
  } finally {
    void reader.cancel();
  }
  throw new Error(`stop condition never satisfied; collected ${JSON.stringify(collected)}`);
}

async function collectFramesFor(
  body: ReadableStream<Uint8Array>,
  windowMs: number,
): Promise<Record<string, unknown>[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const collected: Record<string, unknown>[] = [];
  const deadline = Date.now() + windowMs;
  try {
    while (Date.now() < deadline) {
      const read = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: false }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: false }), deadline - Date.now()),
        ),
      ]);
      if (read.done) break;
      if (!read.value) continue;
      buffer += decoder.decode(read.value, { stream: true });
      while (buffer.includes("\n\n")) {
        const boundary = buffer.indexOf("\n\n");
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        collected.push(JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>);
      }
    }
  } finally {
    void reader.cancel();
  }
  return collected;
}

function postChatMessage(
  base: string,
  taskId: string,
  callback?: { url: string; token: string },
): Promise<Response> {
  return fetch(`${base}/v1/incoming`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VALID_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      task_id: taskId,
      session_id: SESSION_ID,
      reason: "chat_message",
      occurred_at: "2026-01-01T00:00:00Z",
      payload: { text: "hello", user_message_id: "umid-stream" },
      ...(callback ? { callback } : {}),
    }),
  });
}

describe("token stream bridging over the event stream endpoint", () => {
  it("streams incremental text deltas as durable stream chunks ending in finish, then a completed frame", async () => {
    const api = makeApi({
      emitEvents: (emit) => {
        emit({ runId: RUN_ID, stream: "assistant", data: { text: "Hel", delta: "Hel" } });
        emit({ runId: RUN_ID, stream: "assistant", data: { text: "Hello", delta: "lo" } });
      },
    });
    const base = await startTransport(api);

    const stream = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(stream.status).toBe(200);

    const accepted = await postChatMessage(base, TASK_ID);
    expect(accepted.status).toBe(202);

    const frames = await readFramesUntil(
      stream.body!,
      (frame) => frame["status"] === "completed",
    );

    const streamFrames = frames.filter((frame) => frame["status"] === "stream");
    const chunkTypes = streamFrames.map(
      (frame) => (frame["chunk"] as Record<string, unknown>)["type"],
    );
    expect(chunkTypes).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);

    const deltaChunks = streamFrames
      .filter((frame) => (frame["chunk"] as Record<string, unknown>)["type"] === "text-delta")
      .map((frame) => (frame["chunk"] as Record<string, unknown>)["delta"]);
    expect(deltaChunks).toEqual(["Hel", "lo"]);

    const startChunk = streamFrames[0]["chunk"] as Record<string, unknown>;
    expect(startChunk).toEqual({ type: "start", messageId: TASK_ID });

    const finishChunk = streamFrames[streamFrames.length - 1]["chunk"] as Record<
      string,
      unknown
    >;
    expect(finishChunk).toEqual({ type: "finish", finishReason: "stop" });

    expect(frames[frames.length - 1]["status"]).toBe("completed");
  });

  it("does not replay already delivered chunks to a reconnecting listener", async () => {
    const api = makeApi({
      emitEvents: (emit) => {
        emit({ runId: RUN_ID, stream: "assistant", data: { text: "Hel", delta: "Hel" } });
        emit({ runId: RUN_ID, stream: "assistant", data: { text: "Hello", delta: "lo" } });
      },
    });
    const base = await startTransport(api);

    const first = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    const accepted = await postChatMessage(base, TASK_ID);
    expect(accepted.status).toBe(202);

    const delivered = await readIdentifiedFramesUntil(
      first.body!,
      (frame) => frame.payload["status"] === "completed",
    );
    const cursor = delivered[delivered.length - 1].id;
    expect(cursor).toBeTruthy();

    const resumed = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}`, "Last-Event-ID": cursor! },
    });
    expect(resumed.status).toBe(200);

    const replayed = await collectFramesFor(resumed.body!, 1200);

    expect(replayed).toEqual([]);
  });

  it("replays only the unseen tail when a listener reconnects mid answer", async () => {
    const api = makeApi({
      emitEvents: (emit) => {
        emit({ runId: RUN_ID, stream: "assistant", data: { text: "Hel", delta: "Hel" } });
        emit({ runId: RUN_ID, stream: "assistant", data: { text: "Hello", delta: "lo" } });
      },
    });
    const base = await startTransport(api);

    const first = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    const accepted = await postChatMessage(base, TASK_ID);
    expect(accepted.status).toBe(202);

    const delivered = await readIdentifiedFramesUntil(
      first.body!,
      (frame) => frame.payload["status"] === "completed",
    );

    const firstDeltaIndex = delivered.findIndex(
      (frame) =>
        frame.payload["status"] === "stream" &&
        (frame.payload["chunk"] as Record<string, unknown>)["type"] === "text-delta",
    );
    const cursor = delivered[firstDeltaIndex].id!;

    const resumed = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}`, "Last-Event-ID": cursor },
    });

    const replayed = await collectFramesFor(resumed.body!, 1200);
    const replayedDeltas = replayed
      .filter(
        (frame) =>
          frame["status"] === "stream" &&
          (frame["chunk"] as Record<string, unknown>)["type"] === "text-delta",
      )
      .map((frame) => (frame["chunk"] as Record<string, unknown>)["delta"]);

    expect(replayedDeltas).toEqual(["lo"]);
  });

  it("keeps a callback-selected turn off the reply stream entirely", async () => {
    const api = makeApi({
      emitEvents: (emit) => {
        emit({ runId: RUN_ID, stream: "assistant", data: { text: "Hel", delta: "Hel" } });
        emit({ runId: RUN_ID, stream: "assistant", data: { text: "Hello", delta: "lo" } });
      },
    });
    const base = await startTransport(api);

    const stream = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(stream.status).toBe(200);

    const accepted = await postChatMessage(base, TASK_ID, {
      url: "http://127.0.0.1:9/",
      token: "callback-token-32-chars-aaaaaaaa",
    });
    expect(accepted.status).toBe(202);

    const frames = await collectFramesFor(stream.body!, 1500);

    expect(frames.filter((frame) => frame["status"] === "stream")).toEqual([]);
  });

  it("sends a terminal completed frame once a chat task settles successfully even without any streamed deltas", async () => {
    const api = makeApi({});
    const base = await startTransport(api);

    const stream = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });

    const accepted = await postChatMessage(base, TASK_ID);
    expect(accepted.status).toBe(202);

    const frames = await readFramesUntil(
      stream.body!,
      (frame) => frame["status"] === "completed",
    );

    expect(frames.some((frame) => frame["status"] === "stream")).toBe(false);
    const completed = frames[frames.length - 1];
    expect(completed["task_id"]).toBe(TASK_ID);
    expect(completed["session_id"]).toBe(SESSION_ID);
  });
});
