import { Buffer } from "node:buffer";
import { rejection, type LlmRejection } from "./llm-errors.js";

export const LLM_MAX_BODY_BYTES = 196_608;
export const LLM_MAX_MESSAGES = 200;
export const LLM_MAX_TOOLS = 16;
export const LLM_MAX_TOOL_BYTES = 8_192;
export const LLM_MAX_TOOLS_TOTAL_BYTES = 32_768;
export const LLM_MAX_OUTPUT_TOKENS = 8_192;

const HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
const CURRENT_MESSAGE_MARKER = "[Current message - respond to this]";

type JsonObject = Record<string, unknown>;
type Entry = { role: "user" | "assistant" | "tool"; sender: string; body: string };

export type ClientTool = {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
};

export type LibraryTurn = {
  ok: true;
  prompt: string;
  extraSystemPrompt: string;
  clientTools: ClientTool[];
  stream: boolean;
  maxTokens: number | undefined;
};

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function textOf(content: unknown): string | null {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const part of content) {
    if (!isPlainObject(part) || part.type !== "text" || typeof part.text !== "string") return null;
    texts.push(part.text);
  }
  return texts.join("\n");
}

function toolCallLines(message: JsonObject): Entry[] {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls.filter(isPlainObject).map((call) => {
    const fn = isPlainObject(call.function) ? call.function : {};
    return { role: "assistant", sender: "Assistant", body: `called ${String(fn.name)}(${String(fn.arguments ?? "{}")}) as ${String(call.id)}` };
  });
}

function flatten(entries: Entry[]): string {
  const roles = entries.map((entry) => entry.role);
  const lastIncoming = Math.max(roles.lastIndexOf("user"), roles.lastIndexOf("tool"));
  const current = lastIncoming >= 0 ? lastIncoming : entries.length - 1;
  const latest = entries[current];
  if (!latest) return "";
  const history = entries.slice(0, current).map((entry) => `${entry.sender}: ${entry.body}`);
  if (history.length === 0) return latest.body;
  return [HISTORY_CONTEXT_MARKER, ...history, "", CURRENT_MESSAGE_MARKER, `${latest.sender}: ${latest.body}`].join("\n");
}

function readMessages(messages: unknown): { entries: Entry[]; system: string[] } | LlmRejection {
  if (!Array.isArray(messages) || messages.length === 0) {
    return rejection(400, "invalid_value", "messages must be a non-empty list.", "messages");
  }
  if (messages.length > LLM_MAX_MESSAGES) {
    return rejection(400, "too_many_messages", `A request is limited to ${LLM_MAX_MESSAGES} messages.`, "messages");
  }
  const entries: Entry[] = [];
  const system: string[] = [];
  for (const [index, message] of messages.entries()) {
    const text = isPlainObject(message) ? textOf(message.content) : null;
    if (!isPlainObject(message) || text === null) {
      return rejection(400, "unsupported_content", "Only text content is accepted.", `messages.${index}.content`);
    }
    const body = text.trim();
    if (message.role === "system" || message.role === "developer") {
      if (body) system.push(body);
    } else if (message.role === "user") {
      if (body) entries.push({ role: "user", sender: "User", body });
    } else if (message.role === "assistant") {
      if (body) entries.push({ role: "assistant", sender: "Assistant", body });
      entries.push(...toolCallLines(message));
    } else if (message.role === "tool") {
      entries.push({ role: "tool", sender: `Tool:${String(message.tool_call_id)}`, body });
    } else {
      return rejection(400, "invalid_value", "A message role must be system, user, assistant or tool.", `messages.${index}.role`);
    }
  }
  return { entries, system };
}

function readTools(tools: unknown): ClientTool[] | LlmRejection {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) return rejection(400, "invalid_value", "tools must be a list.", "tools");
  if (tools.length > LLM_MAX_TOOLS) {
    return rejection(400, "too_many_tools", `A request is limited to ${LLM_MAX_TOOLS} tools.`, "tools");
  }
  for (const [index, tool] of tools.entries()) {
    if (!isPlainObject(tool) || tool.type !== "function" || !isPlainObject(tool.function) || typeof tool.function.name !== "string") {
      return rejection(400, "unsupported_tool", "Only named function tools are accepted.", `tools.${index}`);
    }
    if (byteSize(tool) > LLM_MAX_TOOL_BYTES) {
      return rejection(400, "tool_schema_too_large", `Each tool is limited to ${LLM_MAX_TOOL_BYTES} bytes.`, `tools.${index}`);
    }
  }
  if (byteSize(tools) > LLM_MAX_TOOLS_TOTAL_BYTES) {
    return rejection(400, "tool_schema_too_large", `All tools together are limited to ${LLM_MAX_TOOLS_TOTAL_BYTES} bytes.`, "tools");
  }
  return tools as ClientTool[];
}

export function readLibraryTurn(raw: unknown): LibraryTurn | LlmRejection {
  if (!isPlainObject(raw)) return rejection(400, "invalid_json", "The request body must be a JSON object.");
  const messages = readMessages(raw.messages);
  if ("ok" in messages) return messages;
  const tools = readTools(raw.tools);
  if (!Array.isArray(tools)) return tools;
  const prompt = flatten(messages.entries);
  if (!prompt) return rejection(400, "invalid_value", "The conversation has no user message.", "messages");
  const requestedTokens = raw.max_tokens;
  const wantsLimit = typeof requestedTokens === "number" && Number.isInteger(requestedTokens) && requestedTokens > 0;
  return {
    ok: true,
    prompt,
    extraSystemPrompt: messages.system.join("\n\n"),
    clientTools: raw.tool_choice === "none" ? [] : tools,
    stream: raw.stream === true,
    maxTokens: wantsLimit ? Math.min(requestedTokens, LLM_MAX_OUTPUT_TOKENS) : undefined,
  };
}
