import {
  CALLBACK_TIMEOUT_MS,
  classifyCallbackStatus,
  guardCallbackAttemptWithSsrfPolicy,
  type CallbackAttempt,
} from "./callback-delivery.js";
import { buildCallbackUrl, type RelayCallback } from "./core.js";

type CallbackFetchInit = RequestInit & { dispatcher?: unknown };

export function buildCallbackAttempt(
  callback: RelayCallback,
  taskId: string,
  body: Record<string, unknown>,
  callbackFetch: typeof fetch,
  recordError: (error: unknown) => void,
): CallbackAttempt {
  const url = buildCallbackUrl(callback.url, taskId);
  const serialized = JSON.stringify(body);
  return guardCallbackAttemptWithSsrfPolicy(
    url,
    async (dispatcher) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
      try {
        const init: CallbackFetchInit = {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${callback.token}`,
          },
          body: serialized,
          signal: controller.signal,
          redirect: "manual",
          dispatcher,
        };
        const res = await callbackFetch(url, init);
        const outcome = classifyCallbackStatus(res.status);
        if (outcome !== "delivered") {
          recordError(new Error(`callback returned status ${res.status}`));
        }
        return outcome;
      } catch (err) {
        recordError(err);
        return "retryable_failure";
      } finally {
        clearTimeout(timeoutId);
      }
    },
    recordError,
  );
}
