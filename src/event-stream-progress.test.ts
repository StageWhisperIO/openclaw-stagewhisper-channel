import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createHttpTransport, type HttpTransport } from "./http-transport.js";

const TOKEN = "test-token-32-chars-min-length__";
const SESSION_ID = "session-progress";
const TASK_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let transport: HttpTransport | null = null;

afterEach(async () => {
  await transport?.stop();
  transport = null;
});

async function readTypingFrame(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (buffer.includes("\n\n")) {
        const boundary = buffer.indexOf("\n\n");
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.includes('"status":"typing"')) return frame;
      }
    }
  } finally {
    void reader.cancel();
  }
  throw new Error("typing frame did not arrive");
}

it("delivers live-only typing while a no-callback agent run is still active", async () => {
  let finishRun: ((value: { status: "ok" }) => void) | undefined;
  const activeRun = new Promise<{ status: "ok" }>((resolve) => {
    finishRun = resolve;
  });
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      subagent: {
        run: vi.fn().mockResolvedValue({ runId: "run-abc" }),
        waitForRun: vi.fn().mockReturnValue(activeRun),
        getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
      },
    },
    pluginConfig: {},
    config: {},
  } as unknown as OpenClawPluginApi;
  transport = createHttpTransport({ api, host: "127.0.0.1", port: 0, token: TOKEN });
  await transport.start();
  const address = transport.address();
  if (!address) throw new Error("transport has no address");
  const base = `http://127.0.0.1:${address.port}`;
  const stream = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  const accepted = await fetch(`${base}/v1/incoming`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      task_id: TASK_ID,
      session_id: SESSION_ID,
      reason: "chat_message",
      occurred_at: "2026-01-01T00:00:00Z",
      payload: { text: "work for a while", user_message_id: "umid-progress" },
    }),
  });
  expect(accepted.status).toBe(202);

  const frame = await readTypingFrame(stream.body!);
  expect(frame).toContain("event: progress");
  expect(frame).not.toContain("id: ");
  finishRun?.({ status: "ok" });
});
