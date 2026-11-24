import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";

import {
  CALLBACK_MAX_ATTEMPTS,
  CALLBACK_TIMEOUT_MS,
  assertCallbackUrlPassesSsrfPolicy,
  classifyCallbackStatus,
  retryCallback,
  type CallbackAttemptOutcome,
} from "./callback-delivery.js";

const contractPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../reply-stream-contract.json",
);
const contract = JSON.parse(readFileSync(contractPath, "utf-8")).callbackRetryContract;

describe("callback retry contract", () => {
  it("uses the callback timeout from the shared cross-plugin contract", () => {
    expect(CALLBACK_TIMEOUT_MS).toBe(contract.timeoutMilliseconds);
  });

  it("uses the callback attempt limit from the shared cross-plugin contract", () => {
    expect(CALLBACK_MAX_ATTEMPTS).toBe(contract.maxAttempts);
  });

  for (const statusCase of contract.statusCases) {
    it(`classifies HTTP ${statusCase.status} as ${statusCase.outcome}`, () => {
      expect(classifyCallbackStatus(statusCase.status)).toBe(statusCase.outcome);
    });
  }

  for (const transportCase of contract.transportFailureCases) {
    it(`treats a ${transportCase.failure} as ${transportCase.outcome}`, async () => {
      let attempts = 0;
      const delivered = await retryCallback(async () => {
        attempts += 1;
        throw new Error(transportCase.failure);
      }, async () => {});

      expect(delivered).toBe(false);
      expect(attempts).toBe(contract.maxAttempts);
    });
  }

  for (const scenario of contract.recoveryScenarios) {
    it(scenario.name, async () => {
      const outcomes = [...scenario.outcomes] as CallbackAttemptOutcome[];
      const backoffs: number[] = [];
      let attempts = 0;

      const delivered = await retryCallback(
        async () => {
          attempts += 1;
          return outcomes.shift() as CallbackAttemptOutcome;
        },
        async (milliseconds) => {
          backoffs.push(milliseconds);
        },
      );

      expect(delivered).toBe(scenario.expectedDelivered);
      expect(attempts).toBe(scenario.expectedAttempts);
      expect(backoffs).toEqual(scenario.expectedBackoffMilliseconds);
    });
  }
});

const INGRESS_ENV = "STAGEWHISPER_ALLOW_INGRESS_HOSTS";
const CALLBACK_ALLOW_ENV = "STAGEWHISPER_ALLOW_CALLBACK_URLS";

function fakeLookupResolvingTo(address: string, family: 4 | 6 = 4): LookupFn {
  return (async () => [{ address, family }]) as unknown as LookupFn;
}

describe("callback ssrf policy", () => {
  afterEach(() => {
    delete process.env[INGRESS_ENV];
    delete process.env[CALLBACK_ALLOW_ENV];
  });

  it("still allows a loopback callback URL when running in local mode", async () => {
    await expect(
      assertCallbackUrlPassesSsrfPolicy("http://127.0.0.1:8788/tasks/abc"),
    ).resolves.toBeUndefined();
  });

  it("validates a callback URL to a public host through ssrf-runtime once remote ingress is enabled", async () => {
    process.env[INGRESS_ENV] = "my-vps.tailnet-name.ts.net";
    await expect(
      assertCallbackUrlPassesSsrfPolicy(
        "https://example.com/tasks/abc",
        fakeLookupResolvingTo("93.184.216.34"),
      ),
    ).resolves.toBeUndefined();
  });

  it("blocks a private-network callback host once remote ingress is enabled and the host is not explicitly allowlisted", async () => {
    process.env[INGRESS_ENV] = "my-vps.tailnet-name.ts.net";
    await expect(
      assertCallbackUrlPassesSsrfPolicy(
        "https://internal.example.com/tasks/abc",
        fakeLookupResolvingTo("10.0.0.5"),
      ),
    ).rejects.toThrow();
  });

  it("allows an explicitly allowlisted private-network callback host even when remote ingress is enabled", async () => {
    process.env[INGRESS_ENV] = "my-vps.tailnet-name.ts.net";
    process.env[CALLBACK_ALLOW_ENV] = "https://my-mac.tailnet-name.ts.net";
    await expect(
      assertCallbackUrlPassesSsrfPolicy(
        "https://my-mac.tailnet-name.ts.net/tasks/abc",
        fakeLookupResolvingTo("100.64.1.2"),
      ),
    ).resolves.toBeUndefined();
  });
});
