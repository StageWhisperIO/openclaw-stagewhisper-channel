import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveAgentEffectiveModelPrimary,
  resolveConfiguredModelRef,
  resolveDefaultAgentId,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
} from "openclaw/plugin-sdk/webhook-ingress";
import { guardRequest, writeResponse, type NormalizedRequest } from "./http-transport-protocol.js";
import { openAiError, openAiErrorResponse, rejection, type LlmRejection } from "./llm-errors.js";
import { chatCompletionChunks, chatCompletionJson, sseFrame, SSE_DONE, type Completion } from "./llm-replay.js";
import { LLM_MAX_BODY_BYTES, readLibraryTurn, type LibraryTurn } from "./llm-request.js";

export const LLM_PATH = "/v1/chat/completions";
const BODY_READ_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 120_000;
const HEARTBEAT_MS = 15_000;
const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" };
const NOT_OFFERED = rejection(404, "unknown_url", "This assistant does not offer a Library model endpoint.");
const TOO_LARGE = rejection(413, "request_too_large", `The request body is limited to ${LLM_MAX_BODY_BYTES} bytes.`);
const HOST_ERROR = rejection(502, "upstream_error", "The assistant could not answer.");

export type LlmPingField = { api: "chat_completions"; model: string } | { api: "none" };

export type LlmEndpoint = {
  pingField(): LlmPingField;
  handle(req: http.IncomingMessage, res: http.ServerResponse, normalized: NormalizedRequest): Promise<void>;
};

export type LlmEndpointOptions = {
  api: OpenClawPluginApi;
  token: string;
  heartbeatMs?: number;
};

type HostConfig = OpenClawPluginApi["config"];

export function resolveHostModel(cfg: HostConfig): { provider: string; model: string } | undefined {
  const agentPrimary = resolveAgentEffectiveModelPrimary(cfg, resolveDefaultAgentId(cfg));
  const effective = agentPrimary
    ? { ...cfg, agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, model: { primary: agentPrimary } } } }
    : cfg;
  const ref = resolveConfiguredModelRef({ cfg: effective, defaultProvider: "", defaultModel: "" });
  return ref.provider && ref.model ? ref : undefined;
}

function send(res: http.ServerResponse, failure: LlmRejection): void {
  writeResponse(res, openAiErrorResponse(failure));
}

async function readBody(req: http.IncomingMessage): Promise<string | LlmRejection> {
  if (Number(req.headers["content-length"]) > LLM_MAX_BODY_BYTES) return TOO_LARGE;
  try {
    return await readRequestBodyWithLimit(req, { maxBytes: LLM_MAX_BODY_BYTES, timeoutMs: BODY_READ_TIMEOUT_MS });
  } catch (error) {
    if (isRequestBodyLimitError(error, "PAYLOAD_TOO_LARGE")) return TOO_LARGE;
    return rejection(400, "invalid_body", "The request body could not be read.");
  }
}

export function createLlmEndpoint(options: LlmEndpointOptions): LlmEndpoint {
  const { api, token } = options;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const hostModel = resolveHostModel(api.config ?? {});
  const runAgent = hostModel ? api.runtime?.agent?.runEmbeddedPiAgent : undefined;
  const modelName = hostModel ? `${hostModel.provider}/${hostModel.model}` : "";

  async function answer(turn: LibraryTurn, signal: AbortSignal): Promise<Completion | LlmRejection> {
    const sessionDir = await mkdtemp(path.join(tmpdir(), "stagewhisper-library-"));
    const runId = `stagewhisper-library-${randomUUID()}`;
    try {
      const result = await runAgent!({
        sessionId: runId,
        sessionFile: path.join(sessionDir, "session.json"),
        runId,
        workspaceDir: api.config?.agents?.defaults?.workspace ?? process.cwd(),
        config: api.config,
        prompt: turn.prompt,
        extraSystemPrompt: turn.extraSystemPrompt || undefined,
        clientTools: turn.clientTools.length > 0 ? turn.clientTools : undefined,
        disableTools: true,
        provider: hostModel!.provider,
        model: hostModel!.model,
        streamParams: turn.maxTokens ? { maxTokens: turn.maxTokens } : undefined,
        timeoutMs: RUN_TIMEOUT_MS,
        abortSignal: signal,
      });
      if (result.meta.error || result.payloads?.some((payload) => payload.isError)) return HOST_ERROR;
      const pending = result.meta.stopReason === "tool_calls" ? (result.meta.pendingToolCalls ?? []) : [];
      return {
        id: `chatcmpl-${randomUUID()}`,
        model: modelName,
        created: Math.floor(Date.now() / 1000),
        content: (result.payloads ?? []).map((payload) => payload.text ?? "").filter(Boolean).join("\n\n"),
        toolCalls: pending.map((call) => ({
          id: `call_${call.id}`,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    } catch (error) {
      api.logger.warn(`[stagewhisper-llm] the Library model run failed: ${error instanceof Error ? error.name : "unknown"}`);
      return HOST_ERROR;
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  }

  async function stream(res: http.ServerResponse, turn: LibraryTurn, signal: AbortSignal): Promise<void> {
    res.writeHead(200, SSE_HEADERS);
    res.write(": keep-alive\n\n");
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), heartbeatMs);
    try {
      const outcome = await answer(turn, signal);
      res.end("ok" in outcome ? sseFrame(openAiError(outcome)) + SSE_DONE : chatCompletionChunks(outcome));
    } finally {
      clearInterval(heartbeat);
    }
  }

  return {
    pingField(): LlmPingField {
      return runAgent ? { api: "chat_completions", model: modelName } : { api: "none" };
    },

    async handle(req, res, normalized): Promise<void> {
      const denied = guardRequest(normalized, token, api.logger);
      if (denied) {
        writeResponse(res, denied);
        return;
      }
      if (!runAgent) {
        send(res, NOT_OFFERED);
        return;
      }
      const body = await readBody(req);
      if (typeof body !== "string") {
        send(res, body);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        send(res, rejection(400, "invalid_json", "The request body is not valid JSON."));
        return;
      }
      const turn = readLibraryTurn(parsed);
      if (!turn.ok) {
        send(res, turn);
        return;
      }
      const controller = new AbortController();
      res.once("close", () => controller.abort());
      if (turn.stream) {
        await stream(res, turn, controller.signal);
        return;
      }
      const outcome = await answer(turn, controller.signal);
      if ("ok" in outcome) {
        send(res, outcome);
        return;
      }
      const json = JSON.stringify(chatCompletionJson(outcome));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(json)) });
      res.end(json);
    },
  };
}
