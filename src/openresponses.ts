import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type GatewayConfig = { url: string; apiKey: string | null };

function resolveGatewayConfig(api: OpenClawPluginApi): GatewayConfig {
  const cfg = api.config as Record<string, unknown>;
  const gw = (cfg?.gateway as Record<string, unknown>) ?? {};
  const auth = (gw?.auth as Record<string, unknown>) ?? {};

  const port = Number(gw?.port) || 18789;
  const explicitUrl = typeof gw?.url === "string" ? gw.url : null;
  const url = (explicitUrl ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");

  const token = typeof auth?.token === "string" ? auth.token : null;

  return { url, apiKey: token };
}

export function isResponsesEndpointEnabled(api: OpenClawPluginApi): boolean {
  const cfg = api.config as Record<string, unknown>;
  const gw = (cfg?.gateway as Record<string, unknown>) ?? {};
  const http = (gw?.http as Record<string, unknown>) ?? {};
  const endpoints = (http?.endpoints as Record<string, unknown>) ?? {};
  const responses = (endpoints?.responses as Record<string, unknown>) ?? {};
  return responses?.enabled === true;
}

export async function callOpenResponses(
  api: OpenClawPluginApi,
  requestBody: OpenResponsesCreateResponseRequestBody,
  signal?: AbortSignal,
  correlationId?: string,
): Promise<OpenResponsesResponseResource> {
  const gw = resolveGatewayConfig(api);
  const url = `${gw.url}/v1/responses`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (gw.apiKey) {
    headers["Authorization"] = `Bearer ${gw.apiKey}`;
  }
  if (correlationId) {
    headers["X-Correlation-ID"] = correlationId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 404) {
      throw new OpenResponsesError(
        "POST /v1/responses returned 404 — the OpenResponses HTTP API is most likely disabled. " +
        'Enable it in OpenClaw config: gateway.http.endpoints.responses.enabled = true, then restart the gateway.',
        response.status,
      );
    }
    throw new OpenResponsesError(`POST /v1/responses returned ${response.status}: ${body}`, response.status);
  }
  return (await response.json()) as OpenResponsesResponseResource;
}

export class OpenResponsesError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "OpenResponsesError";
  }

  get retryable(): boolean {
    return (
      this.statusCode === 408 ||
      this.statusCode === 429 ||
      (this.statusCode >= 500 && this.statusCode < 600)
    );
  }
}

export type { components, operations, paths, webhooks } from "../openresponses";

export type OpenResponsesCreateResponseOperation =
  import("../openresponses").operations["createResponse"];
export type OpenResponsesCreateResponseRequestBody =
  import("../openresponses").components["schemas"]["CreateResponseBody"];
export type OpenResponsesResponseResource =
  import("../openresponses").components["schemas"]["ResponseResource"];
export type OpenResponsesRequestItem =
  import("../openresponses").components["schemas"]["ItemParam"];
export type OpenResponsesResponseItem =
  import("../openresponses").components["schemas"]["ItemField"];
export type OpenResponsesTool =
  import("../openresponses").components["schemas"]["ResponsesToolParam"];
export type OpenResponsesToolChoice =
  import("../openresponses").components["schemas"]["ToolChoiceParam"];
export type OpenResponsesTextFormat =
  import("../openresponses").components["schemas"]["TextFormatParam"];
export type OpenResponsesReasoning =
  import("../openresponses").components["schemas"]["ReasoningParam"];
export type OpenResponsesStreamEvent =
  import("../openresponses").operations["createResponse"]["responses"][200]["content"]["text/event-stream"];
