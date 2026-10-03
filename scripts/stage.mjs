#!/usr/bin/env node
// Prepares build/ for packaging:
//   build/evercut  EverCut's runtime (CLI, Electron main/preload/renderer, ws, esbuild)
//   build/ffmpeg   static ffmpeg + ffprobe for this platform (GPLv3 builds by martin-riedl.de)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evercut = resolve(process.env.EVERCUT_DIR ?? join(root, "../ideacut"));
const out = join(root, "build");
const arch = process.arch;
if (process.platform !== "darwin") throw new Error("packaging is set up for macOS only for now");

// ---- EverCut ----
for (const f of ["dist/cli.js", "out/main/index.js", "out/preload/index.cjs", "out/renderer/render/index.html"]) {
  if (!existsSync(join(evercut, f))) throw new Error(`EverCut isn't built (${f} missing). Run: cd ${evercut} && pnpm install && pnpm build`);
}
const ev = join(out, "evercut");
rmSync(ev, { recursive: true, force: true });
mkdirSync(ev, { recursive: true });
for (const d of ["bin", "dist", "out", "skills", "LICENSE", "NOTICE"]) if (existsSync(join(evercut, d))) cpSync(join(evercut, d), join(ev, d), { recursive: true, dereference: true });
const evPkg = JSON.parse(readFileSync(join(evercut, "package.json"), "utf8"));
writeFileSync(join(ev, "package.json"), JSON.stringify({ name: "evercut", version: evPkg.version, type: "module", private: true, license: evPkg.license }, null, 2));
// Runtime packages the bundles keep external, found by scanning their bare imports,
// copied with their dependencies (pnpm layout: dependencies sit next to each package).
const bundles = [join(evercut, "dist/cli.js"), ...readdirSync(join(evercut, "out/main")).filter((f) => f.endsWith(".js")).map((f) => join(evercut, "out/main", f))];
const external = new Set();
for (const b of bundles) {
  for (const m of readFileSync(b, "utf8").matchAll(/(?:from|import\()\s*["']([^./"'][^"']*)["']/g)) {
    const spec = m[1];
    if (spec.startsWith("node:") || spec === "electron") continue;
    external.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
  }
}
/** Finds `name` in node_modules folders from `fromDir` upward. */
function findPkg(name, fromDir) {
  for (let d = fromDir; d !== dirname(d); d = dirname(d)) {
    const p = join(d, "node_modules", name);
    if (existsSync(join(p, "package.json"))) return realpathSync(p);
  }
  return undefined;
}
const copied = new Set();
function copyWithDeps(name, fromDir) {
  if (copied.has(name)) return;
  const dir = findPkg(name, fromDir);
  if (!dir) throw new Error(`EverCut runtime dependency ${name} not found`);
  copied.add(name);
  cpSync(dir, join(ev, "node_modules", name), { recursive: true, dereference: true });
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyWithDeps(dep, dirname(dir));
  // Platform binaries come as optional dependencies (esbuild → @esbuild/darwin-arm64).
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) if (dep.endsWith(`darwin-${arch}`)) copyWithDeps(dep, dirname(dir));
}
for (const name of external) copyWithDeps(name, evercut);
// pnpm's .bin shims embed absolute paths of this machine and aren't needed at runtime.
for (const bin of readdirSync(join(ev, "node_modules"), { recursive: true }).filter((p) => String(p).endsWith(".bin"))) rmSync(join(ev, "node_modules", String(bin)), { recursive: true, force: true });
console.log(`EverCut runtime deps: ${[...copied].sort().join(", ")}`);
console.log(`staged EverCut ${evPkg.version} → build/evercut`);

// ---- FFmpeg ----
const ff = join(out, "ffmpeg");
const cache = join(root, ".cache/ffmpeg", arch);
mkdirSync(cache, { recursive: true });
for (const tool of ["ffmpeg", "ffprobe"]) {
  if (!existsSync(join(cache, tool))) {
    const url = `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch === "arm64" ? "arm64" : "amd64"}/release/${tool}.zip`;
    console.log(`downloading ${url}`);
    execFileSync("curl", ["-sSL", "-o", join(cache, `${tool}.zip`), url]);
    execFileSync("unzip", ["-o", "-q", join(cache, `${tool}.zip`), "-d", cache]);
  }
}
rmSync(ff, { recursive: true, force: true });
mkdirSync(ff, { recursive: true });
for (const tool of ["ffmpeg", "ffprobe"]) cpSync(join(cache, tool), join(ff, tool));
const version = execFileSync(join(ff, "ffmpeg"), ["-hide_banner", "-version"]).toString().split("\n")[0];
if (/--enable-nonfree/.test(execFileSync(join(ff, "ffmpeg"), ["-hide_banner", "-version"]).toString())) throw new Error("refusing to ship a nonfree FFmpeg build");
writeFileSync(
  join(ff, "README.txt"),
  `${version}\n\nFFmpeg is free software licensed under the GNU GPL v3 (this build). IdeaCut runs it as a separate program.\nBinaries: https://ffmpeg.martin-riedl.de (build scripts: https://git.martin-riedl.de/ffmpeg/build-script)\nSource code: https://ffmpeg.org/download.html\n`,
);
console.log(`staged ${version} → build/ffmpeg`);
