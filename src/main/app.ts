import { spawn } from "node:child_process";
import { copyFileSync, createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";
import { z } from "zod";
import type { IdeaProject } from "../shared/project";
import { Workflow, type ProjectPatch } from "./workflow";

const here = dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | undefined;
/** The IdeaCut checkout/app folder (the one with our package.json), however we were launched. */
function appRoot(): string {
  for (let d = here; d !== dirname(d); d = dirname(d)) {
    try {
      if (JSON.parse(readFileSync(join(d, "package.json"), "utf8")).name === "ideacut") return d;
    } catch {
      /* keep looking */
    }
  }
  return app.getAppPath();
}

let workflow!: Workflow;

const MIME: Record<string, string> = { mp4: "video/mp4", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

/** ideacut://file/<projectId>/<path inside the project> with range support (for <video>). */
function serveProjectFile(request: Request): Response {
  const url = new URL(request.url);
  const [, id, ...rest] = decodeURIComponent(url.pathname).split("/");
  const root = workflow.store.dir(id!);
  const file = normalize(join(root, rest.join("/")));
  if (relative(root, file).startsWith("..")) return new Response("forbidden", { status: 403 });
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return new Response("not found", { status: 404 });
  }
  const type = MIME[file.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
  const range = request.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = Number(range[1] || 0);
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, {
      status: 206,
      headers: { "content-type": type, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" },
    });
  }
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { "content-type": type, "content-length": String(size), "accept-ranges": "bytes", "cache-control": "no-store" } });
}

/** Validation errors become one readable line per problem instead of zod's JSON dump. */
function errorText(err: unknown): string {
  if (err instanceof z.ZodError) return "内容格式不对：\n" + err.issues.map((i) => `${i.path.join(".") || "(root)"}：${i.message}`).join("\n");
  return (err as Error).message;
}

/** Wraps a handler so errors reach the UI as { error } instead of rejected IPC calls. */
function handle(channel: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  });
}

function registerIpc() {
  handle("app:status", () => workflow.status());
  handle("key:set", (key: string) => workflow.setKey(key));
  handle("voices:list", () => workflow.voices());
  handle("project:list", () => workflow.list());
  handle("project:create", (text: string, spec: object) => workflow.create(text, spec));
  handle("project:load", (id: string) => workflow.load(id));
  handle("project:update", (id: string, patch: ProjectPatch) => workflow.update(id, patch));
  handle("project:delete", (id: string) => workflow.remove(id));
  handle("project:addMaterials", async (id: string) => {
    const r = await dialog.showOpenDialog(win!, { title: "添加产品截图或配图", properties: ["openFile", "multiSelections"], filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    let p: IdeaProject | undefined;
    for (const f of r.filePaths) p = workflow.addMaterial(id, f);
    return p ?? workflow.load(id);
  });
  handle("step:questions", (id: string) => workflow.questions(id));
  handle("step:plan", (id: string) => workflow.plan(id));
  handle("step:storyboard", (id: string) => workflow.storyboard(id));
  handle("step:concepts", (id: string) => workflow.concepts(id));
  handle("step:produce", (id: string) => workflow.produce(id));
  handle("step:autopilot", (id: string) => workflow.autopilot(id));
  handle("project:running", (id: string) => workflow.isRunning(id));
  handle("video:saveAs", async (id: string) => {
    const p = workflow.load(id);
    if (!p.run?.output) throw new Error("还没有视频");
    const r = await dialog.showSaveDialog(win!, { defaultPath: `${p.title}.mp4`, filters: [{ name: "MP4", extensions: ["mp4"] }] });
    if (r.canceled || !r.filePath) return null;
    copyFileSync(p.run.output, r.filePath);
    return r.filePath;
  });
  handle("video:reveal", (id: string) => {
    const p = workflow.load(id);
    shell.showItemInFolder(p.run?.output ?? workflow.store.dir(id));
  });
  handle("evercut:open", (id: string) => {
    const { bundle, command } = workflow.evercutBundle(id);
    // Packaged: this same binary hosts EverCut Studio (see index.ts). Dev: EverCut's own Electron.
    const [cmd, args] = app.isPackaged ? [process.execPath, ["--evercut-studio", `--open=${bundle}`]] : [command.command, [...command.args, `--open=${bundle}`]];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(cmd, args, { detached: true, stdio: "ignore", env }).unref();
  });
}

function createWindow() {
  // Dev screenshots (`--screenshot=<png>`) render offscreen so nothing pops up on the desktop.
  const shot = process.argv.find((a) => a.startsWith("--screenshot="))?.slice(13);
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    title: "IdeaCut",
    backgroundColor: "#0e0f13",
    show: false,
    webPreferences: { preload: join(here, "../preload/index.cjs"), sandbox: true, contextIsolation: true, offscreen: !!shot },
  });
  if (!shot) win.once("ready-to-show", () => win!.show());
  const dev = process.env.ELECTRON_RENDERER_URL;
  const hash = new URLSearchParams();
  for (const k of ["open", "step"]) {
    const v = process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
    if (v) hash.set(k, v);
  }
  void win.loadURL((dev ?? pathToFileURL(join(here, "../renderer/index.html")).href) + (hash.size ? `#${hash}` : ""));
  if (shot) {
    win.webContents.once("did-finish-load", () =>
      setTimeout(async () => {
        writeFileSync(shot, (await win!.webContents.capturePage()).toPNG());
        app.quit();
      }, Number(process.env.IDEACUT_SCREENSHOT_DELAY ?? 2500)),
    );
  }
}

/** Starts the IdeaCut app (window, IPC, file protocol). */
export function startIdeaCut() {
  protocol.registerSchemesAsPrivileged([{ scheme: "ideacut", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
  workflow = new Workflow(appRoot(), (p: IdeaProject) => win?.webContents.send("project:changed", p));
  app.whenReady().then(() => {
    protocol.handle("ideacut", serveProjectFile);
    registerIpc();
    createWindow();
    app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => workflow.shutdown());
}

/** `--selftest=<dir>`: runs the whole workflow in demo mode with no window, for checking a build. */
export function runSelfTest(dir: string) {
  app.dock?.hide();
  app.whenReady().then(async () => {
    process.env.IDEACUT_HOME = dir;
    process.env.IDEACUT_FORCE_DEMO = "1";
    const wf = new Workflow(appRoot(), () => undefined);
    const log = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);
    try {
      let p = await wf.create("PPT 生成器：上传文档，一键生成可编辑的演示文稿", { duration: 30 });
      p = (await wf.questions(p.id)).project;
      p = (await wf.plan(p.id)).project;
      p = (await wf.storyboard(p.id)).project;
      p = await wf.produce(p.id);
      log({ selftest: p.run?.status, output: p.run?.output, error: p.run?.error, steps: p.run?.steps.map((s) => `${s.key}:${s.status}`) });
      wf.shutdown();
      app.exit(p.run?.status === "done" ? 0 : 1);
    } catch (err) {
      log({ selftest: "error", error: (err as Error).stack });
      wf.shutdown();
      app.exit(1);
    }
  });
}
