import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { isAllowedHostHeader } from "./core.js";

export type NormalizedRequest = {
  method: string;
  url: string;
  authorization?: string;
  host?: string;
  remoteAddress?: string;
  body: string;
};

export type NormalizedResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type GuardLogger = {
  warn: (message: string) => void;
};

export function constantTimeTokenEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    const sink = Buffer.alloc(Math.max(a.length, b.length));
    timingSafeEqual(sink, sink);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  if (!match) return null;
  return match[1]?.trim() ?? null;
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === "127.0.0.1" || addr === "::1") return true;
  if (addr === "::ffff:127.0.0.1") return true;
  return false;
}

export function jsonResponse(status: number, body: Record<string, unknown>): NormalizedResponse {
  const serialized = JSON.stringify(body);
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(serialized)),
    },
    body: serialized,
  };
}

export function writeResponse(res: http.ServerResponse, response: NormalizedResponse): void {
  res.statusCode = response.status;
  for (const [key, value] of Object.entries(response.headers)) {
    res.setHeader(key, value);
  }
  res.end(response.body);
}

export function guardRequest(
  req: NormalizedRequest,
  token: string,
  logger: GuardLogger,
): NormalizedResponse | null {
  if (!isLoopbackAddress(req.remoteAddress)) {
    logger.warn(`[stagewhisper-http] rejecting non-loopback connection from ${req.remoteAddress}`);
    return jsonResponse(403, { error: "non_loopback_rejected" });
  }

  if (!isAllowedHostHeader(req.host)) {
    logger.warn(`[stagewhisper-http] rejecting disallowed Host header: ${req.host ?? "<missing>"}`);
    return jsonResponse(403, { error: "invalid_host" });
  }

  const providedToken = extractBearerToken(req.authorization);
  if (!providedToken || !constantTimeTokenEqual(providedToken, token)) {
    return jsonResponse(401, { error: "invalid_token" });
  }

  return null;
}
