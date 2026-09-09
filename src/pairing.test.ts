import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { encodePairingCode, generateRelayToken, PAIRING_CODE_PREFIX } from "./pairing.js";

function decode(code: string): { url: string; token: string; label: string } {
  expect(code.startsWith(PAIRING_CODE_PREFIX)).toBe(true);
  const payload = code.slice(PAIRING_CODE_PREFIX.length);
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

describe("encodePairingCode", () => {
  it("round-trips url, token and label", () => {
    const code = encodePairingCode("http://127.0.0.1:8765", "supersecrettoken", "OpenClaw");
    expect(decode(code)).toEqual({
      url: "http://127.0.0.1:8765",
      token: "supersecrettoken",
      label: "OpenClaw",
    });
  });

  it("produces a code that matches the Hermes-emitted contract byte-for-byte", () => {
    const code = encodePairingCode("http://127.0.0.1:8765", "sekrettoken123", "Hermes");
    expect(code).toBe(
      "stagewhisper-pair:v1:eyJ1cmwiOiJodHRwOi8vMTI3LjAuMC4xOjg3NjUiLCJ0b2tlbiI6InNla3JldHRva2VuMTIzIiwibGFiZWwiOiJIZXJtZXMifQ",
    );
  });
});

describe("generateRelayToken", () => {
  it("returns a url-safe token of at least 16 chars", () => {
    const token = generateRelayToken();
    expect(token.length).toBeGreaterThanOrEqual(16);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
