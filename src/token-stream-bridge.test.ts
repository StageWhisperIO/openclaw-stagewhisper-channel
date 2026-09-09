import { describe, expect, it } from "vitest";
import { ReplyStreams } from "./reply-streams.js";
import {
  resolveOnAgentEvent,
  startTokenStreamTurn,
  type AgentStreamEvent,
} from "./token-stream-bridge.js";

const TASK_ID = "task-1";
const SESSION_ID = "session-1";
const RUN_ID = "run-1";

function makeEmitter(): {
  onAgentEvent: (listener: (evt: AgentStreamEvent) => void) => () => void;
  emit: (evt: AgentStreamEvent) => void;
  listenerCount: () => number;
} {
  const listeners = new Set<(evt: AgentStreamEvent) => void>();
  return {
    onAgentEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (evt) => {
      for (const listener of listeners) listener(evt);
    },
    listenerCount: () => listeners.size,
  };
}

function streamChunks(streams: ReplyStreams, sessionId: string): Record<string, unknown>[] {
  return streams
    .retained(sessionId)
    .map((entry) => entry.payload)
    .filter((payload) => payload["status"] === "stream")
    .map((payload) => payload["chunk"] as Record<string, unknown>);
}

describe("startTokenStreamTurn", () => {
  it("emits a start and text-start chunk exactly once on the first delta of the turn", () => {
    const streams = new ReplyStreams();
    const emitter = makeEmitter();
    const turn = startTokenStreamTurn({
      onAgentEvent: emitter.onAgentEvent,
      runId: RUN_ID,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      userMessageId: "um-1",
      replyStreams: streams,
    });

    emitter.emit({ runId: RUN_ID, stream: "assistant", data: { text: "Hel", delta: "Hel" } });
    emitter.emit({ runId: RUN_ID, stream: "assistant", data: { text: "Hello", delta: "lo" } });

    const chunks = streamChunks(streams, SESSION_ID);
    const startChunks = chunks.filter((chunk) => chunk["type"] === "start");
    const textStartChunks = chunks.filter((chunk) => chunk["type"] === "text-start");
    expect(startChunks).toHaveLength(1);
    expect(startChunks[0]).toEqual({ type: "start", messageId: TASK_ID });
    expect(textStartChunks).toHaveLength(1);

    turn.dispose();
  });

  it("forwards each delta verbatim instead of accumulating cumulative text", () => {
    const streams = new ReplyStreams();
    const emitter = makeEmitter();
    const turn = startTokenStreamTurn({
      onAgentEvent: emitter.onAgentEvent,
      runId: RUN_ID,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      userMessageId: null,
      replyStreams: streams,
    });

    emitter.emit({ runId: RUN_ID, stream: "assistant", data: { text: "Hel", delta: "Hel" } });
    emitter.emit({ runId: RUN_ID, stream: "assistant", data: { text: "Hello there", delta: "lo there" } });

    const deltaChunks = streamChunks(streams, SESSION_ID).filter(
      (chunk) => chunk["type"] === "text-delta",
    );
    expect(deltaChunks.map((chunk) => chunk["delta"])).toEqual(["Hel", "lo there"]);
    const ids = new Set(deltaChunks.map((chunk) => chunk["id"]));
    expect(ids.size).toBe(1);

    turn.dispose();
  });

  it("emits text-end followed by finish when the turn ends after streaming a delta", () => {
    const streams = new ReplyStreams();
    const emitter = makeEmitter();
    const turn = startTokenStreamTurn({
      onAgentEvent: emitter.onAgentEvent,
      runId: RUN_ID,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      userMessageId: null,
      replyStreams: streams,
    });

    emitter.emit({ runId: RUN_ID, stream: "assistant", data: { text: "Hi", delta: "Hi" } });
    turn.finish("stop");

    const chunks = streamChunks(streams, SESSION_ID);
    const types = chunks.map((chunk) => chunk["type"]);
    expect(types.slice(-2)).toEqual(["text-end", "finish"]);
    expect(chunks[chunks.length - 1]).toEqual({ type: "finish", finishReason: "stop" });

    turn.dispose();
  });

  it("does not emit any chunk when the turn ends without ever streaming a delta", () => {
    const streams = new ReplyStreams();
    const emitter = makeEmitter();
    const turn = startTokenStreamTurn({
      onAgentEvent: emitter.onAgentEvent,
      runId: RUN_ID,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      userMessageId: null,
      replyStreams: streams,
    });

    turn.finish("stop");

    expect(streamChunks(streams, SESSION_ID)).toEqual([]);

    turn.dispose();
  });

  it("does not emit a second finish chunk when finish is called more than once", () => {
    const streams = new ReplyStreams();
    const emitter = makeEmitter();
    const turn = startTokenStreamTurn({
      onAgentEvent: emitter.onAgentEvent,
      runId: RUN_ID,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      userMessageId: null,
      replyStreams: streams,
    });

    emitter.emit({ runId: RUN_ID, stream: "assistant", data: { text: "Hi", delta: "Hi" } });
    turn.finish("stop");
    turn.finish("error");

    const finishChunks = streamChunks(streams, SESSION_ID).filter(
      (chunk) => chunk["type"] === "finish",
    );
    expect(finishChunks).toHaveLength(1);

    turn.dispose();
  });

  it("ignores agent events from a run other than the one it was started for", () => {
    const streams = new ReplyStreams();
    const emitter = makeEmitter();
    const turn = startTokenStreamTurn({
      onAgentEvent: emitter.onAgentEvent,
      runId: RUN_ID,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      userMessageId: null,
      replyStreams: streams,
    });

    emitter.emit({ runId: "some-other-run", stream: "assistant", data: { text: "x", delta: "x" } });

    expect(streamChunks(streams, SESSION_ID)).toEqual([]);

    turn.dispose();
  });

  it("ignores agent events that are not on the assistant stream", () => {
    const streams = new ReplyStreams();
    const emitter = makeEmitter();
    const turn = startTokenStreamTurn({
      onAgentEvent: emitter.onAgentEvent,
      runId: RUN_ID,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      userMessageId: null,
      replyStreams: streams,
    });

    emitter.emit({ runId: RUN_ID, stream: "tool", data: { text: "x", delta: "x" } });
    emitter.emit({ runId: RUN_ID, stream: "lifecycle", data: {} });

    expect(streamChunks(streams, SESSION_ID)).toEqual([]);

    turn.dispose();
  });

  it("stops forwarding deltas once disposed", () => {
    const streams = new ReplyStreams();
    const emitter = makeEmitter();
    const turn = startTokenStreamTurn({
      onAgentEvent: emitter.onAgentEvent,
      runId: RUN_ID,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      userMessageId: null,
      replyStreams: streams,
    });

    turn.dispose();
    expect(emitter.listenerCount()).toBe(0);
    emitter.emit({ runId: RUN_ID, stream: "assistant", data: { text: "x", delta: "x" } });

    expect(streamChunks(streams, SESSION_ID)).toEqual([]);
  });
});

describe("resolveOnAgentEvent", () => {
  it("returns the runtime's onAgentEvent function when the runtime exposes one", () => {
    const onAgentEvent = () => () => {};
    const resolved = resolveOnAgentEvent({ events: { onAgentEvent } });
    expect(resolved).toBe(onAgentEvent);
  });

  it("returns null when the runtime does not expose an events surface", () => {
    expect(resolveOnAgentEvent({})).toBeNull();
    expect(resolveOnAgentEvent(undefined)).toBeNull();
  });
});
