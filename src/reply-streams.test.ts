import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { notifySubscriber, ReplyStreams, type Subscriber } from "./reply-streams.js";

type UnicodeByteScenario = {
  name: string;
  maxEventBytes: number;
  backlogBytesPerSession: number;
  captures: { taskId: string; textUnit: string; repeat: number }[];
  expectedCaptureResults: boolean[];
  expectedSizes: number[];
  expectedTaskIds: string[];
};

type ReplyStreamContract = {
  unicodeByteScenarios: UnicodeByteScenario[];
};

const contract = JSON.parse(
  readFileSync(new URL("../../reply-stream-contract.json", import.meta.url), "utf8"),
) as ReplyStreamContract;

function payload(taskId: string): Record<string, unknown> {
  return { task_id: taskId, text: `reply for ${taskId}` };
}

function drainedTaskIds(streams: ReplyStreams, subscriber: Subscriber): string[] {
  return streams.drain(subscriber).entries.map((entry) => entry.payload["task_id"] as string);
}

describe("resuming a dropped stream", () => {
  it("replays only the entries a reconnecting subscriber has not already seen", () => {
    const streams = new ReplyStreams({ epoch: "e1" });
    streams.captureDurable("session-a", payload("t1"));
    streams.captureDurable("session-a", payload("t2"));

    const first = streams.subscribe("session-a")!;
    const seen = streams.drain(first).entries;
    expect(seen.map((entry) => entry.payload["task_id"])).toEqual(["t1", "t2"]);
    streams.unsubscribe(first);

    streams.captureDurable("session-a", payload("t3"));

    const resumed = streams.subscribe("session-a", seen[seen.length - 1].id)!;
    expect(drainedTaskIds(streams, resumed)).toEqual(["t3"]);
  });

  it("replays nothing when the cursor is already at the newest entry", () => {
    const streams = new ReplyStreams({ epoch: "e1" });
    streams.captureDurable("session-a", payload("t1"));

    const first = streams.subscribe("session-a")!;
    const seen = streams.drain(first).entries;
    streams.unsubscribe(first);

    const resumed = streams.subscribe("session-a", seen[0].id)!;
    expect(drainedTaskIds(streams, resumed)).toEqual([]);
  });

  it("replays the whole backlog when the cursor came from a different server run", () => {
    const streams = new ReplyStreams({ epoch: "e2" });
    streams.captureDurable("session-a", payload("t1"));
    streams.captureDurable("session-a", payload("t2"));

    const resumed = streams.subscribe("session-a", "e1-0.9999")!;

    expect(drainedTaskIds(streams, resumed)).toEqual(["t1", "t2"]);
  });

  it("ignores a cursor minted for a different session rather than suppressing this one", () => {
    const streams = new ReplyStreams({ epoch: "e1" });
    streams.captureDurable("session-busy", payload("b1"));
    streams.captureDurable("session-busy", payload("b2"));
    streams.captureDurable("session-busy", payload("b3"));
    streams.captureDurable("session-quiet", payload("q1"));

    const busy = streams.drain(streams.subscribe("session-busy")!).entries;
    const foreignCursor = busy[busy.length - 1].id;

    const resumed = streams.subscribe("session-quiet", foreignCursor)!;

    expect(drainedTaskIds(streams, resumed)).toEqual(["q1"]);
  });

  it("ignores a cursor pointing past the newest retained entry", () => {
    const streams = new ReplyStreams({ epoch: "e1" });
    streams.captureDurable("session-a", payload("t1"));

    const backlogToken = streams.drain(streams.subscribe("session-a")!).entries[0].id.split(".")[0];
    const resumed = streams.subscribe("session-a", `${backlogToken}.9999`)!;

    expect(drainedTaskIds(streams, resumed)).toEqual(["t1"]);
  });

  it("replays everything still retained when the cursor predates what was evicted", () => {
    const streams = new ReplyStreams({ epoch: "e1", backlogPerSession: 3 });
    streams.captureDurable("session-a", payload("t1"));

    const seen = streams.drain(streams.subscribe("session-a")!).entries;
    const staleCursor = seen[0].id;

    for (const taskId of ["t2", "t3", "t4", "t5"]) {
      streams.captureDurable("session-a", payload(taskId));
    }

    const resumed = streams.subscribe("session-a", staleCursor)!;

    expect(drainedTaskIds(streams, resumed)).toEqual(["t3", "t4", "t5"]);
  });

  it("replays the whole backlog when the cursor is missing or malformed", () => {
    const streams = new ReplyStreams({ epoch: "e1" });
    streams.captureDurable("session-a", payload("t1"));

    expect(drainedTaskIds(streams, streams.subscribe("session-a")!)).toEqual(["t1"]);
    expect(drainedTaskIds(streams, streams.subscribe("session-a", "nonsense")!)).toEqual(["t1"]);
    expect(drainedTaskIds(streams, streams.subscribe("session-a", "e1-0.notanumber")!)).toEqual([
      "t1",
    ]);
  });

  it("gives every entry a distinct id that carries the server run", () => {
    const streams = new ReplyStreams({ epoch: "e1" });
    streams.captureDurable("session-a", payload("t1"));
    streams.captureDurable("session-b", payload("t2"));

    const a = streams.drain(streams.subscribe("session-a")!).entries;
    const b = streams.drain(streams.subscribe("session-b")!).entries;

    expect(a[0].id).toBe("e1-0.0");
    expect(b[0].id).toBe("e1-1.0");
  });
});

