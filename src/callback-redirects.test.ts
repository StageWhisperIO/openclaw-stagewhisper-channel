import http from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";

import {
  classifyCallbackStatus,
  guardCallbackAttemptWithSsrfPolicy,
  retryCallback,
  type CallbackAttemptOutcome,
} from "./callback-delivery.js";

const contract = JSON.parse(
  readFileSync(new URL("../../reply-stream-contract.json", import.meta.url), "utf8"),
).callbackRetryContract;

const servers: http.Server[] = [];

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((r) => server.close(() => r()))),
  );
});

describe("callback redirects", () => {
  for (const status of contract.redirectStatuses as number[]) {
    it(`never follows an HTTP ${status} off the allowed callback host`, async () => {
      const sinkHits: string[] = [];
      const sinkBase = await listen((req, res) => {
        sinkHits.push(req.url ?? "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
      const redirectorBase = await listen((req, res) => {
        res.writeHead(status, { Location: `${sinkBase}/stolen` });
        res.end();
      });

      const delivered = await retryCallback(async () => {
        const res = await fetch(`${redirectorBase}/tasks/task-a`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer callback-token-32-chars-aaaaaaaa",
          },
          body: JSON.stringify({ task_id: "task-a" }),
          redirect: "manual",
        });
        return classifyCallbackStatus(res.status);
      }, async () => {});

      expect(delivered).toBe(false);
      expect(sinkHits).toEqual([]);
    });
  }
});

describe("callback ssrf dispatcher pinning", () => {
  it("connects to the address resolved at the ssrf check instead of re-resolving the hostname for the actual request", async () => {
    const sinkHits: string[] = [];
    const trustedBase = await listen((req, res) => {
      sinkHits.push(req.url ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    const trustedPort = new URL(trustedBase).port;

    let resolutions = 0;
    const driftingLookup: LookupFn = (async () => {
      resolutions += 1;
      return [{ address: resolutions === 1 ? "127.0.0.1" : "203.0.113.10", family: 4 }];
    }) as unknown as LookupFn;

    const url = `http://toctou-test.invalid:${trustedPort}/tasks/task-a`;
    const guarded = guardCallbackAttemptWithSsrfPolicy(
      url,
      async (dispatcher) => {
        const res = await fetch(url, { redirect: "manual", dispatcher } as RequestInit);
        return classifyCallbackStatus(res.status);
      },
      () => {},
      driftingLookup,
    );

    const outcome: CallbackAttemptOutcome = await guarded();

    expect(outcome).toBe("delivered");
    expect(sinkHits).toEqual(["/tasks/task-a"]);
    expect(resolutions).toBe(1);
  });
});
