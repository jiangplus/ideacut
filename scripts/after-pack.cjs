// electron-builder always drops node_modules from extraResources; copy EverCut's runtime deps
// (ws, esbuild + native binary) in after packing, before signing.
const { cpSync, existsSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(ctx) {
  const app = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, "Contents/Resources/evercut");
  const from = join(ctx.packager.projectDir, "build/evercut/node_modules");
  if (!existsSync(from)) throw new Error("build/evercut/node_modules missing — run `pnpm stage` first");
  cpSync(from, join(app, "node_modules"), { recursive: true, dereference: true });
};
