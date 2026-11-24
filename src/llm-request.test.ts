import { describe, expect, it } from "vitest";
import {
  LLM_MAX_MESSAGES,
  LLM_MAX_OUTPUT_TOKENS,
  LLM_MAX_TOOL_BYTES,
  LLM_MAX_TOOLS,
  LLM_MAX_TOOLS_TOTAL_BYTES,
  readLibraryTurn,
  type LibraryTurn,
} from "./llm-request.js";
import { AI_SDK_REQUEST, SEARCH_TOOL } from "./fixtures/library-request.js";

function turn(overrides: Record<string, unknown> = {}): LibraryTurn {
  const result = readLibraryTurn({ ...structuredClone(AI_SDK_REQUEST), ...overrides });
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result;
}

function refusal(overrides: Record<string, unknown>) {
  const result = readLibraryTurn({ ...structuredClone(AI_SDK_REQUEST), ...overrides });
  if (result.ok) throw new Error("expected a refusal");
  return result;
}

describe("flattening a Chat Completions request into one agent prompt", () => {
  it("history is flattened the way the gateway does it, with the tool call kept as a line", () => {
    expect(turn().prompt).toBe(
      [
        "[Chat messages since your last reply - for context]",
        "User: What does Sealand need now?",
        "Assistant: Let me look.",
        'Assistant: called searchLibrary({"query":"Sealand"}) as call_abc',
        "",
        "[Current message - respond to this]",
        'Tool:call_abc: {"results":[{"excerptId":"e1"}]}',
      ].join("\n"),
    );
  });

  it("a single user message becomes the prompt as is", () => {
    expect(turn({ messages: [{ role: "user", content: [{ type: "text", text: "Hi there" }] }] }).prompt).toBe("Hi there");
  });

  it("system messages become the extra system prompt and the tools are passed on as client tools", () => {
    const result = turn();
    expect(result.extraSystemPrompt).toBe("Answer only from tool results.");
    expect(result.clientTools).toEqual([SEARCH_TOOL]);
    expect(result.stream).toBe(true);
  });

  it("tool choice none withholds the client tools", () => {
    expect(turn({ tool_choice: "none" }).clientTools).toEqual([]);
  });

  it("max tokens is clamped to the output cap", () => {
    expect(turn({ max_tokens: 1_000_000 }).maxTokens).toBe(LLM_MAX_OUTPUT_TOKENS);
    expect(turn().maxTokens).toBeUndefined();
  });
});

describe("caps on a Library request", () => {
  it("more messages than the cap are refused", () => {
    const messages = Array.from({ length: LLM_MAX_MESSAGES + 1 }, () => ({ role: "user", content: "hi" }));
    expect(refusal({ messages })).toMatchObject({ status: 400, code: "too_many_messages" });
  });

  it("more tools than the cap are refused", () => {
    const tools = Array.from({ length: LLM_MAX_TOOLS + 1 }, (_, index) => ({ type: "function", function: { name: `t${index}` } }));
    expect(refusal({ tools })).toMatchObject({ status: 400, code: "too_many_tools" });
  });

  it("a tool schema over the per-tool or total cap is refused", () => {
    const big = { type: "function", function: { name: "searchLibrary", description: "x".repeat(LLM_MAX_TOOL_BYTES) } };
    expect(refusal({ tools: [big] })).toMatchObject({ code: "tool_schema_too_large", param: "tools.0" });
    const large = { type: "function", function: { name: "searchLibrary", description: "x".repeat(LLM_MAX_TOOL_BYTES - 200) } };
    const many = Array.from({ length: LLM_MAX_TOOLS_TOTAL_BYTES / LLM_MAX_TOOL_BYTES + 1 }, () => large);
    expect(refusal({ tools: many })).toMatchObject({ code: "tool_schema_too_large", param: "tools" });
  });

  it("image parts are refused because only text is accepted", () => {
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://169.254.169.254/" } }] }];
    expect(refusal({ messages })).toMatchObject({ code: "unsupported_content", param: "messages.0.content" });
  });

  it("non function tools and conversations without a user message are refused", () => {
    expect(refusal({ tools: [{ type: "web_search" }] })).toMatchObject({ code: "unsupported_tool" });
    expect(refusal({ messages: [{ role: "system", content: "only rules" }] })).toMatchObject({ code: "invalid_value" });
  });
});
