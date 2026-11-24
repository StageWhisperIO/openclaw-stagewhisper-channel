import { afterEach, describe, expect, it, vi } from "vitest";

type CommandAction = (opts: Record<string, unknown>) => Promise<void> | void;

function createProgram(actions: Map<string, CommandAction>, path: string[] = []) {
  return {
    command(name: string) {
      return createProgram(actions, [...path, name]);
    },
    description() {
      return this;
    },
    requiredOption() {
      return this;
    },
    option() {
      return this;
    },
    action(handler: CommandAction) {
      actions.set(path.join(" "), handler);
      return this;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveHttpTransportToken", () => {
  it("does not accept a backend relayToken as the http transport credential", async () => {
    const { resolveHttpTransportToken } = await import("../plugin-main.js");
    const token = resolveHttpTransportToken(
      { relayToken: "relay-token-32-chars-aaaaaaaaaaaa" },
      {} as NodeJS.ProcessEnv,
    );
    expect(token).toBe("");
  });

  it("uses an explicit httpToken and ignores any relayToken", async () => {
    const { resolveHttpTransportToken } = await import("../plugin-main.js");
    const token = resolveHttpTransportToken(
      {
        httpToken: "explicit-http-token-32-chars-xxx",
        relayToken: "relay-token-32-chars-aaaaaaaaaaaa",
      },
      {} as NodeJS.ProcessEnv,
    );
    expect(token).toBe("explicit-http-token-32-chars-xxx");
  });

  it("uses STAGEWHISPER_HTTP_TOKEN and ignores any relayToken", async () => {
    const { resolveHttpTransportToken } = await import("../plugin-main.js");
    const token = resolveHttpTransportToken(
      { relayToken: "relay-token-32-chars-aaaaaaaaaaaa" },
      { STAGEWHISPER_HTTP_TOKEN: "env-http-token-32-chars-yyyyyyyy" } as NodeJS.ProcessEnv,
    );
    expect(token).toBe("env-http-token-32-chars-yyyyyyyy");
  });

  it("returns empty string when nothing is configured", async () => {
    const { resolveHttpTransportToken } = await import("../plugin-main.js");
    expect(resolveHttpTransportToken({}, {} as NodeJS.ProcessEnv)).toBe("");
  });
});

describe("stagewhisper pair-code command", () => {
  it("writes the http transport config without any backend fields", async () => {
    const actions = new Map<string, CommandAction>();
    const writtenConfigs: Array<Record<string, unknown>> = [];

    const api = {
      registerChannel: vi.fn(),
      registerCli(cb: ({ program }: { program: ReturnType<typeof createProgram> }) => void) {
        cb({ program: createProgram(actions) });
      },
      registrationMode: "setup",
      runtime: {
        config: {
          loadConfig: vi.fn().mockResolvedValue({}),
          writeConfigFile: vi.fn().mockImplementation(async (cfg: Record<string, unknown>) => {
            writtenConfigs.push(JSON.parse(JSON.stringify(cfg)));
          }),
        },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };

    const plugin = (await import("../plugin-main.js")).default;
    plugin.register(api as never);

    const pairCode = actions.get("stagewhisper pair-code");
    expect(pairCode).toBeTypeOf("function");

    await pairCode?.({ label: "OpenClaw" });

    expect(writtenConfigs).toHaveLength(1);

    const cfg = writtenConfigs[0] as {
      plugins?: { entries?: Record<string, { config?: Record<string, unknown> }> };
    };
    const swConfig = cfg.plugins?.entries?.stagewhisper?.config;

    expect(swConfig).not.toHaveProperty("apiBaseUrl");
    expect(swConfig).not.toHaveProperty("integrationId");
    expect(swConfig).not.toHaveProperty("relayToken");
    expect(typeof swConfig?.["httpToken"]).toBe("string");
    expect((swConfig?.["httpToken"] as string).length).toBeGreaterThanOrEqual(16);
    expect(swConfig?.["httpHost"]).toBe("127.0.0.1");
    expect(swConfig?.["httpPort"]).toBe(8765);
    expect(swConfig?.["label"]).toBe("OpenClaw");
  });
});
