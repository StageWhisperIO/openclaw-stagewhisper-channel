import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { applyPrelude, dispatchTaskToAgent, httpTaskRequestToTaskPayload, type HttpTaskRequest, type RelayCallback } from "./core.js";
import { buildAgentSessionKey } from "./openclaw-lite.js";
import type { ReplyStreams } from "./reply-streams.js";
import { retryCallback } from "./callback-delivery.js";
import { buildCallbackAttempt } from "./callback-attempt.js";
import {
  deliverCompletedReply,
  deliverErroredReply,
  releaseInflightForMissingTaskPayload,
} from "./reply-task-errors.js";
import { resolveOnAgentEvent, startTokenStreamTurn } from "./token-stream-bridge.js";

const POLL_INTERVAL_MS = 500;
const SUBAGENT_WAIT_TIMEOUT_MS = 120_000;

type RuntimeEvents = {
  onSessionTranscriptUpdate?: (
    listener: (update: {
      sessionKey?: string;
      message?: unknown;
      messageId?: string;
    }) => void,
  ) => () => void;
};

function resolveRuntimeEvents(api: OpenClawPluginApi): RuntimeEvents | null {
  const runtime = api.runtime as unknown as { events?: RuntimeEvents };
  const events = runtime?.events;
  if (!events) return null;
  if (typeof events.onSessionTranscriptUpdate !== "function") return null;
  return events;
}

function extractContentFromMessage(msg: Record<string, unknown>): string | null {
  const content = msg["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>)["type"] === "text" &&
        typeof (part as Record<string, unknown>)["text"] === "string"
      ) {
        return (part as Record<string, unknown>)["text"] as string;
      }
    }
  }
  return null;
}

export type ReplyTaskDeps = {
  api: OpenClawPluginApi;
  callbackFetch: typeof fetch;
  replyStreams: ReplyStreams;
  consumePrelude: (sessionId: string) => string | undefined;
  releaseInflight: (taskId: string) => void;
};

