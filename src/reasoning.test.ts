import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeReasoningJob, type ReasoningJobEnvelope } from "./reasoning.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

vi.mock("./openresponses.js", () => ({
  callOpenResponses: vi.fn(),
  OpenResponsesError: class extends Error {
    status: number;
    retryable: boolean;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
      this.retryable = status >= 500;
    }
  },
}));

const { callOpenResponses, OpenResponsesError } = await import("./openresponses.js");
const mockCall = vi.mocked(callOpenResponses);

function makeApi(): OpenClawPluginApi {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: { get: vi.fn().mockReturnValue({}) },
  } as unknown as OpenClawPluginApi;
}

function makeJob(overrides: Partial<ReasoningJobEnvelope> = {}): ReasoningJobEnvelope {
  return {
    event_type: "reasoning_job",
    job_id: "job-123",
    purpose: "live_analysis",
    deadline_at: new Date(Date.now() + 30_000).toISOString(),
    idempotency_key: "idem-1",
    schema_version: 1,
    response_schema: {
      type: "object",
      properties: { signals: { type: "array" } },
      required: ["signals"],
    },
    payload: { transcript: "Hello world" },
    ...overrides,
  };
}

describe("executeReasoningJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns completed with parsed JSON output", async () => {
    mockCall.mockResolvedValue({
      id: "resp-abc",
      model: "gpt-4o",
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: '{"signals": [{"severity": "green", "message": "ok"}]}' },
          ],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    } as never);

    const result = await executeReasoningJob(makeApi(), makeJob(), "gpt-4o");
    expect(result.status).toBe("completed");
    expect(result.job_id).toBe("job-123");
    expect(result.output).toEqual({ signals: [{ severity: "green", message: "ok" }] });
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(result.provider_run_id).toBe("resp-abc");
  });

  it("returns timed_out when deadline already passed", async () => {
    const job = makeJob({ deadline_at: new Date(Date.now() - 1000).toISOString() });
    const result = await executeReasoningJob(makeApi(), job, "gpt-4o");
    expect(result.status).toBe("timed_out");
    expect(result.error_code).toBe("deadline_expired_before_start");
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("returns failed when output is not valid JSON", async () => {
    mockCall.mockResolvedValue({
      id: "resp-bad",
      output: [
        { type: "message", content: [{ type: "output_text", text: "not json" }] },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    } as never);

    const result = await executeReasoningJob(makeApi(), makeJob(), "gpt-4o");
    expect(result.status).toBe("failed");
    expect(result.error_code).toBe("response_parse_error");
  });

  it("returns failed with retryable flag on 5xx errors", async () => {
    const err = new (OpenResponsesError as unknown as new (msg: string, status: number) => Error & { retryable: boolean })(
      "Internal Server Error",
      500,
    );
    mockCall.mockRejectedValue(err);

    const result = await executeReasoningJob(makeApi(), makeJob(), "gpt-4o");
    expect(result.status).toBe("failed");
    expect(result.error_code).toBe("retryable_error");
  });

  it("returns failed with execution_error on non-retryable errors", async () => {
    mockCall.mockRejectedValue(new Error("Network failure"));

    const result = await executeReasoningJob(makeApi(), makeJob(), "gpt-4o");
    expect(result.status).toBe("failed");
    expect(result.error_code).toBe("execution_error");
    expect(result.error_message).toBe("Network failure");
  });
});
