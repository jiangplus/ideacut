// Entry point. The same binary has three roles:
//   (default)              IdeaCut
//   --evercut-render=<job> EverCut's render worker (spawned by the EverCut engine)
//   --evercut-studio       EverCut Studio ("在 EverCut 中精修")
// In the packaged app EverCut ships under Resources/evercut and is loaded at runtime, so the
// two code bases still never import each other at build time.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, protocol } from "electron";
import { runSelfTest, startIdeaCut } from "./app";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * EverCut's folder. The packaged app only ever uses the copy bundled in its own Resources
 * (IdeaCut and EverCut are one program); a sibling checkout is a development convenience.
 */
function evercutDir(): string | undefined {
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, "evercut");
    return existsSync(join(bundled, "out/main/index.js")) ? bundled : undefined;
  }
  const candidates = [process.env.EVERCUT_DIR, resolve(here, "../../../ideacut")].filter(Boolean) as string[];
  return candidates.find((d) => existsSync(join(d, "out/main/index.js")));
}

const dir = evercutDir();
if (dir) {
  // Packaged: force the bundled copy even if the environment points elsewhere.
  if (app.isPackaged) process.env.EVERCUT_DIR = dir;
  else process.env.EVERCUT_DIR ??= dir;
  if (app.isPackaged) {
    // Render workers and Studio run inside this binary; FFmpeg ships in Resources.
    process.env.EVERCUT_ELECTRON = process.execPath;
    process.env.EVERCUT_APP_MAIN = join(dir, "out/main/index.js");
    const ff = join(process.resourcesPath, "ffmpeg");
    if (existsSync(join(ff, "ffmpeg"))) {
      process.env.EVERCUT_FFMPEG = join(ff, "ffmpeg");
      process.env.EVERCUT_FFPROBE = join(ff, "ffprobe");
    }
  }
}

const hostEverCut = process.argv.some((a) => a.startsWith("--evercut-render=") || a === "--evercut-studio");
const selftest = process.argv.find((a) => a.startsWith("--selftest="))?.slice("--selftest=".length);

if (hostEverCut) {
  if (!dir) {
    console.error("EverCut is not available in this build");
    app.exit(1);
  } else {
    // Scheme privileges can only be registered before "ready", and the dynamic import below may
    // finish after that — so register EverCut's scheme here, synchronously.
    protocol.registerSchemesAsPrivileged([{ scheme: "evercut", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: false } }]);
    import(pathToFileURL(join(dir, "out/main/index.js")).href).catch((err) => {
      console.error(err);
      app.exit(1);
    });
  }
} else if (selftest) {
  runSelfTest(resolve(selftest));
} else {
  startIdeaCut();
}
