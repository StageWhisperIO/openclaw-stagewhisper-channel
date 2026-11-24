export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type Completion = {
  id: string;
  model: string;
  created: number;
  content: string;
  toolCalls: ToolCall[];
};

export const SSE_DONE = "data: [DONE]\n\n";

function finishReason(completion: Completion): string {
  return completion.toolCalls.length > 0 ? "tool_calls" : "stop";
}

export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function chatCompletionJson(completion: Completion): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: completion.content || null };
  if (completion.toolCalls.length > 0) message.tool_calls = completion.toolCalls;
  return {
    id: completion.id,
    object: "chat.completion",
    created: completion.created,
    model: completion.model,
    choices: [{ index: 0, message, finish_reason: finishReason(completion) }],
  };
}

export function chatCompletionChunks(completion: Completion): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
    sseFrame({
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  const deltas = [
    { role: "assistant", content: completion.content },
    ...completion.toolCalls.map((call, index) => ({ tool_calls: [{ index, ...call }] })),
  ];
  return deltas.map((delta) => chunk(delta)).join("") + chunk({}, finishReason(completion)) + SSE_DONE;
}
