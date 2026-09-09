import type { RelayCallback } from "./core.js";

export type ErroredReplyFields = {
  taskId: string;
  sessionId: string;
  userMessageId: unknown;
  errorCode: string;
  errorMessage: string;
};

export type DeliverReplyFn = (
  callback: RelayCallback | undefined,
  sessionId: string,
  taskId: string,
  body: Record<string, unknown>,
) => Promise<void>;

export function buildErroredReplyBody(fields: ErroredReplyFields): Record<string, unknown> {
  return {
    task_id: fields.taskId,
    session_id: fields.sessionId,
    user_message_id: fields.userMessageId ?? null,
    status: "errored",
    error_code: fields.errorCode,
    error_message: fields.errorMessage,
  };
}

export async function deliverErroredReply(
  fields: ErroredReplyFields,
  callback: RelayCallback | undefined,
  deliverReply: DeliverReplyFn,
  onDeliveryFailure: (error: unknown) => void,
): Promise<void> {
  try {
    await deliverReply(callback, fields.sessionId, fields.taskId, buildErroredReplyBody(fields));
  } catch (err) {
    onDeliveryFailure(err);
  }
}

export type CompletedReplyFields = {
  taskId: string;
  sessionId: string;
  userMessageId: unknown;
};

export function buildCompletedReplyBody(fields: CompletedReplyFields): Record<string, unknown> {
  return {
    task_id: fields.taskId,
    session_id: fields.sessionId,
    user_message_id: fields.userMessageId ?? null,
    status: "completed",
    occurred_at: new Date().toISOString(),
  };
}

export async function deliverCompletedReply(
  fields: CompletedReplyFields,
  callback: RelayCallback | undefined,
  deliverReply: DeliverReplyFn,
  onDeliveryFailure: (error: unknown) => void,
): Promise<void> {
  try {
    await deliverReply(callback, fields.sessionId, fields.taskId, buildCompletedReplyBody(fields));
  } catch (err) {
    onDeliveryFailure(err);
  }
}

export type MissingTaskPayloadContext = {
  kind: "chat" | "reasoning";
  taskId: string;
  sessionId: string;
  userMessageId: unknown;
  callback: RelayCallback | undefined;
};

export type MissingTaskPayloadDeps = {
  logError: (message: string) => void;
  deliverReply: DeliverReplyFn;
  releaseInflight: (taskId: string) => void;
};

export async function releaseInflightForMissingTaskPayload(
  context: MissingTaskPayloadContext,
  deps: MissingTaskPayloadDeps,
): Promise<void> {
  deps.logError(
    `[stagewhisper-http] ${context.kind} task ${context.taskId} produced no payload`,
  );
  await deliverErroredReply(
    {
      taskId: context.taskId,
      sessionId: context.sessionId,
      userMessageId: context.userMessageId,
      errorCode: "invalid_task_payload",
      errorMessage: "task payload could not be constructed",
    },
    context.callback,
    deps.deliverReply,
    (err) =>
      deps.logError(
        `[stagewhisper-http] errored callback failed for ${context.taskId}: ${err}`,
      ),
  );
  deps.releaseInflight(context.taskId);
}
