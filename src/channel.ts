import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID } from "./openclaw-lite.js";
import { MIN_HTTP_TOKEN_LENGTH, resolveHttpTransportToken } from "./transport.js";

const HTTP_TRANSPORT_INTEGRATION_ID = "stagewhisper-http";

export type StageWhisperAccount = {
  accountId: string | null;
  integrationId: string;
  relayToken: string;
  label: string;
};

function getChannelSection(cfg: OpenClawConfig): Record<string, unknown> {
  const channels = cfg.channels as
    | Record<string, Record<string, unknown>>
    | undefined;
  return channels?.["stagewhisper"] ?? {};
}

export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): StageWhisperAccount {
  const section = getChannelSection(cfg);
  const pluginCfg = (cfg as Record<string, unknown>)?.["plugins"] as
    | Record<string, unknown>
    | undefined;
  const entries = pluginCfg?.["entries"] as
    | Record<string, Record<string, unknown>>
    | undefined;
  const swConfig = entries?.["stagewhisper"]?.["config"] as
    | Record<string, unknown>
    | undefined;

  const label =
    (section["label"] as string) ??
    (swConfig?.["label"] as string) ??
    "StageWhisper";

  const token = resolveHttpTransportToken(swConfig ?? {});
  if (token.length < MIN_HTTP_TOKEN_LENGTH) {
    throw new Error(
      "stagewhisper: httpToken (>=16 chars) is required for the http transport",
    );
  }

  return {
    accountId: accountId ?? null,
    integrationId: HTTP_TRANSPORT_INTEGRATION_ID,
    relayToken: token,
    label,
  };
}

export const stagewhisperPlugin: ChannelPlugin<StageWhisperAccount> = {
  id: "stagewhisper",
  meta: {
    id: "stagewhisper",
    label: "StageWhisper",
    selectionLabel: "StageWhisper",
    docsPath: "/plugins/stagewhisper",
    blurb: "Turn live call moments into assistant tasks",
  },
  capabilities: {
    chatTypes: ["direct"],
  },
  config: {
    listAccountIds(cfg: OpenClawConfig) {
      try {
        resolveAccount(cfg);
        return [DEFAULT_ACCOUNT_ID];
      } catch {
        return [];
      }
    },
    defaultAccountId() {
      return DEFAULT_ACCOUNT_ID;
    },
    resolveAccount,
    inspectAccount(cfg: OpenClawConfig) {
      try {
        const account = resolveAccount(cfg);
        return {
          enabled: true,
          configured: true,
          label: account.label,
        };
      } catch {
        return {
          enabled: false,
          configured: false,
          tokenStatus: "missing",
        };
      }
    },
  },
  security: {
    resolveDmPolicy() {
      return {
        policy: "closed",
        allowFrom: [],
        allowFromPath: "channels.stagewhisper.allowFrom",
        approveHint:
          "Approve via: openclaw pairing list stagewhisper / openclaw pairing approve stagewhisper <code>",
      };
    },
  },
  pairing: {
    idLabel: "StageWhisper pairing code",
    async notifyApproval() {},
  },
  outbound: {
    deliveryMode: "direct",
    resolveTarget(params: {
      cfg?: OpenClawConfig;
      to?: string;
      allowFrom?: string[];
      accountId?: string | null;
      mode?: string;
    }) {
      if (!params.to) {
        return { ok: false as const, error: new Error("No delivery target") };
      }
      return { ok: true as const, to: params.to };
    },
    async sendText(ctx) {
      const target = ((ctx as Record<string, unknown>).to as string | undefined) ?? "";
      if (target.startsWith("sw-session-")) {
        return {
          channel: "stagewhisper",
          messageId: `sw-relay-ack-${Date.now()}`,
          ok: true,
        };
      }
      console.warn(
        `[stagewhisper] sendText called for unrecognised target "${target}"; ` +
          "StageWhisper channel is inbound-only — task replies are routed by the HTTP transport",
      );
      return {
        channel: "stagewhisper",
        messageId: `sw-dropped-${Date.now()}`,
        ok: false,
      };
    },
  },
};
