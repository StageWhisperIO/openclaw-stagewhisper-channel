import {
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  createWebhookInFlightLimiter,
  WEBHOOK_IN_FLIGHT_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  type FixedWindowRateLimiter,
  type WebhookAnomalyTracker,
  type WebhookInFlightLimiter,
} from "openclaw/plugin-sdk/webhook-ingress";

export type IngressGuardLogger = {
  warn: (message: string) => void;
};

export type IngressGuardsOptions = {
  logger: IngressGuardLogger;
  rateLimiter?: FixedWindowRateLimiter;
  inFlightLimiter?: WebhookInFlightLimiter;
  anomalyTracker?: WebhookAnomalyTracker;
};

export type IngressAdmission =
  | { ok: true; release: () => void }
  | { ok: false; status: number; reason: "rate_limited" | "too_many_concurrent_requests" };

export type IngressGuards = {
  admit(key: string): IngressAdmission;
  recordResponseStatus(key: string, statusCode: number): void;
  reset(): void;
};

export function createIngressGuards(options: IngressGuardsOptions): IngressGuards {
  const rateLimiter =
    options.rateLimiter ?? createFixedWindowRateLimiter({ ...WEBHOOK_RATE_LIMIT_DEFAULTS });
  const inFlightLimiter =
    options.inFlightLimiter ?? createWebhookInFlightLimiter({ ...WEBHOOK_IN_FLIGHT_DEFAULTS });
  const anomalyTracker = options.anomalyTracker ?? createWebhookAnomalyTracker();

  return {
    admit(key: string): IngressAdmission {
      if (rateLimiter.isRateLimited(key)) {
        return { ok: false, status: 429, reason: "rate_limited" };
      }
      if (!inFlightLimiter.tryAcquire(key)) {
        return { ok: false, status: 429, reason: "too_many_concurrent_requests" };
      }
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          inFlightLimiter.release(key);
        },
      };
    },

    recordResponseStatus(key: string, statusCode: number): void {
      anomalyTracker.record({
        key,
        statusCode,
        message: (count) =>
          `[stagewhisper-http] repeated rejected requests from ${key} (count: ${count}, status: ${statusCode})`,
        log: (message) => options.logger.warn(message),
      });
    },

    reset(): void {
      rateLimiter.clear();
      inFlightLimiter.clear();
      anomalyTracker.clear();
    },
  };
}

export async function withIngressAdmission(
  guards: IngressGuards,
  key: string,
  res: { statusCode: number },
  writeRejection: (status: number, reason: string) => void,
  run: () => Promise<void>,
): Promise<void> {
  const admission = guards.admit(key);
  if (!admission.ok) {
    guards.recordResponseStatus(key, admission.status);
    writeRejection(admission.status, admission.reason);
    return;
  }
  try {
    await run();
    guards.recordResponseStatus(key, res.statusCode);
  } finally {
    admission.release();
  }
}
