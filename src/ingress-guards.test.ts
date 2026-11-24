import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
} from "openclaw/plugin-sdk/webhook-ingress";
import {
  createHttpTransport,
  type HttpTransport,
  type HttpTransportOptions,
} from "./http-transport.js";
import { createIngressGuards } from "./ingress-guards.js";
import { MAX_BODY_BYTES } from "./core.js";

const VALID_TOKEN = "test-token-32-chars-min-length__";
const SESSION_ID = "session-ingress-guards";

function makeApi(): OpenClawPluginApi {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      subagent: {
        run: vi.fn().mockResolvedValue({ runId: "run-abc" }),
        waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
        getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
      },
    },
    pluginConfig: {},
    config: {},
  } as unknown as OpenClawPluginApi;
}

let transport: HttpTransport | null = null;

afterEach(async () => {
  await transport?.stop();
  transport = null;
});

async function startTransport(
  options?: Pick<HttpTransportOptions, "ingressGuards">,
): Promise<string> {
  const t = createHttpTransport({
    api: makeApi(),
    host: "127.0.0.1",
    port: 0,
    token: VALID_TOKEN,
    ...(options ?? {}),
  });
  await t.start();
  transport = t;
  const address = t.address();
  if (!address) throw new Error("transport has no address");
  return `http://127.0.0.1:${address.port}`;
}

describe("ingress body size guard", () => {
  it("rejects a POST body that exceeds the configured body size limit without crashing the listener", async () => {
    const base = await startTransport();
    const oversized = "a".repeat(MAX_BODY_BYTES + 1024);
    try {
      const res = await fetch(`${base}/v1/incoming`, {
        method: "POST",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: oversized,
      });
      expect(res.status).toBe(413);
      await res.text();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }

    const followUp = await fetch(`${base}/v1/ping`, {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(followUp.status).toBe(200);
    await followUp.text();
  });
});

describe("ingress rate limit guard", () => {
  it("rejects requests once the fixed window rate limit is exceeded while earlier requests still succeed", async () => {
    const logger = { warn: vi.fn() };
    const rateLimiter = createFixedWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: 2,
      maxTrackedKeys: 10,
    });
    const base = await startTransport({
      ingressGuards: createIngressGuards({ logger, rateLimiter }),
    });

    const ping = () =>
      fetch(`${base}/v1/ping`, {
        method: "POST",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      });

    const first = await ping();
    expect(first.status).toBe(200);
    await first.text();

    const second = await ping();
    expect(second.status).toBe(200);
    await second.text();

    const third = await ping();
    expect(third.status).toBe(429);
    await third.text();
  });
});

describe("ingress in-flight concurrency guard", () => {
  it("does not let a long lived reply stream consume a webhook in-flight slot", async () => {
    const logger = { warn: vi.fn() };
    const inFlightLimiter = createWebhookInFlightLimiter({
      maxInFlightPerKey: 1,
      maxTrackedKeys: 10,
    });
    const base = await startTransport({
      ingressGuards: createIngressGuards({ logger, inFlightLimiter }),
    });

    const chatStream = await fetch(`${base}/v1/events?session_id=${SESSION_ID}`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(chatStream.status).toBe(200);

    const insightStream = await fetch(
      `${base}/v1/events?session_id=insights:${SESSION_ID}`,
      { headers: { Authorization: `Bearer ${VALID_TOKEN}` } },
    );
    expect(insightStream.status).toBe(200);

    const pingRes = await fetch(`${base}/v1/ping`, {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(pingRes.status).toBe(200);
    await pingRes.text();

    await chatStream.body?.cancel();
    await insightStream.body?.cancel();
  });

  it("rejects a concurrent webhook once the in-flight cap is exceeded, then allows one again after the earlier request completes", async () => {
    const logger = { warn: vi.fn() };
    const inFlightLimiter = createWebhookInFlightLimiter({
      maxInFlightPerKey: 1,
      maxTrackedKeys: 10,
    });
    const base = await startTransport({
      ingressGuards: createIngressGuards({ logger, inFlightLimiter }),
    });

    let releaseBody: (() => void) | undefined;
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        releaseBody = () => {
          controller.enqueue(new TextEncoder().encode("}"));
          controller.close();
        };
      },
    });

    const held = fetch(`${base}/v1/ping`, {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      body: stalledBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const blockedRes = await fetch(`${base}/v1/ping`, {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(blockedRes.status).toBe(429);
    await blockedRes.text();

    releaseBody?.();
    await (await held).text();

    const okRes = await fetch(`${base}/v1/ping`, {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(okRes.status).toBe(200);
    await okRes.text();
  });
});
