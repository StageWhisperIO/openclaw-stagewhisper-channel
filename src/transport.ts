export const MIN_HTTP_TOKEN_LENGTH = 16;

export function resolveHttpTransportToken(
  pluginCfg: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof pluginCfg["httpToken"] === "string" && pluginCfg["httpToken"]) {
    return pluginCfg["httpToken"] as string;
  }
  if (env["STAGEWHISPER_HTTP_TOKEN"]) {
    return env["STAGEWHISPER_HTTP_TOKEN"];
  }
  return "";
}
