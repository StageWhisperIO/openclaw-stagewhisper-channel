import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

export const DEFAULT_BACKLOG_PER_SESSION = 64;
export const DEFAULT_BACKLOG_BYTES_PER_SESSION = 1024 * 1024;
export const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;
export const DEFAULT_MAX_SESSIONS = 256;
export const DEFAULT_MAX_SUBSCRIBERS_PER_SESSION = 4;
export const DEFAULT_MAX_SUBSCRIBERS_TOTAL = 64;
export const DEFAULT_BACKLOG_RETENTION_MS = 30 * 60 * 1000;

const DURABLE_STATUSES = new Set(["completed", "errored", "message", "silent", "stream"]);
const TRANSIENT_STATUSES = new Set(["typing", "tool_call"]);

export type QueuedReply = {
  id: string;
  sequence: number;
  payload: Record<string, unknown>;
  serializedPayload: string;
  sizeBytes: number;
};

export type Drained = {
  entries: QueuedReply[];
  transientPayloads: string[];
};

export type Subscriber = {
  sessionId: string;
  pending: QueuedReply[];
  pendingBytes: number;
  transientPayloads: Map<string, string>;
  notify: (() => void) | null;
  dropped: boolean;
};

type SessionBacklog = {
  token: string;
  entries: QueuedReply[];
  retainedBytes: number;
  updatedAt: number;
  nextSequence: number;
};

export type ReplyStreamsOptions = {
  backlogPerSession?: number;
  backlogBytesPerSession?: number;
  maxEventBytes?: number;
  maxSessions?: number;
  maxSubscribersPerSession?: number;
  maxSubscribersTotal?: number;
  retentionMs?: number;
  now?: () => number;
  epoch?: string;
};

export class ReplyStreams {
  private readonly backlogPerSession: number;
  private readonly backlogBytesPerSession: number;
  private readonly maxEventBytes: number;
  private readonly maxSessions: number;
  private readonly maxSubscribersPerSession: number;
  private readonly maxSubscribersTotal: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly epoch: string;
  private nextBacklogSerial = 0;
  private readonly backlogs = new Map<string, SessionBacklog>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private subscriberCount = 0;

  constructor(options: ReplyStreamsOptions = {}) {
    this.backlogPerSession = Math.max(1, options.backlogPerSession ?? DEFAULT_BACKLOG_PER_SESSION);
    this.backlogBytesPerSession = Math.max(
      1,
      options.backlogBytesPerSession ?? DEFAULT_BACKLOG_BYTES_PER_SESSION,
    );
    this.maxEventBytes = Math.min(
      Math.max(1, options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES),
      this.backlogBytesPerSession,
    );
    this.maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
    this.maxSubscribersPerSession = Math.max(
      1,
      options.maxSubscribersPerSession ?? DEFAULT_MAX_SUBSCRIBERS_PER_SESSION,
    );
    this.maxSubscribersTotal = Math.max(
      1,
      options.maxSubscribersTotal ?? DEFAULT_MAX_SUBSCRIBERS_TOTAL,
    );
    this.retentionMs = Math.max(1, options.retentionMs ?? DEFAULT_BACKLOG_RETENTION_MS);
    this.now = options.now ?? Date.now;
    this.epoch = options.epoch ?? randomBytes(8).toString("hex");
  }

  private replayFloor(
    backlog: SessionBacklog | undefined,
    lastEventId: string | null,
  ): number | null {
    if (!backlog || !lastEventId) return null;
    const separator = lastEventId.lastIndexOf(".");
    if (separator <= 0) return null;
    if (lastEventId.slice(0, separator) !== backlog.token) return null;
    const sequence = Number(lastEventId.slice(separator + 1));
    if (!Number.isSafeInteger(sequence)) return null;
    const newest = backlog.entries[backlog.entries.length - 1];
    if (!newest || sequence > newest.sequence) return null;
    return sequence;
  }

  subscribe(sessionId: string, lastEventId: string | null = null): Subscriber | null {
    this.pruneExpired();
    const listeners = this.subscribers.get(sessionId);
    if (
      (listeners?.size ?? 0) >= this.maxSubscribersPerSession ||
      this.subscriberCount >= this.maxSubscribersTotal
    ) {
      return null;
    }

    const backlog = this.backlogs.get(sessionId);
    const floor = this.replayFloor(backlog, lastEventId);
    const replayed = (backlog?.entries ?? []).filter(
      (entry) => floor === null || entry.sequence > floor,
    );
    const subscriber: Subscriber = {
      sessionId,
      pending: replayed,
      pendingBytes: replayed.reduce((total, entry) => total + entry.sizeBytes, 0),
      transientPayloads: new Map(),
      notify: null,
      dropped: false,
    };

    if (listeners) {
      listeners.add(subscriber);
    } else {
      this.subscribers.set(sessionId, new Set([subscriber]));
    }
    this.subscriberCount += 1;
    return subscriber;
  }

