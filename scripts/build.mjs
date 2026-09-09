import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outDir = path.join(rootDir, "dist");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, "plugin-main.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: path.join(outDir, "index.js"),
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});
