import type {
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
} from "openclaw/plugin-sdk/core";

export const DEFAULT_ACCOUNT_ID = "default";

type OpenClawPluginDefinition = {
  id: string;
  name: string;
  description: string;
  kind?: string;
  configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
  register: (api: OpenClawPluginApi) => void;
};

type RoutePeerKind = "direct" | "group" | "channel";

type RoutePeer = {
  kind: RoutePeerKind;
  id: string;
};

type BuildAgentSessionKeyParams = {
  agentId: string;
  channel?: string;
  accountId?: string | null;
  peer?: RoutePeer | null;
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  identityLinks?: Record<string, string[]>;
};

const EMPTY_PLUGIN_CONFIG_SCHEMA: OpenClawPluginConfigSchema = {
  safeParse(value: unknown) {
    if (value === undefined) {
      return { success: true, data: undefined };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        success: false,
        error: { issues: [{ path: [], message: "expected config object" }] },
      };
    }
    if (Object.keys(value).length > 0) {
      return {
        success: false,
        error: { issues: [{ path: [], message: "config must be empty" }] },
      };
    }
    return { success: true, data: value };
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
};

function normalizeAgentId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "main";
  return (
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/g, "")
      .replace(/-+$/g, "")
      .slice(0, 64) || "main"
  );
}

function normalizeAccountId(value?: string | null): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return DEFAULT_ACCOUNT_ID;
  return (
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/g, "")
      .replace(/-+$/g, "")
      .slice(0, 64) || DEFAULT_ACCOUNT_ID
  );
}

function normalizeMainKey(value?: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : "main";
}

function buildAgentMainSessionKey(agentId: string, mainKey?: string): string {
  return `agent:${normalizeAgentId(agentId)}:${normalizeMainKey(mainKey)}`;
}

function normalizeToken(value?: string): string {
  return (value ?? "").trim().toLowerCase();
}

function resolveLinkedPeerId(params: {
  identityLinks?: Record<string, string[]>;
  channel?: string;
  peerId: string;
}): string | null {
  const { identityLinks } = params;
  if (!identityLinks) return null;

  const peerId = params.peerId.trim();
  if (!peerId) return null;

  const candidates = new Set<string>();
  const rawCandidate = normalizeToken(peerId);
  if (rawCandidate) candidates.add(rawCandidate);

  const channel = normalizeToken(params.channel);
  if (channel) {
    const scopedCandidate = normalizeToken(`${channel}:${peerId}`);
    if (scopedCandidate) candidates.add(scopedCandidate);
  }

  if (candidates.size === 0) return null;

  for (const [canonical, ids] of Object.entries(identityLinks)) {
    const canonicalName = canonical.trim();
    if (!canonicalName || !Array.isArray(ids)) continue;
    for (const id of ids) {
      const normalized = normalizeToken(id);
      if (normalized && candidates.has(normalized)) {
        return canonicalName;
      }
    }
  }

  return null;
}

export function buildAgentSessionKey(params: BuildAgentSessionKeyParams): string {
  const peerKind = params.peer?.kind ?? "direct";

  if (peerKind === "direct") {
    const dmScope = params.dmScope ?? "main";
    let peerId = params.peer?.id?.trim() ?? "";

    const linkedPeerId =
      dmScope === "main"
        ? null
        : resolveLinkedPeerId({
            identityLinks: params.identityLinks,
            channel: params.channel,
            peerId,
          });

    if (linkedPeerId) {
      peerId = linkedPeerId;
    }

    peerId = peerId.toLowerCase();

    if (dmScope === "per-account-channel-peer" && peerId) {
      const channel = normalizeToken(params.channel) || "unknown";
      const accountId = normalizeAccountId(params.accountId);
      return `agent:${normalizeAgentId(params.agentId)}:${channel}:${accountId}:direct:${peerId}`;
    }

    if (dmScope === "per-channel-peer" && peerId) {
      const channel = normalizeToken(params.channel) || "unknown";
      return `agent:${normalizeAgentId(params.agentId)}:${channel}:direct:${peerId}`;
    }

    if (dmScope === "per-peer" && peerId) {
      return `agent:${normalizeAgentId(params.agentId)}:direct:${peerId}`;
    }

    return buildAgentMainSessionKey(params.agentId);
  }

  const channel = normalizeToken(params.channel) || "unknown";
  const peerId = (params.peer?.id?.trim() || "unknown").toLowerCase();
  return `agent:${normalizeAgentId(params.agentId)}:${channel}:${peerKind}:${peerId}`;
}

export function definePluginEntry({
  id,
  name,
  description,
  kind,
  configSchema = EMPTY_PLUGIN_CONFIG_SCHEMA,
  register,
}: OpenClawPluginDefinition) {
  return {
    id,
    name,
    description,
    ...(kind ? { kind } : {}),
    configSchema:
      typeof configSchema === "function" ? configSchema() : configSchema,
    register,
  };
}

export function createPluginRuntimeStore<T>(errorMessage: string) {
  let runtime: T | null = null;

  return {
    setRuntime(next: T) {
      runtime = next;
    },
    clearRuntime() {
      runtime = null;
    },
    tryGetRuntime() {
      return runtime;
    },
    getRuntime() {
      if (runtime === null) {
        throw new Error(errorMessage);
      }
      return runtime;
    },
  };
}
