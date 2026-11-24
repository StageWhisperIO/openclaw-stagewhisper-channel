import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { AI_SDK_REQUEST } from "./fixtures/library-request.js";
import { createHttpTransport, type HttpTransport } from "./http-transport.js";
import { createLlmEndpoint } from "./llm-endpoint.js";
import { chatCompletionChunks } from "./llm-replay.js";
import { LLM_MAX_BODY_BYTES } from "./llm-request.js";

type RunAgent = OpenClawPluginApi["runtime"]["agent"]["runEmbeddedPiAgent"];
type RunParams = Parameters<RunAgent>[0];
type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: string };

const here = path.dirname(fileURLToPath(import.meta.url));
const PAIRING_TOKEN = "pairing-token-32-chars-minimum__";
const CONFIG = { agents: { defaults: { model: { primary: "deepseek/deepseek-chat" }, workspace: "/srv/agent" } } };
const REPLAY_FIXTURE = path.join(here, "fixtures", "chat-completions-tool-call-replay.sse");
const openTransports: HttpTransport[] = [];

afterEach(async () => {
  await Promise.all(openTransports.splice(0).map((transport) => transport.stop()));
});

function textResult(text: string) {
  return { payloads: [{ text }], meta: { durationMs: 5, stopReason: "stop" } };
}

function toolCallResult(text = "") {
  return {
    payloads: text ? [{ text }] : undefined,
    meta: {
      durationMs: 5,
      stopReason: "tool_calls",
      pendingToolCalls: [{ id: "a1b2c3d4e", name: "searchLibrary", arguments: '{"query":"Sealand"}' }],
    },
  };
}

function makeApi(runAgent: unknown, config: Record<string, unknown> = CONFIG): OpenClawPluginApi {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: { agent: runAgent ? { runEmbeddedPiAgent: runAgent } : {} },
    pluginConfig: {},
    config,
  } as unknown as OpenClawPluginApi;
}

async function startTransport(api: OpenClawPluginApi, heartbeatMs?: number): Promise<number> {
  const transport = createHttpTransport({
    api,
    host: "127.0.0.1",
    port: 0,
    token: PAIRING_TOKEN,
    llmEndpoint: createLlmEndpoint({ api, token: PAIRING_TOKEN, heartbeatMs }),
  });
  await transport.start();
  openTransports.push(transport);
  return transport.address()!.port;
}

function send(
  port: number,
  requestPath: string,
  options: { token?: string | null; host?: string; body?: unknown } = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = { Host: options.host ?? "127.0.0.1", "Content-Type": "application/json" };
  if (options.token !== null) headers["Authorization"] = `Bearer ${options.token ?? PAIRING_TOKEN}`;
  const body = typeof options.body === "string" ? options.body : JSON.stringify(options.body ?? {});
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: requestPath, method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function sseEvents(body: string): unknown[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => frame.slice("data: ".length))
    .map((payload) => (payload === "[DONE]" ? payload : JSON.parse(payload)));
}

function expectOpenAiError(response: RawResponse, status: number, code: string): void {
  expect(response.status).toBe(status);
  const parsed = JSON.parse(response.body) as { error: Record<string, unknown> };
  expect(parsed.error).toEqual(expect.objectContaining({ code, message: expect.any(String), type: expect.any(String) }));
}