export function createReplyTaskRunner(deps: ReplyTaskDeps) {
  const { api, callbackFetch, replyStreams, consumePrelude, releaseInflight } = deps;

  async function collectAssistantRepliesAfterMarker(
    sessionKey: string,
    markers: string[],
  ): Promise<string[]> {
    const session = await api.runtime.subagent.getSessionMessages({
      sessionKey,
      limit: 100,
    });
    const messages = session.messages as Record<string, unknown>[];

    let markerIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg["role"] !== "user") continue;
      const text = extractContentFromMessage(msg) ?? "";
      if (markers.some((m) => text.includes(m))) {
        markerIndex = i;
        break;
      }
    }
    if (markerIndex === -1) return [];

    const replies: string[] = [];
    for (let j = markerIndex + 1; j < messages.length; j++) {
      const msg = messages[j];
      const role = msg["role"];
      if (role === "user") break;
      if (role === "assistant" || role === "model") {
        const text = extractContentFromMessage(msg);
        if (text) replies.push(text);
      }
    }
    return replies;
  }

  function callbackAttempt(
    callback: RelayCallback,
    taskId: string,
    body: Record<string, unknown>,
    recordError: (error: unknown) => void,
  ) {
    return buildCallbackAttempt(callback, taskId, body, callbackFetch, recordError);
  }

  async function postCallback(
    callback: RelayCallback,
    taskId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    let lastError: unknown = null;
    const attempt = callbackAttempt(callback, taskId, body, (error) => {
      lastError = error;
    });
    if (await retryCallback(attempt)) return;
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "callback_failed"));
  }

  async function postStatusCallbackOnce(
    callback: RelayCallback,
    taskId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    let lastError: unknown = null;
    const attempt = callbackAttempt(callback, taskId, body, (error) => {
      lastError = error;
    });
    if ((await attempt()) === "delivered") return;
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "callback_failed"));
  }

  async function deliverReply(
    callback: RelayCallback | undefined,
    sessionId: string,
    taskId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    if (!callback) {
      if (!replyStreams.captureDurable(sessionId, body)) {
        replyStreams.captureDurable(sessionId, {
          task_id: taskId,
          session_id: sessionId,
          user_message_id: body["user_message_id"] ?? null,
          status: "errored",
          error_code: "reply_too_large",
          error_message: "assistant reply exceeded the stream retention limit",
        });
      }
      return;
    }
    await postCallback(callback, taskId, body);
  }

  async function runReplyTaskAsync(
    taskRequest: HttpTaskRequest,
    kind: "chat" | "reasoning",
  ): Promise<void> {
    const callback = taskRequest.callback;
    const userMessageId = taskRequest.payload.user_message_id;
    const effectiveText = applyPrelude(
      taskRequest.payload.text,
      consumePrelude(taskRequest.session_id),
    );
    const taskPayload = httpTaskRequestToTaskPayload(taskRequest, {
      text: effectiveText,
    });
    if (!taskPayload) {
      await releaseInflightForMissingTaskPayload(
        {
          kind,
          taskId: taskRequest.task_id,
          sessionId: taskRequest.session_id,
          userMessageId,
          callback,
        },
        {
          logError: (message) => api.logger.error(message),
          deliverReply,
          releaseInflight,
        },
      );
      return;
    }
    const peerId = `sw:${taskRequest.session_id}:${kind}`;
    const sessionKey = buildAgentSessionKey({
      agentId: "default",
      channel: "stagewhisper",
      peer: { kind: "direct", id: peerId },
      dmScope: "per-channel-peer",
    });
    const markers = [`StageWhisper task: ${taskRequest.task_id}`];
    if (userMessageId) markers.push(`[StageWhisper chat: ${userMessageId}]`);

    const forwardedContents: string[] = [];

    const postMessage = async (
      replyText: string,
      replyIndex: number,
    ): Promise<void> => {
      const messageId = `${taskRequest.task_id}:msg:${replyIndex}`;
      const body: Record<string, unknown> = {
        task_id: taskRequest.task_id,
        session_id: taskRequest.session_id,
        user_message_id: userMessageId ?? null,
        message_id: messageId,
        status: "message",
        reply_text: replyText,
        occurred_at: new Date().toISOString(),
      };
      try {
        await deliverReply(callback, taskRequest.session_id, taskRequest.task_id, body);
        api.logger.info(
          `[stagewhisper-http] ${kind} task ${taskRequest.task_id} forwarded message ${messageId}`,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        api.logger.error(
          `[stagewhisper-http] callback POST failed for ${taskRequest.task_id}: ${errMsg}`,
        );
      }
    };

    const postTyping = async (): Promise<void> => {
      const body = {
        task_id: taskRequest.task_id,
        session_id: taskRequest.session_id,
        user_message_id: userMessageId ?? null,
        status: "typing",
        label: "thinking",
      };
      if (!callback) {
        replyStreams.publishTransient(taskRequest.session_id, body);
        return;
      }
      try {
        await postStatusCallbackOnce(callback, taskRequest.task_id, body);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        api.logger.warn(
          `[stagewhisper-http] typing callback failed for ${taskRequest.task_id}: ${errMsg}`,
        );
      }
    };

    const events = resolveRuntimeEvents(api);
    const onAgentEvent = resolveOnAgentEvent(api.runtime);
    let unsubscribeTranscript: (() => void) | null = null;
    let tokenStream: ReturnType<typeof startTokenStreamTurn> | null = null;
    let pollDone = false;
    let flushing: Promise<void> | null = null;
    let flushQueued = false;
    let wakePoll: () => void = () => {};

    const sleepUntilPoll = (): Promise<void> =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wakePoll = () => {};
          resolve();
        }, POLL_INTERVAL_MS);
        wakePoll = () => {
          clearTimeout(timer);
          wakePoll = () => {};
          resolve();
        };
      });

    const runFlushOnce = async (): Promise<void> => {
      try {
        const replies = await collectAssistantRepliesAfterMarker(sessionKey, markers);
        for (let i = 0; i < replies.length; i++) {
          const reply = replies[i];
          if (forwardedContents[i] !== undefined) {
            if (forwardedContents[i] !== reply) {
              api.logger.warn(
                `[stagewhisper-http] ${kind} task ${taskRequest.task_id} assistant message ${i} changed after forwarding; keeping the first finalized text`,
              );
            }
            continue;
          }
          if (!reply.trim()) continue;
          forwardedContents[i] = reply;
          await postMessage(reply, i);
        }
      } catch (err) {
        api.logger.warn(
          `[stagewhisper-http] session flush failed for ${taskRequest.task_id}: ${err}`,
        );
      }
    };

    const flushFromSession = async (): Promise<void> => {
      if (flushing) {
        flushQueued = true;
        await flushing;
        return;
      }
      flushing = (async () => {
        await runFlushOnce();
        while (flushQueued) {
          flushQueued = false;
          await runFlushOnce();
        }
      })();
      try {
        await flushing;
      } finally {
        flushing = null;
      }
    };

    try {
      const dispatch = await dispatchTaskToAgent({
        api,
        task: taskPayload,
        deliver: true,
        idempotencyKey: `sw-http-task-${taskRequest.task_id}`,
        sessionPeerId: peerId,
      });
      api.logger.info(
        `[stagewhisper-http] ${kind} task ${taskRequest.task_id} dispatched (runId: ${dispatch.runId})`,
      );
      const runId = dispatch.runId;

      if (onAgentEvent && !callback) {
        tokenStream = startTokenStreamTurn({
          onAgentEvent,
          runId,
          taskId: taskRequest.task_id,
          sessionId: taskRequest.session_id,
          userMessageId: userMessageId ?? null,
          replyStreams,
        });
      }

      await postTyping();

      if (events?.onSessionTranscriptUpdate) {
        unsubscribeTranscript = events.onSessionTranscriptUpdate((update) => {
          if (update.sessionKey && update.sessionKey !== sessionKey) return;
          const message = update.message as Record<string, unknown> | undefined;
          const role = message?.["role"];
          if (role !== undefined && role !== "assistant" && role !== "model") {
            return;
          }
          void flushFromSession();
        });
      }

      let pollLoop: Promise<void> = Promise.resolve();
      if (!events?.onSessionTranscriptUpdate) {
        pollLoop = (async () => {
          while (!pollDone) {
            await sleepUntilPoll();
            if (pollDone) break;
            await flushFromSession();
          }
        })();
      }

      const waitResult = await api.runtime.subagent.waitForRun({
        runId,
        timeoutMs: SUBAGENT_WAIT_TIMEOUT_MS,
      });

      pollDone = true;
      wakePoll();
      await pollLoop;

      await flushFromSession();

      tokenStream?.finish(waitResult.status === "ok" ? "stop" : "error");

      const reportErroredReply = (errorCode: string, errorMessage: string): Promise<void> =>
        deliverErroredReply(
          {
            taskId: taskRequest.task_id,
            sessionId: taskRequest.session_id,
            userMessageId,
            errorCode,
            errorMessage,
          },
          callback,
          deliverReply,
          (postErr) =>
            api.logger.error(
              `[stagewhisper-http] errored callback failed for ${taskRequest.task_id}: ${postErr}`,
            ),
        );

      if (waitResult.status === "error") {
        api.logger.error(
          `[stagewhisper-http] ${kind} task ${taskRequest.task_id} agent error: ${waitResult.error}`,
        );
        await reportErroredReply("agent_error", waitResult.error ?? "agent run error");
      } else if (waitResult.status !== "ok") {
        api.logger.warn(
          `[stagewhisper-http] ${kind} task ${taskRequest.task_id} did not settle (${waitResult.status}); sending terminal callback`,
        );
        await reportErroredReply(
          `agent_${waitResult.status}`,
          `agent run did not complete (${waitResult.status})`,
        );
      } else {
        api.logger.info(`[stagewhisper-http] ${kind} task ${taskRequest.task_id} turn settled (ok)`);
        await deliverCompletedReply(
          { taskId: taskRequest.task_id, sessionId: taskRequest.session_id, userMessageId },
          callback,
          deliverReply,
          (postErr) =>
            api.logger.error(
              `[stagewhisper-http] completed callback failed for ${taskRequest.task_id}: ${postErr}`,
            ),
        );
      }
    } catch (err) {
      tokenStream?.finish("error");
      const errMsg = err instanceof Error ? err.message : String(err);
      api.logger.error(`[stagewhisper-http] ${kind} task ${taskRequest.task_id} threw: ${errMsg}`);
      await deliverErroredReply(
        {
          taskId: taskRequest.task_id,
          sessionId: taskRequest.session_id,
          userMessageId,
          errorCode: "execution_error",
          errorMessage: errMsg,
        },
        callback,
        deliverReply,
        (postErr) =>
          api.logger.error(
            `[stagewhisper-http] errored callback failed for ${taskRequest.task_id}: ${postErr}`,
          ),
      );
    } finally {
      pollDone = true;
      wakePoll();
      unsubscribeTranscript?.();
      tokenStream?.dispose();
      releaseInflight(taskRequest.task_id);
    }
  }

  return { runReplyTaskAsync };
}
