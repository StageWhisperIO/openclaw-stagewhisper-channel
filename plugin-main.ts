import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";
import { stagewhisperPlugin } from "./src/channel.js";
import { createHttpTransport } from "./src/http-transport.js";
import { definePluginEntry } from "./src/openclaw-lite.js";
import { encodePairingCode, generateRelayToken } from "./src/pairing.js";
import { setRuntime } from "./src/runtime.js";
import { MIN_HTTP_TOKEN_LENGTH, resolveHttpTransportToken } from "./src/transport.js";

export { resolveHttpTransportToken };

function createHttpTransportService(api: OpenClawPluginApi) {
  const pluginCfg = (api.pluginConfig as Record<string, unknown> | undefined) ?? {};
  const host =
    typeof pluginCfg["httpHost"] === "string"
      ? (pluginCfg["httpHost"] as string)
      : (process.env["STAGEWHISPER_HTTP_HOST"] ?? "127.0.0.1");
  const portRaw = pluginCfg["httpPort"];
  const port =
    typeof portRaw === "number"
      ? portRaw
      : typeof portRaw === "string"
        ? Number(portRaw)
        : Number(process.env["STAGEWHISPER_HTTP_PORT"]) || 8765;
  const token = resolveHttpTransportToken(pluginCfg);

  let transport: ReturnType<typeof createHttpTransport> | null = null;

  return {
    id: "stagewhisper-http-transport",
    async start(_ctx: OpenClawPluginServiceContext): Promise<void> {
      if (token.length < MIN_HTTP_TOKEN_LENGTH) {
        api.logger.warn(
          "StageWhisper HTTP transport requires `httpToken` (>=16 chars) in plugin config or STAGEWHISPER_HTTP_TOKEN env var — listener not started.",
        );
        return;
      }
      transport = createHttpTransport({ api, host, port, token });
      try {
        await transport.start();
        api.logger.info(`StageWhisper HTTP transport started on ${host}:${port}`);
      } catch (err) {
        api.logger.error(`StageWhisper HTTP transport failed to start: ${err}`);
        transport = null;
      }
    },
    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      if (transport) {
        await transport.stop();
        transport = null;
      }
    },
  };
}

async function ensureResponsesEndpoint(api: OpenClawPluginApi): Promise<void> {
  try {
    const cfg = await api.runtime.config.loadConfig();
    const gw = ((cfg as Record<string, unknown>)["gateway"] ?? {}) as Record<string, unknown>;
    const http = (gw["http"] ?? {}) as Record<string, unknown>;
    const endpoints = (http["endpoints"] ?? {}) as Record<string, unknown>;
    const responses = (endpoints["responses"] ?? {}) as Record<string, unknown>;

    if (responses["enabled"] === true) return;

    const auth = (gw["auth"] ?? {}) as Record<string, unknown>;
    if (auth["mode"] === "none" && !auth["token"] && !auth["password"]) return;

    responses["enabled"] = true;
    endpoints["responses"] = responses;
    http["endpoints"] = endpoints;
    gw["http"] = http;
    (cfg as Record<string, unknown>)["gateway"] = gw;

    await api.runtime.config.writeConfigFile(cfg);
    api.logger.info(
      "Enabled gateway.http.endpoints.responses for StageWhisper reasoning. Restart the gateway for it to take effect.",
    );
  } catch {
    // best-effort — reasoning-check will surface the real error
  }
}

