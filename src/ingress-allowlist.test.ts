import { afterEach, describe, expect, it } from "vitest";
import { isAllowedHostHeader } from "./core.js";

const ENV = "STAGEWHISPER_ALLOW_INGRESS_HOSTS";
const TAILNET_HOST = "my-mac.tailnet-name.ts.net";

describe("ingress host allowlist", () => {
  afterEach(() => {
    delete process.env[ENV];
  });

  it("always accepts loopback hosts", () => {
    expect(isAllowedHostHeader("127.0.0.1")).toBe(true);
    expect(isAllowedHostHeader("localhost:8765")).toBe(true);
  });

  it("rejects a tailnet host when the allowlist is unset (default closed)", () => {
    expect(isAllowedHostHeader(TAILNET_HOST)).toBe(false);
  });

  it("accepts a tailnet host only when it is listed", () => {
    process.env[ENV] = TAILNET_HOST;
    expect(isAllowedHostHeader(TAILNET_HOST)).toBe(true);
    expect(isAllowedHostHeader(`${TAILNET_HOST}:8765`)).toBe(true);
  });

  it("rejects other hosts even when an allowlist is set", () => {
    process.env[ENV] = TAILNET_HOST;
    expect(isAllowedHostHeader("evil.example.com")).toBe(false);
  });

  it("matches host case-insensitively", () => {
    process.env[ENV] = TAILNET_HOST;
    expect(isAllowedHostHeader(TAILNET_HOST.toUpperCase())).toBe(true);
  });

  it("rejects a missing host header", () => {
    process.env[ENV] = TAILNET_HOST;
    expect(isAllowedHostHeader(undefined)).toBe(false);
    expect(isAllowedHostHeader("")).toBe(false);
  });

  it("accepts a bracketed IPv6 loopback host with a port", () => {
    expect(isAllowedHostHeader("[::1]:8765")).toBe(true);
  });

  it("accepts a bracketed IPv6 loopback host without a port", () => {
    expect(isAllowedHostHeader("[::1]")).toBe(true);
  });

  it("rejects a bracketed IPv6 host that is not loopback", () => {
    expect(isAllowedHostHeader("[2001:db8::1]:8765")).toBe(false);
  });
});
