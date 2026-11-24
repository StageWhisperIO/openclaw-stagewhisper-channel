import {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { allowedCallbackOrigins, allowedIngressHosts } from "./core.js";

export const CALLBACK_TIMEOUT_MS = 5_000;
export const CALLBACK_MAX_ATTEMPTS = 4;
export const CALLBACK_RETRY_BASE_MS = 250;

export type CallbackAttemptOutcome = "delivered" | "retryable_failure" | "permanent_failure";

type PinnedDispatcher = ReturnType<typeof createPinnedDispatcher>;

export type CallbackAttempt = () => Promise<CallbackAttemptOutcome>;
export type PinnedCallbackAttempt = (dispatcher: PinnedDispatcher) => Promise<CallbackAttemptOutcome>;
export type CallbackSleep = (milliseconds: number) => Promise<void>;

export function classifyCallbackStatus(status: number): CallbackAttemptOutcome {
  if (status >= 200 && status < 300) return "delivered";
  if (status === 408 || status === 425 || status === 429) return "retryable_failure";
  if (status >= 500 && status < 600) return "retryable_failure";
  return "permanent_failure";
}

const sleepUntilBackoffElapses: CallbackSleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function retryCallback(
  attemptDelivery: CallbackAttempt,
  sleep: CallbackSleep = sleepUntilBackoffElapses,
): Promise<boolean> {
  for (let attempt = 0; attempt < CALLBACK_MAX_ATTEMPTS; attempt++) {
    let outcome: CallbackAttemptOutcome;
    try {
      outcome = await attemptDelivery();
    } catch {
      outcome = "retryable_failure";
    }
    if (outcome === "delivered") return true;
    if (outcome === "permanent_failure") return false;
    if (attempt + 1 < CALLBACK_MAX_ATTEMPTS) {
      await sleep(CALLBACK_RETRY_BASE_MS * 2 ** attempt);
    }
  }
  return false;
}

export function isLocalCallbackIngressMode(): boolean {
  return allowedIngressHosts().size === 0;
}

function hostnameFromOrigin(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

export function callbackSsrfPolicy(): SsrFPolicy {
  if (isLocalCallbackIngressMode()) return { allowPrivateNetwork: true };
  const allowedHostnames = Array.from(allowedCallbackOrigins())
    .map(hostnameFromOrigin)
    .filter((hostname): hostname is string => hostname !== null);
  return { allowedHostnames };
}

export async function assertCallbackUrlPassesSsrfPolicy(
  url: string,
  lookupFn?: LookupFn,
): Promise<void> {
  const hostname = new URL(url).hostname;
  await resolvePinnedHostnameWithPolicy(hostname, {
    policy: callbackSsrfPolicy(),
    lookupFn,
  });
}

async function pinCallbackDispatcher(url: string, lookupFn?: LookupFn): Promise<PinnedDispatcher> {
  const hostname = new URL(url).hostname;
  const pinned = await resolvePinnedHostnameWithPolicy(hostname, {
    policy: callbackSsrfPolicy(),
    lookupFn,
  });
  return createPinnedDispatcher(pinned);
}

export function guardCallbackAttemptWithSsrfPolicy(
  url: string,
  attempt: PinnedCallbackAttempt,
  recordError: (error: unknown) => void,
  lookupFn?: LookupFn,
): CallbackAttempt {
  return async () => {
    let dispatcher: PinnedDispatcher;
    try {
      dispatcher = await pinCallbackDispatcher(url, lookupFn);
    } catch (err) {
      recordError(err);
      return "permanent_failure";
    }
    try {
      return await attempt(dispatcher);
    } finally {
      await closeDispatcher(dispatcher);
    }
  };
}
