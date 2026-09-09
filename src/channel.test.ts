import { describe, it, expect } from "vitest";

describe("config resolution", () => {
  type Config = import("openclaw/plugin-sdk/core").OpenClawConfig;

  it("resolveAccount resolves the http transport from httpToken", async () => {
    const { resolveAccount } = await import("./channel.js");

    const cfg = {
      plugins: {
        entries: {
          stagewhisper: {
            config: {
              httpToken: "http-token-1234567890",
              label: "Local",
            },
          },
        },
      },
    } as unknown as Config;

    const account = resolveAccount(cfg);
    expect(account.relayToken).toBe("http-token-1234567890");
    expect(account.integrationId).toBe("stagewhisper-http");
    expect(account.label).toBe("Local");
  });

  it("resolveAccount throws when httpToken is missing", async () => {
    const { resolveAccount } = await import("./channel.js");

    const cfg = { channels: {} } as unknown as Config;
    expect(() => resolveAccount(cfg)).toThrow("httpToken");
  });

  it("resolveAccount throws when httpToken is too short", async () => {
    const { resolveAccount } = await import("./channel.js");

    const cfg = {
      plugins: {
        entries: {
          stagewhisper: { config: { httpToken: "short" } },
        },
      },
    } as unknown as Config;

    expect(() => resolveAccount(cfg)).toThrow("httpToken");
  });

  it("rejects a backend-style relayToken as the http transport credential", async () => {
    const { resolveAccount, stagewhisperPlugin } = await import("./channel.js");

    const cfg = {
      plugins: {
        entries: {
          stagewhisper: {
            config: {
              relayToken: "relay-token-32-chars-aaaaaaaaaaaa",
            },
          },
        },
      },
    } as unknown as Config;

    expect(() => resolveAccount(cfg)).toThrow("httpToken");
    expect(stagewhisperPlugin.config.listAccountIds(cfg)).toEqual([]);
  });

  it("listAccountIds reports the channel once an httpToken is configured", async () => {
    const { stagewhisperPlugin } = await import("./channel.js");

    const cfg = {
      plugins: {
        entries: {
          stagewhisper: {
            config: { httpToken: "http-token-1234567890" },
          },
        },
      },
    } as unknown as Config;

    expect(stagewhisperPlugin.config.listAccountIds(cfg)).toEqual(["default"]);
  });

  it("listAccountIds reports no accounts when nothing is configured", async () => {
    const { stagewhisperPlugin } = await import("./channel.js");

    const cfg = { channels: {} } as unknown as Config;
    expect(stagewhisperPlugin.config.listAccountIds(cfg)).toEqual([]);
  });
});
