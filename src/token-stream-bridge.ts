import type { ReplyStreams } from "./reply-streams.js";

export type AgentStreamEvent = {
  runId: string;
  stream: string;
  data: Record<string, unknown>;
};

export type OnAgentEvent = (listener: (evt: AgentStreamEvent) => void) => () => void;

export type TokenStreamTurn = {
  finish(finishReason: string): void;
  dispose(): void;
};

export function resolveOnAgentEvent(runtime: unknown): OnAgentEvent | null {
  const events = (runtime as { events?: { onAgentEvent?: unknown } } | undefined)?.events;
  const onAgentEvent = events?.onAgentEvent;
  return typeof onAgentEvent === "function" ? (onAgentEvent as OnAgentEvent) : null;
}

export type StartTokenStreamTurnParams = {
  onAgentEvent: OnAgentEvent;
  runId: string;
  taskId: string;
  sessionId: string;
  userMessageId: string | null;
  replyStreams: ReplyStreams;
};

export function startTokenStreamTurn(params: StartTokenStreamTurnParams): TokenStreamTurn {
  let textPartId: string | null = null;
  let finished = false;

  const publishChunk = (chunk: Record<string, unknown>): void => {
    params.replyStreams.captureDurable(params.sessionId, {
      task_id: params.taskId,
      session_id: params.sessionId,
      user_message_id: params.userMessageId,
      status: "stream",
      chunk,
    });
  };

  const openTextPart = (): string => {
    if (textPartId) return textPartId;
    textPartId = `${params.taskId}:text:0`;
    publishChunk({ type: "start", messageId: params.taskId });
    publishChunk({ type: "text-start", id: textPartId });
    return textPartId;
  };

  const unsubscribe = params.onAgentEvent((evt) => {
    if (finished) return;
    if (evt.runId !== params.runId || evt.stream !== "assistant") return;
    const delta = evt.data["delta"];
    if (typeof delta !== "string" || delta.length === 0) return;
    const id = openTextPart();
    publishChunk({ type: "text-delta", id, delta });
  });

  return {
    finish(finishReason: string): void {
      if (finished) return;
      finished = true;
      if (textPartId) {
        publishChunk({ type: "text-end", id: textPartId });
        publishChunk({ type: "finish", finishReason });
      }
    },
    dispose(): void {
      unsubscribe();
    },
  };
}
