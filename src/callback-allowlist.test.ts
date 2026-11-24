import { afterEach, describe, expect, it } from "vitest";
import { isAllowedCallbackUrl, validateHttpTaskRequest } from "./core.js";

const ENV = "STAGEWHISPER_ALLOW_CALLBACK_URLS";
const INGRESS_ENV = "STAGEWHISPER_ALLOW_INGRESS_HOSTS";
const ALLOWED = "https://my-mac.tailnet-name.ts.net";

const TASK_BODY = {
  task_id: "11111111-2222-3333-4444-555555555555",
  session_id: "sess-1",
  reason: "chat_message",
  payload: { text: "hi" },
};

function withCallback(url: string) {
  return {
    ...TASK_BODY,
    callback: { url, token: "callback-token-32-chars-aaaaaaaa" },
  };
}

describe("callback allowlist", () => {
  afterEach(() => {
    delete process.env[ENV];
    delete process.env[INGRESS_ENV];
  });

  it("always accepts loopback callbacks", () => {
    expect(isAllowedCallbackUrl("http://127.0.0.1:8788")).toBe(true);
    expect(isAllowedCallbackUrl("http://localhost:8788")).toBe(true);
  });

  it("rejects non-loopback callbacks when the allowlist is unset (default closed)", () => {
    expect(isAllowedCallbackUrl(ALLOWED)).toBe(false);
    expect(validateHttpTaskRequest(withCallback(ALLOWED)).ok).toBe(false);
  });

  it("accepts only the exact origin in the allowlist", () => {
    process.env[ENV] = ALLOWED;
    expect(isAllowedCallbackUrl(ALLOWED)).toBe(true);
    expect(isAllowedCallbackUrl("https://evil.example.com")).toBe(false);
    expect(validateHttpTaskRequest(withCallback(ALLOWED)).ok).toBe(true);
  });

  it("rejects a different port on an allowed host", () => {
    process.env[ENV] = ALLOWED;
    expect(isAllowedCallbackUrl(`${ALLOWED}:9999`)).toBe(false);
  });

  it("rejects plain http when only https origin is allowed", () => {
    process.env[ENV] = ALLOWED;
    expect(isAllowedCallbackUrl("http://my-mac.tailnet-name.ts.net")).toBe(false);
  });

  it("allows plain http only when that exact http origin is listed", () => {
    process.env[ENV] = "http://my-mac.tailnet-name.ts.net:8788";
    expect(isAllowedCallbackUrl("http://my-mac.tailnet-name.ts.net:8788")).toBe(true);
  });

  it("rejects an allowed origin carrying a path or query", () => {
    process.env[ENV] = ALLOWED;
    expect(isAllowedCallbackUrl(`${ALLOWED}/tasks`)).toBe(false);
    expect(isAllowedCallbackUrl(`${ALLOWED}/?x=1`)).toBe(false);
  });

  it("stops implicitly trusting loopback once remote ingress is enabled", () => {
    process.env[INGRESS_ENV] = "my-vps.tailnet-name.ts.net";
    expect(isAllowedCallbackUrl("http://127.0.0.1:8788")).toBe(false);
    expect(isAllowedCallbackUrl("http://localhost:8788")).toBe(false);
    expect(validateHttpTaskRequest(withCallback("http://127.0.0.1:8788")).ok).toBe(
      false,
    );
  });

  it("accepts loopback under remote ingress only when its origin is explicitly listed", () => {
    process.env[INGRESS_ENV] = "my-vps.tailnet-name.ts.net";
    process.env[ENV] = "http://127.0.0.1:8788";
    expect(isAllowedCallbackUrl("http://127.0.0.1:8788")).toBe(true);
    expect(isAllowedCallbackUrl("http://127.0.0.1:9999")).toBe(false);
  });
});
