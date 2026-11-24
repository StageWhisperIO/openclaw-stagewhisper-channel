import fs from "node:fs";
import path from "node:path";

// OpenClaw loads external plugins via jiti from ~/.openclaw/extensions/.
// jiti's alias map is built by walking up from the plugin file's directory
// to find a package.json with name "openclaw" — but external plugins live
// outside the openclaw package tree, so the walk never finds it and
// 'openclaw/plugin-sdk/*' imports fail with "Cannot find module".
//
// This bootstrap creates a node_modules/openclaw symlink pointing to the
// actual openclaw package (located via process.argv[1]), then loads the
// real plugin entry where the openclaw imports live.

function ensureOpenClawResolvable(): void {
  const pluginDir =
    typeof __dirname === "string"
      ? __dirname
      : path.dirname(new URL(import.meta.url).pathname);

  const link = path.join(pluginDir, "node_modules", "openclaw");
  if (fs.existsSync(link)) return;

  const binPath = process.argv[1];
  if (!binPath) return;

  try {
    const resolved = fs.realpathSync(binPath);
    let dir = path.dirname(resolved);
    for (let i = 0; i < 20; i++) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          if (pkg.name === "openclaw") {
            fs.mkdirSync(path.join(pluginDir, "node_modules"), {
              recursive: true,
            });
            fs.symlinkSync(dir, link, "dir");
            return;
          }
        } catch {}
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
}

ensureOpenClawResolvable();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pluginMain = require("./plugin-main");
export default pluginMain.default ?? pluginMain;