export default definePluginEntry({
  id: "stagewhisper",
  name: "StageWhisper",
  description: "Turn live call moments into assistant tasks via StageWhisper",
  register(api) {
    api.registerChannel({ plugin: stagewhisperPlugin });

    api.registerCli(
      ({ program }) => {
        const sw = program.command("stagewhisper").description("StageWhisper integration");

        sw.command("pair-code")
          .description(
            "Generate a StageWhisper pairing code for the local HTTP transport (no backend)",
          )
          .option("--url <url>", "Relay URL StageWhisper should reach this gateway at")
          .option("--port <port>", "Loopback port for the HTTP transport listener")
          .option("--label <label>", "Label shown in StageWhisper", "OpenClaw")
          .action(async (opts: { url?: string; port?: string; label?: string }) => {
            try {
              const cfg = await api.runtime.config.loadConfig();
              const plugins =
                ((cfg as Record<string, unknown>)["plugins"] as Record<string, unknown>) ?? {};
              const entries = (plugins["entries"] as Record<string, Record<string, unknown>>) ?? {};
              const swEntry = entries["stagewhisper"] ?? {};
              const swConfig = (swEntry["config"] as Record<string, unknown>) ?? {};

              const host =
                typeof swConfig["httpHost"] === "string" && swConfig["httpHost"]
                  ? (swConfig["httpHost"] as string)
                  : "127.0.0.1";
              const port = opts.port
                ? Number(opts.port)
                : typeof swConfig["httpPort"] === "number"
                  ? (swConfig["httpPort"] as number)
                  : 8765;
              if (!Number.isInteger(port) || port < 1024 || port > 65535) {
                console.error(`\n✗ Invalid port ${port} (must be 1024-65535)\n`);
                process.exit(1);
              }

              let token =
                typeof swConfig["httpToken"] === "string" ? (swConfig["httpToken"] as string) : "";
              if (token.length < 16) {
                token = generateRelayToken();
              }
              const label =
                (opts.label ?? (swConfig["label"] as string) ?? "OpenClaw").trim() || "OpenClaw";

              swConfig["httpHost"] = host;
              swConfig["httpPort"] = port;
              swConfig["httpToken"] = token;
              swConfig["label"] = label;
              swEntry["config"] = swConfig;
              entries["stagewhisper"] = swEntry;
              plugins["entries"] = entries;
              (cfg as Record<string, unknown>)["plugins"] = plugins;
              await api.runtime.config.writeConfigFile(cfg);

              const relayUrl = (opts.url ?? "").trim() || `http://${host}:${port}`;
              const code = encodePairingCode(relayUrl, token, label);

              console.log("\nStageWhisper pairing code:\n");
              console.log(`  ${code}\n`);
              console.log("Paste it into StageWhisper under Settings → Connection.");
              console.log(
                "Restart the gateway so the HTTP transport listens: openclaw gateway restart",
              );
              if (relayUrl.startsWith("http://127.0.0.1")) {
                console.log(
                  "\nRunning on a remote host? Tunnel the port from the machine running StageWhisper:",
                );
                console.log(`  ssh -L ${port}:127.0.0.1:${port} <this-host>\n`);
              }
            } catch (err) {
              console.error(`\n✗ Failed to generate pairing code: ${err}\n`);
              process.exit(1);
            }
          });

        sw.command("unpair")
          .description("Remove StageWhisper pairing (run before `openclaw plugins uninstall`)")
          .option("--keep-responses", "Keep the OpenResponses HTTP API enabled after unpair")
          .action(async (opts: { keepResponses?: boolean }) => {
            try {
              const cfg = await api.runtime.config.loadConfig();
              const plugins =
                ((cfg as Record<string, unknown>)["plugins"] as Record<string, unknown>) ?? {};
              const entries = (plugins["entries"] as Record<string, Record<string, unknown>>) ?? {};
              const swEntry = entries["stagewhisper"];
              if (swEntry) {
                delete swEntry["config"];
              }

              const channels = (cfg as Record<string, unknown>)["channels"] as
                | Record<string, unknown>
                | undefined;
              if (channels?.["stagewhisper"]) {
                delete channels["stagewhisper"];
                if (Object.keys(channels).length === 0) {
                  delete (cfg as Record<string, unknown>)["channels"];
                }
              }

              if (!opts.keepResponses) {
                const gw = (cfg as Record<string, unknown>)["gateway"] as
                  | Record<string, unknown>
                  | undefined;
                const http = gw?.["http"] as Record<string, unknown> | undefined;
                const endpoints = http?.["endpoints"] as Record<string, unknown> | undefined;
                const responses = endpoints?.["responses"] as Record<string, unknown> | undefined;
                if (responses?.["enabled"] === true) {
                  delete responses["enabled"];
                  if (Object.keys(responses).length === 0 && endpoints)
                    delete endpoints["responses"];
                  if (endpoints && Object.keys(endpoints).length === 0 && http)
                    delete http["endpoints"];
                  if (http && Object.keys(http).length === 0 && gw) delete gw["http"];
                  console.log(
                    "  ℹ Disabled gateway.http.endpoints.responses. Use --keep-responses to preserve it.",
                  );
                }
              }

              await api.runtime.config.writeConfigFile(cfg);
              console.log("\n✓ StageWhisper unpaired.");
              console.log("  Config cleaned. You can now safely uninstall:\n");
              console.log("  openclaw plugins uninstall stagewhisper\n");
            } catch (err) {
              console.error(`\n✗ Unpair failed: ${err}\n`);
              process.exit(1);
            }
          });

        sw.command("reasoning-check")
          .description("Test reasoning capability against the local OpenResponses endpoint")
          .option(
            "--model <model>",
            "Model to use (omit to use your configured default)",
            "openclaw/default",
          )
          .action(async (opts: { model: string }) => {
            const { callOpenResponses, isResponsesEndpointEnabled } =
              await import("./src/openresponses.js");
            const modelLabel =
              opts.model === "openclaw/default" ? "default (configured)" : opts.model;

            const cfg = api.config as Record<string, unknown>;
            const gw = (cfg?.gateway as Record<string, unknown>) ?? {};
            const auth = (gw?.auth as Record<string, unknown>) ?? {};
            const port = Number(gw?.port) || 18789;
            const hasToken = typeof auth?.token === "string" && auth.token.length > 0;
            const responsesEnabled = isResponsesEndpointEnabled(api);

            console.log("Preflight checks:");
            console.log(`  Gateway port:       ${port}`);
            console.log(`  Auth token:         ${hasToken ? "✓ present" : "✗ MISSING"}`);
            console.log(`  responses.enabled:  ${responsesEnabled ? "✓ true" : "✗ false"}`);

            if (!responsesEnabled) {
              console.warn("\n⚠ responses.enabled is false in the running config.");
              console.warn(
                "  The plugin auto-enables it on startup — restart the gateway if you haven't:",
              );
              console.warn("  openclaw gateway restart\n");
            }

            if (!hasToken) {
              console.warn("\n⚠ No gateway auth token found — request may be rejected.\n");
            }

            console.log(`\nTesting reasoning with model: ${modelLabel}`);
            console.log("Sending test request to local /v1/responses ...");

            const testSchema = {
              type: "object",
              properties: {
                signals: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      severity: { type: "string", enum: ["green", "orange", "red"] },
                      message: { type: "string" },
                    },
                    required: ["severity", "message"],
                    additionalProperties: false,
                  },
                },
                no_signal_reason: { type: "string" },
              },
              required: ["signals", "no_signal_reason"],
              additionalProperties: false,
            };

            const start = Date.now();
            try {
              const result = await callOpenResponses(api, {
                model: opts.model,
                input: JSON.stringify({
                  transcript: "Candidate: I think we should use Redis for caching.",
                  playbook_guidance: "Evaluate technical decisions",
                }),
                instructions: [
                  'You are a structured reasoning engine for the "reasoning_test" task.',
                  "You MUST respond with a JSON object conforming to this schema.",
                  "Output ONLY valid JSON. No markdown fences, no explanation, no extra text.",
                  "",
                  "JSON Schema:",
                  JSON.stringify(testSchema, null, 2),
                ].join("\n"),
                max_output_tokens: 1024,
              });

              const elapsed = Date.now() - start;
              console.log(`✓ Response received in ${elapsed}ms`);
              console.log(`  Run ID: ${result.id}`);
              if (result.usage) {
                console.log(
                  `  Tokens: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out`,
                );
              }

              const output = result.output;
              const msgItem = Array.isArray(output)
                ? (output.find((o) => o.type === "message") as Record<string, unknown> | undefined)
                : null;
              const textContent = msgItem
                ? ((msgItem.content as Array<Record<string, unknown>>)?.find(
                    (c) => c.type === "output_text",
                  )?.text as string | undefined)
                : null;
              if (textContent) {
                const cleaned = textContent
                  .replace(/^```(?:json)?\s*\n?/i, "")
                  .replace(/\n?```\s*$/, "")
                  .trim();
                try {
                  const parsed = JSON.parse(cleaned);
                  console.log("  Schema-valid JSON: ✓");
                  console.log(`  Output: ${JSON.stringify(parsed, null, 2)}`);
                } catch {
                  console.log("  Schema-valid JSON: ✗ (parse error)");
                  console.log(`  Raw text: ${textContent.slice(0, 500)}`);
                }
              }
            } catch (err) {
              const elapsed = Date.now() - start;
              console.error(`✗ Reasoning check failed after ${elapsed}ms`);
              console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });

        sw.command("status")
          .description("Show StageWhisper HTTP transport status")
          .action(() => {
            const cfg = api.pluginConfig as Record<string, unknown> | undefined;
            const token = resolveHttpTransportToken(cfg ?? {});

            if (token.length < MIN_HTTP_TOKEN_LENGTH) {
              console.log("\nStageWhisper: not paired\n");
              console.log("  Run: openclaw stagewhisper pair-code\n");
              return;
            }

            const host =
              typeof cfg?.["httpHost"] === "string" ? (cfg["httpHost"] as string) : "127.0.0.1";
            const port =
              typeof cfg?.["httpPort"] === "number"
                ? (cfg["httpPort"] as number)
                : typeof cfg?.["httpPort"] === "string"
                  ? Number(cfg["httpPort"])
                  : 8765;
            const label = typeof cfg?.["label"] === "string" ? (cfg["label"] as string) : "(unset)";

            console.log(`\nStageWhisper:`);
            console.log(`  Listener: http://${host}:${port}`);
            console.log(`  Label: ${label}\n`);
          });
      },
      { commands: ["stagewhisper"] },
    );

    if (api.registrationMode !== "full") return;

    ensureResponsesEndpoint(api);
    setRuntime(api.runtime);

    api.registerService(createHttpTransportService(api));
  },
});
