import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildAgentSessionKey } from "./openclaw-lite.js";

export type TaskPayload = {
  id: string;
  session_id: string;
  title: string;
  request_text: string;
  action_type: string;
  status: string;
  evidence_payload: Record<string, unknown> | null;
  created_at: string;
};

export const TASK_ID_REGEX = /^[0-9a-f-]{36}$/;
export const LOOPBACK_CALLBACK_URL_REGEX =
  /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/;
export const ALLOWED_REASONS = new Set([
  "transcript_chunk",
  "chat_message",
  "system_prelude",
]);
export const MAX_BODY_BYTES = 262_144;
export const MAX_PAYLOAD_TEXT_CHARS = 16000;
export const MAX_SESSION_ID_CHARS = 128;
export const ALLOWED_HOSTNAMES = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "::ffff:127.0.0.1",
]);

export function isTestTask(task: TaskPayload): boolean {
  return task.action_type === "connectivity_test";
}

export function buildTaskMessage(task: TaskPayload): string {
  const lines: string[] = [];
  lines.push(`**${task.title}**`);
  lines.push("");
  lines.push(task.request_text);

  if (task.evidence_payload) {
    const evidence = task.evidence_payload;
    if (evidence["transcript_excerpt"]) {
      lines.push("");
      lines.push(`Context: ${evidence["transcript_excerpt"]}`);
    }
    if (evidence["signal_summary"]) {
      lines.push(`Signal: ${evidence["signal_summary"]}`);
    }
    if (evidence["tone_summary"]) {
      lines.push(`Tone: ${evidence["tone_summary"]}`);
    }
    if (evidence["playbook_label"]) {
      lines.push(`Playbook: ${evidence["playbook_label"]}`);
    }
  }

  lines.push("");
  lines.push(`Action type: ${task.action_type}`);
  lines.push(`StageWhisper task: ${task.id}`);
  lines.push(`Session: ${task.session_id}`);

  return lines.join("\n");
}

export type DispatchOptions = {
  api: OpenClawPluginApi;
  task: TaskPayload;
  deliver?: boolean;
  idempotencyKey?: string;
  sessionPeerId?: string;
};

export type DispatchResult = {
  runId: string;
  sessionKey: string;
};

export async function dispatchTaskToAgent(
  options: DispatchOptions,
): Promise<DispatchResult> {
  const { api, task } = options;
  const peerId =
    options.sessionPeerId ??
    (isTestTask(task) ? `sw-test-${task.id}` : `sw-session-${task.session_id}`);

  const sessionKey = buildAgentSessionKey({
    agentId: "default",
    channel: "stagewhisper",
    peer: { kind: "direct", id: peerId },
    dmScope: "per-channel-peer",
  });

  const messageContent = buildTaskMessage(task);

  const result = await api.runtime.subagent.run({
    sessionKey,
    message: messageContent,
    deliver: options.deliver ?? !isTestTask(task),
    idempotencyKey: options.idempotencyKey ?? `sw-task-${task.id}`,
  });

  return { runId: result.runId, sessionKey };
}

export type RelayCallback = {
  url: string;
  token: string;
};

export type HttpTaskRequest = {
  task_id: string;
  session_id: string;
  reason: string;
  chat_id?: string;
  occurred_at?: string;
  payload: {
    text: string;
    ts_start_ms?: number;
    ts_end_ms?: number;
    is_final?: boolean;
    user_message_id?: string;
  };
  callback?: RelayCallback;
};

export type ValidationResult =
  | { ok: true; req: HttpTaskRequest }
  | { ok: false; error: string };

export function isLoopbackCallbackUrl(url: string): boolean {
  return LOOPBACK_CALLBACK_URL_REGEX.test(url);
}

function normalizeOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.origin.toLowerCase();
}

export function allowedCallbackOrigins(): Set<string> {
  const raw = process.env["STAGEWHISPER_ALLOW_CALLBACK_URLS"];
  if (!raw) return new Set();
  const origins = raw
    .split(",")
    .map((entry) => normalizeOrigin(entry.trim()))
    .filter((origin): origin is string => origin !== null);
  return new Set(origins);
}

export function isAllowedCallbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return false;
  if (parsed.search || parsed.hash) return false;
  if (allowedCallbackOrigins().has(parsed.origin.toLowerCase())) return true;
  if (allowedIngressHosts().size === 0 && isLoopbackCallbackUrl(url)) return true;
  return false;
}

export function allowedIngressHosts(): Set<string> {
  const raw = process.env["STAGEWHISPER_ALLOW_INGRESS_HOSTS"];
  if (!raw) return new Set();
  const hosts = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return new Set(hosts);
}

function splitHostHeader(trimmed: string): { hostname: string; port: string } | null {
  if (trimmed.startsWith("[")) {
    const closeIdx = trimmed.indexOf("]");
    if (closeIdx === -1) return null;
    const hostname = trimmed.slice(1, closeIdx);
    const rest = trimmed.slice(closeIdx + 1);
    if (rest === "") return { hostname, port: "" };
    if (rest.startsWith(":")) return { hostname, port: rest.slice(1) };
    return null;
  }
  const colonIdx = trimmed.lastIndexOf(":");
  return {
    hostname: colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx),
    port: colonIdx === -1 ? "" : trimmed.slice(colonIdx + 1),
  };
}

export function isAllowedHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return false;
  const parsed = splitHostHeader(trimmed);
  if (!parsed) return false;
  const { hostname, port } = parsed;
  if (port && !/^\d+$/.test(port)) return false;
  if (ALLOWED_HOSTNAMES.has(hostname)) return true;
  return allowedIngressHosts().has(hostname);
}