describe("reply streams", () => {
  it("captures a stream reply even when nobody is listening", () => {
    const streams = new ReplyStreams();

    streams.captureDurable("session-a", payload("t1"));

    const arrivingLater = streams.subscribe("session-a")!;
    expect(drainedTaskIds(streams, arrivingLater)).toEqual(["t1"]);
  });

  it("delivers a captured reply to both clients on the same session", () => {
    const streams = new ReplyStreams();
    const first = streams.subscribe("session-a")!;
    const second = streams.subscribe("session-a")!;

    streams.captureDurable("session-a", payload("t1"));

    expect(drainedTaskIds(streams, first)).toEqual(["t1"]);
    expect(drainedTaskIds(streams, second)).toEqual(["t1"]);
  });

  it("never delivers one session's reply to another session", () => {
    const streams = new ReplyStreams();
    const listenerA = streams.subscribe("session-a")!;
    const listenerB = streams.subscribe("session-b")!;

    streams.captureDurable("session-a", payload("t1"));

    expect(drainedTaskIds(streams, listenerA)).toEqual(["t1"]);
    expect(drainedTaskIds(streams, listenerB)).toEqual([]);
  });

  it("retains a stream reply regardless of disconnect state", () => {
    const streams = new ReplyStreams();
    const disconnected = streams.subscribe("session-a")!;
    streams.unsubscribe(disconnected);

    streams.captureDurable("session-a", payload("t1"));

    const reconnected = streams.subscribe("session-a")!;
    expect(streams.hasListener("session-a")).toBe(true);
    expect(drainedTaskIds(streams, reconnected)).toEqual(["t1"]);
  });

  it("bounds each session's retained backlog", () => {
    const streams = new ReplyStreams({ backlogPerSession: 3 });
    for (let index = 0; index < 6; index++) {
      streams.captureDurable("session-a", payload(`t${index}`));
    }

    expect(streams.retained("session-a").map((entry) => entry.payload["task_id"])).toEqual([
      "t3",
      "t4",
      "t5",
    ]);
  });

  it("bounds the number of sessions with retained replies", () => {
    const streams = new ReplyStreams({ maxSessions: 2 });
    streams.captureDurable("session-a", payload("t1"));
    streams.captureDurable("session-b", payload("t2"));
    streams.captureDurable("session-c", payload("t3"));

    expect(streams.retained("session-a")).toEqual([]);
    expect(streams.retained("session-b")).toHaveLength(1);
    expect(streams.retained("session-c")).toHaveLength(1);
  });

  it("never captures or delivers an oversized stream reply", () => {
    const streams = new ReplyStreams({ backlogBytesPerSession: 64, maxEventBytes: 64 });
    const subscriber = streams.subscribe("session-a")!;

    const captured = streams.captureDurable("session-a", payload("x".repeat(128)));
    const drained = streams.drain(subscriber);

    expect(captured).toBe(false);
    expect(drained.entries).toEqual([]);
  });

  it("keeps previously retained replies when a later reply exceeds the event size limit", () => {
    const streams = new ReplyStreams({ backlogBytesPerSession: 4096, maxEventBytes: 64 });
    streams.captureDurable("session-a", payload("t1"));

    const captured = streams.captureDurable("session-a", payload("x".repeat(128)));

    expect(captured).toBe(false);
    expect(streams.retained("session-a").map((entry) => entry.payload["task_id"])).toEqual([
      "t1",
    ]);
  });

  it("gives a fresh client every currently retained reply", () => {
    const streams = new ReplyStreams({ backlogPerSession: 1 });
    for (let index = 0; index < 5; index++) {
      streams.captureDurable("session-a", payload(`t${index}`));
    }

    const drained = streams.drain(streams.subscribe("session-a")!);

    expect(drained.entries.map((entry) => entry.payload["task_id"])).toEqual(["t4"]);
  });

  it("drops a subscriber once its own pending queue exceeds the session backlog cap instead of growing it without bound", () => {
    const streams = new ReplyStreams({ backlogPerSession: 2 });
    const subscriber = streams.subscribe("session-a")!;

    for (let index = 0; index < 6; index++) {
      streams.captureDurable("session-a", payload(`t${index}`));
    }

    expect(subscriber.dropped).toBe(true);
    expect(streams.drain(subscriber).entries).toEqual([]);
    expect(streams.retained("session-a").map((entry) => entry.payload["task_id"])).toEqual([
      "t4",
      "t5",
    ]);
  });

  it("lets a subscriber dropped for overflowing its queue recover everything still retained by reconnecting", () => {
    const streams = new ReplyStreams({ backlogPerSession: 2 });
    const subscriber = streams.subscribe("session-a")!;
    for (let index = 0; index < 6; index++) {
      streams.captureDurable("session-a", payload(`t${index}`));
    }
    expect(subscriber.dropped).toBe(true);

    const reconnected = streams.subscribe("session-a")!;
    expect(drainedTaskIds(streams, reconnected)).toEqual(["t4", "t5"]);
  });

  it("drops a subscriber once its own pending byte total exceeds the session backlog byte cap", () => {
    const streams = new ReplyStreams({
      backlogPerSession: 100,
      backlogBytesPerSession: 200,
      maxEventBytes: 200,
    });
    const subscriber = streams.subscribe("session-a")!;

    streams.captureDurable("session-a", payload("a".repeat(80)));
    expect(subscriber.dropped).toBe(false);
    streams.captureDurable("session-a", payload("b".repeat(80)));
    streams.captureDurable("session-a", payload("c".repeat(80)));

    expect(subscriber.dropped).toBe(true);
  });

  it("drops a subscriber once its distinct transient tasks exceed the session backlog cap", () => {
    const streams = new ReplyStreams({ backlogPerSession: 2 });
    const subscriber = streams.subscribe("session-a")!;

    streams.publishTransient("session-a", { task_id: "t1", status: "typing" });
    streams.publishTransient("session-a", { task_id: "t2", status: "typing" });
    expect(subscriber.dropped).toBe(false);
    streams.publishTransient("session-a", { task_id: "t3", status: "typing" });

    expect(subscriber.dropped).toBe(true);
  });

  it("keeps transient progress live only and outside the durable backlog", () => {
    const streams = new ReplyStreams();
    const subscriber = streams.subscribe("session-a")!;

    expect(
      streams.publishTransient("session-a", { task_id: "t1", status: "typing" }),
    ).toBe(true);

    const drained = streams.drain(subscriber);
    expect(drained.transientPayloads.map((payload) => JSON.parse(payload))).toEqual([
      { task_id: "t1", status: "typing" },
    ]);
    expect(streams.retained("session-a")).toEqual([]);
  });

  it("coalesces repeated progress for one task until the stream drains", () => {
    const streams = new ReplyStreams();
    const subscriber = streams.subscribe("session-a")!;
    streams.publishTransient("session-a", {
      task_id: "t1",
      status: "typing",
      label: "first",
    });
    streams.publishTransient("session-a", {
      task_id: "t1",
      status: "tool_call",
      label: "second",
    });

    const drained = streams.drain(subscriber);
    expect(drained.transientPayloads.map((payload) => JSON.parse(payload))).toEqual([
      { task_id: "t1", status: "tool_call", label: "second" },
    ]);
  });

  it("removes queued progress when the durable answer for that task arrives", () => {
    const streams = new ReplyStreams();
    const subscriber = streams.subscribe("session-a")!;
    streams.publishTransient("session-a", { task_id: "t1", status: "typing" });

    streams.captureDurable("session-a", {
      task_id: "t1",
      status: "message",
      reply_text: "done",
    });

    const drained = streams.drain(subscriber);
    expect(drained.transientPayloads).toEqual([]);
    expect(drained.entries.map((entry) => entry.payload["task_id"])).toEqual(["t1"]);
  });

  it("bounds the number of streams per session", () => {
    const streams = new ReplyStreams({ maxSubscribersPerSession: 2 });

    expect(streams.subscribe("session-a")).not.toBeNull();
    expect(streams.subscribe("session-a")).not.toBeNull();
    expect(streams.subscribe("session-a")).toBeNull();
    expect(streams.subscribe("session-b")).not.toBeNull();
  });

  it("bounds the total number of open streams", () => {
    const streams = new ReplyStreams({
      maxSubscribersPerSession: 10,
      maxSubscribersTotal: 3,
    });

    const accepted = [0, 1, 2, 3, 4].map((index) => streams.subscribe(`session-${index}`));

    expect(accepted.filter((subscriber) => subscriber !== null)).toHaveLength(3);
    expect(accepted[3]).toBeNull();
    expect(accepted[4]).toBeNull();
  });

  it("does not corrupt the stream budget when a subscriber is removed twice", () => {
    const streams = new ReplyStreams({ maxSubscribersTotal: 2 });
    const subscriber = streams.subscribe("session-a")!;
    streams.unsubscribe(subscriber);
    streams.unsubscribe(subscriber);

    expect(streams.subscribe("session-a")).not.toBeNull();
    expect(streams.subscribe("session-b")).not.toBeNull();
    expect(streams.subscribe("session-c")).toBeNull();
  });

  it("does not leave a dangling listener when a stream is refused", () => {
    const streams = new ReplyStreams({ maxSubscribersTotal: 1 });
    streams.subscribe("session-a");

    expect(streams.subscribe("session-b")).toBeNull();
    expect(streams.hasListener("session-b")).toBe(false);
  });

  it("reuses a stream slot after its client disconnects", () => {
    const streams = new ReplyStreams({ maxSubscribersTotal: 1 });
    const first = streams.subscribe("session-a")!;
    expect(streams.subscribe("session-b")).toBeNull();

    streams.unsubscribe(first);

    expect(streams.subscribe("session-b")).not.toBeNull();
  });

  it("removes retained replies when a session is forgotten", () => {
    const streams = new ReplyStreams();
    streams.captureDurable("session-a", payload("t1"));

    streams.forget("session-a");

    expect(streams.retained("session-a")).toEqual([]);
  });

  for (const scenario of contract.unicodeByteScenarios) {
    it(scenario.name, () => {
      const streams = new ReplyStreams({
        maxEventBytes: scenario.maxEventBytes,
        backlogBytesPerSession: scenario.backlogBytesPerSession,
      });

      const results = scenario.captures.map((capture) =>
        streams.captureDurable("session-a", {
          task_id: capture.taskId,
          text: capture.textUnit.repeat(capture.repeat),
        }),
      );

      const retained = streams.retained("session-a");
      expect(results).toEqual(scenario.expectedCaptureResults);
      expect(retained.map((entry) => entry.sizeBytes)).toEqual(scenario.expectedSizes);
      expect(retained.map((entry) => entry.payload["task_id"])).toEqual(
        scenario.expectedTaskIds,
      );
    });
  }

  it("notifies an open stream when a reply is captured", () => {
    const streams = new ReplyStreams();
    const subscriber = streams.subscribe("session-a")!;
    let wakeups = 0;
    subscriber.notify = () => {
      wakeups += 1;
    };

    streams.captureDurable("session-a", payload("t1"));

    expect(wakeups).toBe(1);
  });

  it("drops a session's retained replies once the retention ceiling elapses since its last activity", () => {
    let clock = 0;
    const streams = new ReplyStreams({ retentionMs: 1000, now: () => clock });

    streams.captureDurable("session-a", payload("t1"));
    clock += 1500;
    streams.captureDurable("session-b", payload("t2"));

    expect(streams.retained("session-a")).toEqual([]);
    expect(streams.retained("session-b")).toHaveLength(1);
  });

  it("ends a dropped subscriber's stream instead of flushing it", () => {
    const streams = new ReplyStreams({ backlogPerSession: 1 });
    const subscriber = streams.subscribe("session-a")!;
    streams.captureDurable("session-a", payload("t1"));
    streams.captureDurable("session-a", payload("t2"));
    expect(subscriber.dropped).toBe(true);

    let flushed = false;
    let finished = false;
    notifySubscriber(
      subscriber,
      () => {
        flushed = true;
      },
      () => {
        finished = true;
      },
    );

    expect(finished).toBe(true);
    expect(flushed).toBe(false);
  });

  it("flushes a subscriber that has not been dropped", () => {
    const streams = new ReplyStreams();
    const subscriber = streams.subscribe("session-a")!;

    let flushed = false;
    notifySubscriber(
      subscriber,
      () => {
        flushed = true;
      },
      () => {},
    );

    expect(flushed).toBe(true);
  });

  it("treats a stream status frame as durable so it is retained rather than dropped", () => {
    const streams = new ReplyStreams();

    const captured = streams.captureDurable("session-a", {
      task_id: "t1",
      status: "stream",
      chunk: { type: "text-delta", id: "p1", delta: "Hel" },
    });

    expect(captured).toBe(true);
    expect(streams.retained("session-a")).toHaveLength(1);
  });

  it("keeps every incremental stream delta instead of coalescing them like transient progress", () => {
    const streams = new ReplyStreams();
    const subscriber = streams.subscribe("session-a")!;

    streams.captureDurable("session-a", {
      task_id: "t1",
      status: "stream",
      chunk: { type: "text-delta", id: "p1", delta: "Hel" },
    });
    streams.captureDurable("session-a", {
      task_id: "t1",
      status: "stream",
      chunk: { type: "text-delta", id: "p1", delta: "lo" },
    });

    const drained = streams.drain(subscriber);
    expect(
      drained.entries.map((entry) => (entry.payload["chunk"] as Record<string, unknown>)["delta"]),
    ).toEqual(["Hel", "lo"]);
  });

  it("refuses to publish a stream status frame as transient progress", () => {
    const streams = new ReplyStreams();
    const subscriber = streams.subscribe("session-a")!;

    const published = streams.publishTransient("session-a", {
      task_id: "t1",
      status: "stream",
      chunk: { type: "text-delta", id: "p1", delta: "Hel" },
    });

    expect(published).toBe(false);
    expect(streams.drain(subscriber).transientPayloads).toEqual([]);
  });

  it("keeps a session's retained replies alive while it stays within the retention ceiling", () => {
    let clock = 0;
    const streams = new ReplyStreams({ retentionMs: 1000, now: () => clock });

    streams.captureDurable("session-a", payload("t1"));
    clock += 500;
    streams.captureDurable("session-a", payload("t2"));
    clock += 500;
    streams.captureDurable("session-b", payload("t3"));

    expect(streams.retained("session-a").map((entry) => entry.payload["task_id"])).toEqual([
      "t1",
      "t2",
    ]);
  });
});