describe("the Library model endpoint on the OpenClaw HTTP transport", () => {
  it("the ping advertises chat completions with the configured model and runs nothing", async () => {
    const runAgent = vi.fn();
    const port = await startTransport(makeApi(runAgent));
    expect(JSON.parse((await send(port, "/v1/ping")).body)).toEqual({
      ok: true,
      llm: { api: "chat_completions", model: "deepseek/deepseek-chat" },
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("with no model configured the ping says no model is offered and the built-in default model never runs", async () => {
    const runAgent = vi.fn();
    const port = await startTransport(makeApi(runAgent, {}));
    expect(JSON.parse((await send(port, "/v1/ping")).body)).toEqual({ ok: true, llm: { api: "none" } });
    expectOpenAiError(await send(port, "/v1/chat/completions", { body: AI_SDK_REQUEST }), 404, "unknown_url");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("the model resolves the way the host agent does, through aliases and the default agent's own model", async () => {
    const aliased = { agents: { defaults: { model: { primary: "ds" }, models: { "deepseek/deepseek-chat": { alias: "ds" } } } } };
    const aliasPort = await startTransport(makeApi(vi.fn(), aliased));
    expect(JSON.parse((await send(aliasPort, "/v1/ping")).body).llm.model).toBe("deepseek/deepseek-chat");

    const runAgent = vi.fn(async () => textResult("Hi."));
    const perAgent = {
      agents: {
        defaults: { model: "deepseek/deepseek-chat" },
        list: [{ id: "ops" }, { id: "coach", default: true, model: "openrouter/anthropic/claude-sonnet-4" }],
      },
    };
    const agentPort = await startTransport(makeApi(runAgent, perAgent));
    expect(JSON.parse((await send(agentPort, "/v1/ping")).body).llm.model).toBe("openrouter/anthropic/claude-sonnet-4");
    await send(agentPort, "/v1/chat/completions", { body: AI_SDK_REQUEST });
    expect(runAgent.mock.calls[0]![0]).toMatchObject({ provider: "openrouter", model: "anthropic/claude-sonnet-4" });
  });

  it("a host without runEmbeddedPiAgent says no model is offered in the ping and answers 404", async () => {
    const port = await startTransport(makeApi(undefined));
    expect(JSON.parse((await send(port, "/v1/ping")).body)).toEqual({ ok: true, llm: { api: "none" } });
    expectOpenAiError(await send(port, "/v1/chat/completions", { body: AI_SDK_REQUEST }), 404, "unknown_url");
  });

  it("requests without the right pairing token or from a foreign host never run the agent", async () => {
    const runAgent = vi.fn();
    const port = await startTransport(makeApi(runAgent));
    const missing = await send(port, "/v1/chat/completions", { token: null, body: AI_SDK_REQUEST });
    const wrong = await send(port, "/v1/chat/completions", { token: "wrong-token-of-the-same-length__", body: AI_SDK_REQUEST });
    const foreign = await send(port, "/v1/chat/completions", { host: "evil.example", body: AI_SDK_REQUEST });
    expect([missing.status, wrong.status, foreign.status]).toEqual([401, 401, 403]);
    expect(JSON.parse(wrong.body)).toEqual({ error: "invalid_token" });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("a body over the cap and too many tools are refused with openai style errors before the agent runs", async () => {
    const runAgent = vi.fn();
    const port = await startTransport(makeApi(runAgent));
    const oversized = { ...AI_SDK_REQUEST, messages: [{ role: "user", content: "x".repeat(LLM_MAX_BODY_BYTES) }] };
    expectOpenAiError(await send(port, "/v1/chat/completions", { body: oversized }), 413, "request_too_large");
    const tools = Array.from({ length: 17 }, (_, index) => ({ type: "function", function: { name: `t${index}` } }));
    expectOpenAiError(await send(port, "/v1/chat/completions", { body: { ...AI_SDK_REQUEST, tools } }), 400, "too_many_tools");
    expectOpenAiError(await send(port, "/v1/chat/completions", { body: "{not json" }), 400, "invalid_json");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("the agent runs in-process with the configured model, client tools, no host tools and a throwaway session file", async () => {
    let sessionFile = "";
    const runAgent = vi.fn(async (params: RunParams) => {
      sessionFile = params.sessionFile;
      expect(existsSync(path.dirname(params.sessionFile))).toBe(true);
      return textResult("Next Tuesday.");
    });
    const port = await startTransport(makeApi(runAgent));
    await send(port, "/v1/chat/completions", { body: AI_SDK_REQUEST });
    const params = runAgent.mock.calls[0]![0];
    expect(params).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      workspaceDir: "/srv/agent",
      disableTools: true,
      extraSystemPrompt: "Answer only from tool results.",
      clientTools: AI_SDK_REQUEST.tools,
    });
    expect(params.prompt).toContain('Assistant: called searchLibrary({"query":"Sealand"}) as call_abc');
    expect(existsSync(path.dirname(sessionFile))).toBe(false);
  });

  it("a streamed text answer replays as standard chat completion chunks after a keep-alive", async () => {
    const port = await startTransport(makeApi(vi.fn(async () => textResult("Sealand needs a new contract [e1]."))));
    const response = await send(port, "/v1/chat/completions", { body: AI_SDK_REQUEST });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.body.startsWith(": keep-alive\n\n")).toBe(true);
    const events = sseEvents(response.body) as Array<Record<string, any>>;
    expect(events.at(-1)).toBe("[DONE]");
    expect(events[0]!.choices[0].delta).toEqual({ role: "assistant", content: "Sealand needs a new contract [e1]." });
    expect(events.at(-2)!.choices[0]).toEqual({ index: 0, delta: {}, finish_reason: "stop" });
  });

  it("a pending client tool call replays as one tool_calls delta and matches the fixture checked against the ai sdk", async () => {
    const port = await startTransport(makeApi(vi.fn(async () => toolCallResult("Let me look through your calls."))));
    const response = await send(port, "/v1/chat/completions", { body: AI_SDK_REQUEST });
    const events = sseEvents(response.body) as Array<Record<string, any>>;
    expect(events[1]!.choices[0].delta.tool_calls).toEqual([
      { index: 0, id: "call_a1b2c3d4e", type: "function", function: { name: "searchLibrary", arguments: '{"query":"Sealand"}' } },
    ]);
    expect(events.at(-2)!.choices[0].finish_reason).toBe("tool_calls");
    const replay = chatCompletionChunks({
      id: "chatcmpl-host-2",
      model: "deepseek/deepseek-chat",
      created: 1791700000,
      content: "Let me look through your calls.",
      toolCalls: events[1]!.choices[0].delta.tool_calls.map(({ index: _, ...call }: Record<string, unknown>) => call),
    });
    expect(replay).toBe(readFileSync(REPLAY_FIXTURE, "utf8"));
  });

  it("a non streamed request gets one chat completion", async () => {
    const port = await startTransport(makeApi(vi.fn(async () => toolCallResult())));
    const response = await send(port, "/v1/chat/completions", { body: { ...AI_SDK_REQUEST, stream: false } });
    const body = JSON.parse(response.body);
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("deepseek/deepseek-chat");
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.content).toBeNull();
  });

  it("a slow agent keeps the stream alive with heartbeats", async () => {
    const runAgent = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return textResult("Done.");
    });
    const port = await startTransport(makeApi(runAgent), 40);
    const response = await send(port, "/v1/chat/completions", { body: AI_SDK_REQUEST });
    expect(response.body.split(": keep-alive\n\n").length - 1).toBeGreaterThan(1);
    expect(sseEvents(response.body).at(-1)).toBe("[DONE]");
  });

  it("a failed run arrives as an in-stream error or a 502 without the error text", async () => {
    const runAgent = vi.fn(async () => {
      throw new Error("provider said no for key sk-live-123 about Sealand");
    });
    const api = makeApi(runAgent);
    const port = await startTransport(api);
    const streamed = await send(port, "/v1/chat/completions", { body: AI_SDK_REQUEST });
    expect((sseEvents(streamed.body)[0] as Record<string, any>).error.code).toBe("upstream_error");
    expect(streamed.body).not.toContain("sk-live-123");
    expectOpenAiError(await send(port, "/v1/chat/completions", { body: { ...AI_SDK_REQUEST, stream: false } }), 502, "upstream_error");
    const logged = JSON.stringify((api.logger.warn as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain("Sealand");
    expect(logged).not.toContain("sk-live-123");
  });

  it("an error payload from the agent is treated as a failure, not an answer", async () => {
    const runAgent = vi.fn(async () => ({ payloads: [{ text: "⚠️ API rate limit reached", isError: true }], meta: { durationMs: 1 } }));
    const port = await startTransport(makeApi(runAgent));
    const response = await send(port, "/v1/chat/completions", { body: { ...AI_SDK_REQUEST, stream: false } });
    expectOpenAiError(response, 502, "upstream_error");
  });
});