export function buildChatId(sessionId: string, reason: string): string | null {
  if (reason === "transcript_chunk") return `sw:${sessionId}:reasoning`;
  if (reason === "chat_message") return `sw:${sessionId}:chat`;
  return null;
}

export function buildCallbackUrl(baseUrl: string, taskId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/tasks/${taskId}`;
}

export function applyPrelude(text: string, prelude: string | undefined): string {
  if (!prelude) return text;
  return `[Context: ${prelude}]\n\n${text}`;
}

export function validateHttpTaskRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const obj = body as Record<string, unknown>;
  const task_id = obj["task_id"];
  if (typeof task_id !== "string" || task_id.length === 0) {
    return { ok: false, error: "task_id must be a non-empty string" };
  }
  if (!TASK_ID_REGEX.test(task_id)) {
    return { ok: false, error: "task_id must match ^[0-9a-f-]{36}$" };
  }
  const session_id = obj["session_id"];
  if (typeof session_id !== "string" || session_id.length === 0) {
    return { ok: false, error: "session_id must be a non-empty string" };
  }
  if (session_id.length > MAX_SESSION_ID_CHARS) {
    return {
      ok: false,
      error: `session_id must be <= ${MAX_SESSION_ID_CHARS} chars`,
    };
  }
  const reason = obj["reason"];
  if (typeof reason !== "string" || reason.length === 0) {
    return { ok: false, error: "reason must be a non-empty string" };
  }
  if (!ALLOWED_REASONS.has(reason)) {
    return {
      ok: false,
      error: `reason must be one of ${Array.from(ALLOWED_REASONS).join(", ")}`,
    };
  }
  const payload = obj["payload"];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "payload must be an object" };
  }
  const payloadObj = payload as Record<string, unknown>;
  const text = payloadObj["text"];
  if (typeof text !== "string") {
    return { ok: false, error: "payload.text must be a string" };
  }
  if (text.length > MAX_PAYLOAD_TEXT_CHARS) {
    return {
      ok: false,
      error: `payload.text must be <= ${MAX_PAYLOAD_TEXT_CHARS} chars`,
    };
  }

  let callback: RelayCallback | undefined;
  const callbackRaw = obj["callback"];
  if (callbackRaw !== undefined && callbackRaw !== null) {
    if (typeof callbackRaw !== "object" || Array.isArray(callbackRaw)) {
      return { ok: false, error: "callback must be an object" };
    }
    const cbObj = callbackRaw as Record<string, unknown>;
    const cbUrl = cbObj["url"];
    const cbToken = cbObj["token"];
    if (typeof cbUrl !== "string" || cbUrl.length === 0) {
      return { ok: false, error: "callback.url must be a non-empty string" };
    }
    if (!isAllowedCallbackUrl(cbUrl)) {
      return {
        ok: false,
        error:
          "callback.url must be a loopback base URL (http://127.0.0.1:PORT) or an origin listed in STAGEWHISPER_ALLOW_CALLBACK_URLS, with no path",
      };
    }
    if (typeof cbToken !== "string" || cbToken.length < 16) {
      return {
        ok: false,
        error: "callback.token must be a string of length >= 16",
      };
    }
    callback = { url: cbUrl, token: cbToken };
  }

  const chatIdRaw = obj["chat_id"];
  const chat_id =
    typeof chatIdRaw === "string" && chatIdRaw.length > 0
      ? chatIdRaw
      : buildChatId(session_id, reason) ?? undefined;

  const req: HttpTaskRequest = {
    task_id,
    session_id,
    reason,
    ...(chat_id ? { chat_id } : {}),
    occurred_at:
      typeof obj["occurred_at"] === "string"
        ? (obj["occurred_at"] as string)
        : undefined,
    payload: {
      text,
      ts_start_ms:
        typeof payloadObj["ts_start_ms"] === "number"
          ? (payloadObj["ts_start_ms"] as number)
          : undefined,
      ts_end_ms:
        typeof payloadObj["ts_end_ms"] === "number"
          ? (payloadObj["ts_end_ms"] as number)
          : undefined,
      is_final:
        typeof payloadObj["is_final"] === "boolean"
          ? (payloadObj["is_final"] as boolean)
          : undefined,
      user_message_id:
        typeof payloadObj["user_message_id"] === "string"
          ? (payloadObj["user_message_id"] as string)
          : undefined,
    },
    ...(callback ? { callback } : {}),
  };
  return { ok: true, req };
}

export function httpTaskRequestToTaskPayload(
  req: HttpTaskRequest,
  overrides?: { text?: string },
): TaskPayload | null {
  if (req.reason === "system_prelude") return null;

  const text = overrides?.text ?? req.payload.text;

  const evidence: Record<string, unknown> = {
    transcript_excerpt: text,
  };
  if (typeof req.payload.ts_start_ms === "number") {
    evidence["ts_start_ms"] = req.payload.ts_start_ms;
  }
  if (typeof req.payload.ts_end_ms === "number") {
    evidence["ts_end_ms"] = req.payload.ts_end_ms;
  }
  if (typeof req.payload.is_final === "boolean") {
    evidence["is_final"] = req.payload.is_final;
  }
  if (typeof req.payload.user_message_id === "string") {
    evidence["user_message_id"] = req.payload.user_message_id;
  }
  if (req.chat_id) {
    evidence["chat_id"] = req.chat_id;
  }

  const isChat = req.reason === "chat_message";

  return {
    id: req.task_id,
    session_id: req.session_id,
    title: isChat
      ? `Chat message in session ${req.session_id}`
      : `Transcript chunk from session ${req.session_id}`,
    request_text: text,
    action_type: req.reason,
    status: "delivered",
    evidence_payload: evidence,
    created_at: req.occurred_at ?? new Date().toISOString(),
  };
}
