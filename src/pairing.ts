import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

export const PAIRING_CODE_PREFIX = "stagewhisper-pair:v1:";

export function encodePairingCode(url: string, token: string, label: string): string {
  const payload = JSON.stringify({ url, token, label });
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  return `${PAIRING_CODE_PREFIX}${encoded}`;
}

export function generateRelayToken(): string {
  return randomBytes(32).toString("base64url");
}