  unsubscribe(subscriber: Subscriber): void {
    const listeners = this.subscribers.get(subscriber.sessionId);
    if (!listeners || !listeners.has(subscriber)) return;
    listeners.delete(subscriber);
    this.subscriberCount -= 1;
    if (listeners.size === 0) this.subscribers.delete(subscriber.sessionId);
  }

  hasListener(sessionId: string): boolean {
    return (this.subscribers.get(sessionId)?.size ?? 0) > 0;
  }

  captureDurable(sessionId: string, payload: Record<string, unknown>): boolean {
    const status = payload["status"];
    if (typeof status === "string" && !DURABLE_STATUSES.has(status)) return false;
    const serializedPayload = serializePayload(payload);
    const sizeBytes = Buffer.byteLength(serializedPayload);
    if (sizeBytes > this.maxEventBytes) return false;
    this.append(sessionId, payload, serializedPayload, sizeBytes);
    return true;
  }

  publishTransient(sessionId: string, payload: Record<string, unknown>): boolean {
    const status = payload["status"];
    const taskId = payload["task_id"];
    if (typeof status !== "string" || !TRANSIENT_STATUSES.has(status)) return false;
    if (typeof taskId !== "string" || taskId.length === 0) return false;
    const serializedPayload = serializePayload(payload);
    if (Buffer.byteLength(serializedPayload) > this.maxEventBytes) return false;
    for (const subscriber of this.subscribers.get(sessionId) ?? []) {
      if (subscriber.dropped) continue;
      subscriber.transientPayloads.delete(taskId);
      subscriber.transientPayloads.set(taskId, serializedPayload);
      if (subscriber.transientPayloads.size > this.backlogPerSession) {
        this.dropSubscriber(subscriber);
      }
      subscriber.notify?.();
    }
    return true;
  }

  drain(subscriber: Subscriber): Drained {
    const entries = subscriber.pending;
    subscriber.pending = [];
    subscriber.pendingBytes = 0;
    const transientPayloads = [...subscriber.transientPayloads.values()];
    subscriber.transientPayloads.clear();
    return { entries, transientPayloads };
  }

  retained(sessionId: string): QueuedReply[] {
    return [...(this.backlogs.get(sessionId)?.entries ?? [])];
  }

  forget(sessionId: string): void {
    this.invalidate(sessionId);
  }

  private dropSubscriber(subscriber: Subscriber): void {
    subscriber.dropped = true;
    subscriber.pending = [];
    subscriber.pendingBytes = 0;
    subscriber.transientPayloads.clear();
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [sessionId, backlog] of this.backlogs) {
      if (backlog.updatedAt < cutoff) this.forget(sessionId);
    }
  }

  private append(
    sessionId: string,
    payload: Record<string, unknown>,
    serializedPayload: string,
    sizeBytes: number,
  ): void {
    this.pruneExpired();
    let backlog = this.backlogs.get(sessionId);
    if (!backlog) {
      const serial = this.nextBacklogSerial;
      this.nextBacklogSerial += 1;
      backlog = {
        token: `${this.epoch}-${serial}`,
        entries: [],
        retainedBytes: 0,
        updatedAt: this.now(),
        nextSequence: 0,
      };
      this.backlogs.set(sessionId, backlog);
    } else {
      this.backlogs.delete(sessionId);
      backlog.updatedAt = this.now();
      this.backlogs.set(sessionId, backlog);
    }

    const sequence = backlog.nextSequence;
    backlog.nextSequence += 1;
    const entry: QueuedReply = {
      id: `${backlog.token}.${sequence}`,
      sequence,
      payload,
      serializedPayload,
      sizeBytes,
    };
    backlog.entries.push(entry);
    backlog.retainedBytes += sizeBytes;
    const taskId = payload["task_id"];
    for (const subscriber of this.subscribers.get(sessionId) ?? []) {
      if (subscriber.dropped) continue;
      subscriber.pending.push(entry);
      subscriber.pendingBytes += sizeBytes;
      if (typeof taskId === "string") {
        subscriber.transientPayloads.delete(taskId);
      }
      if (
        subscriber.pending.length > this.backlogPerSession ||
        subscriber.pendingBytes > this.backlogBytesPerSession
      ) {
        this.dropSubscriber(subscriber);
      }
      subscriber.notify?.();
    }
    while (
      backlog.entries.length > this.backlogPerSession ||
      backlog.retainedBytes > this.backlogBytesPerSession
    ) {
      const discarded = backlog.entries.shift();
      if (discarded) backlog.retainedBytes -= discarded.sizeBytes;
    }
    while (this.backlogs.size > this.maxSessions) {
      const oldestKey = this.backlogs.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.invalidate(oldestKey);
    }
  }

  private invalidate(sessionId: string): void {
    this.backlogs.delete(sessionId);
  }
}

export function serializePayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

export function notifySubscriber(
  subscriber: Subscriber,
  flush: () => void,
  finish: () => void,
): void {
  if (subscriber.dropped) {
    finish();
    return;
  }
  flush();
}
