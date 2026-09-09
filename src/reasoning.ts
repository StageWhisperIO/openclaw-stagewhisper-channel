import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  callOpenResponses,
  OpenResponsesError,
  type OpenResponsesCreateResponseRequestBody,
  type OpenResponsesResponseResource,
} from "./openresponses.js";

export type ProbeResult = {
  ok: boolean;
  model: string | null;
  error: string | null;
};

export async function probeOpenResponses(
  api: OpenClawPluginApi,
): Promise<ProbeResult> {
  const body: OpenResponsesCreateResponseRequestBody = {
    model: "openclaw/default",
    input: "Reply with exactly: OK",
    max_output_tokens: 16,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const result = await callOpenResponses(api, body, controller.signal, undefined);
    const model = (result as Record<string, unknown>).model as string ?? null;
    return { ok: true, model, error: null };
  } catch (err) {
    return {
      ok: false,
      model: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export type ReasoningJobEnvelope = {
  event_type: "reasoning_job";
  job_id: string;
  purpose: string;
  deadline_at: string;
  idempotency_key: string;
  schema_version: number;
  response_schema: Record<string, unknown>;
  payload: Record<string, unknown>;
  model?: string;
  correlation_id?: string;
};

export type ReasoningJobResult = {
  job_id: string;
  status: "completed" | "failed" | "timed_out";
  provider_run_id: string | null;
  model_ref: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  output: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
};

function extractTextOutput(result: OpenResponsesResponseResource): string | null {
  const output = result.output;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (item.type !== "message") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as Record<string, unknown>;
      if (p.type === "output_text" && typeof p.text === "string") {
        return p.text;
      }
    }
  }
  return null;
}

function buildSchemaInstruction(schema: Record<string, unknown>, purpose: string, systemInstruction?: string): string {
  const parts: string[] = [];
  if (systemInstruction) {
    parts.push(systemInstruction);
    parts.push("");
  }
  parts.push(
    `You are a structured reasoning engine for the "${purpose}" task.`,
    "You MUST respond with a JSON object conforming to this schema.",
    "Output ONLY valid JSON. No markdown fences, no explanation, no extra text.",
    "",
    "JSON Schema:",
    JSON.stringify(schema, null, 2),
  );
  return parts.join("\n");
}

export async function executeReasoningJob(
  api: OpenClawPluginApi,
  job: ReasoningJobEnvelope,
  displayModel: string | null,
): Promise<ReasoningJobResult> {
  const parsedDeadline = new Date(job.deadline_at).getTime();
  const deadlineMs = Number.isFinite(parsedDeadline)
    ? parsedDeadline - Date.now()
    : -1;
  if (deadlineMs <= 0) {
    return {
      job_id: job.job_id,
      status: "timed_out",
      provider_run_id: null,
      model_ref: displayModel,
      usage: null,
      output: null,
      error_code: "deadline_expired_before_start",
      error_message: "Job deadline had already passed when execution began",
    };
  }

  const model = job.model ?? displayModel ?? "openclaw/default";
  const correlationId = job.correlation_id;

  const requestBody: OpenResponsesCreateResponseRequestBody = {
    model,
    input: JSON.stringify(job.payload),
    instructions: buildSchemaInstruction(
      job.response_schema,
      job.purpose,
      (job.payload.system_instruction as string) ?? undefined,
    ),
    max_output_tokens: 4096,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);

  try {
    const result = await callOpenResponses(api, requestBody, controller.signal, correlationId);
    const textOutput = extractTextOutput(result);

    let parsed: Record<string, unknown> | null = null;
    if (textOutput) {
      const cleaned = textOutput.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
      try {
        parsed = JSON.parse(cleaned) as Record<string, unknown>;
      } catch {
        return {
          job_id: job.job_id,
          status: "failed",
          provider_run_id: result.id,
          model_ref: (result as Record<string, unknown>).model as string ?? model,
          usage: result.usage
            ? {
                input_tokens: result.usage.input_tokens ?? 0,
                output_tokens: result.usage.output_tokens ?? 0,
              }
            : null,
          output: null,
          error_code: "response_parse_error",
          error_message: "Response text is not valid JSON",
        };
      }
    }

    return {
      job_id: job.job_id,
      status: "completed",
      provider_run_id: result.id,
      model_ref: (result as Record<string, unknown>).model as string ?? model,
      usage: result.usage
        ? {
            input_tokens: result.usage.input_tokens ?? 0,
            output_tokens: result.usage.output_tokens ?? 0,
          }
        : null,
      output: parsed,
      error_code: null,
      error_message: null,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        job_id: job.job_id,
        status: "timed_out",
        provider_run_id: null,
        model_ref: model,
        usage: null,
        output: null,
        error_code: "deadline_exceeded",
        error_message: `Reasoning execution exceeded deadline of ${deadlineMs}ms`,
      };
    }

    const isRetryable = err instanceof OpenResponsesError && err.retryable;
    return {
      job_id: job.job_id,
      status: "failed",
      provider_run_id: null,
      model_ref: model,
      usage: null,
      output: null,
      error_code: isRetryable ? "retryable_error" : "execution_error",
      error_message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
