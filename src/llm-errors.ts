import { Buffer } from "node:buffer";
import type { NormalizedResponse } from "./http-transport-protocol.js";

const ERROR_TYPES: Record<number, string> = {
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  429: "rate_limit_error",
};

export type LlmRejection = {
  ok: false;
  status: number;
  code: string;
  message: string;
  param?: string;
};

export function rejection(status: number, code: string, message: string, param?: string): LlmRejection {
  return { ok: false, status, code, message, param };
}

export function openAiError(failure: LlmRejection): { error: Record<string, unknown> } {
  return {
    error: {
      message: failure.message,
      type: ERROR_TYPES[failure.status] ?? (failure.status >= 500 ? "server_error" : "invalid_request_error"),
      param: failure.param ?? null,
      code: failure.code,
    },
  };
}

export function openAiErrorResponse(failure: LlmRejection): NormalizedResponse {
  const body = JSON.stringify(openAiError(failure));
  return {
    status: failure.status,
    headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) },
    body,
  };
}
