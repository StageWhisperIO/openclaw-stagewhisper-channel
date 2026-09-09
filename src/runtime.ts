import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "./openclaw-lite.js";

const runtimeStore = createPluginRuntimeStore<PluginRuntime>(
  "StageWhisper plugin runtime not initialized",
);

export const setRuntime: (next: PluginRuntime) => void = runtimeStore.setRuntime;
export const getRuntime: () => PluginRuntime = runtimeStore.getRuntime;
