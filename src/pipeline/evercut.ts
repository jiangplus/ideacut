// IdeaCut talks to EverCut only through its engine API: it starts a private headless engine
// (`evercut engine start --no-advertise`) and sends JSON-RPC over WebSocket. No EverCut code
// is imported, so either app can change internally without breaking the other.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import WebSocket from "ws";

export class EverCutError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** Where EverCut lives: EVERCUT_DIR, else a sibling "ideacut" checkout next to this app. */
export function locateEverCut(appRoot: string): string {
  const candidates = [process.env.EVERCUT_DIR, resolve(appRoot, "../ideacut"), resolve(appRoot, "../evercut")].filter(Boolean) as string[];
  for (const dir of candidates) if (existsSync(join(dir, "bin/evercut.js"))) return dir;
  throw new EverCutError(`EverCut not found (looked in ${candidates.join(", ")}). Set EVERCUT_DIR to the EverCut folder.`);
}

export function checkEverCutBuilt(dir: string): string[] {
  const missing = ["dist/cli.js", "out/main/index.js"].filter((f) => !existsSync(join(dir, f)));
  return missing.length ? [`EverCut isn't built (${missing.join(", ")} missing). Run \`pnpm install && pnpm build\` in ${dir}.`] : [];
}

export class EverCutEngine {
  private proc?: ChildProcess;
  private ws?: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(method: string, params: any) => void>();

  constructor(readonly dir: string) {}

  async start(): Promise<void> {
    if (this.ws) return;
    const problems = checkEverCutBuilt(this.dir);
    if (problems.length) throw new EverCutError(problems[0]!);
    // Runs the EverCut CLI with this process's runtime (Electron as Node, or Node in tests).
    const proc = spawn(process.execPath, [join(this.dir, "bin/evercut.js"), "--compact", "--local", "engine", "start", "--no-advertise"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;
    let stderr = "";
    proc.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    const info = await new Promise<{ listening: string; token: string }>((resolveInfo, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new EverCutError(`EverCut engine didn't start: ${stderr || "timeout"}`)), 20_000);
      proc.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        const line = buf.split("\n").find((l) => l.includes('"listening"'));
        if (line) {
          clearTimeout(timer);
          resolveInfo(JSON.parse(line));
        }
      });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        reject(new EverCutError(`EverCut engine exited (${code}): ${stderr}`));
      });
    });
    const ws = new WebSocket(`${info.listening}/?token=${encodeURIComponent(info.token)}&client=ideacut`);
    await new Promise<void>((r, j) => {
      ws.once("open", () => r());
      ws.once("error", (e) => j(new EverCutError(`can't connect to EverCut engine: ${e.message}`)));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== undefined && msg.id !== null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new EverCutError(msg.error.message, msg.error.code, msg.error.data));
        else p.resolve(msg.result);
      } else if (msg.method) {
        this.listeners.forEach((l) => l(msg.method, msg.params));
      }
    });
    ws.on("close", () => {
      for (const p of this.pending.values()) p.reject(new EverCutError("EverCut engine connection closed"));
      this.pending.clear();
      this.ws = undefined;
    });
    this.ws = ws;
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws) return Promise.reject(new EverCutError("EverCut engine not started"));
    const id = ++this.seq;
    return new Promise<T>((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall, reject });
      this.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  on(cb: (method: string, params: any) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  stop() {
    this.ws?.close();
    this.proc?.kill();
    this.ws = undefined;
    this.proc = undefined;
  }

  /** The Electron binary + main script that launch EverCut Studio. */
  studioCommand(): { command: string; args: string[] } {
    const electronDir = join(this.dir, "node_modules/electron");
    const rel = readFileSync(join(electronDir, "path.txt"), "utf8").trim();
    return { command: join(electronDir, "dist", rel), args: [join(this.dir, "out/main/index.js")] };
  }
}
